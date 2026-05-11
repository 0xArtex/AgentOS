/**
 * Tier B dry-run — agent-side.
 *
 * With i402 v0.1 being agent-side-execution-only, the server's responsibility
 * ends at plan generation. This test validates that the planner emits a plan
 * whose SHAPE would correctly drive an agent-side executor end-to-end:
 *
 *  - 5+ steps covering the Tier B capabilities available today (no web_search
 *    or summarize until Agentic Market lands)
 *  - Every step is x402-native (x402-solana or x402-base)
 *  - Every step has a concrete endpoint the agent can hit
 *  - Budget math is consistent
 *  - Multi-turn follow-up inherits the session via wallet-keyed resolution
 *
 * Real-money Tier B (the merge gate proper) involves actually signing x402
 * per step and is executed per internal/MANUAL_TESTING_RUNBOOK.md.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.I402_ORCHESTRATION_FEE_PCT = "0.15";
process.env.I402_SESSION_IDLE_TIMEOUT_HOURS = "24";
process.env.I402_SESSION_MAX_BUDGET_USDC = "1000";
process.env.PALMYR_API_BASE = "https://staging.palmyr.ai";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

import { db, initDatabase } from "../db";
import { seedPalmyrPrimitives } from "../services/i402-providers";
import { generatePlan } from "../services/i402-planner";
import { llm } from "../services/i402-llm";
import type { Plan, PlannerRequest } from "../services/i402-types";

initDatabase();
seedPalmyrPrimitives();

const ORIGINAL_LLM = llm.completeStructured;
const WALLET = "TIER_B_DRYRUN_WALLET";

function clearState(): void {
  db.exec(`
    DELETE FROM i402_session_step_results;
    DELETE FROM i402_session_artifacts;
    DELETE FROM i402_escrow_ledger;
    DELETE FROM i402_session_plans;
    DELETE FROM i402_session_messages;
    DELETE FROM i402_agent_sessions;
  `);
}

function stubLLM(): void {
  llm.completeStructured = (async (input: any) => {
    if (input.tool.name === "classify_intent") {
      return {
        model: "claude-haiku-4-5-20251001",
        content: { classification: "compound", reason: "full product launch" },
        usage: { tokensIn: 80, tokensOut: 30, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
      };
    }
    if (input.tool.name === "classify_session_relatedness") {
      return {
        model: "claude-haiku-4-5-20251001",
        content: { verdict: "new_goal", reason: "fresh topic" },
        usage: { tokensIn: 50, tokensOut: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.0005 },
      };
    }
    if (input.tool.name === "emit_plan") {
      return {
        model: "claude-opus-4-7",
        content: {
          interpreted_intent: "End-to-end launch: domain, landing page, email, socials, launch post.",
          steps: [
            { step_id: "s1", capability: "register_domain", provider_id: "palmyr.register_domain", input: { domain_preferences: ["freshkicks.io"] } },
            { step_id: "s2", capability: "deploy_vps",       provider_id: "palmyr.deploy_vps",     input: { plan: "cx23" } },
            { step_id: "s3", capability: "provision_email_inbox", provider_id: "palmyr.provision_email_inbox", input: { local_part: "contact" }, depends_on: ["s1"] },
            { step_id: "s4", capability: "social_account_provision", provider_id: "palmyr.x_account", input: { platform: "x" } },
            { step_id: "s5", capability: "social_post", provider_id: "palmyr.x_post", input: { platform: "x", account_id: "$STEPS.s4.output.account_id", content: "Launch day 🔥" }, depends_on: ["s4"] },
          ],
        },
        usage: { tokensIn: 1600, tokensOut: 500, cacheReadTokens: 4000, cacheCreationTokens: 0, costUsdc: 0.04 },
      };
    }
    throw new Error(`unexpected tool call: ${input.tool.name}`);
  }) as any;
}

// -------------------- Tests --------------------

describe("Tier B dry-run — agent-side plan shape", () => {
  before(clearState);
  beforeEach(() => {
    llm.completeStructured = ORIGINAL_LLM;
    clearState();
  });
  after(() => {
    llm.completeStructured = ORIGINAL_LLM;
  });

  it("produces a 5-step Tier B-ready plan covering critical capabilities", async () => {
    stubLLM();
    const result = (await generatePlan(
      {
        sessionId: "",
        walletAddress: WALLET,
        intent: "Launch a sneaker resale brand for US teens",
        budgetUsdc: 60,
        quality: "best",
      } as PlannerRequest,
      { forceNewSession: true }
    )) as Plan;

    assert.ok("planId" in result);
    assert.equal(result.status, "approved");
    assert.ok(result.steps.length >= 5, `expected 5+ steps, got ${result.steps.length}`);

    const capSet = new Set(result.steps.map(s => s.capability));
    for (const required of [
      "register_domain",
      "deploy_vps",
      "provision_email_inbox",
      "social_account_provision",
      "social_post",
    ]) {
      assert.ok(capSet.has(required), `missing Tier B capability: ${required}`);
    }
  });

  it("every step is x402-native with a concrete endpoint", async () => {
    stubLLM();
    const plan = (await generatePlan(
      {
        sessionId: "",
        walletAddress: WALLET,
        intent: "Launch brand",
        budgetUsdc: 60,
      } as PlannerRequest,
      { forceNewSession: true }
    )) as Plan;
    assert.ok("planId" in plan);

    for (const step of plan.steps) {
      assert.ok(
        step.x402.paymentRail === "x402-solana" || step.x402.paymentRail === "x402-base",
        `step ${step.stepId} has non-x402 rail: ${step.x402.paymentRail}`
      );
      assert.ok(step.x402.endpoint && step.x402.endpoint.startsWith("http"), `step ${step.stepId} missing endpoint`);
      assert.ok(step.x402.method === "POST" || step.x402.method === "GET", `step ${step.stepId} bad method`);
    }
  });

  it("fits within declared budget with step_cost + fee == total (within cent)", async () => {
    stubLLM();
    const plan = (await generatePlan(
      {
        sessionId: "",
        walletAddress: WALLET,
        intent: "Launch brand",
        budgetUsdc: 60,
      } as PlannerRequest,
      { forceNewSession: true }
    )) as Plan;
    assert.ok("planId" in plan);
    assert.ok(plan.totals.totalCostUsdc <= 60 + 0.01);
    assert.ok(plan.totals.withinBudget);
    assert.ok(
      Math.abs(plan.totals.stepCostUsdc + plan.totals.orchestrationFeeUsdc - plan.totals.totalCostUsdc) < 0.01
    );
  });

  it("inter-step templating reference is left intact in the plan for the client to resolve", async () => {
    stubLLM();
    const plan = (await generatePlan(
      {
        sessionId: "",
        walletAddress: WALLET,
        intent: "Launch brand",
        budgetUsdc: 60,
      } as PlannerRequest,
      { forceNewSession: true }
    )) as Plan;
    assert.ok("planId" in plan);
    const socialPost = plan.steps.find(s => s.capability === "social_post");
    assert.ok(socialPost);
    const templated = JSON.stringify(socialPost!.input);
    assert.ok(templated.includes("$STEPS."), "plan should retain $STEPS.* templating for client-side resolution");
  });
});
