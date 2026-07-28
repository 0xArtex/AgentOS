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
function isLoopbackPeer(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
}

/**
 * Best-effort ISO-3166 country of the real client, or null.
 *
 * Cloudflare resolves this at the edge and injects `CF-IPCountry`, under the
 * same trust model as CF-Connecting-IP above: only believed when the request
 * actually arrived through the local tunnel. "XX"/"T1" are Cloudflare's own
 * placeholders for unknown and Tor, and are treated as no answer.
 */
export function clientCountry(req: Request): string | null {
  const peer = req.socket.remoteAddress;
  const cc = req.headers["cf-ipcountry"];
  if (typeof cc !== "string" || !isLoopbackPeer(peer)) return null;
  const v = cc.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(v) || v === "xx" || v === "t1") return null;
  return v;
}

export function clientIp(req: Request): string {
  const peer = req.socket.remoteAddress;
  const cf = req.headers["cf-connecting-ip"];
  // Only trust CF-Connecting-IP when the request actually arrived via the local
  // cloudflared tunnel — i.e. the immediate peer is loopback. A request that
  // reaches the origin OFF-tunnel (a direct connection, were the process ever
  // bound publicly) has a non-loopback peer; we then ignore its forgeable CF-*
  // header and key on the real socket address. Otherwise an attacker could set
  // a fresh CF-Connecting-IP per request to land in a new rate-limit /
  // brute-force bucket every time and evade both, and forge audit attribution.
  if (typeof cf === "string" && cf.length > 0 && isLoopbackPeer(peer)) return cf;
  return req.ip || peer || "unknown";
}
