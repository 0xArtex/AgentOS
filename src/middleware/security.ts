import { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import hpp from "hpp";

/**
 * Security middleware stack for AgentOS API.
 * - Helmet: sets security headers (CSP, XSS protection, etc.)
 * - HPP: prevents HTTP parameter pollution
 * - Input sanitization: strips dangerous characters
 * - Request size limiting
 * - SQL injection detection
 */

// Helmet with API-friendly config
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
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

// SQL injection pattern detection
const SQL_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b.*\b(FROM|INTO|TABLE|DATABASE|WHERE)\b)/i,
  /(--|;|\/\*|\*\/|xp_|sp_)/i,
  /(\b(OR|AND)\b\s+\d+\s*=\s*\d+)/i,
];

export function sqlInjectionGuard(req: Request, res: Response, next: NextFunction): void {
  const checkValue = (val: unknown): boolean => {
    if (typeof val === "string") {
      return SQL_PATTERNS.some(p => p.test(val));
    }
    if (typeof val === "object" && val !== null) {
      return Object.values(val).some(checkValue);
    }
    return false;
  };

  // Skip SQL check for canvas state saves (contains HTML/SVG that triggers false positives)
  if (req.method === "PUT" && (req.path.startsWith("/projects/") || req.originalUrl.startsWith("/projects/"))) {
    next();
    return;
  }
  // Skip for image-upload endpoints — base64 + data-URL prefix contains `;`
  // which the SQL pattern matches as a statement separator.
  if (req.path === "/social/twitter/avatar" || req.path === "/social/twitter/banner") {
    next();
    return;
  }
  if (checkValue(req.body) || checkValue(req.query) || checkValue(req.params)) {
    res.status(400).json({ error: "Malicious Input Detected", message: "Request blocked by security filter" });
    return;
  }
  next();
}

// Request body size check (prevent payload bombs)
export function bodySizeLimit(maxBytes: number = 1024 * 100) { // 100KB default
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = parseInt(req.headers["content-length"] || "0");
    if (contentLength > maxBytes) {
      res.status(413).json({ error: "Payload Too Large", message: `Max body size: ${maxBytes} bytes` });
      return;
    }
    next();
  };
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

// API key brute force protection — track failed auth attempts per IP
const failedAttempts = new Map<string, { count: number; blockedUntil: number }>();

export function bruteForceProtection(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
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
      const entry = failedAttempts.get(ip) || { count: 0, blockedUntil: 0 };
      entry.count++;
      if (entry.count >= 10) {
        entry.blockedUntil = Date.now() + 15 * 60 * 1000; // Block 15 min
        entry.count = 0;
      }
      failedAttempts.set(ip, entry);
    }
    return originalJson(body);
  };

  next();
}

// Cleanup blocked IPs periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failedAttempts) {
    if (now > entry.blockedUntil + 60000) failedAttempts.delete(ip);
  }
}, 5 * 60_000);
