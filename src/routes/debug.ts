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
    checks.push({ name: "X-Agent-Id Header", status: "warn", message: "Missing X-Agent-Id header. Add it so your requests are attributed to your agent." });
  }

  // Check auth
  if (authHeader && authHeader.startsWith("Bearer ")) {
    checks.push({ name: "Authorization", status: "pass", message: "Bearer token present" });
  } else if (agentId) {
    checks.push({ name: "Authorization", status: "pass", message: "X-Agent-Id present. Paid endpoints settle per call via x402 — your wallet is your identity." });
  } else {
    checks.push({ name: "Authorization", status: "warn", message: "No auth provided. Free endpoints work anonymously; paid endpoints settle via x402." });
  }
  
  // Check connectivity
  checks.push({ name: "API Connectivity", status: "pass", message: "You reached the API successfully!" });
  
  // System info
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const memUsed = process.memoryUsage();

  res.json({
    title: "Palmyr Integration Debugger",
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
    next_steps: [
      "GET /skill.md — Agent-readable guide to the whole API",
      "GET /pricing — Live per-call x402 pricing",
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
