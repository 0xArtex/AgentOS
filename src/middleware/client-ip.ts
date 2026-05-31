import { Request } from "express";

/**
 * Best-effort real client IP.
 *
 * In production Palmyr runs behind a Cloudflare Tunnel (cloudflared → localhost:3001),
 * so Express's socket only ever sees 127.0.0.1 and `req.ip` collapses to a single
 * value for every caller — which silently neuters per-IP rate-limiting and
 * brute-force protection. Cloudflare injects the true client IP in
 * `CF-Connecting-IP`, a header a client cannot forge *through* Cloudflare (the
 * edge overwrites it). We therefore prefer it, falling back to `req.ip` / the
 * socket for local/dev (non-tunnel) requests.
 *
 * NOTE: this trust assumption holds only because the app is not exposed
 * off-tunnel in prod. Do not bind this process to a public interface without
 * also stripping inbound CF-* headers at the edge.
 */
export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  return req.ip || req.socket.remoteAddress || "unknown";
}
