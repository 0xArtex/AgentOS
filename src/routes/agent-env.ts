import { Router, Request, Response } from 'express';
const router = Router();

interface EnvVar {
  key: string;
  value: string;
  scope: 'runtime' | 'build' | 'global';
  sensitive: boolean;
  agentId: string;
  createdAt: string;
  updatedAt: string;
}

const envStore: Map<string, EnvVar[]> = new Map();

// Set env var
router.post('/', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) { res.status(401).json({ error: 'X-Agent-Id header required' }); return; }
  const { key, value, scope = 'runtime', sensitive = false } = req.body;
  if (!key || value === undefined) { res.status(400).json({ error: 'key and value required' }); return; }
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) { res.status(400).json({ error: 'Invalid env var name' }); return; }

  const vars = envStore.get(agentId) || [];
  const existing = vars.findIndex(v => v.key === key);
  const envVar: EnvVar = { key, value, scope: scope as EnvVar['scope'], sensitive, agentId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (existing >= 0) { envVar.createdAt = vars[existing].createdAt; vars[existing] = envVar; }
  else { vars.push(envVar); }
  envStore.set(agentId, vars);
  res.json({ success: true, env: { ...envVar, value: sensitive ? '***' : value } });
});

// List env vars
router.get('/', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) { res.status(401).json({ error: 'X-Agent-Id header required' }); return; }
  const scope = req.query.scope as string;
  let vars = envStore.get(agentId) || [];
  if (scope) vars = vars.filter(v => v.scope === scope);
  res.json({ agentId, count: vars.length, env: vars.map(v => ({ ...v, value: v.sensitive ? '***' : v.value })) });
});

// Get single env var
router.get('/:key', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) { res.status(401).json({ error: 'X-Agent-Id header required' }); return; }
  const vars = envStore.get(agentId) || [];
  const v = vars.find(e => e.key === req.params.key);
  if (!v) { res.status(404).json({ error: 'Env var not found' }); return; }
  res.json({ env: { ...v, value: v.sensitive ? '***' : v.value } });
});

// Delete env var
router.delete('/:key', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string;
  if (!agentId) { res.status(401).json({ error: 'X-Agent-Id header required' }); return; }
  const vars = envStore.get(agentId) || [];
  const idx = vars.findIndex(e => e.key === req.params.key);
  if (idx < 0) { res.status(404).json({ error: 'Env var not found' }); return; }
  vars.splice(idx, 1);
  envStore.set(agentId, vars);
  res.json({ success: true, deleted: req.params.key });
});

export default router;
