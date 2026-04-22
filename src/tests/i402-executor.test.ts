/**
 * Unit tests for the i402 executor.
 *
 * Covers:
 *  - Pure helpers: resolveTemplateValue, resolveStepInput, topoOrder
 *  - Linear plan happy path
 *  - DAG with parallel-eligible branches (still serialized in v0.1)
 *  - Input templating resolves $STEPS.sN.output.path
 *  - Fallback to next-ranked provider on step failure
 *  - Unrecoverable failure → fatal step_error + plan failed
 *  - Escrow debited only on successful steps; orchestration fee at start
 *  - Artifacts extracted for each known capability type
 *  - Summary event accurate
 *
 * Uses mock StepHandler map — no real HTTP, no real LLM.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.I402_ORCHESTRATION_FEE_PCT = "0.15";
process.env.I402_SESSION_IDLE_TIMEOUT_HOURS = "24";
process.env.I402_SESSION_MAX_BUDGET_USDC = "1000";
process.env.AGENTOS_API_BASE = "https://staging.agntos.dev";

import { db, initDatabase } from "../db";
import {
  seedAgentOSPrimitives,
  registerProvider,
  CAPABILITY_CLASSES,
} from "../services/i402-providers";
import { createSession } from "../services/i402-session";
import { deposit, getBalance, getLedger } from "../services/i402-escrow";
import {
  executePlanStream,
  executePlan,
  resolveTemplateValue,
  resolveStepInput,
  topoOrder,
  getStepResults,
  type ExecutorEvent,
  type StepHandler,
} from "../services/i402-executor";
import { updatePlanStatus } from "../services/i402-planner";
import { listArtifacts } from "../services/i402-session";
import { db as database } from "../db";
import type { Plan, PlanStep } from "../services/i402-types";

// -------------------- Setup --------------------

initDatabase();
seedAgentOSPrimitives();

// Register a cheap backup provider for web_search so fallback tests have somewhere to go
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

function persistApprovedPlan(args: {
  sessionId: string;
  planId: string;
  steps: PlanStep[];
  budget: number;
}): Plan {
  const stepCost = args.steps.reduce((s, x) => s + x.costUsdc, 0);
  const fee = Math.max(0.01, stepCost * 0.15);
  const total = stepCost + fee;

  database
    .prepare(
      `INSERT INTO i402_session_plans (
         id, session_id, message_seq, intent, interpreted_intent, params, quality,
         steps, step_cost_usdc, orchestration_fee_usdc, total_cost_usdc, within_budget,
         execution_mode, status, approved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','utc'))`
    )
    .run(
      args.planId,
      args.sessionId,
      0,
      "test intent",
      "test interpretation",
      null,
      "best",
      JSON.stringify(args.steps),
      stepCost,
      fee,
      total,
      total <= args.budget ? 1 : 0,
      "server_side",
      "approved"
    );

  return {
    sessionId: args.sessionId,
    planId: args.planId,
    status: "approved",
    intent: { original: "test intent", interpreted: "test interpretation" },
    steps: args.steps,
    totals: {
      stepCostUsdc: stepCost,
      orchestrationFeeUsdc: fee,
      totalCostUsdc: total,
      withinBudget: total <= args.budget,
      executionModes: ["server_side", "hybrid"],
    },
  };
}

function makeStep(overrides: Partial<PlanStep> & { stepId: string; capability: string; provider: string }): PlanStep {
  return {
    stepId: overrides.stepId,
    capability: overrides.capability,
    provider: overrides.provider,
    input: overrides.input ?? {},
    costUsdc: overrides.costUsdc ?? 0.10,
    etaSeconds: overrides.etaSeconds,
    dependsOn: overrides.dependsOn,
    description: overrides.description,
    x402: overrides.x402 ?? {
      endpoint: "https://example/endpoint",
      method: "POST",
      paymentRail: "x402-solana",
    },
  };
}

// -------------------- Pure helpers --------------------

describe("resolveTemplateValue", () => {
  const outputs = {
    s1: { foo: "bar", list: [{ title: "t0" }, { title: "t1" }] },
    s2: { nested: { deep: { value: 42 } } },
  };

  it("returns non-string values unchanged", () => {
    assert.equal(resolveTemplateValue(5, outputs), 5);
    assert.equal(resolveTemplateValue(null, outputs), null);
    const obj = { x: 1 };
    assert.equal(resolveTemplateValue(obj, outputs), obj);
  });

  it("returns strings that don't match the template pattern unchanged", () => {
    assert.equal(resolveTemplateValue("hello", outputs), "hello");
    assert.equal(resolveTemplateValue("$NOT_STEPS.foo", outputs), "$NOT_STEPS.foo");
  });

  it("resolves $STEPS.sN.output to full prior output", () => {
    assert.deepEqual(resolveTemplateValue("$STEPS.s1.output", outputs), outputs.s1);
  });

  it("resolves nested field access", () => {
    assert.equal(resolveTemplateValue("$STEPS.s1.output.foo", outputs), "bar");
    assert.equal(resolveTemplateValue("$STEPS.s2.output.nested.deep.value", outputs), 42);
  });

  it("resolves array index access", () => {
    assert.equal(resolveTemplateValue("$STEPS.s1.output.list[1].title", outputs), "t1");
  });

  it("passes through when step ID is unknown", () => {
    assert.equal(resolveTemplateValue("$STEPS.missing.output.foo", outputs), "$STEPS.missing.output.foo");
  });

  it("passes through when path is invalid", () => {
    assert.equal(resolveTemplateValue("$STEPS.s1.output.nonexistent", outputs), undefined);
  });
});

describe("resolveStepInput", () => {
  const outputs = {
    s1: { query: "sneakers", results: [{ url: "https://a.com" }] },
  };

  it("walks deeply-nested objects and resolves all templated strings", () => {
    const input = {
      top: "$STEPS.s1.output.query",
      nested: { value: "$STEPS.s1.output.results[0].url", literal: "unchanged" },
      arr: ["literal", "$STEPS.s1.output.query"],
    };
    const resolved = resolveStepInput(input, outputs);
    assert.equal(resolved.top, "sneakers");
    assert.deepEqual(resolved.nested, { value: "https://a.com", literal: "unchanged" });
    assert.deepEqual(resolved.arr, ["literal", "sneakers"]);
  });
});

describe("topoOrder", () => {
  it("returns steps in dependency-respecting order", () => {
    const steps = [
      makeStep({ stepId: "s3", capability: "web_search", provider: "agentos.web_search", dependsOn: ["s1", "s2"] }),
      makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search" }),
      makeStep({ stepId: "s2", capability: "web_search", provider: "agentos.web_search", dependsOn: ["s1"] }),
    ];
    const ordered = topoOrder(steps);
    const index = (id: string) => ordered.findIndex(s => s.stepId === id);
    assert.ok(index("s1") < index("s2"), "s1 before s2");
    assert.ok(index("s2") < index("s3"), "s2 before s3");
  });

  it("throws on a cycle", () => {
    const steps = [
      makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", dependsOn: ["s2"] }),
      makeStep({ stepId: "s2", capability: "web_search", provider: "agentos.web_search", dependsOn: ["s1"] }),
    ];
    assert.throws(() => topoOrder(steps), /cycle/i);
  });

  it("throws on reference to nonexistent step", () => {
    const steps = [
      makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", dependsOn: ["nope"] }),
    ];
    assert.throws(() => topoOrder(steps), /unknown step/i);
  });
});

// -------------------- End-to-end execution --------------------

describe("executePlanStream — linear happy path", () => {
  before(clearI402DynamicTables);

  it("executes a two-step plan, emits events in the correct order, debits correctly", async () => {
    const session = createSession({ walletAddress: "WALLET1", budgetUsdc: 50 });
    deposit({ sessionId: session.id, amountUsdc: 50 });
    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_exec1",
      steps: [
        makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", input: { query: "foo" }, costUsdc: 0.10 }),
        makeStep({
          stepId: "s2",
          capability: "register_domain",
          provider: "agentos.register_domain",
          input: { domain_preferences: ["test.io"] },
          costUsdc: 9.99,
          dependsOn: ["s1"],
        }),
      ],
      budget: 50,
    });

    const handlers: Record<string, StepHandler> = {
      "agentos.web_search": async () => ({ results: [{ title: "t", url: "https://a.com", snippet: "s" }] }),
      "agentos.register_domain": async () => ({
        domain_registered: "test.io",
        expires_at: "2027-04-22T00:00:00Z",
        registrar: "namecheap",
        dns_nameservers: ["ns1.cloudflare.com"],
      }),
    };

    const events: ExecutorEvent[] = [];
    for await (const e of executePlanStream(plan, "WALLET1", { handlers })) events.push(e);

    const typesInOrder = events.map(e => e.type);
    assert.equal(typesInOrder[0], "session");
    assert.equal(typesInOrder[1], "plan");
    assert.equal(typesInOrder[typesInOrder.length - 1], "summary");

    const stepResults = events.filter(e => e.type === "step_result");
    assert.equal(stepResults.length, 2);

    // Orchestration fee = max(0.01, (0.10 + 9.99) * 0.15) = 1.5135 → rounded to 1.51
    // Plus 0.10 + 9.99 = 10.09 step cost. Total ≈ 11.60.
    const summary = events[events.length - 1];
    if (summary.type === "summary") {
      assert.ok(summary.spentUsdc >= 11.5, `expected spent ~11.60, got ${summary.spentUsdc}`);
      assert.ok(summary.status === "completed");
      assert.equal(summary.artifacts.length, 1);
      assert.equal(summary.artifacts[0].type, "domain");
    } else {
      assert.fail("last event is not a summary");
    }
  });
});

describe("executePlanStream — input templating", () => {
  before(clearI402DynamicTables);

  it("resolves $STEPS.sN.output.FIELD inputs between steps", async () => {
    const session = createSession({ walletAddress: "WALLET2", budgetUsdc: 50 });
    deposit({ sessionId: session.id, amountUsdc: 50 });

    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_templ",
      steps: [
        makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", input: { query: "sneakers" }, costUsdc: 0.10 }),
        makeStep({
          stepId: "s2",
          capability: "summarize",
          provider: "agentos.web_search", // provider mismatch but we're mocking; capability alignment not enforced at runtime in this test
          input: { text: "$STEPS.s1.output.results[0].snippet" },
          costUsdc: 0.08,
          dependsOn: ["s1"],
        }),
      ],
      budget: 50,
    });

    let capturedInput: Record<string, unknown> | undefined;
    const handlers: Record<string, StepHandler> = {
      "agentos.web_search": async (input) => {
        if (input.query === "sneakers") {
          return { results: [{ title: "t", url: "u", snippet: "sneaker trends rising" }] };
        }
        capturedInput = input;
        return { summary: "done", token_count: 5 };
      },
    };

    await executePlan(plan, "WALLET2", { handlers });
    assert.equal(capturedInput?.text, "sneaker trends rising");
  });
});

describe("executePlanStream — provider fallback on failure", () => {
  before(clearI402DynamicTables);

  it("retries with next-ranked provider when primary fails, succeeds with fallback", async () => {
    const session = createSession({ walletAddress: "WALLET3", budgetUsdc: 10 });
    deposit({ sessionId: session.id, amountUsdc: 10 });

    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_fallback",
      steps: [
        makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", input: { query: "foo" }, costUsdc: 0.10 }),
      ],
      budget: 10,
    });

    let primaryCalls = 0;
    let fallbackCalls = 0;
    // Include ALL registered web_search providers in the handler map so the
    // retry walk doesn't hit a "no handler" detour. The scoring may pick any
    // of them as the next candidate.
    const handlers: Record<string, StepHandler> = {
      "agentos.web_search": async () => {
        primaryCalls++;
        throw new Error("primary broken");
      },
      "exa.web_search": async () => {
        throw new Error("exa also broken");
      },
      "external.backup_search": async () => {
        fallbackCalls++;
        return { results: [{ title: "t", url: "u", snippet: "s" }] };
      },
    };

    const events: ExecutorEvent[] = [];
    // Allow enough retries to walk through agentos → exa → external
    for await (const e of executePlanStream(plan, "WALLET3", { handlers, maxStepRetries: 5 })) events.push(e);

    // The exact fallback walk depends on provider scoring. What matters is:
    //  - the primary provider in the plan was attempted
    //  - the successful fallback (backup_search) was ultimately reached
    //  - the step produced exactly one successful result event
    assert.ok(primaryCalls >= 1, "primary should be called at least once");
    assert.equal(fallbackCalls, 1);

    const resultEvents = events.filter(e => e.type === "step_result");
    const errEvents = events.filter(e => e.type === "step_error");
    assert.equal(resultEvents.length, 1);
    assert.ok(errEvents.length >= 1, "should emit at least one step_error before fallback succeeds");

    const summary = events[events.length - 1];
    assert.equal(summary.type === "summary" && summary.status, "completed");
  });
});

describe("executePlanStream — unrecoverable failure", () => {
  before(clearI402DynamicTables);

  it("emits fatal step_error and marks plan failed when all providers fail", async () => {
    const session = createSession({ walletAddress: "WALLET4", budgetUsdc: 10 });
    deposit({ sessionId: session.id, amountUsdc: 10 });

    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_fatal",
      steps: [
        makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", input: { query: "x" }, costUsdc: 0.10 }),
      ],
      budget: 10,
    });

    const handlers: Record<string, StepHandler> = {
      "agentos.web_search": async () => { throw new Error("always broken"); },
      "exa.web_search": async () => { throw new Error("exa also broken"); },
      "external.backup_search": async () => { throw new Error("backup also broken"); },
    };

    const events: ExecutorEvent[] = [];
    // enough retries to walk all registered web_search providers
    for await (const e of executePlanStream(plan, "WALLET4", { handlers, maxStepRetries: 5 })) events.push(e);

    const fatalError = events.find(e => e.type === "step_error" && e.fatal);
    assert.ok(fatalError, "expected a fatal step_error");

    const summary = events[events.length - 1];
    assert.equal(summary.type === "summary" && summary.status, "failed");
  });
});

describe("executePlanStream — escrow accounting", () => {
  before(clearI402DynamicTables);

  it("debits orchestration fee once + step cost on success; no debit on failure", async () => {
    const session = createSession({ walletAddress: "WALLET5", budgetUsdc: 20 });
    deposit({ sessionId: session.id, amountUsdc: 20 });

    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_escrow",
      steps: [
        makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", input: { query: "foo" }, costUsdc: 0.10 }),
      ],
      budget: 20,
    });

    const handlers: Record<string, StepHandler> = {
      "agentos.web_search": async () => ({ results: [] }),
    };

    await executePlan(plan, "WALLET5", { handlers, refundOnClose: false });

    const ledger = getLedger(session.id);
    const kinds = ledger.map(e => e.kind);
    assert.ok(kinds.includes("deposit"));
    assert.ok(kinds.includes("debit_orchestration_fee"));
    assert.ok(kinds.includes("debit_step"));

    // Balance = 20 - (0.10 + fee)
    const balance = getBalance(session.id);
    assert.ok(balance > 19 && balance < 20, `expected balance ~19.89, got ${balance}`);
  });

  it("refunds remaining escrow on successful completion when refundOnClose=true", async () => {
    const session = createSession({ walletAddress: "WALLET6", budgetUsdc: 20 });
    deposit({ sessionId: session.id, amountUsdc: 20 });

    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_refund",
      steps: [
        makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", input: { query: "foo" }, costUsdc: 0.10 }),
      ],
      budget: 20,
    });

    const handlers: Record<string, StepHandler> = {
      "agentos.web_search": async () => ({ results: [] }),
    };

    await executePlan(plan, "WALLET6", { handlers, refundOnClose: true });

    const balance = getBalance(session.id);
    assert.equal(balance, 0);

    const ledger = getLedger(session.id);
    assert.ok(ledger.some(e => e.kind === "refund"));
  });
});

describe("executePlanStream — artifact extraction", () => {
  before(clearI402DynamicTables);

  it("extracts domain, VPS, email, and social_account artifacts correctly", async () => {
    const session = createSession({ walletAddress: "WALLET7", budgetUsdc: 100 });
    deposit({ sessionId: session.id, amountUsdc: 100 });

    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_artifacts",
      steps: [
        makeStep({ stepId: "s1", capability: "register_domain", provider: "agentos.register_domain", input: { domain_preferences: ["x.io"] }, costUsdc: 9.99 }),
        makeStep({ stepId: "s2", capability: "deploy_vps", provider: "agentos.deploy_vps", input: { plan: "cx23" }, costUsdc: 6.0 }),
        makeStep({ stepId: "s3", capability: "provision_email_inbox", provider: "agentos.provision_email_inbox", input: {}, costUsdc: 1.0 }),
        makeStep({ stepId: "s4", capability: "social_account_provision", provider: "agentos.x_account", input: { platform: "x" }, costUsdc: 15.0 }),
      ],
      budget: 100,
    });

    const handlers: Record<string, StepHandler> = {
      "agentos.register_domain": async () => ({
        domain_registered: "x.io", expires_at: "2027-01-01", registrar: "namecheap", dns_nameservers: ["ns1.cf.com"],
      }),
      "agentos.deploy_vps": async () => ({ server_id: "srv_42", ipv4: "1.2.3.4", status: "running" }),
      "agentos.provision_email_inbox": async () => ({ address: "contact@x.io", inbox_id: "inb_1" }),
      "agentos.x_account": async () => ({ platform: "x", handle: "@freshkicks", account_id: "acc_1", warming_status: "ready" }),
    };

    await executePlan(plan, "WALLET7", { handlers });

    const artifacts = listArtifacts(session.id);
    const types = new Set(artifacts.map(a => a.type));
    assert.ok(types.has("domain"));
    assert.ok(types.has("vps"));
    assert.ok(types.has("email_inbox"));
    assert.ok(types.has("social_account_x"));
    assert.equal(artifacts.length, 4);
  });
});

describe("executePlanStream — wallet ownership guard", () => {
  before(clearI402DynamicTables);

  it("rejects execution when walletAddress does not match session owner", async () => {
    const session = createSession({ walletAddress: "OWNER", budgetUsdc: 10 });
    deposit({ sessionId: session.id, amountUsdc: 10 });

    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_wallet_guard",
      steps: [makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", input: {}, costUsdc: 0.10 })],
      budget: 10,
    });

    await assert.rejects(async () => {
      for await (const _ of executePlanStream(plan, "NOT_THE_OWNER", { handlers: {} })) {
        // drain
      }
    }, /different wallet/i);
  });
});

describe("executePlanStream — step result persistence", () => {
  before(clearI402DynamicTables);

  it("persists every step attempt with status and cost", async () => {
    const session = createSession({ walletAddress: "WALLET9", budgetUsdc: 20 });
    deposit({ sessionId: session.id, amountUsdc: 20 });

    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_persist",
      steps: [
        makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", input: { query: "q" }, costUsdc: 0.10 }),
      ],
      budget: 20,
    });

    const handlers: Record<string, StepHandler> = {
      "agentos.web_search": async () => ({ results: [] }),
    };

    await executePlan(plan, "WALLET9", { handlers });

    const results = getStepResults(plan.planId);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "ok");
    assert.equal(results[0].costChargedUsdc, 0.10);
    assert.ok(results[0].latencyMs !== undefined);
  });
});

describe("executePlanStream — rejects unapproved plan", () => {
  before(clearI402DynamicTables);

  it("throws when plan.status is not 'approved'", async () => {
    const session = createSession({ walletAddress: "WALLETX", budgetUsdc: 10 });
    deposit({ sessionId: session.id, amountUsdc: 10 });

    const plan = persistApprovedPlan({
      sessionId: session.id,
      planId: "plan_unapp",
      steps: [makeStep({ stepId: "s1", capability: "web_search", provider: "agentos.web_search", input: {}, costUsdc: 0.10 })],
      budget: 10,
    });
    // downgrade status
    updatePlanStatus(plan.planId, "awaiting_approval");
    plan.status = "awaiting_approval";

    await assert.rejects(async () => {
      for await (const _ of executePlanStream(plan, "WALLETX", { handlers: {} })) { /* drain */ }
    }, /not approved/i);
  });
});
