import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

/**
 * GET /api/agent-directory — list REAL registered agents.
 *
 * Previously backed by an in-memory Map that was lost on every restart. Now
 * reads the persistent `agents` table, the same source as /agents.
 */
router.get('/', (req: Request, res: Response) => {
  const search = (req.query.search as string) || '';

  const rows = search
    ? db
        .prepare(
          'SELECT id, name, description, created_at FROM agents WHERE name LIKE ? OR description LIKE ? LIMIT 100'
        )
        .all(`%${search}%`, `%${search}%`)
    : db.prepare('SELECT id, name, description, created_at FROM agents LIMIT 100').all();

  res.json({
    total: rows.length,
    agents: rows,
    register: 'POST /agents/register',
    search_params: '?search=keyword',
  });
});

/**
 * POST /api/agent-directory — RETIRED (registrations never persisted).
 *
 * This used to store agents in an in-memory Map and reply "registered" even
 * though the entry vanished on restart. The real, persistent registry is
 * POST /agents/register.
 */
router.post('/', (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Gone',
    message: 'This directory never persisted registrations. Use the real registry.',
    registerAt: 'POST /agents/register',
    hint: 'POST /agents/register with a Solana walletAddress + name to receive an aos_ token.',
  });
});

export default router;
