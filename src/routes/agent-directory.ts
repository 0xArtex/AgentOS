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

  // Pagination: ?limit= (default 50, hard-cap 200) + ?cursor= (the `id` of the
  // last agent from the previous page). Keyset pagination under a fixed
  // ORDER BY id DESC — `id` is the PRIMARY KEY so the cursor is stable.
  // Backward-compatible: with no query params this still returns the first
  // page of agents under the `agents` key, just capped at 50.
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;
  const cursor = (req.query.cursor as string) || undefined;

  // Fetch one extra row to detect whether a further page exists.
  const fetch = limit + 1;
  const like = `%${search}%`;

  let rows: Array<{ id: string; name: string; description: string | null; created_at: string }>;
  if (search) {
    rows = cursor
      ? (db
          .prepare(
            'SELECT id, name, description, created_at FROM agents WHERE (name LIKE ? OR description LIKE ?) AND id < ? ORDER BY id DESC LIMIT ?'
          )
          .all(like, like, cursor, fetch) as any[])
      : (db
          .prepare(
            'SELECT id, name, description, created_at FROM agents WHERE name LIKE ? OR description LIKE ? ORDER BY id DESC LIMIT ?'
          )
          .all(like, like, fetch) as any[]);
  } else {
    rows = cursor
      ? (db
          .prepare('SELECT id, name, description, created_at FROM agents WHERE id < ? ORDER BY id DESC LIMIT ?')
          .all(cursor, fetch) as any[])
      : (db.prepare('SELECT id, name, description, created_at FROM agents ORDER BY id DESC LIMIT ?').all(fetch) as any[]);
  }

  const hasMore = rows.length > limit;
  const agents = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? agents[agents.length - 1].id : null;

  res.json({
    total: agents.length,
    agents,
    limit,
    next_cursor: nextCursor,
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
