import { Router, Request, Response } from 'express';

const router = Router();

interface Alert {
  id: string;
  agentId: string;
  name: string;
  type: string;
  condition: { metric: string; operator: string; threshold: number };
  channels: string[];
  webhookUrl?: string;
  enabled: boolean;
  cooldownMinutes: number;
  lastTriggered: string | null;
  createdAt: string;
}

const alerts: Map<string, Alert> = new Map();
let counter = 0;

// Create alert rule
router.post('/', (req: Request, res: Response) => {
  const agentId = (req.headers['x-agent-id'] as string) || 'anonymous';
  const { name, type, condition, channels, webhookUrl, cooldownMinutes } = req.body;
  if (!name || !type || !condition || !channels) {
    res.status(400).json({ error: 'Missing required fields: name, type, condition, channels' });
    return;
  }
  const id = `alert_${++counter}_${Date.now()}`;
  const alert: Alert = {
    id, agentId, name, type, condition, channels,
    webhookUrl: webhookUrl || undefined,
    enabled: true,
    cooldownMinutes: cooldownMinutes || 15,
    lastTriggered: null,
    createdAt: new Date().toISOString()
  };
  alerts.set(id, alert);
  res.status(201).json({ alert });
});

// List alerts
router.get('/', (req: Request, res: Response) => {
  const agentId = (req.headers['x-agent-id'] as string) || 'anonymous';
  const type = req.query.type as string;
  let agentAlerts = Array.from(alerts.values()).filter(a => a.agentId === agentId);
  if (type) agentAlerts = agentAlerts.filter(a => a.type === type);
  res.json({ alerts: agentAlerts, total: agentAlerts.length });
});

// Preset templates — MUST be before /:id
router.get('/templates', (_req: Request, res: Response) => {
  res.json({
    templates: [
      { name: 'Budget Warning', type: 'billing', condition: { metric: 'monthly_spend_usdc', operator: 'gte', threshold: 50 }, channels: ['webhook', 'email'], cooldownMinutes: 60 },
      { name: 'High CPU', type: 'usage', condition: { metric: 'cpu_percent', operator: 'gte', threshold: 90 }, channels: ['webhook'], cooldownMinutes: 5 },
      { name: 'Service Down', type: 'health', condition: { metric: 'uptime_percent', operator: 'lt', threshold: 99 }, channels: ['webhook', 'phone'], cooldownMinutes: 1 },
      { name: 'Auth Failures', type: 'security', condition: { metric: 'failed_auth_count', operator: 'gte', threshold: 10 }, channels: ['webhook', 'email', 'sms'], cooldownMinutes: 15 },
      { name: 'API Latency Spike', type: 'health', condition: { metric: 'p95_latency_ms', operator: 'gte', threshold: 500 }, channels: ['webhook'], cooldownMinutes: 10 }
    ]
  });
});

// Toggle/update alert
router.patch('/:id', (req: Request, res: Response) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) { res.status(404).json({ error: 'Alert not found' }); return; }
  const agentId = (req.headers['x-agent-id'] as string) || 'anonymous';
  if (alert.agentId !== agentId) { res.status(403).json({ error: 'Not your alert' }); return; }
  if (req.body.enabled !== undefined) alert.enabled = req.body.enabled;
  if (req.body.cooldownMinutes) alert.cooldownMinutes = req.body.cooldownMinutes;
  if (req.body.condition) alert.condition = req.body.condition;
  if (req.body.channels) alert.channels = req.body.channels;
  res.json({ alert });
});

// Delete alert
router.delete('/:id', (req: Request, res: Response) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) { res.status(404).json({ error: 'Alert not found' }); return; }
  const agentId = (req.headers['x-agent-id'] as string) || 'anonymous';
  if (alert.agentId !== agentId) { res.status(403).json({ error: 'Not your alert' }); return; }
  alerts.delete(req.params.id as string);
  res.json({ deleted: true });
});

// Test alert trigger
router.post('/:id/test', (req: Request, res: Response) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) { res.status(404).json({ error: 'Alert not found' }); return; }
  alert.lastTriggered = new Date().toISOString();
  res.json({
    message: 'Test alert triggered',
    alert,
    simulated: { channels: alert.channels, payload: { alertName: alert.name, type: alert.type, triggeredAt: alert.lastTriggered } }
  });
});

export default router;
