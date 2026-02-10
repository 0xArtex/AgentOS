import { Router, Request, Response } from "express";

const router = Router();

interface AgentEvent {
  id: string;
  agentId: string;
  type: string;
  payload: any;
  timestamp: string;
}

const events: AgentEvent[] = [];

// POST /api/events - publish an event
router.post("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const { type, payload } = req.body;
  if (!type) return res.status(400).json({ error: "type field required" });

  const event: AgentEvent = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    type,
    payload: payload || {},
    timestamp: new Date().toISOString()
  };

  events.push(event);
  if (events.length > 1000) events.splice(0, events.length - 1000);

  res.status(201).json({ event });
});

// GET /api/events - subscribe/poll events
router.get("/", (req: Request, res: Response) => {
  const { type, since, limit } = req.query;
  let filtered = [...events];

  if (type) filtered = filtered.filter(e => e.type === String(type));
  if (since) filtered = filtered.filter(e => e.timestamp > String(since));

  const max = Math.min(Number(limit) || 50, 100);
  filtered = filtered.slice(-max);

  res.json({
    events: filtered,
    total: filtered.length,
    earliest: filtered[0]?.timestamp || null,
    latest: filtered[filtered.length - 1]?.timestamp || null
  });
});

// GET /api/events/types - list known event types
router.get("/types", (_req: Request, res: Response) => {
  const types = [...new Set(events.map(e => e.type))];
  res.json({ types, total: types.length });
});

export default router;
