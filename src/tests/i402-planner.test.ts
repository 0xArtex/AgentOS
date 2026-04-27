/**
 * Unit tests for the i402 planner (agent-side-only mode).
 *
 * Covers:
 *  - computeTotals math (tiered quality, rounding, budget)
 *  - validatePlanSteps (happy + every failure mode including x402-native enforcement)
 *  - EXPANSION_TEMPLATES shape
 *  - generatePlan with stubbed LLM — direct, compound, ambiguous, budget-exceeded
 *  - wallet-keyed session behavior (see i402-chat-route.test.ts for the full coverage)
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.I402_ORCHESTRATION_FEE_PCT = "0.15";
process.env.I402_SESSION_IDLE_TIMEOUT_HOURS = "24";
process.env.I402_SESSION_MAX_BUDGET_USDC = "1000";
process.env.AGENTOS_API_BASE = "https://staging.agntos.dev";

import { db, initDatabase } from "../db";
import { seedAgentOSPrimitives, listProviders, CAPABILITY_CLASSES } from "../services/i402-providers";
import {
  computeTotals,
  validatePlanSteps,
  EXPANSION_TEMPLATES,
  generatePlan,
  getPlan,
} from "../services/i402-planner";
import { llm } from "../services/i402-llm";
import type { PlanStep, PlannerRequest } from "../services/i402-types";

// -------------------- Setup --------------------

initDatabase();
seedAgentOSPrimitives();

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

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    stepId: overrides.stepId ?? "s1",
    capability: overrides.capability ?? "register_domain",
    provider: overrides.provider ?? "agentos.register_domain",
    input: overrides.input ?? { domain_preferences: ["test.io"] },
    costUsdc: overrides.costUsdc ?? 9.99,
    etaSeconds: overrides.etaSeconds ?? 30,
    dependsOn: overrides.dependsOn,
    description: overrides.description,
    x402: overrides.x402 ?? {
      endpoint: "https://agntos.dev/domain/register",
      method: "POST",
      paymentRail: "x402-solana",
    },
  };
}

function makeRequest(overrides: Partial<PlannerRequest> = {}): PlannerRequest {
  return {
    sessionId: overrides.sessionId ?? "",
    walletAddress: overrides.walletAddress ?? "WALLETx",
    intent: overrides.intent ?? "do a thing",
    params: overrides.params,
    budgetUsdc: overrides.budgetUsdc ?? 50,
    deadlineSeconds: overrides.deadlineSeconds,
    quality: overrides.quality ?? "best",
    constraints: overrides.constraints,
  };
}

const ORIGINAL_LLM = llm.completeStructured;

// -------------------- Pure function tests --------------------

describe("computeTotals", () => {
  it("computes step cost, fee (15%), total, within_budget correctly", () => {
    const steps = [makeStep({ costUsdc: 1.0 }), makeStep({ stepId: "s2", costUsdc: 2.0 })];
    const totals = computeTotals(steps, 10);
    assert.equal(totals.stepCostUsdc, 3.0);
    assert.equal(totals.orchestrationFeeUsdc, 0.45);
    assert.equal(totals.totalCostUsdc, 3.45);
    assert.equal(totals.withinBudget, true);
  });

  it("flags within_budget=false when total exceeds budget", () => {
    const steps = [makeStep({ costUsdc: 15 })];
    const totals = computeTotals(steps, 10);
    assert.equal(totals.withinBudget, false);
    assert.ok(totals.totalCostUsdc > 10);
  });

  it("applies minimum fee of $0.01 on tiny plans", () => {
    const steps = [makeStep({ costUsdc: 0.01 })];
    const totals = computeTotals(steps, 1);
    assert.ok(totals.orchestrationFeeUsdc >= 0.01);
  });

  it("sums ETA across steps", () => {
    const steps = [
      makeStep({ stepId: "s1", etaSeconds: 5 }),
      makeStep({ stepId: "s2", etaSeconds: 10 }),
    ];
    const totals = computeTotals(steps, 100);
    assert.equal(totals.etaSeconds, 15);
  });
});

describe("validatePlanSteps", () => {
  const providers = listProviders({ enabledOnly: true });

  it("accepts a valid single-step plan", () => {
    const llmPlan = {
      interpreted_intent: "register a domain",
      steps: [
        { step_id: "s1", capability: "register_domain", provider_id: "agentos.register_domain", input: { domain_preferences: ["x.io"] } },
      ],
    };
    const result = validatePlanSteps(llmPlan, providers, undefined);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].x402.paymentRail, "x402-solana");
    }
  });

  it("rejects empty steps array", () => {
    const r = validatePlanSteps({ interpreted_intent: "", steps: [] }, providers, undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /no steps/i);
  });

  it("rejects unknown capability", () => {
    const plan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "bogus_capability", provider_id: "agentos.register_domain", input: {} }],
    };
    const r = validatePlanSteps(plan, providers, undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /unknown capability/i);
  });

  it("rejects unknown provider", () => {
    const plan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "register_domain", provider_id: "nope.doesnt.exist", input: {} }],
    };
    const r = validatePlanSteps(plan, providers, undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /unknown provider/i);
  });

  it("rejects provider/capability mismatch", () => {
    const plan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "deploy_vps", provider_id: "agentos.register_domain", input: {} }],
    };
    const r = validatePlanSteps(plan, providers, undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /capability/);
  });

  it("rejects duplicate step IDs", () => {
    const plan = {
      interpreted_intent: "x",
      steps: [
        { step_id: "s1", capability: "register_domain", provider_id: "agentos.register_domain", input: {} },
        { step_id: "s1", capability: "register_domain", provider_id: "agentos.register_domain", input: {} },
      ],
    };
    const r = validatePlanSteps(plan, providers, undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /duplicate step_id/i);
  });

  it("rejects step depending on unknown prior step", () => {
    const plan = {
      interpreted_intent: "x",
      steps: [
        {
          step_id: "s1",
          capability: "register_domain",
          provider_id: "agentos.register_domain",
          input: {},
          depends_on: ["nope"],
        },
      ],
    };
    const r = validatePlanSteps(plan, providers, undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /unknown step/i);
  });

  it("honors excludeCapabilities", () => {
    const plan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "register_domain", provider_id: "agentos.register_domain", input: {} }],
    };
    const r = validatePlanSteps(plan, providers, { excludeCapabilities: ["register_domain"] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /excluded capability/i);
  });

  it("honors excludeProviders", () => {
    const plan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "register_domain", provider_id: "agentos.register_domain", input: {} }],
    };
    const r = validatePlanSteps(plan, providers, { excludeProviders: ["agentos.register_domain"] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /excluded provider/i);
  });

  it("honors requireProviders", () => {
    const plan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "register_domain", provider_id: "agentos.register_domain", input: {} }],
    };
    const r = validatePlanSteps(plan, providers, { requireProviders: ["agentos.deploy_vps"] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /required provider/i);
  });
});

describe("EXPANSION_TEMPLATES", () => {
  it("defines a template for launch_product with the critical Tier B steps", () => {
    const t = EXPANSION_TEMPLATES.launch_product;
    assert.ok(t);
    const caps = new Set(t.steps.map(s => s.capability));
    for (const required of [
      "register_domain",
      "deploy_vps",
      "provision_email_inbox",
      "social_account_provision",
      "social_post",
    ]) {
      assert.ok(caps.has(required), `launch_product missing ${required}`);
    }
  });

  it("only references capabilities that exist in CAPABILITY_CLASSES", () => {
    for (const template of Object.values(EXPANSION_TEMPLATES)) {
      for (const step of template.steps) {
        assert.ok(
          CAPABILITY_CLASSES[step.capability],
          `expansion ${template.capability} references unknown capability ${step.capability}`
        );
      }
    }
  });
});

// -------------------- generatePlan with stubbed LLM --------------------

describe("generatePlan — stubbed LLM", () => {
  beforeEach(() => {
    llm.completeStructured = ORIGINAL_LLM;
    clearI402Dynamic();
  });

  after(() => {
    llm.completeStructured = ORIGINAL_LLM;
  });

  it("returns clarification when router classifies as ambiguous", async () => {
    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: { classification: "ambiguous", reason: "too vague", clarification_questions: ["What region?"] },
      usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan(makeRequest({
      walletAddress: "WALLET_AMB",
      intent: "help me",
    }));
    assert.equal((result as any).status, "clarification_needed");
    assert.equal((result as any).questions.length, 1);
  });

  it("produces a single-step plan for 'direct' classification", async () => {
    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: { classification: "direct", detected_capability: "register_domain", reason: "single" },
      usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan(makeRequest({
      walletAddress: "WALLET_DIRECT",
      intent: "Register example.io",
      params: { domain: "example.io" },
    }));
    assert.ok("planId" in result);
    const plan = result as any;
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].capability, "register_domain");
    assert.equal(plan.status, "approved");
    assert.equal(plan.totals.withinBudget, true);
  });

  it("produces a multi-step plan for 'compound' classification", async () => {
    llm.completeStructured = (async (input: any) => {
      if (input.tool.name === "classify_intent") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { classification: "compound", reason: "launch" },
          usage: { tokensIn: 50, tokensOut: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
        };
      }
      return {
        model: "claude-opus-4-7",
        content: {
          interpreted_intent: "launch brand",
          steps: [
            { step_id: "s1", capability: "register_domain", provider_id: "agentos.register_domain", input: { domain_preferences: ["brand.io"] } },
            { step_id: "s2", capability: "deploy_vps", provider_id: "agentos.deploy_vps", input: { plan: "cx23" }, depends_on: ["s1"] },
          ],
        },
        usage: { tokensIn: 500, tokensOut: 200, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.02 },
      };
    }) as any;

    const result = await generatePlan(makeRequest({
      walletAddress: "WALLET_COMPOUND",
      intent: "launch a brand",
      budgetUsdc: 30,
    }));
    assert.ok("planId" in result);
    const plan = result as any;
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.status, "approved");
    assert.equal(plan.totals.withinBudget, true);
  });

  it("marks status=budget_exceeded when plan total > budget", async () => {
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
          interpreted_intent: "big plan",
          steps: [
            { step_id: "s1", capability: "deploy_vps", provider_id: "agentos.deploy_vps", input: { plan: "cx23" } },
            { step_id: "s2", capability: "register_domain", provider_id: "agentos.register_domain", input: { domain_preferences: ["x.io"] } },
          ],
        },
        usage: { tokensIn: 500, tokensOut: 200, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.02 },
      };
    }) as any;

    const result = await generatePlan(makeRequest({
      walletAddress: "WALLET_OVER",
      intent: "deploy everything",
      budgetUsdc: 5, // insufficient
    }));
    assert.ok("planId" in result);
    const plan = result as any;
    assert.equal(plan.status, "budget_exceeded");
    assert.equal(plan.totals.withinBudget, false);
  });

  it("persists agent + clarification messages in session log", async () => {
    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: { classification: "ambiguous", reason: "vague", clarification_questions: ["be specific"] },
      usage: { tokensIn: 10, tokensOut: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.0001 },
    })) as any;

    const result = await generatePlan(makeRequest({
      walletAddress: "WALLET_LOG",
      intent: "???",
    }));
    assert.equal((result as any).status, "clarification_needed");

    const messages = db
      .prepare(`SELECT role, content FROM i402_session_messages WHERE session_id = ? ORDER BY seq`)
      .all((result as any).sessionId) as Array<{ role: string; content: string }>;
    assert.ok(messages.length >= 2);
    assert.equal(messages[0].role, "agent");
    assert.equal(messages[1].role, "clarification");
  });

  it("every step in a persisted plan has x402-native payment_rail", async () => {
    llm.completeStructured = (async (input: any) => {
      if (input.tool.name === "classify_intent") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { classification: "compound", reason: "multi" },
          usage: { tokensIn: 50, tokensOut: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.0005 },
        };
      }
      return {
        model: "claude-opus-4-7",
        content: {
          interpreted_intent: "domain + vps",
          steps: [
            { step_id: "s1", capability: "register_domain", provider_id: "agentos.register_domain", input: { domain_preferences: ["x.io"] } },
            { step_id: "s2", capability: "deploy_vps", provider_id: "agentos.deploy_vps", input: { plan: "cx23" }, depends_on: ["s1"] },
          ],
        },
        usage: { tokensIn: 500, tokensOut: 200, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.02 },
      };
    }) as any;

    const result = await generatePlan(makeRequest({
      walletAddress: "WALLET_RAIL",
      intent: "domain and vps",
      budgetUsdc: 30,
    }));
    assert.ok("planId" in result);
    const plan = result as any;
    const persisted = getPlan(plan.planId);
    assert.ok(persisted);
    for (const step of persisted!.steps) {
      assert.ok(step.x402.paymentRail === "x402-solana" || step.x402.paymentRail === "x402-base");
    }
  });
});
