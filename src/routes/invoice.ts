import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// Create invoice
router.post("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const { recipient, items, currency, due_date, notes } = req.body;
  if (!recipient || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "recipient and items[] required" });
  }

  const total = items.reduce((sum: number, i: any) => sum + (i.quantity || 1) * (i.unit_price || 0), 0);
  const invoiceId = `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const stmt = db.prepare(`
    INSERT INTO invoices (id, agent_id, recipient, items, total, currency, status, due_date, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(now))
  `);

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, agent_id TEXT, recipient TEXT, items TEXT,
      total REAL, currency TEXT DEFAULT USDC, status TEXT DEFAULT pending,
      due_date TEXT, notes TEXT, created_at TEXT, paid_at TEXT
    )`).run();

    stmt.run(invoiceId, agentId, recipient, JSON.stringify(items), total, currency || "USDC", "pending", due_date || null, notes || null);

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

// List invoices for agent
router.get("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, agent_id TEXT, recipient TEXT, items TEXT,
      total REAL, currency TEXT DEFAULT USDC, status TEXT DEFAULT pending,
      due_date TEXT, notes TEXT, created_at TEXT, paid_at TEXT
    )`).run();

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

// Mark invoice as paid
router.post("/:id/pay", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  try {
    const { tx_signature } = req.body;
    const result = db.prepare("UPDATE invoices SET status = paid, paid_at = datetime(now) WHERE id = ? AND agent_id = ?").run(req.params.id, agentId);
    if ((result as any).changes === 0) return res.status(404).json({ error: "Invoice not found" });
    res.json({ invoice_id: req.params.id, status: "paid", tx_signature: tx_signature || null, paid_at: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
