import { Request, Response, NextFunction } from "express";
import { db } from "../db";

/**
 * Middleware that logs every API request for analytics
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  // Hook into response finish
  res.on("finish", () => {
    const duration = Date.now() - start;
    const agentId = (req as any).agentId || req.headers["x-agent-id"] as string || null;
    const isHackathon = (req as any).isHackathonMode;
    const hasPayment = !!(req as any).payment;

    let paymentType: string = "free";
    if (hasPayment) paymentType = "x402";
    else if (isHackathon) paymentType = "hackathon";

    // Skip logging for static files, health checks, etc.
    const skip = ["/", "/health", "/favicon.ico"];
    if (skip.includes(req.path) || req.path.startsWith("/docs")) return;

    try {
      db.prepare(
        `INSERT INTO request_log (agent_id, endpoint, method, status_code, payment_type, response_time_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'utc'))`
      ).run(agentId, req.path, req.method, res.statusCode, paymentType, duration);
    } catch {
      // Don't let logging errors break requests
    }
  });

  next();
}
