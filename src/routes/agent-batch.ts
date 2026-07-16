import { Router, Request, Response } from "express";

const router = Router();

const ALLOWED_METHODS = new Set(["GET", "POST"]);

// Reject control chars and whitespace (code point <= 0x20) and DEL (0x7f)
// without embedding any of those bytes in this source file.
function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

// Only same-origin internal API paths may be batched. `op.path` MUST be a pure
// absolute pathname ("/api/..."), never a full / scheme-relative / userinfo URL.
// Without this an unauthenticated caller could redirect the server-side fetch to
// an internal or cloud-metadata host (e.g. "@169.254.169.254/...", "//evil.tld/...")
// and read the response back -- a classic SSRF. We resolve the supplied path
// against the loopback base and require the resolved origin to still be that
// base, then dispatch using the URL object (never string concatenation, which is
// what allowed the host override in the first place).
function resolveInternalTarget(rawPath: unknown, baseUrl: string): URL | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  // Must be an absolute path beginning with a single "/". Reject "//host"
  // (scheme-relative -- URL treats the next token as a new host) outright.
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return null;
  // No backslashes (some parsers treat "\" like "/"), no userinfo "@", no raw
  // control chars / whitespace, and no embedded scheme marker.
  if (/[\\@]/.test(rawPath)) return null;
  if (hasControlOrSpace(rawPath)) return null;
  if (rawPath.includes("://")) return null;

  let target: URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(rawPath, base);
  } catch {
    return null;
  }
  // Defence in depth: even after the string checks, the resolved origin must be
  // byte-for-byte the loopback base. Anything else is a host override -> reject.
  if (target.origin !== base.origin) return null;
  // Never let a batch re-enter the batch endpoint (recursion / amplification).
  if (target.pathname === "/api/agent-batch" || target.pathname.startsWith("/api/agent-batch/")) return null;
  return target;
}

// POST /api/agent-batch — execute multiple API operations in a single request
// Body: { "operations": [{ "method": "GET", "path": "/api/health" }, ...] }
router.post("/", async (req: Request, res: Response) => {
  const { operations } = req.body || {};

  if (!operations || !Array.isArray(operations)) {
    return res.status(400).json({
      error: "Provide operations array: [{ method, path, body? }]",
      example: {
        operations: [
          { method: "GET", path: "/api/service-health" },
          { method: "GET", path: "/api/agent-dashboard" }
        ]
      }
    });
  }

  if (operations.length > 10) {
    return res.status(400).json({ error: "Max 10 operations per batch" });
  }

  const results = [];
  const baseUrl = `http://localhost:${process.env.PORT || 3001}`;

  for (const op of operations) {
    const start = Date.now();
    const method = String(op?.method || "GET").toUpperCase();

    // Reject anything that isn't a simple, same-origin internal API call BEFORE
    // any network I/O. This is the SSRF gate.
    if (!ALLOWED_METHODS.has(method)) {
      results.push({
        path: op?.path,
        status: 400,
        latencyMs: 0,
        error: `Unsupported method: only ${[...ALLOWED_METHODS].join(", ")} allowed`
      });
      continue;
    }
    const target = resolveInternalTarget(op?.path, baseUrl);
    if (!target) {
      results.push({
        path: op?.path,
        status: 400,
        latencyMs: 0,
        error: "Invalid op.path: must be an internal absolute API pathname like /api/... (no host, scheme, or '@')"
      });
      continue;
    }

    try {
      const fetchOpts: any = {
        method,
        headers: {
          "Content-Type": "application/json",
          // Forward only the caller's OWN identity header; the underlying route
          // re-validates it. The SSRF gate above is what prevents this from being
          // replayed against an off-box host.
          ...(req.headers["x-agent-id"] ? { "x-agent-id": req.headers["x-agent-id"] } : {})
        }
      };
      if (op.body && method !== "GET") {
        fetchOpts.body = JSON.stringify(op.body);
      }
      const resp = await fetch(target, fetchOpts);
      const data = await resp.json().catch(() => null);
      results.push({
        path: op.path,
        status: resp.status,
        latencyMs: Date.now() - start,
        data
      });
    } catch (err: any) {
      results.push({
        path: op.path,
        status: 500,
        latencyMs: Date.now() - start,
        error: err.message
      });
    }
  }

  res.json({
    batchId: `batch_${Date.now()}`,
    count: results.length,
    totalLatencyMs: results.reduce((s, r) => s + r.latencyMs, 0),
    results
  });
});

// GET /api/agent-batch — docs
router.get("/", (_req: Request, res: Response) => {
  res.json({
    description: "Batch multiple API calls in a single request",
    method: "POST",
    maxOperations: 10,
    note: "op.path must be an internal absolute API pathname (e.g. /api/service-health). External URLs are rejected.",
    example: {
      operations: [
        { method: "GET", path: "/api/service-health" },
        { method: "GET", path: "/api/agent-dashboard" }
      ]
    },
    tip: "Reduce round trips — get health, billing, and status in one call"
  });
});

export default router;
