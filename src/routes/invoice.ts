import { Router, Response } from "express";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";

const router = Router();

// Every route requires a verified identity. requireAuth(0) lets registered
// agents (token / X-Agent-Id) and x402 payers through for free and sets
// req.agentId to the VERIFIED wallet identity — never the raw X-Agent-Id header,
// which a caller could otherwise forge to read/modify another agent's invoices.
router.use(requireAuth(0, "general"));

// Identifiers were previously unquoted in the DDL/DML (DEFAULT USDC,
// datetime(now), SET status = paid), so SQLite parsed them as bare column
// references and every call 500'd. String literals must be single-quoted and the
// SQLite datetime() function takes the modifier 'now' as a quoted string.
function ensureTable(): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, agent_id TEXT, recipient TEXT, items TEXT,
    total REAL, currency TEXT DEFAULT 'USDC', status TEXT DEFAULT 'pending',
    due_date TEXT, notes TEXT, created_at TEXT, paid_at TEXT
  )`).run();
}

// Create invoice
router.post("/", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) return res.status(401).json({ error: "authentication required" });

  const { recipient, items, currency, due_date, notes } = req.body || {};
  if (!recipient || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "recipient and items[] required" });
  }

  const total = items.reduce((sum: number, i: any) => sum + (i.quantity || 1) * (i.unit_price || 0), 0);
  const invoiceId = `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    ensureTable();
    db.prepare(`
      INSERT INTO invoices (id, agent_id, recipient, items, total, currency, status, due_date, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(invoiceId, agentId, recipient, JSON.stringify(items), total, currency || "USDC", "pending", due_date || null, notes || null);

    res.status(201).json({
      invoice_id: invoiceId,
      agent_id: agentId,
      recipient,
      items,
      total,
      currency: currency || "USDC",
      status: "pending",
      due_date: due_date || null,
      notes: notes || null,
      created_at: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List invoices for the authenticated agent only
router.get("/", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) return res.status(401).json({ error: "authentication required" });

  try {
    ensureTable();

    const status = req.query.status as string;
    let rows;
    if (status) {
      rows = db.prepare("SELECT * FROM invoices WHERE agent_id = ? AND status = ? ORDER BY created_at DESC").all(agentId, status);
    } else {
      rows = db.prepare("SELECT * FROM invoices WHERE agent_id = ? ORDER BY created_at DESC").all(agentId);
    }

    const invoices = (rows as any[]).map((r: any) => ({ ...r, items: JSON.parse(r.items) }));
    res.json({ invoices, count: invoices.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Mark invoice as paid — scoped to the owning agent
router.post("/:id/pay", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) return res.status(401).json({ error: "authentication required" });

  try {
    ensureTable();
    const { tx_signature } = req.body || {};
    const result = db.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND agent_id = ?").run(req.params.id, agentId);
    if ((result as any).changes === 0) return res.status(404).json({ error: "Invoice not found" });
    res.json({ invoice_id: req.params.id, status: "paid", tx_signature: tx_signature || null, paid_at: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
