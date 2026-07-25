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

    // The FULL path, not req.path. Express strips a mounted router's prefix
    // from req.url for the duration of that router's stack, and this callback
    // fires while the response is still inside it — so req.path was recording
    // "/register" for /domains/register, "/joingrange.xyz/dns" for a DNS write,
    // and, worst of all, "/" for every POST /chat, which the skip list below
    // then dropped entirely. The i402 rail looked like it had zero traffic
    // while agents were paying for it. originalUrl is always the whole path.
    const endpoint = req.originalUrl.split("?")[0] || req.path;

    // Skip logging for static files, health checks, etc.
    const skip = ["/", "/health", "/favicon.ico"];
    if (skip.includes(endpoint) || endpoint.startsWith("/docs") ||
        endpoint.endsWith(".js") || endpoint.endsWith(".css") ||
        endpoint.endsWith(".map") || endpoint.endsWith(".png") ||
        endpoint.endsWith(".ico")) return;

    try {
      db.prepare(
        `INSERT INTO request_log (agent_id, endpoint, method, status_code, payment_type, response_time_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'utc'))`
      ).run(agentId, endpoint, req.method, res.statusCode, paymentType, duration);
    } catch {
      // Don't let logging errors break requests
    }
  });

  next();
}
