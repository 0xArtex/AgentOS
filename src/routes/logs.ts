import { Router, Request, Response } from 'express';

const router = Router();

interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  metadata?: Record<string, any>;
  timestamp: string;
  agentId: string;
}

const agentLogs: Map<string, LogEntry[]> = new Map();
const MAX_LOGS_PER_AGENT = 500;

// POST /api/logs - Submit log entries
router.post('/', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) {
    return res.status(401).json({ error: 'X-Agent-Id header required' });
  }

  const { level, message, metadata } = req.body;

  if (!level || !message) {
    return res.status(400).json({ error: 'level and message required' });
  }

  if (!['info', 'warn', 'error', 'debug'].includes(level)) {
    return res.status(400).json({ error: 'level must be info|warn|error|debug' });
  }

  const entry: LogEntry = {
    level,
    message: String(message).slice(0, 2000),
    metadata: metadata || undefined,
    timestamp: new Date().toISOString(),
    agentId,
  };

  if (!agentLogs.has(agentId)) {
    agentLogs.set(agentId, []);
  }

  const logs = agentLogs.get(agentId)!;
  logs.push(entry);

  // Trim old logs
  if (logs.length > MAX_LOGS_PER_AGENT) {
    logs.splice(0, logs.length - MAX_LOGS_PER_AGENT);
  }

  res.json({
    success: true,
    stored: entry,
    total: logs.length,
  });
});

// GET /api/logs - Retrieve your logs
router.get('/', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) {
    return res.status(401).json({ error: 'X-Agent-Id header required' });
  }

  const level = req.query.level as string;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const since = req.query.since as string;

  let logs = agentLogs.get(agentId) || [];

  if (level) {
    logs = logs.filter(l => l.level === level);
  }

  if (since) {
    logs = logs.filter(l => l.timestamp > since);
  }

  const result = logs.slice(-limit);

  res.json({
    agentId,
    logs: result,
    total: result.length,
    filters: { level: level || 'all', limit, since: since || 'none' },
  });
});

// GET /api/logs/stats - Log statistics
router.get('/stats', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) {
    return res.status(401).json({ error: 'X-Agent-Id header required' });
  }

  const logs = agentLogs.get(agentId) || [];
  const counts = { info: 0, warn: 0, error: 0, debug: 0 };
  logs.forEach(l => counts[l.level]++);

  res.json({
    agentId,
    total: logs.length,
    byLevel: counts,
    oldest: logs[0]?.timestamp || null,
    newest: logs[logs.length - 1]?.timestamp || null,
  });
});

// DELETE /api/logs - Clear your logs
router.delete('/', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) {
    return res.status(401).json({ error: 'X-Agent-Id header required' });
  }

  const count = (agentLogs.get(agentId) || []).length;
  agentLogs.delete(agentId);

  res.json({
    success: true,
    cleared: count,
  });
});

export default router;
