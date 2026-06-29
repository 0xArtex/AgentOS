import { Router, Request, Response } from "express";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";

const router = Router();

// NON-CUSTODIAL: this endpoint does NOT take custody of any USDC. It is an
// advisory bookkeeping ledger only — "release"/"dispute" change a status row,
// they move no funds. Responses say so explicitly so an agent never delivers
// goods believing a counterparty's payment is actually held in escrow.
const NON_CUSTODIAL_NOTE =
  "Advisory ledger only — Palmyr holds no funds. This does not guarantee or move payment.";

// Escrow moves money — every route requires a verified identity. requireAuth(0)
// lets registered agents (aos_/agt_ token) through for free and sets
// req.agentId to the VERIFIED wallet identity, never the raw X-Agent-Id header.
// /stats is public (aggregate only) and is registered without auth below.
router.use((req, res, next) => {
  if (req.path === "/stats") return next();
  return requireAuth(0, "general")(req as AuthenticatedRequest, res, next);
});

try {
  db.exec("CREATE TABLE IF NOT EXISTS escrows (id INTEGER PRIMARY KEY AUTOINCREMENT, escrow_id TEXT UNIQUE NOT NULL, payer_agent TEXT NOT NULL, payee_agent TEXT NOT NULL, amount_usdc REAL NOT NULL, description TEXT, status TEXT, created_at TEXT, released_at TEXT, disputed_at TEXT, tx_signature TEXT)");
} catch(e) { /* exists */ }
// Columns for the dispute-resolution path (#77). ALTER fails on a pre-existing
// DB that already has them, so each is wrapped defensively.
for (const ddl of [
  "ALTER TABLE escrows ADD COLUMN resolved_at TEXT",
  "ALTER TABLE escrows ADD COLUMN resolution TEXT",
]) {
  try { db.exec(ddl); } catch(e) { /* column exists */ }
}

router.post("/", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) return res.status(401).json({ error: "authentication required" });
  const { payee_agent, amount_usdc, description } = req.body || {};
  if (!payee_agent || amount_usdc === undefined || amount_usdc === null) return res.status(400).json({ error: "payee_agent and amount_usdc required" });
  const amount = Number(amount_usdc);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "amount_usdc must be a positive number" });
  const escrowId = `esc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT INTO escrows (escrow_id, payer_agent, payee_agent, amount_usdc, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(?))").run(escrowId, agentId, payee_agent, amount, description || null, "pending", "now");
  res.json({ escrow_id: escrowId, payer: agentId, payee: payee_agent, amount_usdc: amount, status: "pending", custodial: false, note: NON_CUSTODIAL_NOTE, message: "Escrow record created (advisory; no funds held).", actions: { release: `POST /api/agent-escrow/${escrowId}/release`, dispute: `POST /api/agent-escrow/${escrowId}/dispute` } });
});

router.get("/", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) return res.status(401).json({ error: "authentication required" });
  const escrows = db.prepare("SELECT * FROM escrows WHERE payer_agent = ? OR payee_agent = ? ORDER BY created_at DESC LIMIT 50").all(agentId, agentId);
  res.json({ agent: agentId, escrows, count: escrows.length });
});

router.post("/:escrowId/release", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) return res.status(401).json({ error: "authentication required" });
  const { escrowId } = req.params;
  const { tx_signature } = req.body || {};
  const escrow: any = db.prepare("SELECT * FROM escrows WHERE escrow_id = ?").get(escrowId);
  if (!escrow) return res.status(404).json({ error: "Escrow not found" });
  if (escrow.payer_agent !== agentId) return res.status(403).json({ error: "Only payer can release" });
  if (escrow.status !== "pending") return res.status(400).json({ error: "Not pending" });
  db.prepare("UPDATE escrows SET status = ?, released_at = datetime(?), tx_signature = ? WHERE escrow_id = ?").run("released", "now", tx_signature || null, escrowId);
  res.json({ escrow_id: escrowId, status: "released", custodial: false, note: NON_CUSTODIAL_NOTE, message: "Escrow marked released (advisory record; Palmyr moved no funds — settle payment on-chain directly)." });
});

router.post("/:escrowId/dispute", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) return res.status(401).json({ error: "authentication required" });
  const { escrowId } = req.params;
  const { reason } = req.body || {};
  const escrow: any = db.prepare("SELECT * FROM escrows WHERE escrow_id = ?").get(escrowId);
  if (!escrow) return res.status(404).json({ error: "Escrow not found" });
  if (escrow.payer_agent !== agentId && escrow.payee_agent !== agentId) return res.status(403).json({ error: "Unauthorized" });
  if (escrow.status !== "pending") return res.status(400).json({ error: "Not pending" });
  db.prepare("UPDATE escrows SET status = ?, disputed_at = datetime(?) WHERE escrow_id = ?").run("disputed", "now", escrowId);
  res.json({ escrow_id: escrowId, status: "disputed", custodial: false, note: NON_CUSTODIAL_NOTE, reason, message: "Escrow disputed (advisory record). Resolve via POST /api/agent-escrow/" + escrowId + "/resolve.", actions: { resolve: `POST /api/agent-escrow/${escrowId}/resolve` } });
});

// Resolve a disputed escrow. Without this a 'disputed' record is a permanent
// dead end — neither release nor dispute can act on it (both require 'pending'),
// so either party can freeze the record forever (#77). Authority is the payer,
// the payee, or a configured platform arbiter (a verified wallet listed in
// POOL_ADMIN_WALLETS). Still NON-CUSTODIAL: this moves no funds — it only takes
// the advisory record out of limbo to a terminal outcome so both sides have a
// path forward.
const RESOLVE_OUTCOMES = ["released", "refunded", "cancelled"] as const;
function arbiterWallets(): string[] {
  return (process.env.POOL_ADMIN_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean);
}
router.post("/:escrowId/resolve", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) return res.status(401).json({ error: "authentication required" });
  const { escrowId } = req.params;
  const { outcome, note } = req.body || {};
  if (!RESOLVE_OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of: ${RESOLVE_OUTCOMES.join(", ")}` });
  const escrow: any = db.prepare("SELECT * FROM escrows WHERE escrow_id = ?").get(escrowId);
  if (!escrow) return res.status(404).json({ error: "Escrow not found" });
  const isPayer = escrow.payer_agent === agentId;
  const isPayee = escrow.payee_agent === agentId;
  const isArbiter = !isPayer && !isPayee && arbiterWallets().includes(agentId);
  if (!isPayer && !isPayee && !isArbiter) return res.status(403).json({ error: "Only the payer, payee, or a platform arbiter can resolve" });
  if (escrow.status !== "disputed") return res.status(400).json({ error: "Only a disputed escrow can be resolved", status: escrow.status });
  const resolvedBy = isArbiter ? "arbiter" : isPayer ? "payer" : "payee";
  const resolution = `${outcome} by ${resolvedBy}${note ? `: ${String(note).slice(0, 500)}` : ""}`;
  db.prepare("UPDATE escrows SET status = ?, resolved_at = datetime(?), resolution = ? WHERE escrow_id = ?").run(outcome, "now", resolution, escrowId);
  res.json({ escrow_id: escrowId, status: outcome, resolved_by: resolvedBy, resolution, custodial: false, note: NON_CUSTODIAL_NOTE, message: "Disputed escrow resolved (advisory record; Palmyr moved no funds — settle on-chain directly)." });
});

router.get("/stats", (_req: Request, res: Response) => {
  const stats = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(amount_usdc),0) as total_volume_usdc FROM escrows").get();
  res.json({ escrow_stats: stats });
});

export default router;
