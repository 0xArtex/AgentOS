import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";

const router = Router();
const db = new Database(path.join(__dirname, "../../data/health-monitor.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS health_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    service TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT "healthy",
    latency_ms INTEGER,
    error_message TEXT,
    metadata TEXT,
    checked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_health_agent ON health_checks(agent_id);
  CREATE INDEX IF NOT EXISTS idx_health_service ON health_checks(service);
`);

// POST /api/health-monitor/check - Report a health check
router.post("/check", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  const { service, status, latency_ms, error_message, metadata } = req.body;

  if (!service) {
    return res.status(400).json({ error: "service is required" });
  }

  const validStatuses = ["healthy", "degraded", "down", "unknown"];
  const checkStatus = validStatuses.includes(status) ? status : "healthy";

  const stmt = db.prepare(
    "INSERT INTO health_checks (agent_id, service, status, latency_ms, error_message, metadata) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const result = stmt.run(agentId, service, checkStatus, latency_ms || null, error_message || null, metadata ? JSON.stringify(metadata) : null);

  res.status(201).json({
    id: result.lastInsertRowid,
    agent_id: agentId,
    service,
    status: checkStatus,
    recorded: true
  });
});

// GET /api/health-monitor/status - Get current health status for an agent
router.get("/status", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || req.query.agent_id as string;

  if (!agentId) {
    return res.status(400).json({ error: "agent_id required (header or query)" });
  }

  const services = db.prepare(`
    SELECT service, status, latency_ms, error_message, checked_at,
      ROW_NUMBER() OVER (PARTITION BY service ORDER BY checked_at DESC) as rn
    FROM health_checks WHERE agent_id = ?
  `).all(agentId) as any[];

  const latest = services.filter((s: any) => s.rn === 1).map((s: any) => ({
    service: s.service,
    status: s.status,
    latency_ms: s.latency_ms,
    error_message: s.error_message,
    last_check: s.checked_at
  }));

  const overall = latest.some((s: any) => s.status === "down") ? "down"
    : latest.some((s: any) => s.status === "degraded") ? "degraded"
    : "healthy";

  res.json({
    agent_id: agentId,
    overall_status: overall,
    services: latest,
    total_services: latest.length
  });
});

// GET /api/health-monitor/history - Get health check history
router.get("/history", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || req.query.agent_id as string;
  const service = req.query.service as string;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  let query = "SELECT * FROM health_checks WHERE 1=1";
  const params: any[] = [];

  if (agentId) { query += " AND agent_id = ?"; params.push(agentId); }
  if (service) { query += " AND service = ?"; params.push(service); }
  query += " ORDER BY checked_at DESC LIMIT ?";
  params.push(limit);

  const checks = db.prepare(query).all(...params);
  res.json({ checks, count: checks.length });
});

// GET /api/health-monitor/summary - Global health summary
router.get("/summary", (_req: Request, res: Response) => {
  const stats = db.prepare(`
    SELECT 
      COUNT(DISTINCT agent_id) as total_agents,
      COUNT(*) as total_checks,
      SUM(CASE WHEN status = "healthy" THEN 1 ELSE 0 END) as healthy_count,
      SUM(CASE WHEN status = "degraded" THEN 1 ELSE 0 END) as degraded_count,
      SUM(CASE WHEN status = "down" THEN 1 ELSE 0 END) as down_count,
      AVG(latency_ms) as avg_latency_ms
    FROM health_checks
  `).get();

  res.json({
    platform: "AgentOS Health Monitor",
    description: "Centralized health monitoring for autonomous agents",
    stats,
    endpoints: {
      "POST /check": "Report a health check",
      "GET /status": "Current status per agent",
      "GET /history": "Historical checks",
      "GET /summary": "This endpoint"
    }
  });
});

export default router;
