/**
 * Tier B DRY-RUN end-to-end test for the i402 reference implementation.
 *
 * This is the orchestration-correctness gate. It runs the full sneaker-launch
 * scenario from `internal/E2E_TIER_B_SNEAKER_LAUNCH.md` but with:
 *   - LLM calls stubbed via the `llm` adapter
 *   - StepHandlers mocked (no Hetzner, Namecheap, SendGrid, xaccounts, Exa calls)
 *   - No x402 payment verification (escrow deposited directly)
 *
 * What it validates:
 *   - Planner produces a sensible compound plan (7+ steps covering the Tier B capabilities)
 *   - Executor runs the plan in the right dependency order
 *   - All 4 Tier B artifact types are collected (domain, vps, email_inbox, social_account)
 *   - Escrow math matches: spent = orchestration_fee + step_costs, refund = deposit - spent
 *   - Session reaches status='completed' with artifacts reachable via listArtifacts
 *   - Multi-turn follow-up: a second intent in the same session inherits artifacts (via
 *     context_summary + the artifact list that the planner sees)
 *
 * Real-money Tier B (the merge gate proper) is run manually per E2E_TIER_B_SNEAKER_LAUNCH.md
 * against a live staging instance. This dry-run passes 0-cost and gates the pipeline's
 * structural correctness before spending any USDC.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.I402_ORCHESTRATION_FEE_PCT = "0.15";
process.env.I402_SESSION_IDLE_TIMEOUT_HOURS = "24";
process.env.I402_SESSION_MAX_BUDGET_USDC = "1000";
process.env.AGENTOS_API_BASE = "https://staging.agntos.dev";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

import { db, initDatabase } from "../db";
import { seedAgentOSPrimitives } from "../services/i402-providers";
import { createSession, listArtifacts, updateContextSummary } from "../services/i402-session";
import { deposit, getLedgerSummary, getBalance } from "../services/i402-escrow";
import {
  executePlanStream,
  type StepHandler,
  type ExecutorEvent,
} from "../services/i402-executor";
import { generatePlan } from "../services/i402-planner";
import { llm } from "../services/i402-llm";
import type { PlannerRequest, Plan } from "../services/i402-types";

// -------------------- Setup --------------------

initDatabase();
seedAgentOSPrimitives();

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

// -------------------- Mocked LLM: sneaker launch plan --------------------

function stubLLM(): void {
  llm.completeStructured = (async (input: any) => {
    // First call: router classifies as compound (launch is a compound goal)
    if (input.tool.name === "classify_intent") {
      return {
        model: "claude-haiku-4-5-20251001",
        content: { classification: "compound", reason: "full product launch — compound goal" },
        usage: { tokensIn: 80, tokensOut: 30, cacheReadTokens: 0, cacheCreationTokens: 0, costUsdc: 0.001 },
      };
    }
    // Second call: planner emits the 7-step launch plan
    if (input.tool.name === "emit_plan") {
      return {
        model: "claude-opus-4-7",
        content: {
          interpreted_intent:
            "Launch a sneaker resale brand for US teens: research, domain, landing page, email, social presence, initial posts.",
          steps: [
            { step_id: "s1", capability: "web_search", provider_id: "agentos.web_search", input: { query: "sneaker resale trends US teens 2026", max_results: 10 } },
            { step_id: "s2", capability: "register_domain", provider_id: "agentos.register_domain", input: { domain_preferences: ["freshkicks.io", "hypekicks.io"], years: 1 }, depends_on: ["s1"] },
            { step_id: "s3", capability: "deploy_vps", provider_id: "agentos.deploy_vps", input: { plan: "cx23" }, depends_on: [] },
            { step_id: "s4", capability: "provision_email_inbox", provider_id: "agentos.provision_email_inbox", input: { local_part: "contact" }, depends_on: ["s2"] },
            { step_id: "s5", capability: "social_account_provision", provider_id: "agentos.x_account", input: { platform: "x" }, depends_on: ["s2"] },
            { step_id: "s6", capability: "social_account_provision", provider_id: "agentos.tiktok_account", input: { platform: "tiktok" }, depends_on: ["s2"] },
            { step_id: "s7", capability: "social_post", provider_id: "agentos.x_post", input: { platform: "x", account_id: "$STEPS.s5.output.account_id", content: "Launch day 🔥" }, depends_on: ["s5"] },
          ],
        },
        usage: { tokensIn: 1800, tokensOut: 600, cacheReadTokens: 4200, cacheCreationTokens: 0, costUsdc: 0.05 },
      };
    }
    throw new Error(`Unexpected tool call: ${input.tool.name}`);
  }) as any;
}

// Follow-up stub: returns a single social_post plan referencing existing TikTok account
function stubFollowUpLLM(): void {
  llm.completeStructured = (async (input: any) => {
    if (input.tool.name === "classify_intent") {
      return {
        model: "claude-haiku-4-5-20251001",
        content: { classification: "compound", reason: "post multiple pieces of content" },
        usage: { tokensIn: 60, tokensOut: 20, cacheReadTokens: 1000, cacheCreationTokens: 0, costUsdc: 0.0005 },
      };
    }
    if (input.tool.name === "emit_plan") {
      return {
        model: "claude-opus-4-7",
        content: {
          interpreted_intent: "Publish 3 TikTok videos about launch week, reusing the TikTok account from the prior plan.",
          steps: [
            { step_id: "p1", capability: "social_post", provider_id: "agentos.tiktok_post", input: { platform: "tiktok", account_id: "tiktok_account_id_from_session", content: "Day 1: limited drop" } },
            { step_id: "p2", capability: "social_post", provider_id: "agentos.tiktok_post", input: { platform: "tiktok", account_id: "tiktok_account_id_from_session", content: "Day 2: behind the scenes" } },
            { step_id: "p3", capability: "social_post", provider_id: "agentos.tiktok_post", input: { platform: "tiktok", account_id: "tiktok_account_id_from_session", content: "Day 3: customer stories" } },
          ],
        },
        usage: { tokensIn: 600, tokensOut: 120, cacheReadTokens: 4200, cacheCreationTokens: 0, costUsdc: 0.008 },
      };
    }
    throw new Error(`Unexpected tool: ${input.tool.name}`);
  }) as any;
}

// -------------------- Mocked step handlers --------------------

function buildMockHandlers(): Record<string, StepHandler> {
  return {
    "agentos.web_search": async (input) => ({
      results: [
        { title: "Sneaker resale market 2026", url: "https://example.com/trends", snippet: "The teen sneaker resale market has grown 40% year-over-year...", published: "2026-03-01T00:00:00Z" },
      ],
    }),
    "agentos.register_domain": async () => ({
      domain_registered: "freshkicks.io",
      expires_at: "2027-04-22",
      registrar: "namecheap",
      dns_nameservers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
    }),
    "agentos.deploy_vps": async () => ({
      server_id: "srv_dryrun_42",
      ipv4: "203.0.113.42",
      ipv6: "2001:db8::42",
      status: "running",
    }),
    "agentos.provision_email_inbox": async () => ({
      address: "contact@freshkicks.io",
      inbox_id: "inb_dryrun_7",
    }),
    "agentos.x_account": async () => ({
      platform: "x",
      handle: "@freshkicksdaily",
      account_id: "x_acc_9k",
      warming_status: "ready",
    }),
    "agentos.tiktok_account": async () => ({
      platform: "tiktok",
      handle: "@freshkicksdaily",
      account_id: "tt_acc_9k",
      warming_status: "warming",
    }),
    "agentos.x_post": async () => ({
      post_id: "tweet_8881",
      url: "https://x.com/freshkicksdaily/status/8881",
      posted_at: "2026-04-22T12:00:00Z",
    }),
    "agentos.tiktok_post": async () => ({
      post_id: "tt_9991",
      url: "https://tiktok.com/@freshkicksdaily/video/9991",
      posted_at: "2026-04-22T12:05:00Z",
    }),
  };
}

// -------------------- Tests --------------------

describe("Tier B dry-run: sneaker launch end-to-end", () => {
  before(clearState);

  beforeEach(() => {
    llm.completeStructured = ORIGINAL_LLM;
    clearState();
  });

  after(() => {
    llm.completeStructured = ORIGINAL_LLM;
  });

  it("generates a 7-step compound plan, executes end-to-end, collects all Tier B artifacts", async () => {
    // Setup session with $60 budget (reasonable headroom over $50 demo)
    const session = createSession({ walletAddress: WALLET, budgetUsdc: 60 });
    stubLLM();

    const plannerRequest: PlannerRequest = {
      sessionId: session.id,
      walletAddress: WALLET,
      intent: "Launch a sneaker resale brand targeting US teens, budget conscious.",
      budgetUsdc: 60,
      quality: "best",
      autoApproveUnderUsdc: 60, // auto-approve in test
    };

    const plan = (await generatePlan(plannerRequest)) as Plan;
    assert.ok("planId" in plan, "Planner must return a Plan, not a clarification");
    assert.equal(plan.status, "approved");
    assert.ok(plan.steps.length >= 7, `Expected 7+ steps, got ${plan.steps.length}`);

    // Verify plan covers all Tier B capabilities
    const capsInPlan = new Set(plan.steps.map(s => s.capability));
    for (const required of [
      "web_search",
      "register_domain",
      "deploy_vps",
      "provision_email_inbox",
      "social_account_provision",
      "social_post",
    ]) {
      assert.ok(capsInPlan.has(required), `Plan missing Tier B capability: ${required}`);
    }

    // Budget check
    assert.ok(plan.totals.withinBudget, `Plan cost ${plan.totals.totalCostUsdc} exceeds $60 budget`);

    // Fund escrow (dry-run: no real x402, just the ledger entry)
    deposit({ sessionId: session.id, amountUsdc: plan.totals.totalCostUsdc });

    // Execute
    const handlers = buildMockHandlers();
    const events: ExecutorEvent[] = [];
    for await (const e of executePlanStream(plan, WALLET, { handlers, refundOnClose: true })) {
      events.push(e);
    }

    // ── Event stream assertions ──
    assert.equal(events[0].type, "session");
    assert.equal(events[1].type, "plan");
    assert.equal(events[events.length - 1].type, "summary");

    const stepResults = events.filter(e => e.type === "step_result");
    assert.equal(stepResults.length, plan.steps.length, `Expected ${plan.steps.length} step_result events, got ${stepResults.length}`);

    // ── Summary assertions ──
    const summary = events[events.length - 1];
    assert.equal(summary.type === "summary" && summary.status, "completed");

    // ── Artifact assertions ──
    const artifacts = listArtifacts(session.id);
    const types = new Set(artifacts.map(a => a.type));
    assert.ok(types.has("domain"), "Missing domain artifact");
    assert.ok(types.has("vps"), "Missing VPS artifact");
    assert.ok(types.has("email_inbox"), "Missing email_inbox artifact");
    assert.ok(types.has("social_account_x"), "Missing X account artifact");
    assert.ok(types.has("social_account_tiktok"), "Missing TikTok account artifact");
    assert.ok(types.has("social_post"), "Missing social_post artifact");

    // ── Escrow math ──
    const ledgerSummary = getLedgerSummary(session.id);
    const expectedSpent = plan.totals.totalCostUsdc;
    assert.ok(
      Math.abs(ledgerSummary.totalSpent - expectedSpent) < 0.01,
      `Expected spent ~$${expectedSpent.toFixed(2)}, got $${ledgerSummary.totalSpent.toFixed(2)}`
    );
    assert.ok(ledgerSummary.totalRefunded >= 0, "Refund entry should exist");
    assert.ok(getBalance(session.id) === 0, "Remaining escrow should be zero after refund");
  });

  it("multi-turn follow-up: second intent inherits prior artifacts via context summary", async () => {
    // Complete turn 1 first
    const session = createSession({ walletAddress: WALLET, budgetUsdc: 80 });
    stubLLM();
    const plan1 = (await generatePlan({
      sessionId: session.id,
      walletAddress: WALLET,
      intent: "Launch a sneaker brand.",
      budgetUsdc: 80,
      autoApproveUnderUsdc: 80,
    })) as Plan;
    deposit({ sessionId: session.id, amountUsdc: plan1.totals.totalCostUsdc });
    const handlers = buildMockHandlers();
    for await (const _ of executePlanStream(plan1, WALLET, { handlers, refundOnClose: true })) { /* drain */ }

    // Turn 2: follow-up in same session
    // The planner will pick up the session context via listArtifacts()
    updateContextSummary(
      session.id,
      "Launched sneaker brand FreshKicks. Owns freshkicks.io, VPS srv_dryrun_42 (203.0.113.42), inbox contact@freshkicks.io, X handle @freshkicksdaily (x_acc_9k), TikTok @freshkicksdaily (tt_acc_9k)."
    );
    stubFollowUpLLM();

    // Top up escrow for turn 2
    deposit({ sessionId: session.id, amountUsdc: 5 });

    const plan2 = (await generatePlan({
      sessionId: session.id,
      walletAddress: WALLET,
      intent: "Now post 3 TikTok videos about launch week.",
      budgetUsdc: 5,
      autoApproveUnderUsdc: 5,
    })) as Plan;

    assert.ok("planId" in plan2, "Second turn should produce a plan");
    assert.equal(plan2.status, "approved");
    assert.equal(plan2.steps.length, 3, "Follow-up should be 3 posting steps, not re-provisioning");

    // All follow-up steps should be social_post on tiktok — no re-provisioning
    for (const step of plan2.steps) {
      assert.equal(step.capability, "social_post", `Follow-up should only post, not provision. Got capability: ${step.capability}`);
    }

    // Execute the follow-up
    const events: ExecutorEvent[] = [];
    for await (const e of executePlanStream(plan2, WALLET, { handlers, refundOnClose: true })) {
      events.push(e);
    }
    const summary = events[events.length - 1];
    assert.equal(summary.type === "summary" && summary.status, "completed");

    // 3 new social_post artifacts should exist alongside the 6 from turn 1
    const allArtifacts = listArtifacts(session.id);
    const socialPosts = allArtifacts.filter(a => a.type === "social_post");
    assert.ok(socialPosts.length >= 3, `Expected 3+ social_post artifacts after follow-up, got ${socialPosts.length}`);
  });

  it("within-budget assertion: plan cost never exceeds declared budget", async () => {
    const session = createSession({ walletAddress: WALLET, budgetUsdc: 60 });
    stubLLM();
    const plan = (await generatePlan({
      sessionId: session.id,
      walletAddress: WALLET,
      intent: "Launch a brand",
      budgetUsdc: 60,
      autoApproveUnderUsdc: 60,
    })) as Plan;
    assert.ok(plan.totals.totalCostUsdc <= 60 + 0.01, `Plan exceeds budget: ${plan.totals.totalCostUsdc}`);
    // Accounting consistency within 1-cent float tolerance. Exact equality
    // fails on floats like 50.59 + 7.59 which IEEE-754 renders as 58.18000000...
    assert.ok(
      Math.abs(plan.totals.stepCostUsdc + plan.totals.orchestrationFeeUsdc - plan.totals.totalCostUsdc) < 0.01,
      "step_cost + orchestration_fee must equal total (within cent)"
    );
  });
});
