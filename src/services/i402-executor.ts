import crypto from "crypto";
import { db } from "../db";
import { getSession, addArtifact, updateSessionStatus, appendMessage } from "./i402-session";
import { getProvider, scoreProviders, updateProviderMetrics } from "./i402-providers";
import { debitStep, debitOrchestrationFee, refund, getLedgerSummary } from "./i402-escrow";
import { getPlan, updatePlanStatus } from "./i402-planner";
import type {
  Plan,
  PlanStep,
  StepResult,
  StepStatus,
  I402Artifact,
} from "./i402-types";

// -------------------- Event stream types (spec §7.3) --------------------

export type ExecutorEvent =
  | { type: "session"; sessionId: string }
  | {
      type: "plan";
      planId: string;
      steps: Array<{ stepId: string; provider: string; capability: string; costUsdc: number }>;
      totalCostUsdc: number;
    }
  | { type: "step_start"; stepId: string; provider: string; capability: string; costUsdc: number }
  | {
      type: "step_result";
      stepId: string;
      provider: string;
      output: Record<string, unknown>;
      latencyMs: number;
      costChargedUsdc: number;
    }
  | {
      type: "step_error";
      stepId: string;
      provider: string;
      error: string;
      retryWith?: string;
      fatal: boolean;
    }
  | { type: "clarification_needed"; questions: Array<{ id: string; text: string }> }
  | {
      type: "summary";
      spentUsdc: number;
      remainingEscrowUsdc: number;
      artifacts: I402Artifact[];
      status: "completed" | "failed" | "cancelled" | "budget_exhausted";
    };

// -------------------- Step handler contract --------------------

export interface StepExecutionContext {
  sessionId: string;
  planId: string;
  stepId: string;
  walletAddress: string;
  priorOutputs: Record<string, Record<string, unknown>>;
}

/**
 * A StepHandler executes one step against a provider and returns the output.
 * It MUST:
 *   - Throw on failure (any error → step fails)
 *   - Return an object matching the provider's output_schema
 * It MUST NOT debit escrow, emit events, or touch session state — those are the executor's job.
 */
export type StepHandler = (
  input: Record<string, unknown>,
  ctx: StepExecutionContext
) => Promise<Record<string, unknown>>;

// -------------------- Input templating --------------------

const STEP_REF_PATTERN = /^\$STEPS\.([a-zA-Z0-9_]+)\.output(?:\.(.+))?$/;

/**
 * Resolve a single templated string against prior step outputs.
 * `$STEPS.s1.output.results[0].title` → prior s1 output.results[0].title
 * `$STEPS.s1.output` → entire s1 output
 * Unresolvable references return the original string unchanged (caller may decide to error).
 */
export function resolveTemplateValue(
  value: unknown,
  priorOutputs: Record<string, Record<string, unknown>>
): unknown {
  if (typeof value !== "string") return value;
  const match = value.match(STEP_REF_PATTERN);
  if (!match) return value;
  const [, stepId, path] = match;
  const stepOutput = priorOutputs[stepId];
  if (!stepOutput) return value; // cannot resolve; pass through
  if (!path) return stepOutput;

  // Walk the path — supports dot notation and [n] array indices
  const segments = path.split(/\.|\[(\d+)\]/).filter(s => s !== undefined && s !== "");
  let cursor: unknown = stepOutput;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return value;
    if (/^\d+$/.test(seg) && Array.isArray(cursor)) {
      cursor = cursor[parseInt(seg, 10)];
    } else if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return value;
    }
  }
  return cursor;
}

/**
 * Deeply walk an input object and resolve $STEPS templating on every string leaf.
 */
export function resolveStepInput(
  input: Record<string, unknown>,
  priorOutputs: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  return walk(input, priorOutputs) as Record<string, unknown>;
}

function walk(node: unknown, priorOutputs: Record<string, Record<string, unknown>>): unknown {
  if (node === null || node === undefined) return node;
  if (typeof node === "string") return resolveTemplateValue(node, priorOutputs);
  if (Array.isArray(node)) return node.map(n => walk(n, priorOutputs));
  if (typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walk(v, priorOutputs);
    }
    return out;
  }
  return node;
}

// -------------------- Topological ordering --------------------

/**
 * Return steps in a topologically-valid execution order.
 * Steps with no depends_on are ready first; later groups execute after their deps complete.
 * Throws on cycles or references to nonexistent steps.
 */
export function topoOrder(steps: PlanStep[]): PlanStep[] {
  const byId = new Map(steps.map(s => [s.stepId, s]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const s of steps) {
    indegree.set(s.stepId, (s.dependsOn ?? []).length);
    for (const dep of s.dependsOn ?? []) {
      if (!byId.has(dep)) throw new Error(`Step ${s.stepId} depends on unknown step ${dep}`);
      if (!outgoing.has(dep)) outgoing.set(dep, []);
      outgoing.get(dep)!.push(s.stepId);
    }
    if (!outgoing.has(s.stepId)) outgoing.set(s.stepId, []);
  }

  const order: PlanStep[] = [];
  const ready: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) ready.push(id);

  while (ready.length > 0) {
    const id = ready.shift()!;
    const step = byId.get(id);
    if (step) order.push(step);
    for (const dependent of outgoing.get(id) ?? []) {
      const newDeg = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, newDeg);
      if (newDeg === 0) ready.push(dependent);
    }
  }

  if (order.length !== steps.length) {
    throw new Error("Cycle detected in plan dependencies");
  }
  return order;
}

// -------------------- Step result persistence --------------------

function writeStepResult(input: {
  planId: string;
  stepId: string;
  sessionId: string;
  capability: string;
  providerId: string;
  stepInput?: Record<string, unknown>;
  output?: Record<string, unknown>;
  status: StepStatus;
  latencyMs?: number;
  costChargedUsdc: number;
  retryCount: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO i402_session_step_results (
       plan_id, step_id, session_id, capability, provider_id,
       input, output, status, latency_ms, cost_charged_usdc, retry_count,
       x402_tx_signature, error, started_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  ).run(
    input.planId,
    input.stepId,
    input.sessionId,
    input.capability,
    input.providerId,
    input.stepInput ? JSON.stringify(input.stepInput) : null,
    input.output ? JSON.stringify(input.output) : null,
    input.status,
    input.latencyMs ?? null,
    input.costChargedUsdc,
    input.retryCount,
    input.error ?? null,
    input.startedAt ?? null,
    input.completedAt ?? null
  );
}

// -------------------- Artifact extraction --------------------

/**
 * Extract well-known artifact shapes from step outputs. AgentOS's compound demos
 * rely on these being present — domain, VPS, email inbox, social account.
 */
function extractArtifacts(step: PlanStep, output: Record<string, unknown>): Array<{ type: string; name?: string; resourceRef: string; metadata?: Record<string, unknown> }> {
  const artifacts: Array<{ type: string; name?: string; resourceRef: string; metadata?: Record<string, unknown> }> = [];

  switch (step.capability) {
    case "register_domain": {
      const domain = output.domain_registered as string | undefined;
      if (domain) {
        artifacts.push({
          type: "domain",
          name: domain,
          resourceRef: domain,
          metadata: {
            expires_at: output.expires_at,
            registrar: output.registrar,
            dns_nameservers: output.dns_nameservers,
          },
        });
      }
      break;
    }
    case "deploy_vps": {
      const serverId = output.server_id as string | undefined;
      if (serverId) {
        artifacts.push({
          type: "vps",
          name: serverId,
          resourceRef: serverId,
          metadata: { ipv4: output.ipv4, ipv6: output.ipv6, status: output.status },
        });
      }
      break;
    }
    case "provision_email_inbox": {
      const address = output.address as string | undefined;
      if (address) {
        artifacts.push({
          type: "email_inbox",
          name: address,
          resourceRef: (output.inbox_id as string) ?? address,
          metadata: { address },
        });
      }
      break;
    }
    case "provision_phone": {
      const phone = output.phone_number as string | undefined;
      if (phone) {
        artifacts.push({
          type: "phone",
          name: phone,
          resourceRef: phone,
          metadata: { country: output.country, capabilities: output.capabilities },
        });
      }
      break;
    }
    case "social_account_provision": {
      const handle = output.handle as string | undefined;
      const platform = output.platform as string | undefined;
      if (handle && platform) {
        artifacts.push({
          type: `social_account_${platform}`,
          name: handle,
          resourceRef: (output.account_id as string) ?? handle,
          metadata: { platform, warming_status: output.warming_status },
        });
      }
      break;
    }
    case "social_post": {
      const postId = output.post_id as string | undefined;
      if (postId) {
        artifacts.push({
          type: "social_post",
          name: postId,
          resourceRef: (output.url as string) ?? postId,
          metadata: { posted_at: output.posted_at },
        });
      }
      break;
    }
  }

  return artifacts;
}

// -------------------- Fallback provider selection --------------------

function nextFallbackProvider(capability: string, excludeIds: Set<string>, quality: "fast" | "cheap" | "best" = "best"): string | null {
  const ranked = scoreProviders(capability, quality);
  for (const p of ranked) {
    if (!excludeIds.has(p.id)) return p.id;
  }
  return null;
}

// -------------------- Executor entry (async generator) --------------------

export interface ExecutorOptions {
  /** providerId → handler. Required for every provider referenced in the plan. */
  handlers: Record<string, StepHandler>;
  /** Set to true to charge the orchestration fee at the start of execution. */
  chargeOrchestrationFee?: boolean;
  /** Max retries per step (across alternate providers). Default 2. */
  maxStepRetries?: number;
  /** Per-step timeout in ms. Default 120000 (2 min). */
  stepTimeoutMs?: number;
  /** If true, refund remaining escrow on completion/cancellation. Default true. */
  refundOnClose?: boolean;
}

/**
 * Execute an approved plan server-side. Yields spec-compliant events as execution proceeds.
 *
 * Event order is guaranteed:
 *   session → plan → (step_start, step_result | step_error)+ → summary
 *
 * Steps with no interdependencies still execute sequentially in v0.1. Parallel execution
 * within a dependency level is a v0.2 optimization (spec permits either).
 */
export async function* executePlanStream(
  plan: Plan,
  walletAddress: string,
  opts: ExecutorOptions
): AsyncGenerator<ExecutorEvent, void, undefined> {
  const session = getSession(plan.sessionId);
  if (!session) throw new Error(`Session ${plan.sessionId} not found`);
  if (session.walletAddress !== walletAddress) {
    throw new Error(`Session ${plan.sessionId} belongs to a different wallet`);
  }
  if (plan.status !== "approved") {
    throw new Error(`Plan ${plan.planId} is not approved (status=${plan.status})`);
  }

  const maxRetries = opts.maxStepRetries ?? 2;
  const stepTimeoutMs = opts.stepTimeoutMs ?? 120_000;
  const refundOnClose = opts.refundOnClose !== false;

  // Mark plan executing
  updatePlanStatus(plan.planId, "executing");

  yield { type: "session", sessionId: plan.sessionId };
  yield {
    type: "plan",
    planId: plan.planId,
    steps: plan.steps.map(s => ({ stepId: s.stepId, provider: s.provider, capability: s.capability, costUsdc: s.costUsdc })),
    totalCostUsdc: plan.totals.totalCostUsdc,
  };

  // Orchestration fee
  if (opts.chargeOrchestrationFee !== false && plan.totals.orchestrationFeeUsdc > 0) {
    try {
      debitOrchestrationFee({
        sessionId: plan.sessionId,
        planId: plan.planId,
        amountUsdc: plan.totals.orchestrationFeeUsdc,
        notes: `Orchestration fee for plan ${plan.planId}`,
      });
    } catch (err: any) {
      const error = err?.message ?? "orchestration fee debit failed";
      updatePlanStatus(plan.planId, "failed");
      yield {
        type: "step_error",
        stepId: "__orchestration_fee__",
        provider: "i402_server",
        error,
        fatal: true,
      };
      const summary = getLedgerSummary(plan.sessionId);
      yield {
        type: "summary",
        spentUsdc: summary.totalSpent,
        remainingEscrowUsdc: summary.currentBalance,
        artifacts: [],
        status: "budget_exhausted",
      };
      return;
    }
  }

  // Topological execution
  const ordered = topoOrder(plan.steps);
  const priorOutputs: Record<string, Record<string, unknown>> = {};
  const collectedArtifacts: I402Artifact[] = [];
  let encounteredFatal = false;

  for (const step of ordered) {
    // Resolve $STEPS templating against prior outputs
    const resolvedInput = resolveStepInput(step.input, priorOutputs);

    const excluded = new Set<string>();
    let lastError: string | null = null;
    let succeeded = false;
    let activeProvider = step.provider;
    let retryCount = 0;

    // Retry loop (same step, alternate providers)
    while (retryCount <= maxRetries) {
      const handler = opts.handlers[activeProvider];
      if (!handler) {
        lastError = `no handler registered for provider ${activeProvider}`;
        excluded.add(activeProvider);
        const fallback = nextFallbackProvider(step.capability, excluded);
        if (!fallback) break;
        activeProvider = fallback;
        retryCount++;
        continue;
      }

      const provider = getProvider(activeProvider);
      if (!provider) {
        lastError = `provider ${activeProvider} not in registry`;
        excluded.add(activeProvider);
        const fallback = nextFallbackProvider(step.capability, excluded);
        if (!fallback) break;
        activeProvider = fallback;
        retryCount++;
        continue;
      }

      yield {
        type: "step_start",
        stepId: step.stepId,
        provider: activeProvider,
        capability: step.capability,
        costUsdc: provider.costPerCallUsdc,
      };

      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      writeStepResult({
        planId: plan.planId,
        stepId: step.stepId,
        sessionId: plan.sessionId,
        capability: step.capability,
        providerId: activeProvider,
        stepInput: resolvedInput,
        status: "running",
        costChargedUsdc: 0,
        retryCount,
        startedAt,
      });

      try {
        const output = await Promise.race<Record<string, unknown>>([
          handler(resolvedInput, {
            sessionId: plan.sessionId,
            planId: plan.planId,
            stepId: step.stepId,
            walletAddress,
            priorOutputs,
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`step timeout after ${stepTimeoutMs}ms`)), stepTimeoutMs)),
        ]);

        const latencyMs = Date.now() - startMs;
        const completedAt = new Date().toISOString();

        // Debit escrow for this step
        debitStep({
          sessionId: plan.sessionId,
          planId: plan.planId,
          stepId: step.stepId,
          amountUsdc: provider.costPerCallUsdc,
          notes: `${step.capability} via ${activeProvider}`,
        });

        // Persist result
        writeStepResult({
          planId: plan.planId,
          stepId: step.stepId,
          sessionId: plan.sessionId,
          capability: step.capability,
          providerId: activeProvider,
          stepInput: resolvedInput,
          output,
          status: "ok",
          latencyMs,
          costChargedUsdc: provider.costPerCallUsdc,
          retryCount,
          startedAt,
          completedAt,
        });

        // Update provider metrics
        updateProviderMetrics(activeProvider, { latencyMs, success: true });

        // Extract artifacts
        const extracted = extractArtifacts(step, output);
        for (const a of extracted) {
          const saved = addArtifact({
            sessionId: plan.sessionId,
            planId: plan.planId,
            stepId: step.stepId,
            type: a.type,
            name: a.name,
            resourceRef: a.resourceRef,
            metadata: a.metadata,
          });
          collectedArtifacts.push(saved);
        }

        priorOutputs[step.stepId] = output;
        yield {
          type: "step_result",
          stepId: step.stepId,
          provider: activeProvider,
          output,
          latencyMs,
          costChargedUsdc: provider.costPerCallUsdc,
        };

        succeeded = true;
        break;
      } catch (err: any) {
        const latencyMs = Date.now() - startMs;
        const errMessage: string = err?.message ?? String(err);
        lastError = errMessage;
        updateProviderMetrics(activeProvider, { latencyMs, success: false });

        writeStepResult({
          planId: plan.planId,
          stepId: step.stepId,
          sessionId: plan.sessionId,
          capability: step.capability,
          providerId: activeProvider,
          stepInput: resolvedInput,
          status: "error",
          latencyMs,
          costChargedUsdc: 0,
          retryCount,
          error: errMessage,
          startedAt,
          completedAt: new Date().toISOString(),
        });

        excluded.add(activeProvider);
        const fallback = nextFallbackProvider(step.capability, excluded);
        if (!fallback || retryCount >= maxRetries) {
          yield {
            type: "step_error",
            stepId: step.stepId,
            provider: activeProvider,
            error: errMessage,
            retryWith: fallback ?? undefined,
            fatal: !fallback,
          };
          break;
        }

        yield {
          type: "step_error",
          stepId: step.stepId,
          provider: activeProvider,
          error: errMessage,
          retryWith: fallback,
          fatal: false,
        };
        activeProvider = fallback;
        retryCount++;
      }
    }

    if (!succeeded) {
      encounteredFatal = true;
      // Continue executing later steps that don't depend on this one. The topo ordering
      // means dependents will see a missing priorOutputs entry and are expected to
      // handle it via input templating failures (they'll error too). For now, simply abort.
      break;
    }
  }

  // Finalize
  const finalStatus: "completed" | "failed" = encounteredFatal ? "failed" : "completed";
  updatePlanStatus(plan.planId, finalStatus);

  if (encounteredFatal) {
    updateSessionStatus(plan.sessionId, "active"); // session remains active so agent can retry
  }

  // Refund remaining escrow if requested
  if (refundOnClose && !encounteredFatal) {
    try {
      refund({ sessionId: plan.sessionId, notes: `Plan ${plan.planId} completed` });
    } catch {
      // best-effort; don't mask the summary event
    }
  }

  // Log summary message to session for auditability
  const summary = getLedgerSummary(plan.sessionId);
  appendMessage({
    sessionId: plan.sessionId,
    role: "orchestrator",
    content: JSON.stringify({
      plan_id: plan.planId,
      status: finalStatus,
      spent: summary.totalSpent,
      artifacts: collectedArtifacts.map(a => ({ type: a.type, name: a.name })),
    }),
  });

  yield {
    type: "summary",
    spentUsdc: summary.totalSpent,
    remainingEscrowUsdc: summary.currentBalance,
    artifacts: collectedArtifacts,
    status: finalStatus,
  };
}

/**
 * Non-streaming convenience wrapper — collects all events and returns them.
 */
export async function executePlan(
  plan: Plan,
  walletAddress: string,
  opts: ExecutorOptions
): Promise<ExecutorEvent[]> {
  const events: ExecutorEvent[] = [];
  for await (const event of executePlanStream(plan, walletAddress, opts)) {
    events.push(event);
  }
  return events;
}

/**
 * Load a persisted plan by ID, reconstruct, and execute.
 */
export async function* executePersistedPlan(
  planId: string,
  walletAddress: string,
  opts: ExecutorOptions
): AsyncGenerator<ExecutorEvent, void, undefined> {
  const persisted = getPlan(planId);
  if (!persisted) throw new Error(`Plan ${planId} not found`);
  if (persisted.status !== "approved") {
    throw new Error(`Plan ${planId} is not approved (status=${persisted.status})`);
  }
  const reconstructed: Plan = {
    sessionId: persisted.sessionId,
    planId: persisted.id,
    status: persisted.status,
    intent: { original: persisted.intent, interpreted: persisted.interpretedIntent },
    steps: persisted.steps,
    totals: {
      stepCostUsdc: persisted.stepCostUsdc,
      orchestrationFeeUsdc: persisted.orchestrationFeeUsdc,
      totalCostUsdc: persisted.totalCostUsdc,
      withinBudget: persisted.withinBudget,
      executionModes: ["server_side", "hybrid"],
    },
  };
  yield* executePlanStream(reconstructed, walletAddress, opts);
}

// -------------------- Public helpers --------------------

export { writeStepResult as _writeStepResult_testOnly };

/**
 * Read all persisted step results for a plan, in step_id order.
 */
export function getStepResults(planId: string): StepResult[] {
  const rows = db
    .prepare(`SELECT * FROM i402_session_step_results WHERE plan_id = ? ORDER BY step_id ASC`)
    .all(planId) as Array<{
      plan_id: string;
      step_id: string;
      session_id: string;
      capability: string;
      provider_id: string;
      input: string | null;
      output: string | null;
      status: StepStatus;
      latency_ms: number | null;
      cost_charged_usdc: number;
      retry_count: number;
      x402_tx_signature: string | null;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
    }>;

  return rows.map(r => ({
    planId: r.plan_id,
    stepId: r.step_id,
    sessionId: r.session_id,
    capability: r.capability,
    providerId: r.provider_id,
    input: r.input ? JSON.parse(r.input) : undefined,
    output: r.output ? JSON.parse(r.output) : undefined,
    status: r.status,
    latencyMs: r.latency_ms ?? undefined,
    costChargedUsdc: r.cost_charged_usdc,
    retryCount: r.retry_count,
    x402TxSignature: r.x402_tx_signature ?? undefined,
    error: r.error ?? undefined,
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
  }));
}

// Used by tests to mint a unique tag when injecting synthetic step inputs
export function _testStepId(): string {
  return `s_${crypto.randomBytes(4).toString("hex")}`;
}
