import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';

const router = Router();

// Every route requires a VERIFIED identity. requireAuth(0) sets req.agentId to
// the verified wallet identity (never the raw X-Agent-Id header), so a caller
// can no longer read or overwrite another agent's stored config / PII by
// spoofing a header — the store is keyed on req.agentId.
router.use(requireAuth(0, 'general'));

// Agent configuration management
interface AgentConfig {
  webhookUrl?: string;
  alertEmail?: string;
  alertPhone?: string;
  logLevel?: string;
  autoScale?: boolean;
  maxBudgetUsdc?: number;
  timezone?: string;
  tags?: string[];
}

const configs: Record<string, AgentConfig> = {};

// GET /api/config - Get agent config
router.get('/', (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: 'authentication required' }); return; }
  const config = configs[agentId] || {};
  res.json({
    agentId,
    config,
    defaults: {
      logLevel: 'info',
      autoScale: false,
      maxBudgetUsdc: 100,
      timezone: 'UTC',
    },
    updatedAt: new Date().toISOString(),
  });
});

// PUT /api/config - Update agent config
router.put('/', (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: 'authentication required' }); return; }
  const allowed = ['webhookUrl', 'alertEmail', 'alertPhone', 'logLevel', 'autoScale', 'maxBudgetUsdc', 'timezone', 'tags'];
  const update: any = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  configs[agentId] = { ...(configs[agentId] || {}), ...update };
  res.json({
    agentId,
    config: configs[agentId],
    message: 'Configuration updated',
    updatedAt: new Date().toISOString(),
  });
});

// DELETE /api/config - Reset agent config
router.delete('/', (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: 'authentication required' }); return; }
  delete configs[agentId];
  res.json({ agentId, message: 'Configuration reset to defaults' });
});

export default router;
