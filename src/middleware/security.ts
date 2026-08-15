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
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://plausible.palmyr.ai", "https://challenges.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "http:", "https:"],
      frameSrc: ["'self'", "https://challenges.cloudflare.com"],
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

// Sanitize string inputs — strip null bytes ONLY. Deliberately non-destructive
// of whitespace.
//
// This runs globally (index.ts) ahead of every route, so it must not corrupt
// data. It used to also `.trim()` every string, which silently mutated
// whitespace-significant payloads before any handler saw them — an opaque
// secret/credential submitted with a trailing newline got stored trimmed, and
// message/post bodies lost intended leading/trailing whitespace, with no signal
// to the caller. Null bytes have no legitimate place in JSON text input and can
// truncate C-backed string handling, so those we still remove; trimming is the
// job of per-route validation on the specific fields that want it.
//
// MAX_SANITIZE_DEPTH caps the recursion: a deeply-nested JSON body (still within
// the 100KB express.json limit) would otherwise overflow the stack and surface
// as a 500. Past the cap we stop descending and pass the subtree through as-is.
const MAX_SANITIZE_DEPTH = 64;

export function sanitizeInputs(req: Request, _res: Response, next: NextFunction): void {
  const sanitize = (obj: any, depth: number): any => {
    if (typeof obj === "string") return obj.replace(/\0/g, "");
    if (depth >= MAX_SANITIZE_DEPTH) return obj;
    if (Array.isArray(obj)) return obj.map((v) => sanitize(v, depth + 1));
    if (typeof obj === "object" && obj !== null) {
      const clean: any = {};
      for (const [k, v] of Object.entries(obj)) {
        clean[sanitize(k, depth + 1)] = sanitize(v, depth + 1);
      }
      return clean;
    }
    return obj;
  };

  if (req.body) req.body = sanitize(req.body, 0);
  if (req.query) req.query = sanitize(req.query, 0) as any;
  next();
}

// API key brute force protection — track failed auth attempts per IP.
//
// Best-effort, single-process, NON-durable by design: this Map (like the rate
// limiter in rateLimit.ts) lives only in this process's memory and resets to
// empty on every deploy/restart. Prod runs as one Node process behind one
// Cloudflare Tunnel (see client-ip.ts), so there are no peer workers to share
// state with; a shared store (Redis) would be infrastructure this single-node
// topology doesn't warrant. The lockout is therefore a speed-bump, not a hard
// guarantee — acceptable because the credentials it guards (aos_/agt_ tokens,
// dashboard session tokens, wallet identities) are high-entropy random values
// that are not practically brute-forceable, and the per-IP key is anchored to
// the un-forgeable CF edge IP in prod (clientIp()).
//
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

  // Count auth failures when the response completes. Hooking `finish` (fires
  // exactly once, after the body is flushed) instead of monkey-patching res.json
  // means failures sent via res.send / res.end / res.sendStatus are counted too
  // — the old json-only patch silently missed every non-json failure path.
  res.on("finish", () => {
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
  });

  next();
}

// Cleanup blocked IPs periodically. unref: a housekeeping timer must not
// keep the process alive (tests importing route files would hang).
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failedAttempts) {
    // Drop entries that are neither currently blocked nor recently updated.
    const stale = now > entry.updatedAt + 30 * 60_000;
    const unblocked = now > entry.blockedUntil + 60_000;
    if (stale && unblocked) failedAttempts.delete(ip);
  }
}, 5 * 60_000).unref();
