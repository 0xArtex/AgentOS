import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';

const router = Router();

// Every route requires a VERIFIED identity. requireAuth(0,"general") lets
// registered agents (aos_/agt_ token, or an X-Agent-Id that resolves to a
// registered agent) and x402 payers through for free, and sets req.agentId to
// the verified wallet identity — NEVER the raw, spoofable X-Agent-Id header.
// Keying the store on req.agentId is what blocks the cross-tenant
// read/overwrite/delete this route previously allowed.
router.use(requireAuth(0, 'general'));

interface EnvVar {
  key: string;
  value: string;
  scope: 'runtime' | 'build' | 'global';
  sensitive: boolean;
  agentId: string;
  createdAt: string;
  updatedAt: string;
}

// In-process store. Note on "encryption at rest": this Map is never persisted
// to disk, so there is no at-rest surface to encrypt — the value and any key
// would live in the same process memory, giving no real protection. Sensitive
// values are additionally masked ('***') in every API response, so they are
// never returned over the wire. The exploitable bug here was identity spoofing
// (fixed by requireAuth above); durable, disk-encrypted secrets belong in
// agent-secrets.ts (AES-256-GCM, keyed on SECRETS_MASTER_KEY).
const envStore: Map<string, EnvVar[]> = new Map();

// Set env var
router.post('/', (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: 'authentication required' }); return; }
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
router.get('/', (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: 'authentication required' }); return; }
  const scope = req.query.scope as string;
  let vars = envStore.get(agentId) || [];
  if (scope) vars = vars.filter(v => v.scope === scope);
  res.json({ agentId, count: vars.length, env: vars.map(v => ({ ...v, value: v.sensitive ? '***' : v.value })) });
});

// Get single env var
router.get('/:key', (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: 'authentication required' }); return; }
  const vars = envStore.get(agentId) || [];
  const v = vars.find(e => e.key === req.params.key);
  if (!v) { res.status(404).json({ error: 'Env var not found' }); return; }
  res.json({ env: { ...v, value: v.sensitive ? '***' : v.value } });
});

// Delete env var
router.delete('/:key', (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: 'authentication required' }); return; }
  const vars = envStore.get(agentId) || [];
  const idx = vars.findIndex(e => e.key === req.params.key);
  if (idx < 0) { res.status(404).json({ error: 'Env var not found' }); return; }
  vars.splice(idx, 1);
  envStore.set(agentId, vars);
  res.json({ success: true, deleted: req.params.key });
});

export default router;
