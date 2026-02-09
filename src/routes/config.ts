import { Router, Request, Response } from 'express';

const router = Router();

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
router.get('/', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string || 'anonymous';
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
router.put('/', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) {
    return res.status(401).json({ error: 'X-Agent-Id header required' });
  }
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
router.delete('/', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) {
    return res.status(401).json({ error: 'X-Agent-Id header required' });
  }
  delete configs[agentId];
  res.json({ agentId, message: 'Configuration reset to defaults' });
});

export default router;
