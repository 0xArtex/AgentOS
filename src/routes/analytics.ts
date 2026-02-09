import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// GET /analytics - Platform analytics dashboard
router.get("/", async (req: Request, res: Response) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    // Requests by endpoint
    const byEndpoint = db
      .prepare(
        `SELECT method, endpoint, COUNT(*) as count,
         AVG(response_time_ms) as avg_response_ms
         FROM request_log WHERE created_at > ?
         GROUP BY method, endpoint ORDER BY count DESC LIMIT 20`
      )
      .all(since);

    // Requests by agent
    const byAgent = db
      .prepare(
        `SELECT agent_id, COUNT(*) as count
         FROM request_log WHERE created_at > ? AND agent_id IS NOT NULL
         GROUP BY agent_id ORDER BY count DESC LIMIT 20`
      )
      .all(since);

    // Requests by hour
    const byHour = db
      .prepare(
        `SELECT strftime('%Y-%m-%d %H:00', created_at) as hour, COUNT(*) as count
         FROM request_log WHERE created_at > ?
         GROUP BY hour ORDER BY hour DESC LIMIT 48`
      )
      .all(since);

    // Status code distribution
    const byStatus = db
      .prepare(
        `SELECT status_code, COUNT(*) as count
         FROM request_log WHERE created_at > ?
         GROUP BY status_code ORDER BY count DESC`
      )
      .all(since);

    // Total requests
    const total = db
      .prepare(`SELECT COUNT(*) as count FROM request_log WHERE created_at > ?`)
      .get(since) as any;

    res.json({
      window_hours: hours,
      since,
      total_requests: total?.count || 0,
      by_endpoint: byEndpoint,
      by_agent: byAgent,
      by_hour: byHour,
      by_status: byStatus,
    });
  } catch (error: any) {
    res.json({
      window_hours: 24,
      total_requests: 0,
      by_endpoint: [],
      by_agent: [],
      by_hour: [],
      by_status: [],
      note: "Analytics requires request logging middleware",
    });
  }
});

export default router;
