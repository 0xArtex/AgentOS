import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { send402Response, x402 as requireX402Payment } from "../middleware/x402";
import { resolveSession, requireSession } from "../middleware/i402-session";
import type { AuthenticatedRequest } from "../types";

import {
  createSession,
  getSession,
  listActiveSessions,
  listArtifacts,
  listMessages,
  updateSessionStatus,
} from "../services/i402-session";
import { generatePlan, getPlan, updatePlanStatus, PROTOCOL_VERSION } from "../services/i402-planner";
import {
  deposit,
  refund,
  getLedgerSummary,
} from "../services/i402-escrow";
import {
  executePlanStream,
  type ExecutorEvent,
  type StepHandler,
} from "../services/i402-executor";
import { buildDefaultHandlers } from "../services/i402-provider-handlers";
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
const USDC_DECIMALS = 1_000_000; // 6 decimals

// -------------------- Helpers --------------------

function isPlan(r: PlanOrClarification): r is Plan {
  return (r as Plan).planId !== undefined;
}

function paymentAmountUsdc(req: AuthenticatedRequest): number {
  const lamports = req.payment?.amountLamports;
  if (!lamports) return 0;
  return Number(lamports) / USDC_DECIMALS;
}

function parseQuality(value: unknown): I402Quality | undefined {
  if (value === "fast" || value === "cheap" || value === "best") return value;
  return undefined;
}

function writeSseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-i402-Version", PROTOCOL_VERSION);
  res.flushHeaders?.();
}

function writeSseEvent(res: Response, event: ExecutorEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
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
      execution_modes: plan.totals.executionModes,
    },
    approval: plan.approval
      ? {
          required: plan.approval.required,
          expires_at: plan.approval.expiresAt,
          hint: plan.approval.hint,
          approve_url: "/chat/" + plan.sessionId + "/execute",
          approve_method: "POST",
          approve_body: plan.approval.approveBody,
        }
      : undefined,
  };
}

// -------------------- Capability & provider discovery (free) --------------------

router.get("/capabilities", (_req, res: Response) => {
  res.setHeader("X-i402-Version", PROTOCOL_VERSION);
  res.json({
    version: PROTOCOL_VERSION,
    capabilities: listCapabilities(),
  });
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
      cost_per_call_usdc: p.costPerCallUsdc,
      p50_latency_ms: p.p50LatencyMs,
      p99_latency_ms: p.p99LatencyMs,
      success_rate: p.successRate,
      reputation_score: p.reputationScore,
    })),
  });
});

// -------------------- Session inspection (free, wallet-scoped) --------------------

router.get(
  "/:sessionId",
  requireAuth(0, "general"),
  resolveSession(),
  requireSession(),
  (req: AuthenticatedRequest, res: Response) => {
    const session = req.i402Session!;
    res.setHeader("X-i402-Version", PROTOCOL_VERSION);
    res.json({
      session: {
        id: session.id,
        wallet_address: session.walletAddress,
        budget_usdc: session.budgetUsdc,
        spent_usdc: session.spentUsdc,
        escrow_usdc: session.escrowUsdc,
        status: session.status,
        created_at: session.createdAt,
        last_active_at: session.lastActiveAt,
        expires_at: session.expiresAt,
        context_summary: session.contextSummary,
      },
      artifacts: listArtifacts(session.id).map(a => ({
        type: a.type,
        name: a.name,
        resource_ref: a.resourceRef,
        metadata: a.metadata,
        created_at: a.createdAt,
      })),
      messages: listMessages(session.id, 50).map(m => ({
        seq: m.seq,
        role: m.role,
        content: m.content,
        model: m.model,
        created_at: m.createdAt,
      })),
    });
  }
);

router.get(
  "/:sessionId/spend",
  requireAuth(0, "general"),
  resolveSession(),
  requireSession(),
  (req: AuthenticatedRequest, res: Response) => {
    const session = req.i402Session!;
    const summary = getLedgerSummary(session.id);
    res.setHeader("X-i402-Version", PROTOCOL_VERSION);
    res.json({
      session_id: session.id,
      total_deposited_usdc: summary.totalDeposited,
      total_spent_usdc: summary.totalSpent,
      total_refunded_usdc: summary.totalRefunded,
      current_balance_usdc: summary.currentBalance,
    });
  }
);

router.post(
  "/:sessionId/cancel",
  requireAuth(0, "general"),
  resolveSession(),
  requireSession(),
  (req: AuthenticatedRequest, res: Response) => {
    const session = req.i402Session!;
    if (session.status !== "active" && session.status !== "paused") {
      res.status(409).json({
        error: "Session Not Cancellable",
        message: `Session is ${session.status}`,
      });
      return;
    }
    updateSessionStatus(session.id, "cancelled");
    const { refundedUsdc } = refund({
      sessionId: session.id,
      notes: "Session cancelled by wallet owner",
    });
    res.setHeader("X-i402-Version", PROTOCOL_VERSION);
    res.status(200).json({
      session_id: session.id,
      status: "cancelled",
      refunded_usdc: refundedUsdc,
    });
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
        spent_usdc: s.spentUsdc,
        escrow_usdc: s.escrowUsdc,
        status: s.status,
        last_active_at: s.lastActiveAt,
      })),
    });
  }
);

// -------------------- POST /chat — plan generation --------------------

router.post(
  "/",
  requireAuth(ORCHESTRATION_FEE_USDC, "general", {
    description:
      "Generate an i402 plan from a natural-language intent. Returns a 402 response with the plan body per spec §6.",
    category: "orchestration",
    tags: ["i402", "orchestrator", "plan", "agent"],
  }),
  resolveSession(),
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
        approve,
        auto_approve_under_usdc: autoApprove,
      } = req.body as Record<string, unknown>;

      if (typeof intent !== "string" || intent.trim().length === 0) {
        res.status(400).json({
          error: "Missing Intent",
          message: "'intent' field is required and must be a non-empty string.",
        });
        return;
      }
      const budget = typeof budgetRaw === "number" ? budgetRaw : Number(budgetRaw);
      if (!isFinite(budget) || budget <= 0) {
        res.status(400).json({
          error: "Invalid Budget",
          message: "'budget_usdc' is required and must be a positive number.",
          hint: "Set budget_usdc to the maximum USDC you authorize for this outcome.",
        });
        return;
      }

      // Create session if none provided
      const session = req.i402Session ?? createSession({ walletAddress, budgetUsdc: budget });

      const plannerRequest: PlannerRequest = {
        sessionId: session.id,
        walletAddress,
        intent: intent.trim(),
        params: (params as Record<string, unknown>) ?? undefined,
        budgetUsdc: budget,
        deadlineSeconds: typeof deadline === "number" ? deadline : undefined,
        quality: parseQuality(qualityRaw),
        constraints: (constraints as PlannerRequest["constraints"]) ?? undefined,
        approve: approve === true,
        autoApproveUnderUsdc: typeof autoApprove === "number" ? autoApprove : undefined,
      };

      const result = await generatePlan(plannerRequest);

      res.setHeader("X-i402-Version", PROTOCOL_VERSION);
      if (!isPlan(result)) {
        // Clarification needed
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

// -------------------- POST /chat/:id/execute — run an approved plan --------------------

// Helper: promisify middleware so we can call x402 verification mid-handler.
function runMiddleware(
  mw: (req: any, res: any, next: (err?: any) => void) => void,
  req: any,
  res: any
): Promise<void> {
  return new Promise((resolve, reject) => {
    mw(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

router.post(
  "/:sessionId/execute",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      // ── 1. Parse body ──
      const { plan_id: planId, approve, execution } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof planId !== "string") {
        res.status(400).json({ error: "Missing plan_id", message: "Request body must include 'plan_id'." });
        return;
      }

      // ── 2. Load plan + session BEFORE auth so we can advertise the right cost ──
      const persisted = getPlan(planId);
      if (!persisted) {
        res.status(404).json({ error: "Plan Not Found", message: `plan ${planId} does not exist.` });
        return;
      }
      if (persisted.sessionId !== req.params.sessionId) {
        res.status(403).json({
          error: "Plan Belongs To Another Session",
          message: `plan ${planId} is not part of session ${req.params.sessionId}.`,
        });
        return;
      }
      const session = getSession(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: "Session Not Found" });
        return;
      }
      if (session.status === "expired" || session.status === "cancelled" || session.status === "completed") {
        res.status(410).json({
          error: "Session Closed",
          message: `Session is ${session.status}.`,
        });
        return;
      }

      // ── 3. Upgrade plan status if caller approved ──
      if (persisted.status === "awaiting_approval" && approve === true) {
        updatePlanStatus(planId, "approved");
      }
      const refreshed = getPlan(planId)!;
      if (refreshed.status !== "approved") {
        res.status(409).json({
          error: "Plan Not Approved",
          message: `plan ${planId} is ${refreshed.status} — include {approve: true} to approve and execute.`,
        });
        return;
      }

      const expectedCost = refreshed.totalCostUsdc;

      // ── 4. Payment required — advertise the real amount so clients pay once ──
      const hasPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);
      const metadata = {
        description: `Execute i402 plan ${planId}: ${refreshed.steps.length} steps`,
        category: "orchestration",
        tags: ["i402", "executor", "stream"],
      };
      if (!hasPayment) {
        send402Response(res, req, expectedCost, `Pay ${expectedCost.toFixed(2)} USDC to execute this plan.`, metadata);
        return;
      }

      // ── 5. Verify x402 payment against expectedCost ──
      try {
        await runMiddleware(requireX402Payment(expectedCost, metadata), req, res);
      } catch {
        // middleware already responded
        return;
      }
      if (res.headersSent) return;

      const walletAddress = req.payment?.payer;
      if (!walletAddress) {
        res.status(401).json({ error: "Unauthenticated" });
        return;
      }

      // ── 6. Wallet ownership match ──
      if (session.walletAddress !== walletAddress) {
        res.status(403).json({
          error: "Forbidden",
          message: "Payment wallet does not match session owner.",
        });
        return;
      }

      const paid = paymentAmountUsdc(req);
      if (paid + 1e-9 < expectedCost) {
        send402Response(res, req, expectedCost, "Insufficient payment — the facilitator verified a payment smaller than the plan total.", metadata);
        return;
      }

      // ── 7. Deposit into session escrow ──
      deposit({
        sessionId: session.id,
        amountUsdc: paid,
        txSignature: req.payment?.signature,
        chain: "solana",
        notes: `x402 deposit for plan ${planId} execution`,
      });

      // Reconstruct the Plan object the executor expects
      const plan: Plan = {
        sessionId: session.id,
        planId: refreshed.id,
        status: "approved",
        intent: { original: refreshed.intent, interpreted: refreshed.interpretedIntent },
        steps: refreshed.steps,
        totals: {
          stepCostUsdc: refreshed.stepCostUsdc,
          orchestrationFeeUsdc: refreshed.orchestrationFeeUsdc,
          totalCostUsdc: refreshed.totalCostUsdc,
          withinBudget: refreshed.withinBudget,
          executionModes: ["server_side", "hybrid"],
        },
      };

      // Execute with SSE streaming
      const mode = execution === "agent_side" || execution === "hybrid" ? execution : "server_side";
      if (mode !== "server_side") {
        res.status(501).json({
          error: "Execution Mode Not Implemented",
          message: `Execution mode '${mode}' is not available in v0.1 — server_side only.`,
        });
        return;
      }

      writeSseHeaders(res);

      const handlers: Record<string, StepHandler> = buildDefaultHandlers();
      const clientClosed = { value: false };
      req.on("close", () => {
        clientClosed.value = true;
      });

      try {
        for await (const event of executePlanStream(plan, walletAddress, { handlers })) {
          if (clientClosed.value) {
            // Client disconnected — cancel the session so we don't keep spending
            updateSessionStatus(session.id, "cancelled");
            refund({ sessionId: session.id, notes: "Client disconnected mid-execution" });
            return;
          }
          writeSseEvent(res, event);
        }
      } catch (err: any) {
        console.error("[chat] execute stream error:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Execution Failed", message: err?.message });
          return;
        }
        writeSseEvent(res, {
          type: "step_error",
          stepId: "__executor__",
          provider: "i402_server",
          error: err?.message ?? "unknown error",
          fatal: true,
        });
      } finally {
        res.end();
      }
    } catch (err: any) {
      console.error("[chat] execute setup error:", err);
      if (!res.headersSent) {
        res.status(err?.statusCode ?? 500).json({
          error: "Execute Failed",
          message: err?.message ?? "unknown error",
        });
      }
    }
  }
);

export default router;
