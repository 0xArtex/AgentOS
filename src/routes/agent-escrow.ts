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
  res.json({ escrow_id: escrowId, status: "disputed", reason, message: "Escrow disputed." });
});

router.get("/stats", (_req: Request, res: Response) => {
  const stats = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(amount_usdc),0) as total_volume_usdc FROM escrows").get();
  res.json({ escrow_stats: stats });
});

export default router;
