import { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types";
import { getSession, touchSession } from "../services/i402-session";

/**
 * Resolve X-Session-Id header into req.i402Session.
 *
 * Behavior:
 *  - If no header is present, passes through (new session will be created downstream).
 *  - If header is present but session doesn't exist → 404 with structured error.
 *  - If session exists but belongs to a different wallet than req.payment?.payer / req.agentId → 403.
 *  - If session is terminal (expired/cancelled/completed) → 410.
 *  - Otherwise attaches session to req.i402Session and touches its last_active_at.
 *
 * This middleware MUST run AFTER requireAuth so req.payment / req.agentId are populated.
 */
export function resolveSession() {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const sessionId = req.headers["x-session-id"] as string | undefined;
    if (!sessionId) {
      next();
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      res.status(404).json({
        error: "Session Not Found",
        message: `No session with id ${sessionId}`,
        hint: "Omit X-Session-Id to start a new session.",
      });
      return;
    }

    const callerWallet = req.payment?.payer ?? req.agentId;
    if (!callerWallet) {
      res.status(401).json({
        error: "Unauthenticated",
        message: "A wallet identity is required to access sessions.",
      });
      return;
    }

    if (session.walletAddress !== callerWallet) {
      res.status(403).json({
        error: "Forbidden",
        message: `Session ${sessionId} belongs to a different wallet.`,
      });
      return;
    }

    if (session.status === "expired" || session.status === "cancelled" || session.status === "completed") {
      res.status(410).json({
        error: "Session Closed",
        message: `Session ${sessionId} is ${session.status} and no longer accepts new activity.`,
        hint: "Start a new session by omitting X-Session-Id.",
      });
      return;
    }

    touchSession(sessionId);
    req.i402Session = session;
    next();
  };
}

/**
 * Require that req.i402Session is populated. Use after resolveSession() on endpoints
 * that operate on an existing session (GET /chat/:id, /chat/:id/cancel, etc.).
 */
export function requireSession() {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.i402Session) {
      res.status(400).json({
        error: "Session Required",
        message: "X-Session-Id header or :session_id path parameter is required.",
      });
      return;
    }
    next();
  };
}
