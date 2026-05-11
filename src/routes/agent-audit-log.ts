import { Router, Request, Response } from 'express';

const router = Router();

router.get('/api/agent-audit-log', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string || 'anonymous';
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const service = req.query.service as string;
  const now = Date.now();

  const sampleEvents = [
    { action: 'phone.provision', service: 'phone', status: 'success', durationMs: 1200, details: 'Provisioned +1-555-0142' },
    { action: 'email.send', service: 'email', status: 'success', durationMs: 340, details: 'Sent to partner@example.com' },
    { action: 'compute.exec', service: 'compute', status: 'success', durationMs: 2100, details: 'Executed task: data-analysis-v3' },
    { action: 'auth.token_refresh', service: 'auth', status: 'success', durationMs: 45, details: 'Token refreshed' },
    { action: 'storage.upload', service: 'storage', status: 'success', durationMs: 890, details: 'Uploaded 2.3MB to /agent-data/' },
    { action: 'payment.x402', service: 'payments', status: 'success', durationMs: 2300, details: '0.50 USDC via x402 (Solana)' },
    { action: 'domain.dns_update', service: 'domains', status: 'success', durationMs: 560, details: 'A record updated for agent.palmyr.ai' },
    { action: 'webhook.fire', service: 'notifications', status: 'success', durationMs: 120, details: 'Webhook delivered to callback URL' },
  ];

  let events = sampleEvents.map((e, i) => ({
    id: `evt_${(now - i * 300000).toString(36)}`,
    timestamp: new Date(now - i * 300000).toISOString(),
    agentId,
    ...e,
    ipAddress: '***.***.***',
    cost: 0.00,
    note: 'Builder program — no charge'
  }));

  if (service) {
    events = events.filter(e => e.service === service);
  }

  res.json({
    agentId,
    period: { from: new Date(now - 86400000).toISOString(), to: new Date(now).toISOString() },
    totalEvents: events.length,
    events: events.slice(0, limit),
    filters: { service: service || 'all', limit },
    availableServices: ['phone', 'email', 'compute', 'storage', 'payments', 'domains', 'auth', 'notifications'],
    exportFormats: ['json', 'csv'],
    note: 'Audit logs retained for 90 days. Use ?service=phone to filter by service.'
  });
});

export default router;
