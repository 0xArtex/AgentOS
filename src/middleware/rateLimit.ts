import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../types";
import { clientIp } from "./client-ip";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Best-effort, single-process, NON-durable by design. This counter lives only
// in this process's memory: it resets to empty on every deploy/restart and is
// not shared with any peer. That is acceptable — and a shared store (Redis) is
// deliberately NOT used — because prod runs as a single Node process behind one
// Cloudflare Tunnel (see client-ip.ts), so there are no workers to share state
// with and nothing to gain from external infra. Treat the cap as a throttle/
// speed-bump, not a hard security boundary; the auth lockout (security.ts) and
// the high-entropy, non-brute-forceable credentials are the real defense.
//
// Rotation is already hardened where it matters: the bucket key prefers the
// authenticated identity (req.agentId / req.payment.payer) and falls back to
// clientIp(), which trusts only the CF-edge IP a caller cannot forge through
// the tunnel — never a raw inbound header.
const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes. unref: a housekeeping timer must
// not keep the process alive (tests importing route files would hang).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}, 5 * 60_000).unref();

/**
 * Simple in-memory rate limiter keyed by the caller's authenticated identity,
 * falling back to IP. NEVER keys off a raw inbound header — that was a
 * trivial bypass (rotate the header, get a fresh bucket).
 * @param maxRequests  Maximum requests allowed in the window
 * @param windowMs     Window duration in milliseconds
 */
export function rateLimit(maxRequests: number = 10, windowMs: number = 60_000) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    // Authenticated identity first: req.agentId / req.payment.payer are set by
    // trusted middleware earlier in the pipeline. The IP fallback uses
    // clientIp() (CF-Connecting-IP behind the tunnel, else req.ip) — without it
    // every caller collapses to 127.0.0.1 in prod. We still NEVER trust a raw
    // X-Forwarded-* header (forgeable); CF-Connecting-IP is edge-controlled.
    const key = req.agentId || req.payment?.payer || clientIp(req) || "unknown";
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
