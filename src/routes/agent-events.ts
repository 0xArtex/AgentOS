import { Router, Request, Response } from 'express';
const router = Router();

interface AgentEvent {
  id: string;
  type: string;
  agentId: string;
  timestamp: string;
  data: Record<string, unknown>;
  severity: 'info' | 'warning' | 'critical';
}

const recentEvents: AgentEvent[] = [
  { id: 'evt-001', type: 'agent.registered', agentId: 'agent-demo-001', timestamp: new Date(Date.now() - 3600000).toISOString(), data: { services: ['phone', 'email', 'compute'] }, severity: 'info' },
  { id: 'evt-002', type: 'phone.provisioned', agentId: 'agent-demo-001', timestamp: new Date(Date.now() - 3000000).toISOString(), data: { number: '+1-555-0142', region: 'US' }, severity: 'info' },
  { id: 'evt-003', type: 'compute.scaled', agentId: 'agent-sugar-001', timestamp: new Date(Date.now() - 2400000).toISOString(), data: { from: '1x', to: '4x', reason: 'traffic spike' }, severity: 'warning' },
  { id: 'evt-004', type: 'email.bounced', agentId: 'agent-varuna-001', timestamp: new Date(Date.now() - 1800000).toISOString(), data: { to: 'invalid@nowhere.test', reason: 'mailbox not found' }, severity: 'warning' },
  { id: 'evt-005', type: 'health.check.passed', agentId: 'agent-demo-001', timestamp: new Date(Date.now() - 600000).toISOString(), data: { latency: '45ms', services: 4, allHealthy: true }, severity: 'info' },
  { id: 'evt-006', type: 'rate.limit.warning', agentId: 'agent-unbrowse-001', timestamp: new Date(Date.now() - 300000).toISOString(), data: { endpoint: '/api/compute/run', usage: '85%', limit: '1000/hour' }, severity: 'warning' },
  { id: 'evt-007', type: 'payment.received', agentId: 'agent-identity-001', timestamp: new Date(Date.now() - 120000).toISOString(), data: { amount: 2.50, currency: 'USDC', tx: 'demo-tx-hash' }, severity: 'info' },
];

// Get event stream
router.get('/', (req: Request, res: Response) => {
  const { type, severity, agentId, limit } = req.query;
  let filtered = [...recentEvents];
  if (type) filtered = filtered.filter(e => e.type === String(type));
  if (severity) filtered = filtered.filter(e => e.severity === String(severity));
  if (agentId) filtered = filtered.filter(e => e.agentId === String(agentId));
  const max = Math.min(Number(limit) || 50, 100);
  filtered = filtered.slice(0, max);

  res.json({
    events: {
      description: 'Real-time agent event stream — monitor all activity across your AgentOS services',
      total: filtered.length,
      supportedTypes: [
        'agent.registered', 'agent.deactivated',
        'phone.provisioned', 'phone.call.received', 'phone.sms.received',
        'email.sent', 'email.received', 'email.bounced',
        'compute.started', 'compute.completed', 'compute.scaled', 'compute.failed',
        'domain.registered', 'domain.dns.updated',
        'health.check.passed', 'health.check.failed',
        'rate.limit.warning', 'rate.limit.exceeded',
        'payment.received', 'payment.failed',
        'webhook.delivered', 'webhook.failed'
      ],
      items: filtered
    },
    _links: {
      filter: 'GET /api/agent-events?type=phone.provisioned&severity=warning',
      subscribe: 'POST /api/agent-webhooks (register webhook for real-time event delivery)',
      docs: 'http://77.42.89.233:3001/docs'
    }
  });
});

// Get events for specific agent
router.get('/agent/:agentId', (req: Request, res: Response) => {
  const events = recentEvents.filter(e => e.agentId === req.params.agentId);
  res.json({ agentId: req.params.agentId, events, total: events.length });
});

// Get event types summary
router.get('/types', (_req: Request, res: Response) => {
  const typeCounts: Record<string, number> = {};
  recentEvents.forEach(e => { typeCounts[e.type] = (typeCounts[e.type] || 0) + 1; });
  res.json({ eventTypes: typeCounts, total: recentEvents.length });
});

export default router;
