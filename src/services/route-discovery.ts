/**
 * Walk Express's router stack and return every paid route — `(method, path,
 * price, metadata)` — so the `/.well-known/x402` endpoint and `/openapi.json`
 * can advertise an accurate, drift-free list to x402scan / Bazaar / clients.
 *
 * "Paid" = the route's handler stack contains a middleware tagged with
 * `_x402PaidMin` (set by `requireAuth(>0)` in auth.ts and `x402()` in x402.ts).
 *
 * Express layer regex parsing is the brittle part. We keep it minimal: only
 * decode the two patterns Palmyr uses — `app.use("/<prefix>", router)` and
 * `app.get/post/...("/path", handler)`. Anything fancier (regex mounts,
 * sub-sub-routers) returns "" and the caller can audit the result.
 */

import type { Express } from "express";
import type { X402Metadata } from "../middleware/x402";

export interface PaidRoute {
  method: string;       // 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string;         // full path including mount prefix, e.g. "/email/inboxes/:id/send"
  priceUsdc: number;
  metadata?: X402Metadata;
}

/**
 * Curated set of routes we advertise on `/.well-known/x402` and `/openapi.json`.
 *
 * WHY an allowlist: x402scan flags catalogs with >50 routes as `L2_ROUTE_COUNT_HIGH`,
 * which hurts ranking and buries the headline capabilities under a long tail of
 * call-control, OpenClaw, ownership/sharing, and account-admin sub-operations.
 * Rather than scatter `discoverable: false` across ~65 handlers, we advertise the
 * *happy path* for each primitive here — provision, list, and the primary actions —
 * and keep the bounded surface high-signal and easy to audit.
 *
 * Everything not listed is still fully callable and still 402-gated; it's just not
 * advertised. To advertise a route, add `"<METHOD> <path>"` (express-style `:param`).
 * Keep this under 50 entries.
 */
const DISCOVERABLE_ALLOWLIST = new Set<string>([
  // i402 intent planner
  "POST /chat",
  // Phone — provision, messaging, calling, lifecycle
  "POST /phone/numbers",
  "GET /phone/numbers",
  "POST /phone/numbers/:id/send",
  "GET /phone/numbers/:id/messages",
  "GET /phone/messages/:id",
  "POST /phone/numbers/:id/call",
  "DELETE /phone/numbers/:id",
  // Email — provision, list, send, read
  "POST /email/inboxes",
  "GET /email/inboxes",
  "POST /email/inboxes/:id/send",
  "GET /email/inboxes/:id/messages",
  "GET /email/inboxes/:id/threads",
  // Domains — list, inspect, DNS
  "GET /domains",
  "GET /domains/:domain",
  "GET /domains/:domain/dns",
  "POST /domains/:domain/dns",
  // Compute — deploy, list, inspect, exec, lifecycle, terminate, ssh handoff
  "POST /compute/servers",
  "GET /compute/servers",
  "GET /compute/servers/:id",
  "POST /compute/servers/:id/exec",
  "POST /compute/servers/:id/actions",
  "DELETE /compute/servers/:id",
  "POST /compute/servers/:id/setup-ssh",
  // Social — X core
  "POST /social/twitter/buy",
  "POST /social/twitter/register",
  "POST /social/twitter/login",
  "POST /social/twitter/post",
  "POST /social/twitter/post-thread",
  "POST /social/twitter/reply",
  "POST /social/twitter/like",
  "POST /social/twitter/follow",
  "POST /social/twitter/retweet",
  // Social — TikTok core
  "POST /social/tiktok/login",
  "POST /social/tiktok/post",
]);

/**
 * Decode an Express layer's mount path. Express stores it as a regex but
 * exposes `fast_slash` / `fast_star` flags for the simple cases we care about.
 * Falls back to parsing the regex source.
 */
function extractMountPath(layer: any): string {
  const re = layer.regexp;
  if (!re) return "";
  if (re.fast_slash) return "";
  if (re.fast_star) return "";

  // Express mount-path regexes look like: ^\/email\/?(?=\/|$)
  const src = String(re.source || re);
  const m = /^\^\\?\/(.+?)\\\/\?\(\?=\\\/\|\$\)/.exec(src);
  if (m) return "/" + m[1].replace(/\\\//g, "/");

  // Final fallback: strip ^ and trailing artifacts; works for simple regexes.
  return src
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\\\//g, "/")
    .replace(/\$$/, "")
    || "";
}

/**
 * Recursively walk a stack of layers, accumulating paid routes.
 */
function walk(stack: any[], prefix: string, out: PaidRoute[]): void {
  for (const layer of stack || []) {
    if (layer.route) {
      // Single route — `app.get/post/...` or `router.get/post/...`
      const route = layer.route;
      const fullPath = prefix + (route.path || "");
      // route.stack is the chain of middlewares for this route. Find any
      // layer whose handle was tagged by requireAuth/x402.
      const paidLayer = (route.stack || []).find(
        (s: any) => s?.handle && (s.handle._x402PaidMin !== undefined),
      );
      if (paidLayer) {
        const handle = paidLayer.handle;
        const methods = route.methods || {};
        for (const method of Object.keys(methods)) {
          if (!methods[method]) continue;
          out.push({
            method: method.toUpperCase(),
            path: fullPath,
            priceUsdc: handle._x402PaidMin,
            metadata: handle._x402Metadata,
          });
        }
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      // Sub-router mounted via `app.use("/<prefix>", router)`.
      const mountPath = extractMountPath(layer);
      walk(layer.handle.stack, prefix + mountPath, out);
    }
  }
}

/**
 * Enumerate every paid route registered on `app`. Cheap (<1 ms for Palmyr-
 * sized apps); fine to call on every request.
 *
 * @param opts.includeNonDiscoverable when true, returns *all* paid routes
 *   including ones whose metadata sets `discoverable: false`. Default false:
 *   the discovery surfaces (well-known, openapi) hide internal/admin routes
 *   so the listed surface stays inside agent-token-budget thresholds.
 */
export function enumeratePaidRoutes(
  app: Express,
  opts: { includeNonDiscoverable?: boolean } = {},
): PaidRoute[] {
  const stack = (app as any)?._router?.stack;
  if (!Array.isArray(stack)) return [];
  const out: PaidRoute[] = [];
  walk(stack, "", out);

  // Normalize trailing-slash duplicates: Express's stack walker can produce
  // both "/agents" and "/agents/" depending on how a router was mounted.
  // x402scan probes the canonical form, so anything ending in "/" (other
  // than the root) is the duplicate — drop the trailing slash.
  for (const r of out) {
    if (r.path.length > 1 && r.path.endsWith("/")) r.path = r.path.replace(/\/+$/, "");
  }

  // Dedupe (method, path).
  const seen = new Set<string>();
  const deduped = out.filter(r => {
    const key = r.method + " " + r.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Discovery surfaces advertise only the curated allowlist (and never a route
  // that explicitly opted out via `discoverable: false`). includeNonDiscoverable
  // callers (audits, internal tooling) still get the full paid set.
  const filtered = opts.includeNonDiscoverable
    ? deduped
    : deduped.filter(
        r => r.metadata?.discoverable !== false && DISCOVERABLE_ALLOWLIST.has(r.method + " " + r.path),
      );

  // Stable order so the well-known doc and OpenAPI don't shuffle on each call.
  filtered.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  return filtered;
}
