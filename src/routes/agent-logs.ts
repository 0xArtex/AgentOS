import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

interface LogEntry {
  id: string;
  agentId: string;
  level: "info" | "warn" | "error" | "debug";
  action: string;
  message: string;
  metadata?: Record<string, any>;
  timestamp: string;
}

const logs: LogEntry[] = [];

// POST /api/agent-logs — submit a log entry
router.post("/", (req: Request, res: Response) => {
  const { agentId, level, action, message, metadata } = req.body;
  const xAgentId = req.headers["x-agent-id"] as string;
  const effectiveAgentId = agentId || xAgentId;

  if (!effectiveAgentId || !action || !message) {
    res.status(400).json({ error: "agentId, action, and message are required" });
    return;
  }

  const validLevels = ["info", "warn", "error", "debug"];
  const logLevel = validLevels.includes(level) ? level : "info";

  const entry: LogEntry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    agentId: effectiveAgentId,
    level: logLevel as LogEntry["level"],
    action,
    message,
    metadata: metadata || {},
    timestamp: new Date().toISOString(),
  };

  logs.push(entry);
  // Keep last 10000 entries
  if (logs.length > 10000) logs.splice(0, logs.length - 10000);

  res.status(201).json({ success: true, logId: entry.id, timestamp: entry.timestamp });
});

// GET /api/agent-logs — query logs with filters
router.get("/", (req: Request, res: Response) => {
  const { agentId, level, action, since, limit: limitStr } = req.query;
  const xAgentId = req.headers["x-agent-id"] as string;
  const effectiveAgentId = (agentId as string) || xAgentId;

  let filtered = [...logs];

  if (effectiveAgentId) {
    filtered = filtered.filter((l) => l.agentId === effectiveAgentId);
  }
  if (level) {
    filtered = filtered.filter((l) => l.level === level);
  }
  if (action) {
    filtered = filtered.filter((l) => l.action.includes(action as string));
  }
  if (since) {
    const sinceDate = new Date(since as string);
    filtered = filtered.filter((l) => new Date(l.timestamp) >= sinceDate);
  }

  const limit = Math.min(parseInt(limitStr as string) || 100, 500);
  filtered = filtered.slice(-limit);

  res.json({
    logs: filtered,
    total: filtered.length,
    filters: { agentId: effectiveAgentId, level, action, since, limit },
  });
});

// GET /api/agent-logs/stats — log statistics per agent
router.get("/stats", (req: Request, res: Response) => {
  const xAgentId = req.headers["x-agent-id"] as string;
  const agentId = (req.query.agentId as string) || xAgentId;

  let filtered = agentId ? logs.filter((l) => l.agentId === agentId) : logs;

  const byLevel: Record<string, number> = { info: 0, warn: 0, error: 0, debug: 0 };
  const byAction: Record<string, number> = {};

  for (const l of filtered) {
    byLevel[l.level] = (byLevel[l.level] || 0) + 1;
    byAction[l.action] = (byAction[l.action] || 0) + 1;
  }

  const topActions = Object.entries(byAction)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([action, count]) => ({ action, count }));

  res.json({
    totalLogs: filtered.length,
    byLevel,
    topActions,
    oldestLog: filtered[0]?.timestamp || null,
    newestLog: filtered[filtered.length - 1]?.timestamp || null,
    agentId: agentId || "all",
  });
});

// GET /api/agent-logs/docs
router.get("/docs", (_req: Request, res: Response) => {
  res.json({
    description: "Agent activity logging — submit, query, and analyze agent logs",
    endpoints: [
      { method: "POST", path: "/api/agent-logs", description: "Submit a log entry", body: "agentId (string), level (info|warn|error|debug), action (string, required), message (string, required), metadata (object, optional)" },
      { method: "GET", path: "/api/agent-logs", description: "Query logs", query: "agentId, level, action, since, limit (default 100, max 500)" },
      { method: "GET", path: "/api/agent-logs/stats", description: "Log statistics", query: "agentId (optional)" },
    ],
    example: "See docs above for usage examples",
  });
});

export default router;
