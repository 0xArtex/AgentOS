import { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import hpp from "hpp";
import { clientIp } from "./client-ip";

/**
 * Security middleware stack for Palmyr API.
 * - Helmet: sets security headers (CSP, XSS protection, etc.)
 * - HPP: prevents HTTP parameter pollution
 * - Input sanitization: strips dangerous characters
 * - Request size limiting
 * - SQL injection detection
 */

// Helmet with API-friendly config.
// `https://plausible.palmyr.ai` is the self-hosted analytics tracker — needed
// in scriptSrc to load /js/script.js and in connectSrc for the pageview POSTs.
// Setup lives in tools/observability/plausible/.
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://plausible.palmyr.ai"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "http:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

// HTTP parameter pollution protection
export const paramPollution = hpp();

/**
 * SQL injection guard (no-op).
 *
 * The real defense is `better-sqlite3` prepared statements, which are used
 * everywhere in this codebase — parameterised input cannot be misinterpreted
 * as SQL regardless of its contents. The earlier regex-based WAF layer was
 * generating false positives on legitimate content (tweets containing the
 * words "select" and "from", data-URL image uploads, project canvas saves)
 * and providing no real security value on top of prepared statements.
 *
 * Kept as a middleware so the `app.use(sqlInjectionGuard)` call sites don't
 * need to change.
 */
export function sqlInjectionGuard(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

// Sanitize string inputs (strip null bytes, trim)
export function sanitizeInputs(req: Request, _res: Response, next: NextFunction): void {
  const sanitize = (obj: any): any => {
    if (typeof obj === "string") return obj.replace(/\0/g, "").trim();
    if (Array.isArray(obj)) return obj.map(sanitize);
    if (typeof obj === "object" && obj !== null) {
      const clean: any = {};
      for (const [k, v] of Object.entries(obj)) {
        clean[sanitize(k)] = sanitize(v);
      }
      return clean;
    }
    return obj;
  };

  if (req.body) req.body = sanitize(req.body);
  if (req.query) req.query = sanitize(req.query) as any;
  next();
}

// API key brute force protection — track failed auth attempts per IP.
// Map is capped at MAX_FAILED_ENTRIES; on overflow the oldest entry is evicted
// (Map iteration order is insertion order). Prevents unbounded growth under a
// distributed spray attack.
const MAX_FAILED_ENTRIES = 10_000;
const failedAttempts = new Map<string, { count: number; blockedUntil: number; updatedAt: number }>();

function touchFailedEntry(ip: string, entry: { count: number; blockedUntil: number; updatedAt: number }): void {
  // Re-insert to move to the tail (most recently used).
  failedAttempts.delete(ip);
  failedAttempts.set(ip, entry);
  if (failedAttempts.size > MAX_FAILED_ENTRIES) {
    const oldestKey = failedAttempts.keys().next().value;
    if (oldestKey !== undefined) failedAttempts.delete(oldestKey);
  }
}

export function bruteForceProtection(req: Request, res: Response, next: NextFunction): void {
  const ip = clientIp(req);
  const entry = failedAttempts.get(ip);

  if (entry && Date.now() < entry.blockedUntil) {
    const retryAfter = Math.ceil((entry.blockedUntil - Date.now()) / 1000);
    res.status(429).json({
      error: "Too Many Failed Attempts",
      message: "Temporarily blocked due to repeated failures",
      retryAfter
    });
    return;
  }

  // Hook into response to track failures
  const originalJson = res.json.bind(res);
  res.json = function(body: any) {
    if (res.statusCode === 401 || res.statusCode === 403) {
      const cur = failedAttempts.get(ip) || { count: 0, blockedUntil: 0, updatedAt: Date.now() };
      cur.count++;
      cur.updatedAt = Date.now();
      if (cur.count >= 10) {
        cur.blockedUntil = Date.now() + 15 * 60 * 1000; // Block 15 min
        cur.count = 0;
      }
      touchFailedEntry(ip, cur);
    }
    return originalJson(body);
  };

  next();
}

// Cleanup blocked IPs periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failedAttempts) {
    // Drop entries that are neither currently blocked nor recently updated.
    const stale = now > entry.updatedAt + 30 * 60_000;
    const unblocked = now > entry.blockedUntil + 60_000;
    if (stale && unblocked) failedAttempts.delete(ip);
  }
}, 5 * 60_000);
