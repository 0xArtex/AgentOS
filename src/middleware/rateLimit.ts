import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../types";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}, 5 * 60_000);

/**
 * Simple in-memory rate limiter keyed by payer wallet address.
 * @param maxRequests  Maximum requests allowed in the window
 * @param windowMs     Window duration in milliseconds
 */
export function rateLimit(maxRequests: number = 10, windowMs: number = 60_000) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    // Use dashboard user, payer wallet, or IP
    const key = req.headers["x-dashboard-user"] as string || req.payment?.payer ?? req.ip ?? "unknown";
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - entry.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      res.status(429).json({
        error: "Too Many Requests",
        message: `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs / 1000}s.`,
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}
