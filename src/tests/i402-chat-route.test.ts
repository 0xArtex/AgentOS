/**
 * Integration-ish tests for the /chat route.
 *
 * Mounts only the agent-chat router on a minimal Express app (no global middleware,
 * no DB bootstrap beyond initDatabase) so we can test route-specific behavior in
 * isolation. LLM calls are stubbed via the `llm` adapter.
 *
 * What's covered here:
 *  - GET /chat/capabilities returns the canonical capability list
 *  - GET /chat/providers lists providers, filter by capability
 *  - GET /chat/providers?capability=unknown → 404
 *  - POST /chat without x402 payment → 402 (x402 discovery)
 *  - Service-level integration (generatePlan → updatePlanStatus(approved) → executePlanStream)
 *    exercises the full planner+executor pipeline with stubbed LLM and mocked StepHandlers
 *
 * Paid HTTP paths (POST /chat, POST /chat/:id/execute) require a signed x402 payment
 * that can't be produced without a real wallet, so their business logic is exercised
 * at the service layer above. Full HTTP exercise lives in the Tier B E2E plan.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

process.env.I402_ORCHESTRATION_FEE_PCT = "0.15";
process.env.I402_SESSION_IDLE_TIMEOUT_HOURS = "24";
process.env.I402_SESSION_MAX_BUDGET_USDC = "1000";
process.env.AGENTOS_API_BASE = "https://staging.agntos.dev";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

import { db, initDatabase } from "../db";
import {
  seedAgentOSPrimitives,
  registerProvider,
  CAPABILITY_CLASSES,
} from "../services/i402-providers";
import { createSession } from "../services/i402-session";
import { deposit, getLedger } from "../services/i402-escrow";
import {
  executePlanStream,
  type StepHandler,
  type ExecutorEvent,
} from "../services/i402-executor";
import { generatePlan, getPlan, updatePlanStatus } from "../services/i402-planner";
import { llm } from "../services/i402-llm";
import agentChatRoutes from "../routes/agent-chat";
import type { PlannerRequest } from "../services/i402-types";

// -------------------- Setup --------------------

initDatabase();
seedAgentOSPrimitives();
registerProvider({
  id: "external.backup_search",
  source: "external",
  capability: "web_search",
  name: "Backup web search",
  endpoint: "https://example.com/search",
  authScheme: "x402-base",
  inputSchema: CAPABILITY_CLASSES.web_search.inputSchema,
  outputSchema: CAPABILITY_CLASSES.web_search.outputSchema,
  costPerCallUsdc: 0.15,
  p50LatencyMs: 2000,
  reputationScore: 0.6,
});

function clearI402DynamicTables(): void {
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

// Build a minimal Express app that mounts the chat router only. We don't load the
// full AgentOS middleware chain because most of it (rate limiting, x402 settle) is
// out of scope for per-route testing.
function buildTestServer(): { server: http.Server; port: number; close: () => Promise<void> } {
  const app = express();
  app.use(express.json());
  app.use("/chat", agentChatRoutes);

  return new Promise<{ server: http.Server; port: number; close: () => Promise<void> }>(resolve => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to bind test server");
      resolve({
        server,
        port: addr.port,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  }) as any; // the listen callback makes this synchronous-resolvable for tests
}

// The returned type of buildTestServer is actually a Promise, so we await it.
async function launchTestServer(): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return await buildTestServer();
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
          try {
            body = JSON.parse(buf);
          } catch {
            /* non-JSON */
          }
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
          try {
            parsed = JSON.parse(buf);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// -------------------- Discovery endpoints (free, no auth needed) --------------------

describe("GET /chat/capabilities", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => {
    ctx = await launchTestServer();
  });
  after(async () => {
    await ctx.close();
  });

  it("returns the full capability list with version", async () => {
    const res = await httpGet(ctx.port, "/chat/capabilities");
    assert.equal(res.status, 200);
    assert.equal(res.body.version, "0.1");
    assert.ok(Array.isArray(res.body.capabilities));
    const names = new Set(res.body.capabilities.map((c: any) => c.name));
    for (const required of ["web_search", "register_domain", "deploy_vps", "social_post", "launch_product"]) {
      assert.ok(names.has(required), `missing capability ${required}`);
    }
    assert.equal(res.headers["x-i402-version"], "0.1");
  });
});

describe("GET /chat/providers", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => {
    ctx = await launchTestServer();
  });
  after(async () => {
    await ctx.close();
  });

  it("returns all providers when no capability filter", async () => {
    const res = await httpGet(ctx.port, "/chat/providers");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.providers));
    assert.ok(res.body.providers.length > 0);
  });

  it("filters providers by capability", async () => {
    const res = await httpGet(ctx.port, "/chat/providers?capability=web_search");
    assert.equal(res.status, 200);
    const provs = res.body.providers;
    assert.ok(provs.every((p: any) => p.capability === "web_search"));
  });

  it("returns 404 for unknown capability", async () => {
    const res = await httpGet(ctx.port, "/chat/providers?capability=does_not_exist");
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Unknown Capability/i);
  });
});

// -------------------- Paid endpoint discovery (x402 probe) --------------------

describe("POST /chat without x402 payment → 402", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => {
    ctx = await launchTestServer();
  });
  after(async () => {
    await ctx.close();
  });

  it("emits 402 with PAYMENT-REQUIRED metadata for x402 discovery", async () => {
    const res = await httpPostJson(ctx.port, "/chat", {
      intent: "test",
      budget_usdc: 1,
    });
    assert.equal(res.status, 402);
    // Canonical AgentOS 402 response — the existing auth middleware formats this.
    assert.ok(res.body.error);
  });
});

// -------------------- Full pipeline at service level (bypasses HTTP/auth) --------------------

describe("End-to-end: generatePlan → approve → executePlanStream", () => {
  before(clearI402DynamicTables);

  beforeEach(() => {
    llm.completeStructured = ORIGINAL_LLM;
    clearI402DynamicTables();
  });

  after(() => {
    llm.completeStructured = ORIGINAL_LLM;
  });

  it("runs a full two-step plan end-to-end with mocked providers", async () => {
    const session = createSession({ walletAddress: "WALLET_E2E", budgetUsdc: 50 });

    // Stub LLM: first call = router (compound), second call = planner
    llm.completeStructured = (async (input: any) => {
      if (input.tool.name === "classify_intent") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { classification: "compound", reason: "needs multi-step" },
          usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
        };
      }
      return {
        model: "claude-opus-4-7",
        content: {
          interpreted_intent: "search + register a domain",
          steps: [
            { step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: { query: "agent infra trends 2026" } },
            {
              step_id: "s2",
              capability: "register_domain",
              provider_id: "agentos.register_domain",
              input: { domain_preferences: ["agentlaunch.io"] },
              depends_on: ["s1"],
            },
          ],
        },
        usage: { tokensIn: 500, tokensOut: 200, cacheReadTokens: 2000, cacheCreationTokens: 0, costUsdc: 0.02 },
      };
    }) as any;

    const plannerRequest: PlannerRequest = {
      sessionId: session.id,
      walletAddress: session.walletAddress,
      intent: "Research agent infra and register a domain",
      budgetUsdc: 50,
      quality: "best",
      autoApproveUnderUsdc: 50, // auto-approve since we're in test
    };
    const plan = await generatePlan(plannerRequest);
    assert.ok("planId" in plan);
    const p = plan as any;
    assert.equal(p.status, "approved");
    assert.equal(p.steps.length, 2);

    // Deposit escrow (simulating x402 payment)
    deposit({ sessionId: session.id, amountUsdc: p.totals.totalCostUsdc });

    // Execute with mocked handlers
    const handlers: Record<string, StepHandler> = {
      "agentos.web_search": async () => ({ results: [{ title: "t", url: "https://x.com", snippet: "s" }] }),
      "agentos.register_domain": async () => ({
        domain_registered: "agentlaunch.io",
        expires_at: "2027-04-22",
        registrar: "namecheap",
        dns_nameservers: ["ns1.cf.com"],
      }),
    };

    const events: ExecutorEvent[] = [];
    for await (const e of executePlanStream(p, session.walletAddress, { handlers, refundOnClose: false })) {
      events.push(e);
    }

    // Confirm event order + outcome
    assert.equal(events[0].type, "session");
    assert.equal(events[1].type, "plan");
    assert.equal(events[events.length - 1].type, "summary");

    const summary = events[events.length - 1];
    if (summary.type === "summary") {
      assert.equal(summary.status, "completed");
      assert.equal(summary.artifacts.length, 1);
      assert.equal(summary.artifacts[0].type, "domain");
    }

    // Ledger reflects the debits
    const ledger = getLedger(session.id);
    const kinds = ledger.map(l => l.kind);
    assert.ok(kinds.includes("deposit"));
    assert.ok(kinds.includes("debit_orchestration_fee"));
    assert.ok(kinds.includes("debit_step"));
  });

  it("returns clarification when intent is ambiguous", async () => {
    const session = createSession({ walletAddress: "WALLET_AMB", budgetUsdc: 50 });

    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: {
        classification: "ambiguous",
        reason: "no concrete target",
        clarification_questions: ["What outcome?"],
      },
      usage: { tokensIn: 50, tokensOut: 30, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan({
      sessionId: session.id,
      walletAddress: session.walletAddress,
      intent: "help me",
      budgetUsdc: 50,
    });
    assert.equal((result as any).status, "clarification_needed");
  });

  it("approval + execution flow: plan is awaiting_approval → updatePlanStatus → execute", async () => {
    const session = createSession({ walletAddress: "WALLET_APP", budgetUsdc: 50 });

    llm.completeStructured = (async (input: any) => {
      if (input.tool.name === "classify_intent") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { classification: "direct", detected_capability: "web_search", reason: "single search" },
          usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
        };
      }
      throw new Error("planner should not be called for direct");
    }) as any;

    const plan = await generatePlan({
      sessionId: session.id,
      walletAddress: session.walletAddress,
      intent: "search for something",
      params: { query: "test" },
      budgetUsdc: 50,
      // no auto_approve_under_usdc → should require manual approval
    });
    assert.ok("planId" in plan);
    const p = plan as any;
    assert.equal(p.status, "awaiting_approval");

    // Manual approval
    updatePlanStatus(p.planId, "approved");
    const approved = getPlan(p.planId)!;
    assert.equal(approved.status, "approved");

    // Now execution should proceed
    deposit({ sessionId: session.id, amountUsdc: approved.totalCostUsdc });

    const handlers: Record<string, StepHandler> = {
      "agentos.web_search": async () => ({ results: [] }),
    };

    const events: ExecutorEvent[] = [];
    for await (const e of executePlanStream(
      {
        sessionId: session.id,
        planId: approved.id,
        status: "approved",
        intent: { original: approved.intent, interpreted: approved.interpretedIntent },
        steps: approved.steps,
        totals: {
          stepCostUsdc: approved.stepCostUsdc,
          orchestrationFeeUsdc: approved.orchestrationFeeUsdc,
          totalCostUsdc: approved.totalCostUsdc,
          withinBudget: approved.withinBudget,
          executionModes: ["server_side", "hybrid"],
        },
      },
      session.walletAddress,
      { handlers }
    )) {
      events.push(e);
    }

    const summary = events[events.length - 1];
    assert.equal(summary.type === "summary" && summary.status, "completed");
  });
});
