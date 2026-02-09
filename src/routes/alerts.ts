import { Router, Request, Response } from "express";

const router = Router();

interface Alert {
  id: string;
  agentId: string;
  name: string;
  condition: string;
  threshold: number;
  channel: "webhook" | "email" | "sms";
  target: string;
  enabled: boolean;
  triggered: number;
  lastTriggered: string | null;
  createdAt: string;
}

const alertStore: Map<string, Alert[]> = new Map();

// POST /api/alerts - create an alert rule
router.post("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  const { name, condition, threshold, channel, target } = req.body;

  if (!name || !condition || !channel || !target) {
    return res.status(400).json({
      error: "Missing required fields: name, condition, channel, target",
      example: {
        name: "High Error Rate",
        condition: "error_rate_percent",
        threshold: 5,
        channel: "webhook",
        target: "https://your-agent.com/alerts"
      }
    });
  }

  const validConditions = [
    "error_rate_percent", "latency_ms", "requests_per_minute",
    "storage_percent", "compute_cpu_percent", "spend_usd_daily"
  ];

  if (!validConditions.includes(condition)) {
    return res.status(400).json({
      error: `Invalid condition. Valid: ${validConditions.join(", ")}`
    });
  }

  const alert: Alert = {
    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    name,
    condition,
    threshold: threshold || 0,
    channel,
    target,
    enabled: true,
    triggered: 0,
    lastTriggered: null,
    createdAt: new Date().toISOString()
  };

  const agentAlerts = alertStore.get(agentId) || [];
  agentAlerts.push(alert);
  alertStore.set(agentId, agentAlerts);

  res.status(201).json({ alert, message: "Alert rule created" });
});

// GET /api/alerts - list your alert rules
router.get("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  const alerts = alertStore.get(agentId) || [];

  res.json({
    agentId,
    alerts,
    total: alerts.length,
    availableConditions: [
      { name: "error_rate_percent", description: "Alert when error rate exceeds threshold %" },
      { name: "latency_ms", description: "Alert when API latency exceeds threshold ms" },
      { name: "requests_per_minute", description: "Alert when RPM exceeds threshold" },
      { name: "storage_percent", description: "Alert when storage usage exceeds threshold %" },
      { name: "compute_cpu_percent", description: "Alert when compute CPU exceeds threshold %" },
      { name: "spend_usd_daily", description: "Alert when daily USDC spend exceeds threshold" }
    ]
  });
});

// DELETE /api/alerts/:id - delete an alert rule
router.delete("/:id", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  const alerts = alertStore.get(agentId) || [];
  const idx = alerts.findIndex(a => a.id === req.params.id);

  if (idx === -1) {
    return res.status(404).json({ error: "Alert not found" });
  }

  alerts.splice(idx, 1);
  alertStore.set(agentId, alerts);
  res.json({ message: "Alert deleted", remaining: alerts.length });
});

// PATCH /api/alerts/:id - toggle alert enabled/disabled
router.patch("/:id", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  const alerts = alertStore.get(agentId) || [];
  const alert = alerts.find(a => a.id === req.params.id);

  if (!alert) {
    return res.status(404).json({ error: "Alert not found" });
  }

  if (req.body.enabled !== undefined) alert.enabled = req.body.enabled;
  if (req.body.threshold !== undefined) alert.threshold = req.body.threshold;
  if (req.body.name) alert.name = req.body.name;

  res.json({ alert, message: "Alert updated" });
});

export default router;
