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

// -------------------- Helpers --------------------

function isPlan(r: PlanOrClarification): r is Plan {
  return (r as Plan).planId !== undefined;
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

      const forceNew = req.headers["x-new-session"] === "true";

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
        res.status(402).json({
          session_id: result.sessionId,
          status: result.status,
          questions: result.questions,
        });
        return;
      }
      res.status(402).json(planToApiResponse(result));
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
