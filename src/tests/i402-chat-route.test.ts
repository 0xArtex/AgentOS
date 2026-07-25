/**
 * Integration tests for the /chat route in agent-side-only mode.
 *
 * What this covers:
 *  - GET /chat/capabilities returns the canonical list
 *  - GET /chat/providers lists only x402-native providers (no API-key proxies)
 *  - GET /chat/providers?capability=unknown → 404
 *  - POST /chat without x402 → 402 (x402 discovery probe)
 *  - Service-layer: generatePlan → persistence round trip with wallet-keyed
 *    session resolution (no X-Session-Id header)
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

process.env.I402_ORCHESTRATION_FEE_PCT = "0.15";
process.env.I402_SESSION_IDLE_TIMEOUT_HOURS = "24";
process.env.I402_SESSION_MAX_BUDGET_USDC = "1000";
process.env.PALMYR_API_BASE = "https://staging.palmyr.ai";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

import { db, initDatabase } from "../db";
import { seedPalmyrPrimitives, listProviders } from "../services/i402-providers";
import { generatePlan, getPlan } from "../services/i402-planner";
import { createSession, findActiveSessionForWallet } from "../services/i402-session";
import { llm } from "../services/i402-llm";
import agentChatRoutes, {
  buildChatPlanPayload,
  validateChatRequestLimits,
  MAX_INTENT_CHARS,
  MAX_STRUCTURED_BYTES,
} from "../routes/agent-chat";
import type { Plan, PlannerRequest } from "../services/i402-types";

// -------------------- Setup --------------------

initDatabase();
seedPalmyrPrimitives();

function clearI402Dynamic(): void {
  db.exec(`
    DELETE FROM i402_session_step_results;
    DELETE FROM i402_session_artifacts;
    DELETE FROM i402_escrow_ledger;
    DELETE FROM i402_session_plans;
    DELETE FROM i402_session_messages;
    DELETE FROM i402_agent_sessions;
  `);
}

const ORIGINAL_LLM = llm.completeStructured;

async function launchTestServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use("/chat", agentChatRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind failed");
      resolve({
        port: addr.port,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

async function httpGet(port: number, path: string): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path, headers: { Accept: "application/json" } }, res => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", chunk => (buf += chunk));
        res.on("end", () => {
          let body: any = buf;
          try { body = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      })
      .on("error", reject);
  });
}

async function httpPostJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      res => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", c => (buf += c));
        res.on("end", () => {
          let parsed: any = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// -------------------- Discovery (free) --------------------

describe("GET /chat/capabilities", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => { ctx = await launchTestServer(); });
  after(async () => { await ctx.close(); });

  it("returns the full capability list with version header", async () => {
    const res = await httpGet(ctx.port, "/chat/capabilities");
    assert.equal(res.status, 200);
    assert.equal(res.body.version, "0.1");
    assert.ok(Array.isArray(res.body.capabilities));
    const names = new Set(res.body.capabilities.map((c: any) => c.name));
    for (const required of ["register_domain", "deploy_vps", "social_post", "launch_product"]) {
      assert.ok(names.has(required), `missing capability ${required}`);
    }
    assert.equal(res.headers["x-i402-version"], "0.1");
  });
});

describe("GET /chat/providers", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => { ctx = await launchTestServer(); });
  after(async () => { await ctx.close(); });

  it("only returns x402-native providers (no API-key providers)", async () => {
    const res = await httpGet(ctx.port, "/chat/providers");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.providers));
    for (const p of res.body.providers) {
      assert.ok(
        p.payment_rail === "x402-solana" || p.payment_rail === "x402-base",
        `provider ${p.id} has non-x402 auth: ${p.payment_rail}`
      );
    }
  });

  it("filters by capability", async () => {
    const res = await httpGet(ctx.port, "/chat/providers?capability=register_domain");
    assert.equal(res.status, 200);
    assert.ok(res.body.providers.every((p: any) => p.capability === "register_domain"));
    assert.ok(res.body.providers.length >= 1);
  });

  it("404 on unknown capability", async () => {
    const res = await httpGet(ctx.port, "/chat/providers?capability=bogus");
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Unknown Capability/i);
  });
});

// -------------------- Payment discovery --------------------

describe("POST /chat without x402 payment", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => { ctx = await launchTestServer(); });
  after(async () => { await ctx.close(); });

  it("returns 402 to trigger x402 payment for the orchestration fee", async () => {
    const res = await httpPostJson(ctx.port, "/chat", {
      intent: "test",
      budget_usdc: 1,
    });
    assert.equal(res.status, 402);
    assert.ok(res.body.error);
  });
});

// -------------------- Spend-cap enforcement (finding: plan-level budget) --------------------

describe("buildChatPlanPayload — plan-level spend cap", () => {
  function makePlan(within: boolean): Plan {
    return {
      sessionId: "sess",
      planId: "plan_cap",
      status: within ? "approved" : "budget_exceeded",
      intent: { original: "deploy a vps" },
      steps: [
        {
          stepId: "s1",
          capability: "deploy_vps",
          provider: "palmyr.deploy_vps",
          input: { name: "box" },
          costUsdc: 6,
          x402: { endpoint: "https://palmyr.ai/compute/servers", method: "POST", paymentRail: "x402-solana" },
        },
      ],
      totals: {
        stepCostUsdc: 6,
        orchestrationFeeUsdc: 0.9,
        totalCostUsdc: 6.9,
        withinBudget: within,
      },
    };
  }

  it("emits executable x402 specs for a within-budget plan", () => {
    const { status, body } = buildChatPlanPayload(makePlan(true));
    assert.equal(status, 200);
    const steps = body.steps as any[];
    assert.ok(steps[0].x402?.endpoint, "within-budget step should carry an x402 spec");
    assert.equal(body.executable, true);
  });

  // Regression: a settled plan must NEVER come back as 402. Clients read 402 as
  // "unpaid" and re-sign — an agent paid the orchestration fee twice on Base
  // before abandoning a plan that was already in the body.
  it("answers 200 for both executable and budget-blocked plans", () => {
    assert.equal(buildChatPlanPayload(makePlan(true)).status, 200);
    assert.equal(buildChatPlanPayload(makePlan(false)).status, 200);
    assert.equal(buildChatPlanPayload(makePlan(false), { allowBudgetExceeded: true }).status, 200);
  });

  it("withholds x402 specs for a budget_exceeded plan with no opt-in", () => {
    const { body } = buildChatPlanPayload(makePlan(false));
    assert.equal(body.status, "budget_exceeded");
    assert.equal(body.executable, false);
    const steps = body.steps as any[];
    assert.ok(steps.length >= 1, "should still show a cost preview");
    assert.equal(steps[0].x402, undefined, "blocked steps must NOT include executable x402 specs");
    assert.match(String(body.message), /budget|exceed/i);
  });

  it("emits executable x402 specs for a budget_exceeded plan WITH an explicit opt-in", () => {
    const { body } = buildChatPlanPayload(makePlan(false), { allowBudgetExceeded: true });
    const steps = body.steps as any[];
    assert.ok(steps[0].x402?.endpoint, "opt-in should restore the executable x402 spec");
    assert.notEqual(body.executable, false);
  });
});

describe("validateChatRequestLimits — input cost guard", () => {
  it("accepts a normal request", () => {
    assert.equal(validateChatRequestLimits({ intent: "launch a brand" }).ok, true);
  });

  it("rejects an over-long intent", () => {
    const r = validateChatRequestLimits({ intent: "x".repeat(MAX_INTENT_CHARS + 1) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Intent Too Long/i);
  });

  it("rejects oversized structured params", () => {
    const big = { blob: "y".repeat(MAX_STRUCTURED_BYTES + 1) };
    const r = validateChatRequestLimits({ intent: "ok", params: big });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Too Large/i);
  });
});

// -------------------- Service-level: wallet-keyed session resolution --------------------

describe("generatePlan — wallet-keyed session resolution", () => {
  beforeEach(() => {
    llm.completeStructured = ORIGINAL_LLM;
    clearI402Dynamic();
  });

  after(() => {
    llm.completeStructured = ORIGINAL_LLM;
  });

  it("creates a new session when wallet has none", async () => {
    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: { classification: "direct", detected_capability: "register_domain", reason: "single domain" },
      usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan({
      sessionId: "",
      walletAddress: "NEW_WALLET_1",
      intent: "Register example.com",
      params: { domain: "example.com" },
      budgetUsdc: 20,
    });
    assert.ok("planId" in result);
    const plan = result as any;
    const session = findActiveSessionForWallet("NEW_WALLET_1");
    assert.ok(session);
    assert.equal(plan.sessionId, session!.id);
  });

  it("continues an active session when the new intent is related", async () => {
    // First turn establishes a session
    const firstSession = createSession({ walletAddress: "WALLET_CONT", budgetUsdc: 50 });

    // Stub LLM to say: relatedness=continues, then direct capability
    let call = 0;
    llm.completeStructured = (async (input: any) => {
      call++;
      if (input.tool.name === "classify_session_relatedness") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { verdict: "continues", reason: "same project" },
          usage: { tokensIn: 50, tokensOut: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.0005 },
        };
      }
      if (input.tool.name === "classify_intent") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { classification: "direct", detected_capability: "register_domain", reason: "single" },
          usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
        };
      }
      throw new Error(`unexpected tool ${input.tool.name}`);
    }) as any;

    // Seed an agent message so the relatedness check has something to compare against
    const { appendMessage } = await import("../services/i402-session");
    appendMessage({ sessionId: firstSession.id, role: "agent", content: "Launch sneaker brand" });

    const result = await generatePlan({
      sessionId: "",
      walletAddress: "WALLET_CONT",
      intent: "Now register freshkicks.io",
      params: { domain: "freshkicks.io" },
      budgetUsdc: 20,
    });
    assert.ok("planId" in result);
    const plan = result as any;
    assert.equal(plan.sessionId, firstSession.id, "should reuse the existing session");
  });

  it("starts a fresh session when new intent is unrelated to prior", async () => {
    const priorSession = createSession({ walletAddress: "WALLET_SWITCH", budgetUsdc: 50 });
    const { appendMessage } = await import("../services/i402-session");
    appendMessage({ sessionId: priorSession.id, role: "agent", content: "Launch sneaker brand" });

    llm.completeStructured = (async (input: any) => {
      if (input.tool.name === "classify_session_relatedness") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { verdict: "new_goal", reason: "unrelated topic" },
          usage: { tokensIn: 50, tokensOut: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.0005 },
        };
      }
      if (input.tool.name === "classify_intent") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { classification: "direct", detected_capability: "register_domain", reason: "single" },
          usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
        };
      }
      throw new Error(`unexpected tool ${input.tool.name}`);
    }) as any;

    const result = await generatePlan({
      sessionId: "",
      walletAddress: "WALLET_SWITCH",
      intent: "Start a coffee subscription business",
      params: { domain: "coffeesub.io" },
      budgetUsdc: 20,
    });
    assert.ok("planId" in result);
    const plan = result as any;
    assert.notEqual(plan.sessionId, priorSession.id, "should create a fresh session for unrelated goal");

    // Prior session should be auto-closed as 'completed'
    const closed = db.prepare(`SELECT status FROM i402_agent_sessions WHERE id = ?`).get(priorSession.id) as { status: string };
    assert.equal(closed.status, "completed");
  });

  it("forceNewSession=true always creates fresh regardless of active session", async () => {
    const prior = createSession({ walletAddress: "WALLET_FORCE", budgetUsdc: 50 });
    const { appendMessage } = await import("../services/i402-session");
    appendMessage({ sessionId: prior.id, role: "agent", content: "whatever" });

    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: { classification: "direct", detected_capability: "register_domain", reason: "x" },
      usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan(
      { sessionId: "", walletAddress: "WALLET_FORCE", intent: "Do thing", params: { domain: "thing.io" }, budgetUsdc: 10 },
      { forceNewSession: true }
    );
    assert.ok("planId" in result);
    assert.notEqual((result as any).sessionId, prior.id);
  });

  it("every step in a generated plan has x402-native payment_rail", async () => {
    llm.completeStructured = (async (input: any) => {
      if (input.tool.name === "classify_intent") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { classification: "compound", reason: "multi-step" },
          usage: { tokensIn: 50, tokensOut: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.0005 },
        };
      }
      return {
        model: "claude-opus-4-7",
        content: {
          interpreted_intent: "domain + vps",
          steps: [
            { step_id: "s1", capability: "register_domain", provider_id: "palmyr.register_domain", input: { domain_preferences: ["test.io"] } },
            { step_id: "s2", capability: "deploy_vps", provider_id: "palmyr.deploy_vps", input: { plan: "cx23" }, depends_on: ["s1"] },
          ],
        },
        usage: { tokensIn: 500, tokensOut: 200, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.02 },
      };
    }) as any;

    const result = await generatePlan({
      sessionId: "",
      walletAddress: "WALLET_X402",
      intent: "register domain and deploy vps",
      budgetUsdc: 30,
    });
    assert.ok("planId" in result);
    const plan = result as any;
    for (const step of plan.steps) {
      assert.ok(
        step.x402.paymentRail === "x402-solana" || step.x402.paymentRail === "x402-base",
        `step ${step.stepId} has non-x402 rail: ${step.x402.paymentRail}`
      );
    }
  });

  it("persists plan to DB and is retrievable via getPlan", async () => {
    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: { classification: "direct", detected_capability: "register_domain", reason: "single" },
      usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan({
      sessionId: "",
      walletAddress: "WALLET_PERSIST",
      intent: "Register example.io",
      params: { domain: "example.io" },
      budgetUsdc: 20,
    });
    assert.ok("planId" in result);
    const plan = result as any;
    const persisted = getPlan(plan.planId);
    assert.ok(persisted);
    assert.equal(persisted!.sessionId, plan.sessionId);
    assert.equal(persisted!.status, "approved");
  });
});
