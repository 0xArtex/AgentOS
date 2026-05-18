/**
 * Async transfer status. Clients poll this while a transfer is in flight.
 *
 * GET /transfers/:id returns the row if the caller is from_wallet or
 * to_wallet — same access pattern as the underlying account. Anyone else
 * gets 404 (not 403, to avoid leaking that the transfer exists).
 */
import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { getTransfer } from "../services/transfers";

const router = Router();

// Tiny fee so wallet-only callers can still hit it; the value matters less
// than the signature proving who's asking.
const POLL_FEE_USDC = 0.0001;

router.get(
  "/:id",
  requireAuth(POLL_FEE_USDC, "general", { discoverable: false }),
  (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = String(req.params.id || "");
    const row = getTransfer(id);
    if (!row || (row.from_wallet !== caller && row.to_wallet !== caller)) {
      // 404 not 403 — don't reveal that someone else's transfer exists.
      res.status(404).json({ error: "Transfer not found" });
      return;
    }
    res.json({
      id: row.id,
      account_id: row.account_id,
      account_kind: row.account_kind,
      from_wallet: row.from_wallet,
      to_wallet: row.to_wallet,
      status: row.status,
      error: row.error,
      error_code: row.error_code,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
    });
  }
);

export default router;
