import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// GET /api/agent-changelog/:agentId - Per-agent activity timeline
router.get("/:agentId", async (req: Request, res: Response) => {
  const { agentId } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  

  try {
    // Gather events from multiple tables
    const events: any[] = [];

    // Resources provisioned
    const resources = db.prepare(
      `SELECT type, status, created_at FROM resources WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(agentId, limit) as any[];
    
    for (const r of resources) {
      events.push({
        type: "resource_provisioned",
        detail: `${r.type} provisioned (${r.status})`,
        timestamp: r.created_at
      });
    }

    // API requests
    const requests = db.prepare(
      `SELECT method, path, status_code, created_at FROM request_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(agentId, limit) as any[];

    for (const r of requests) {
      events.push({
        type: "api_request",
        detail: `${r.method} ${r.path} → ${r.status_code}`,
        timestamp: r.created_at
      });
    }

    // Sort by timestamp desc
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json({
      agentId,
      totalEvents: events.length,
      events: events.slice(0, limit),
      generatedAt: new Date().toISOString()
    });
  } catch (err: any) {
    res.json({
      agentId,
      totalEvents: 0,
      events: [],
      note: "No activity recorded yet",
      generatedAt: new Date().toISOString()
    });
  }
});

export default router;
