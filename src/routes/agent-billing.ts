import { Router, Request, Response } from "express";
const router = Router();

interface UsageRecord {
  service: string;
  units: number;
  unitPrice: number;
  total: number;
  period: string;
}

interface Invoice {
  id: string;
  agentId: string;
  period: string;
  items: UsageRecord[];
  subtotal: number;
  discount: number;
  total: number;
  status: "paid" | "pending" | "overdue";
  issuedAt: string;
  dueAt: string;
}

// GET /api/agent-billing — billing overview
router.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "agent-billing",
    description: "Usage-based billing and invoice management for AI agents",
    pricing: {
      phone: { unit: "minute", price: 0.02, currency: "USDC" },
      email: { unit: "message", price: 0.001, currency: "USDC" },
      compute: { unit: "hour", price: 0.05, currency: "USDC" },
      domains: { unit: "month", price: 1.0, currency: "USDC" },
      storage: { unit: "GB/month", price: 0.01, currency: "USDC" },
      webhooks: { unit: "delivery", price: 0.0001, currency: "USDC" }
    },
    hackathon: {
      status: "FREE",
      until: "2026-02-12T17:00:00Z",
      note: "All services free during Colosseum hackathon with X-Agent-Id header"
    },
    endpoints: [
      "GET /api/agent-billing — this overview",
      "GET /api/agent-billing/usage/:agentId — current period usage",
      "GET /api/agent-billing/invoices/:agentId — invoice history",
      "GET /api/agent-billing/estimate — cost estimator"
    ]
  });
});

// GET /api/agent-billing/usage/:agentId
router.get("/usage/:agentId", (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  
  const usage: UsageRecord[] = [
    { service: "phone", units: 142, unitPrice: 0.02, total: 2.84, period: periodStart },
    { service: "email", units: 1893, unitPrice: 0.001, total: 1.89, period: periodStart },
    { service: "compute", units: 67, unitPrice: 0.05, total: 3.35, period: periodStart },
    { service: "storage", units: 2.4, unitPrice: 0.01, total: 0.024, period: periodStart },
    { service: "webhooks", units: 4521, unitPrice: 0.0001, total: 0.45, period: periodStart }
  ];

  const subtotal = usage.reduce((sum, u) => sum + u.total, 0);
  
  res.json({
    agentId,
    period: { start: periodStart, end: now.toISOString() },
    usage,
    subtotal: Math.round(subtotal * 100) / 100,
    hackathonDiscount: subtotal > 0 ? "100% — FREE during hackathon" : "N/A",
    amountDue: 0
  });
});

// GET /api/agent-billing/invoices/:agentId
router.get("/invoices/:agentId", (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  
  const invoices: any[] = [
    {
      id: `INV-${agentId.slice(0, 8)}-202602`,
      agentId,
      period: "2026-02",
      items: [
        { service: "phone", units: 142, unitPrice: 0.02, total: 2.84, period: "2026-02" },
        { service: "email", units: 1893, unitPrice: 0.001, total: 1.89, period: "2026-02" },
        { service: "compute", units: 67, unitPrice: 0.05, total: 3.35, period: "2026-02" }
      ],
      subtotal: 8.08,
      discount: 8.08,
      total: 0,
      status: "paid",
      issuedAt: "2026-02-01T00:00:00Z",
      dueAt: "2026-03-01T00:00:00Z"
    }
  ];

  res.json({ agentId, invoices, note: "All invoices $0 during hackathon period" });
});

// GET /api/agent-billing/estimate
router.get("/estimate", (req: Request, res: Response) => {
  const phones = parseInt(String(req.query.phone_minutes || 0)) || 0;
  const emails = parseInt(String(req.query.emails || 0)) || 0;
  const compute = parseInt(String(req.query.compute_hours || 0)) || 0;
  const storage = parseFloat(String(req.query.storage_gb || 0)) || 0;
  const webhooks = parseInt(String(req.query.webhooks || 0)) || 0;

  const breakdown = {
    phone: { units: phones, rate: 0.02, cost: Math.round(phones * 0.02 * 100) / 100 },
    email: { units: emails, rate: 0.001, cost: Math.round(emails * 0.001 * 1000) / 1000 },
    compute: { units: compute, rate: 0.05, cost: Math.round(compute * 0.05 * 100) / 100 },
    storage: { units: storage, rate: 0.01, cost: Math.round(storage * 0.01 * 100) / 100 },
    webhooks: { units: webhooks, rate: 0.0001, cost: Math.round(webhooks * 0.0001 * 10000) / 10000 }
  };

  const total = Object.values(breakdown).reduce((sum, b) => sum + b.cost, 0);

  res.json({
    estimate: breakdown,
    monthly_total: Math.round(total * 100) / 100,
    currency: "USDC",
    hackathon_price: 0,
    note: "Free during Colosseum hackathon (until Feb 12, 2026)"
  });
});

export default router;
