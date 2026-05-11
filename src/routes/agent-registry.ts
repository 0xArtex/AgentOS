import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

// Ensure table exists
db.prepare(`
  CREATE TABLE IF NOT EXISTS agent_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    capabilities TEXT,
    endpoint_url TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

router.get('/api/agent-registry', (_req: Request, res: Response) => {
  const agents = db.prepare('SELECT * FROM agent_registry ORDER BY last_seen DESC LIMIT 50').all();
  res.json({
    service: 'Palmyr Agent Registry',
    description: 'Decentralized agent discovery — register your agent, find collaborators',
    total: agents.length,
    agents,
    endpoints: {
      register: 'POST /api/agent-registry',
      list: 'GET /api/agent-registry',
      heartbeat: 'POST /api/agent-registry/:id/heartbeat',
      search: 'GET /api/agent-registry/search?q=keyword'
    }
  });
});

router.post('/api/agent-registry', (req: Request, res: Response) => {
  const { name, description, capabilities, endpoint_url } = req.body;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  const result = db.prepare(
    'INSERT INTO agent_registry (name, description, capabilities, endpoint_url) VALUES (?, ?, ?, ?)'
  ).run(name, description || '', JSON.stringify(capabilities || []), endpoint_url || '');
  res.status(201).json({ message: `Agent "${name}" registered`, id: result.lastInsertRowid });
});

router.post('/api/agent-registry/:id/heartbeat', (req: Request, res: Response) => {
  db.prepare('UPDATE agent_registry SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ status: 'alive', id: req.params.id });
});

router.get('/api/agent-registry/search', (req: Request, res: Response) => {
  const q = (req.query.q as string || '').toLowerCase();
  const agents = db.prepare(
    'SELECT * FROM agent_registry WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(capabilities) LIKE ? ORDER BY last_seen DESC LIMIT 20'
  ).all(`%${q}%`, `%${q}%`, `%${q}%`);
  res.json({ query: q, results: agents });
});

export default router;
