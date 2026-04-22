/**
 * Unit tests for the i402 planner.
 *
 * Covers:
 *  - computeTotals math (all quality tiers, edge cases, rounding)
 *  - validatePlanSteps (happy path + every failure mode)
 *  - shouldAutoApprove logic (approve flag, auto_approve_under_usdc)
 *  - EXPANSION_TEMPLATES shape validation
 *  - End-to-end generatePlan with a stubbed LLM — direct, compound, ambiguous, budget-exceeded, auto-approve
 *
 * LLM calls are stubbed via the `llm` adapter in i402-llm.ts — no network, no API key required.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Point env at isolated test state BEFORE importing anything that touches the DB
process.env.I402_ORCHESTRATION_FEE_PCT = "0.15";
process.env.I402_SESSION_IDLE_TIMEOUT_HOURS = "24";
process.env.I402_SESSION_MAX_BUDGET_USDC = "1000";
process.env.AGENTOS_API_BASE = "https://staging.agntos.dev";

import { db, initDatabase } from "../db";
import { seedAgentOSPrimitives, listProviders } from "../services/i402-providers";
import {
  computeTotals,
  validatePlanSteps,
  shouldAutoApprove,
  EXPANSION_TEMPLATES,
  generatePlan,
  getPlan,
} from "../services/i402-planner";
import { CAPABILITY_CLASSES } from "../services/i402-providers";
import { createSession } from "../services/i402-session";
import { llm } from "../services/i402-llm";
import type { PlanStep, PlanTotals, PlannerRequest } from "../services/i402-types";

// -------------------- Setup --------------------

initDatabase();
seedAgentOSPrimitives();

function clearI402Tables(): void {
  db.exec(`
    DELETE FROM i402_session_step_results;
    DELETE FROM i402_session_plans;
    DELETE FROM i402_session_messages;
    DELETE FROM i402_session_artifacts;
    DELETE FROM i402_escrow_ledger;
    DELETE FROM i402_agent_sessions;
  `);
}

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    stepId: overrides.stepId ?? "s1",
    capability: overrides.capability ?? "web_search",
    provider: overrides.provider ?? "agentos.web_search",
    input: overrides.input ?? { query: "test" },
    costUsdc: overrides.costUsdc ?? 0.10,
    etaSeconds: overrides.etaSeconds ?? 3,
    dependsOn: overrides.dependsOn,
    description: overrides.description,
    x402: overrides.x402 ?? {
      endpoint: "https://example/endpoint",
      method: "POST",
      paymentRail: "x402-solana",
    },
  };
}

function makeRequest(overrides: Partial<PlannerRequest> = {}): PlannerRequest {
  return {
    sessionId: overrides.sessionId ?? "sess_test",
    walletAddress: overrides.walletAddress ?? "WALLETx",
    intent: overrides.intent ?? "do a thing",
    params: overrides.params,
    budgetUsdc: overrides.budgetUsdc ?? 10,
    deadlineSeconds: overrides.deadlineSeconds,
    quality: overrides.quality ?? "best",
    constraints: overrides.constraints,
    approve: overrides.approve,
    autoApproveUnderUsdc: overrides.autoApproveUnderUsdc,
  };
}

// Snapshot the original adapter so we can restore between test groups
const ORIGINAL_COMPLETE_STRUCTURED = llm.completeStructured;

// -------------------- Pure function tests --------------------

describe("computeTotals", () => {
  it("computes step cost, fee (15%), total, and within_budget correctly", () => {
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

  it("applies minimum fee of $0.01 even on tiny plans", () => {
    const steps = [makeStep({ costUsdc: 0.01 })];
    const totals = computeTotals(steps, 1);
    assert.ok(totals.orchestrationFeeUsdc >= 0.01);
  });

  it("sums ETA across steps", () => {
    const steps = [
      makeStep({ stepId: "s1", etaSeconds: 5 }),
      makeStep({ stepId: "s2", etaSeconds: 10 }),
      makeStep({ stepId: "s3", etaSeconds: 20 }),
    ];
    const totals = computeTotals(steps, 100);
    assert.equal(totals.etaSeconds, 35);
  });

  it("declares hybrid+server_side execution modes by default", () => {
    const totals = computeTotals([makeStep()], 10);
    assert.deepEqual(totals.executionModes.sort(), ["hybrid", "server_side"]);
  });
});

describe("validatePlanSteps", () => {
  const providers = listProviders({ enabledOnly: true });

  it("accepts a valid single-step plan", () => {
    const llmPlan = {
      interpreted_intent: "search for something",
      steps: [{ step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: { query: "test" } }],
    };
    const result = validatePlanSteps(llmPlan, providers, undefined);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].stepId, "s1");
    }
  });

  it("rejects empty steps array", () => {
    const result = validatePlanSteps({ interpreted_intent: "", steps: [] }, providers, undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /no steps/i);
  });

  it("rejects unknown capability", () => {
    const llmPlan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "bogus_capability", provider_id: "agentos.web_search", input: {} }],
    };
    const result = validatePlanSteps(llmPlan, providers, undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /unknown capability/i);
  });

  it("rejects unknown provider", () => {
    const llmPlan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "web_search", provider_id: "nonexistent.provider", input: {} }],
    };
    const result = validatePlanSteps(llmPlan, providers, undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /unknown provider/i);
  });

  it("rejects provider/capability mismatch", () => {
    const llmPlan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "deploy_vps", provider_id: "agentos.web_search", input: {} }],
    };
    const result = validatePlanSteps(llmPlan, providers, undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /capability/);
  });

  it("rejects duplicate step IDs", () => {
    const llmPlan = {
      interpreted_intent: "x",
      steps: [
        { step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: {} },
        { step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: {} },
      ],
    };
    const result = validatePlanSteps(llmPlan, providers, undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /duplicate step_id/i);
  });

  it("rejects step depending on unknown prior step", () => {
    const llmPlan = {
      interpreted_intent: "x",
      steps: [
        { step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: {}, depends_on: ["does_not_exist"] },
      ],
    };
    const result = validatePlanSteps(llmPlan, providers, undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /unknown step/i);
  });

  it("honors excludeCapabilities constraint", () => {
    const llmPlan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: {} }],
    };
    const result = validatePlanSteps(llmPlan, providers, { excludeCapabilities: ["web_search"] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /excluded capability/i);
  });

  it("honors excludeProviders constraint", () => {
    const llmPlan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: {} }],
    };
    const result = validatePlanSteps(llmPlan, providers, { excludeProviders: ["agentos.web_search"] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /excluded provider/i);
  });

  it("honors requireProviders constraint", () => {
    const llmPlan = {
      interpreted_intent: "x",
      steps: [{ step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: {} }],
    };
    const result = validatePlanSteps(llmPlan, providers, { requireProviders: ["agentos.deploy_vps"] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /required provider/i);
  });
});

describe("shouldAutoApprove", () => {
  const totals: PlanTotals = {
    stepCostUsdc: 5,
    orchestrationFeeUsdc: 0.75,
    totalCostUsdc: 5.75,
    withinBudget: true,
    executionModes: ["server_side"],
  };

  it("auto-approves when approve=true", () => {
    assert.equal(shouldAutoApprove(makeRequest({ approve: true }), totals), true);
  });

  it("auto-approves when totalCost <= autoApproveUnderUsdc", () => {
    assert.equal(shouldAutoApprove(makeRequest({ autoApproveUnderUsdc: 10 }), totals), true);
    assert.equal(shouldAutoApprove(makeRequest({ autoApproveUnderUsdc: 5.75 }), totals), true);
  });

  it("does not auto-approve when totalCost > autoApproveUnderUsdc", () => {
    assert.equal(shouldAutoApprove(makeRequest({ autoApproveUnderUsdc: 5 }), totals), false);
  });

  it("requires manual approval by default", () => {
    assert.equal(shouldAutoApprove(makeRequest({}), totals), false);
  });
});

describe("EXPANSION_TEMPLATES", () => {
  it("defines templates for every compound capability", () => {
    const compoundCaps = Object.values(CAPABILITY_CLASSES).filter(c => c.isCompound);
    for (const cap of compoundCaps) {
      assert.ok(
        EXPANSION_TEMPLATES[cap.name],
        `compound capability ${cap.name} has no expansion template`
      );
    }
  });

  it("launch_product expands into the full end-to-end step set", () => {
    const tmpl = EXPANSION_TEMPLATES["launch_product"];
    assert.ok(tmpl);
    const capSet = new Set(tmpl.steps.map(s => s.capability));
    for (const required of [
      "web_search",
      "summarize",
      "register_domain",
      "deploy_vps",
      "provision_email_inbox",
      "social_account_provision",
      "social_post",
    ]) {
      assert.ok(capSet.has(required), `launch_product missing capability ${required}`);
    }
  });
});

// -------------------- generatePlan with stubbed LLM --------------------

describe("generatePlan (stubbed LLM)", () => {
  before(() => {
    clearI402Tables();
  });

  beforeEach(() => {
    // Restore adapter after every test so stubs don't bleed
    llm.completeStructured = ORIGINAL_COMPLETE_STRUCTURED;
    clearI402Tables();
  });

  after(() => {
    llm.completeStructured = ORIGINAL_COMPLETE_STRUCTURED;
  });

  it("returns clarification when router classifies intent as ambiguous", async () => {
    const session = createSession({ walletAddress: "WALLET1", budgetUsdc: 50 });

    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: {
        classification: "ambiguous",
        reason: "goal too abstract",
        clarification_questions: ["What region?", "What budget tier?"],
      },
      usage: { tokensIn: 100, tokensOut: 50, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan(makeRequest({ sessionId: session.id, walletAddress: session.walletAddress, intent: "make me successful" }));

    assert.equal((result as any).status, "clarification_needed");
    const clar = result as any;
    assert.equal(clar.questions.length, 2);
    assert.equal(clar.questions[0].text, "What region?");
  });

  it("produces a single-step plan when router classifies as direct", async () => {
    const session = createSession({ walletAddress: "WALLET2", budgetUsdc: 50 });

    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: {
        classification: "direct",
        reason: "single register_domain call",
        detected_capability: "register_domain",
      },
      usage: { tokensIn: 100, tokensOut: 50, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan(
      makeRequest({
        sessionId: session.id,
        walletAddress: session.walletAddress,
        intent: "register example-sneakerco.io",
        params: { domain_preferences: ["example-sneakerco.io"] },
        budgetUsdc: 50,
      })
    );

    assert.ok("planId" in result);
    const plan = result as any;
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].capability, "register_domain");
    assert.equal(plan.totals.withinBudget, true);
  });

  it("produces a multi-step compound plan when router classifies as compound", async () => {
    const session = createSession({ walletAddress: "WALLET3", budgetUsdc: 60 });

    // Router → "compound", Planner → emit_plan with a valid multi-step plan
    llm.completeStructured = (async (input: any) => {
      if (input.tool.name === "classify_intent") {
        return {
          model: "claude-haiku-4-5-20251001",
          content: { classification: "compound", reason: "full product launch" },
          usage: { tokensIn: 100, tokensOut: 50, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
        };
      }
      return {
        model: "claude-opus-4-7",
        content: {
          interpreted_intent: "launch a sneaker reselling brand end-to-end",
          steps: [
            { step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: { query: "sneaker resale teens" } },
            { step_id: "s2", capability: "register_domain", provider_id: "agentos.register_domain", input: { domain_preferences: ["freshkicks.io"] }, depends_on: ["s1"] },
            { step_id: "s3", capability: "deploy_vps", provider_id: "agentos.deploy_vps", input: { plan: "cx23" }, depends_on: ["s2"] },
          ],
        },
        usage: { tokensIn: 500, tokensOut: 200, cacheReadTokens: 2000, cacheCreationTokens: 0, costUsdc: 0.02 },
      };
    }) as any;

    const result = await generatePlan(
      makeRequest({
        sessionId: session.id,
        walletAddress: session.walletAddress,
        intent: "launch a sneaker reselling brand",
        budgetUsdc: 60,
        autoApproveUnderUsdc: 0, // force manual approval
      })
    );

    assert.ok("planId" in result);
    const plan = result as any;
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.status, "awaiting_approval");
    assert.equal(plan.totals.withinBudget, true);
  });

  it("marks status=budget_exceeded when plan costs more than budget", async () => {
    const session = createSession({ walletAddress: "WALLET4", budgetUsdc: 5 });

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
            { step_id: "s2", capability: "register_domain", provider_id: "agentos.register_domain", input: { domain_preferences: ["a.io"] } },
          ],
        },
        usage: { tokensIn: 500, tokensOut: 200, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.02 },
      };
    }) as any;

    const result = await generatePlan(
      makeRequest({
        sessionId: session.id,
        walletAddress: session.walletAddress,
        intent: "deploy vps and domain",
        budgetUsdc: 5,
      })
    );

    assert.ok("planId" in result);
    const plan = result as any;
    assert.equal(plan.status, "budget_exceeded");
    assert.equal(plan.totals.withinBudget, false);
  });

  it("auto-approves when autoApproveUnderUsdc threshold covers total", async () => {
    const session = createSession({ walletAddress: "WALLET5", budgetUsdc: 50 });

    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: { classification: "direct", reason: "single search", detected_capability: "web_search" },
      usage: { tokensIn: 100, tokensOut: 50, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan(
      makeRequest({
        sessionId: session.id,
        walletAddress: session.walletAddress,
        intent: "search for sneaker trends",
        autoApproveUnderUsdc: 1.0,
        budgetUsdc: 50,
      })
    );

    assert.ok("planId" in result);
    const plan = result as any;
    assert.equal(plan.status, "approved");
    assert.equal(plan.approval, undefined);
  });

  it("persists plan to DB with correct status and retrievable via getPlan", async () => {
    const session = createSession({ walletAddress: "WALLET6", budgetUsdc: 50 });

    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: { classification: "direct", reason: "single search", detected_capability: "web_search" },
      usage: { tokensIn: 100, tokensOut: 50, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
    })) as any;

    const result = await generatePlan(
      makeRequest({
        sessionId: session.id,
        walletAddress: session.walletAddress,
        intent: "search",
        autoApproveUnderUsdc: 1.0,
      })
    );

    assert.ok("planId" in result);
    const plan = result as any;

    const persisted = getPlan(plan.planId);
    assert.ok(persisted, "plan must be persisted");
    assert.equal(persisted!.status, "approved");
    assert.equal(persisted!.sessionId, session.id);
    assert.equal(persisted!.steps.length, 1);
  });

  it("persists agent message in session log", async () => {
    const session = createSession({ walletAddress: "WALLET7", budgetUsdc: 50 });

    llm.completeStructured = (async () => ({
      model: "claude-haiku-4-5-20251001",
      content: { classification: "ambiguous", reason: "vague", clarification_questions: ["be specific"] },
      usage: { tokensIn: 10, tokensOut: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.0001 },
    })) as any;

    await generatePlan(
      makeRequest({
        sessionId: session.id,
        walletAddress: session.walletAddress,
        intent: "???",
      })
    );

    const messages = db
      .prepare(`SELECT role, content FROM i402_session_messages WHERE session_id = ? ORDER BY seq`)
      .all(session.id) as Array<{ role: string; content: string }>;

    assert.equal(messages.length >= 2, true);
    assert.equal(messages[0].role, "agent");
    assert.equal(messages[0].content, "???");
    assert.equal(messages[1].role, "clarification");
  });
});
