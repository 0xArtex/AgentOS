import { Router, Request, Response } from "express";
import os from "os";

const router = Router({ mergeParams: true });
const startTime = Date.now();

/**
 * GET /api/debug — Agent integration debugger
 * Helps agents troubleshoot their setup by validating headers, auth, and connectivity
 */
router.get("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  const authHeader = req.headers["authorization"] as string;
  const contentType = req.headers["content-type"] as string;
  
  const checks: { name: string; status: "pass" | "warn" | "fail"; message: string }[] = [];
  
  // Check X-Agent-Id header
  if (agentId) {
    checks.push({ name: "X-Agent-Id Header", status: "pass", message: `Agent identified as: ${agentId}` });
  } else {
    checks.push({ name: "X-Agent-Id Header", status: "warn", message: "Missing X-Agent-Id header. Add it for free hackathon access and analytics tracking." });
  }
  
  // Check auth
  if (authHeader && authHeader.startsWith("Bearer ")) {
    checks.push({ name: "Authorization", status: "pass", message: "Bearer token present" });
  } else if (agentId) {
    checks.push({ name: "Authorization", status: "pass", message: "Hackathon mode: X-Agent-Id is sufficient (free until Feb 12)" });
  } else {
    checks.push({ name: "Authorization", status: "warn", message: "No auth provided. Use X-Agent-Id header for free hackathon access." });
  }
  
  // Check connectivity
  checks.push({ name: "API Connectivity", status: "pass", message: "You reached the API successfully!" });
  
  // System info
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const memUsed = process.memoryUsage();
  
  const deadlineUTC = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, (deadlineUTC - Date.now()) / 3600000).toFixed(1);
  
  res.json({
    title: "AgentOS Integration Debugger",
    description: "Use this endpoint to verify your agent is properly configured",
    checks,
    your_request: {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || "not set",
      headers_sent: Object.keys(req.headers).length,
    },
    system: {
      uptime_seconds: uptimeSeconds,
      memory_mb: Math.round(memUsed.heapUsed / 1024 / 1024),
      node_version: process.version,
      platform: os.platform(),
    },
    hackathon: {
      hours_remaining: parseFloat(hoursLeft),
      deadline: "2026-02-12T17:00:00Z",
      free_access: true,
    },
    next_steps: [
      "GET /api/quickstart — Step-by-step setup guide",
      "GET /api/agent-kit — Complete starter bundle",
      "POST /agents/register — Register your agent",
      "GET /docs — Full API documentation",
    ],
  });
});

/**
 * POST /api/debug/echo — Echo back whatever you send (useful for testing POST payloads)
 */
router.post("/echo", (req: Request, res: Response) => {
  res.json({
    title: "Echo Response",
    description: "Your request echoed back for debugging",
    received: {
      method: req.method,
      contentType: req.headers["content-type"],
      bodyKeys: req.body ? Object.keys(req.body) : [],
      body: req.body,
      queryParams: req.query,
    },
    tip: "Use this to verify your POST payloads are formatted correctly before hitting real endpoints.",
  });
});

export default router;
