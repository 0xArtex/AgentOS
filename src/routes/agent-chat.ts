import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import type { AuthenticatedRequest } from "../types";

import {
  createSession,
  getSession,
  listActiveSessions,
  listMessages,
  updateSessionStatus,
} from "../services/i402-session";
import {
  generatePlan,
  planExecutionGate,
  PROTOCOL_VERSION,
} from "../services/i402-planner";
import {
  listCapabilities,
  listProviders,
  CAPABILITY_CLASSES,
} from "../services/i402-providers";
import type { I402Quality } from "../services/i402-providers";
import type { PlannerRequest, PlanOrClarification, Plan } from "../services/i402-types";

const router = Router();

// -------------------- Constants --------------------

const ORCHESTRATION_FEE_USDC = 0.10; // Base fee for plan generation (covers LLM tokens)

// Bound the attacker-controllable input that gets serialized into the (Opus)
// planner prompt, so a single flat-fee call can't be inflated into a huge
// generation. The planner caps its own output/steps; these cap the input side.
export const MAX_INTENT_CHARS = 4000;
export const MAX_STRUCTURED_BYTES = 8000;

// -------------------- Helpers --------------------

function isPlan(r: PlanOrClarification): r is Plan {
  return (r as Plan).planId !== undefined;
}

/**
 * Reject oversized plan-generation requests before they reach the LLM planner.
 * `intent`, `params`, and `constraints` all flow into the planner prompt, so an
 * unbounded payload is a cost-amplification lever on the flat $0.10 fee.
 */
export function validateChatRequestLimits(args: {
  intent: string;
  params?: unknown;
  constraints?: unknown;
}): { ok: true } | { ok: false; error: string; message: string } {
  if (args.intent.length > MAX_INTENT_CHARS) {
    return { ok: false, error: "Intent Too Long", message: `'intent' exceeds ${MAX_INTENT_CHARS} characters.` };
  }
  for (const [field, val] of [["params", args.params], ["constraints", args.constraints]] as const) {
    if (val !== undefined && JSON.stringify(val).length > MAX_STRUCTURED_BYTES) {
      return { ok: false, error: "Request Too Large", message: `'${field}' exceeds ${MAX_STRUCTURED_BYTES} bytes.` };
    }
  }
  return { ok: true };
}

function parseQuality(value: unknown): I402Quality | undefined {
  if (value === "fast" || value === "cheap" || value === "best") return value;
  return undefined;
}

function planToApiResponse(plan: Plan): Record<string, unknown> {
  return {
    session_id: plan.sessionId,
    plan_id: plan.planId,
    status: plan.status,
    // Explicit counterpart to blockedPlanResponse's `executable: false`, so a
    // caller branches on one field instead of inferring from the HTTP status.
    executable: true,
    intent: plan.intent,
    steps: plan.steps.map(s => ({
      step_id: s.stepId,
      capability: s.capability,
      provider: s.provider,
      description: s.description,
      input: s.input,
      cost_usdc: s.costUsdc,
      eta_seconds: s.etaSeconds,
      depends_on: s.dependsOn,
      x402: {
        endpoint: s.x402.endpoint,
        method: s.x402.method,
        payment_rail: s.x402.paymentRail,
      },
    })),
    totals: {
      step_cost_usdc: plan.totals.stepCostUsdc,
      orchestration_fee_usdc: plan.totals.orchestrationFeeUsdc,
      total_cost_usdc: plan.totals.totalCostUsdc,
      within_budget: plan.totals.withinBudget,
      eta_seconds: plan.totals.etaSeconds,
    },
  };
}

/**
 * Cost preview for a budget-blocked plan. Deliberately omits every step's `x402`
 * spec so the plan is NOT executable — the agent can see what it would cost (and
 * raise the budget or opt in) but cannot sign/run it under its stated budget.
 */
function blockedPlanResponse(plan: Plan, reason: string): Record<string, unknown> {
  return {
    session_id: plan.sessionId,
    plan_id: plan.planId,
    status: plan.status, // 'budget_exceeded'
    executable: false,
    message: reason,
    hint: "Raise budget_usdc to cover the total, or resend with allow_budget_exceeded: true to override the cap.",
    intent: plan.intent,
    steps: plan.steps.map(s => ({
      step_id: s.stepId,
      capability: s.capability,
      provider: s.provider,
      description: s.description,
      cost_usdc: s.costUsdc,
      depends_on: s.dependsOn,
    })),
    totals: {
      step_cost_usdc: plan.totals.stepCostUsdc,
      orchestration_fee_usdc: plan.totals.orchestrationFeeUsdc,
      total_cost_usdc: plan.totals.totalCostUsdc,
      within_budget: plan.totals.withinBudget,
      eta_seconds: plan.totals.etaSeconds,
    },
  };
}

/**
 * Build the HTTP response for a generated plan, ENFORCING the plan-level spend
 * cap: a budget_exceeded plan is returned as a non-executable cost preview (no
 * x402 specs) unless the caller explicitly opts in to overspend.
 *
 * Both branches answer 200. This route USED to reply 402 with the plan as a
 * "here is what to do" data channel — but by the time a plan exists the
 * orchestration fee has ALREADY settled on-chain, and 402 is the one status
 * every x402 client reads as "you have not paid". Real cost of that: an agent
 * paid the fee, got its plan back under a 402 with no `accepts` array, decided
 * the server had rejected its signature, re-signed, and paid again — twice on
 * Base — before giving up on a plan that was sitting in the body the whole
 * time. 402 now means exactly one thing on this route: the unpaid challenge
 * emitted by the x402 middleware. Payment outcome lives in the status; plan
 * outcome lives in `status`/`executable` in the body.
 */
export function buildChatPlanPayload(
  plan: Plan,
  opts: { allowBudgetExceeded?: boolean } = {}
): { status: number; body: Record<string, unknown> } {
  const gate = planExecutionGate(plan, opts);
  if (!gate.executable) {
    return { status: 200, body: blockedPlanResponse(plan, gate.reason ?? "Plan exceeds budget.") };
  }
  return { status: 200, body: planToApiResponse(plan) };
}

// -------------------- Discovery (free) --------------------

router.get("/capabilities", (_req, res: Response) => {
  res.setHeader("X-i402-Version", PROTOCOL_VERSION);
  res.json({ version: PROTOCOL_VERSION, capabilities: listCapabilities() });
});

router.get("/providers", (req, res: Response) => {
  const capability = req.query.capability as string | undefined;
  if (capability && !CAPABILITY_CLASSES[capability]) {
    res.status(404).json({
      error: "Unknown Capability",
      message: `Capability ${capability} is not registered.`,
      hint: "GET /chat/capabilities to list available capabilities.",
    });
    return;
  }
  const providers = listProviders({ capability, enabledOnly: true });
  res.setHeader("X-i402-Version", PROTOCOL_VERSION);
  res.json({
    version: PROTOCOL_VERSION,
    providers: providers.map(p => ({
      id: p.id,
      source: p.source,
      capability: p.capability,
      name: p.name,
      description: p.description,
      endpoint: p.endpoint,
      method: p.method,
      payment_rail:
        p.authScheme === "x402-solana" ? "x402-solana" : p.authScheme === "x402-base" ? "x402-base" : p.authScheme,
      cost_per_call_usdc: p.costPerCallUsdc,
      p50_latency_ms: p.p50LatencyMs,
      p99_latency_ms: p.p99LatencyMs,
      success_rate: p.successRate,
      reputation_score: p.reputationScore,
    })),
  });
});

// -------------------- Session inspection (wallet-scoped) --------------------

router.get(
  "/:sessionId",
  requireAuth(0, "general"),
  (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer ?? req.agentId;
    const session = getSession(String(req.params.sessionId));
    if (!session) {
      res.status(404).json({ error: "Session Not Found" });
      return;
    }
    const walletStr = typeof wallet === "string" ? wallet : undefined;
    if (!walletStr || session.walletAddress !== walletStr) {
      res.status(403).json({ error: "Forbidden", message: "Session belongs to a different wallet." });
      return;
    }
    res.setHeader("X-i402-Version", PROTOCOL_VERSION);
    res.json({
      session: {
        id: session.id,
        wallet_address: session.walletAddress,
        budget_usdc: session.budgetUsdc,
        status: session.status,
        created_at: session.createdAt,
        last_active_at: session.lastActiveAt,
        expires_at: session.expiresAt,
        context_summary: session.contextSummary,
      },
      messages: listMessages(session.id, 100).map(m => ({
        seq: m.seq,
        role: m.role,
        content: m.content,
        model: m.model,
        created_at: m.createdAt,
      })),
    });
  }
);

router.post(
  "/:sessionId/cancel",
  requireAuth(0, "general"),
  (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer ?? req.agentId;
    const session = getSession(String(req.params.sessionId));
    if (!session) {
      res.status(404).json({ error: "Session Not Found" });
      return;
    }
    const walletStr = typeof wallet === "string" ? wallet : undefined;
    if (!walletStr || session.walletAddress !== walletStr) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (session.status !== "active" && session.status !== "paused") {
      res.status(409).json({ error: "Session Not Cancellable", message: `Session is ${session.status}` });
      return;
    }
    updateSessionStatus(session.id, "cancelled");
    res.setHeader("X-i402-Version", PROTOCOL_VERSION);
    res.status(200).json({ session_id: session.id, status: "cancelled" });
  }
);

router.get(
  "/",
  requireAuth(0, "general"),
  (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer ?? req.agentId;
    if (!wallet) {
      res.status(401).json({ error: "Unauthenticated", message: "Wallet identity required." });
      return;
    }
    const sessions = listActiveSessions(wallet);
    res.setHeader("X-i402-Version", PROTOCOL_VERSION);
    res.json({
      sessions: sessions.map(s => ({
        id: s.id,
        budget_usdc: s.budgetUsdc,
        status: s.status,
        last_active_at: s.lastActiveAt,
      })),
    });
  }
);

// -------------------- POST /chat — plan generation --------------------
//
// Agent-side-only model: the response body is a list of x402 calls the agent
// will sign and execute itself. No server-side execution, no escrow, no
// artifact tracking — the agent owns the entire execution path.
//
// Session continuity: the server looks up the wallet's most-recent active
// session and the planner decides whether the new intent continues it. Pass
// X-New-Session: true to force a fresh session.

router.post(
  "/",
  requireAuth(ORCHESTRATION_FEE_USDC, "general", {
    description:
      "Generate an i402 plan from a natural-language intent. Returns a 402 response with a list of x402 calls the agent should sign and execute.",
    category: "orchestration",
    tags: ["i402", "orchestrator", "plan", "agent"],
  }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const walletAddress = req.payment?.payer ?? req.agentId;
      if (!walletAddress) {
        res.status(401).json({ error: "Unauthenticated", message: "Wallet identity required." });
        return;
      }

      const {
        intent,
        params,
        budget_usdc: budgetRaw,
        deadline_seconds: deadline,
        quality: qualityRaw,
        constraints,
      } = req.body as Record<string, unknown>;

      if (typeof intent !== "string" || intent.trim().length === 0) {
        res.status(400).json({ error: "Missing Intent", message: "'intent' is required." });
        return;
      }
      const budget = typeof budgetRaw === "number" ? budgetRaw : Number(budgetRaw);
      if (!isFinite(budget) || budget <= 0) {
        res.status(400).json({
          error: "Invalid Budget",
          message: "'budget_usdc' is required and must be a positive number.",
        });
        return;
      }

      // Bound attacker-controlled prompt input (cost-amplification guard).
      const limit = validateChatRequestLimits({ intent: intent.trim(), params, constraints });
      if (!limit.ok) {
        res.status(400).json({ error: limit.error, message: limit.message });
        return;
      }

      const forceNew = req.headers["x-new-session"] === "true";
      // Explicit opt-in to exceed the stated budget. Without it, a budget_exceeded
      // plan is returned as a non-executable preview (no x402 specs).
      const allowBudgetExceeded = (req.body as Record<string, unknown>)?.allow_budget_exceeded === true;

      const plannerRequest: PlannerRequest = {
        // Session is resolved by the planner via wallet lookup — sessionId left empty
        // and will be assigned by the planner.
        sessionId: "",
        walletAddress,
        intent: intent.trim(),
        params: (params as Record<string, unknown>) ?? undefined,
        budgetUsdc: budget,
        deadlineSeconds: typeof deadline === "number" ? deadline : undefined,
        quality: parseQuality(qualityRaw),
        constraints: (constraints as PlannerRequest["constraints"]) ?? undefined,
      };

      const result = await generatePlan(plannerRequest, { forceNewSession: forceNew });

      res.setHeader("X-i402-Version", PROTOCOL_VERSION);
      if (!isPlan(result)) {
        // 200, not 402 — the fee settled, this IS the answer (see
        // buildChatPlanPayload). `executable: false` marks that there's nothing
        // to run yet: answer the questions and call again.
        res.status(200).json({
          session_id: result.sessionId,
          status: result.status,
          executable: false,
          questions: result.questions,
        });
        return;
      }
      const { status, body } = buildChatPlanPayload(result, { allowBudgetExceeded });
      res.status(status).json(body);
    } catch (err: any) {
      console.error("[chat] plan generation error:", err);
      res.status(err?.statusCode ?? 500).json({
        error: "Plan Generation Failed",
        message: err?.message ?? "unknown error",
      });
    }
  }
);

// Placeholder — not used; kept so pre-existing doc references don't 404
export default router;
