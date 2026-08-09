/**
 * Live login hand-off for `tiktok connect` (QR mode — the default).
 *
 * The agent creates a session UP FRONT — getting a stable `/connect/<token>`
 * link it can forward to a human instantly, before the QR even renders. As
 * TikTok rotates the QR, `connect` keeps refreshing the session's image; the
 * human's page polls and live-updates, so the QR is never stale and the link
 * stays valid for the whole connect window. On capture, the session is marked
 * done so the page confirms.
 *
 * In-memory + guarded (TTL, size cap, entry cap, strict data-URL validation) so
 * it can't be abused as a general image host.
 */
import { randomBytes, timingSafeEqual } from "crypto";

type State = "waiting" | "ready" | "completed";
// The map is keyed by the PUBLIC read token (the value embedded in the
// /connect link). `writer` is the high-entropy secret half of the write
// capability — it is NEVER part of that link, so the public link can only READ
// the QR/status and can never replace it.
interface Entry { dataUrl: string | null; state: State; expiresAt: number; writer: string; }

const store = new Map<string, Entry>();
const TTL_MS = 15 * 60 * 1000; // reset on every update — gives the human ample time
const MAX_ENTRIES = 500;
const MAX_DATAURL_LEN = 200_000; // ~150 KB; a QR PNG is a few KB
const DATAURL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of store) if (now > v.expiresAt) store.delete(k);
}
function evictIfFull(): void {
  if (store.size < MAX_ENTRIES) return;
  let oldestKey: string | undefined, oldestAt = Infinity;
  for (const [k, v] of store) if (v.expiresAt < oldestAt) { oldestAt = v.expiresAt; oldestKey = k; }
  if (oldestKey) store.delete(oldestKey);
}
function fresh(token: string): Entry | null {
  const e = store.get(token);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { store.delete(token); return null; }
  return e;
}
/** Constant-time string compare (tolerates length mismatch). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Create a session (no QR yet) so the agent gets a link immediately, or update
 * an existing one. The capability is SPLIT: creation mints a public READ token
 * (returned as `token`, embedded in the /connect link, used to READ the QR and
 * status) and a separate high-entropy WRITER credential (`writer`, of the form
 * `<readToken>.<secret>`) handed back ONLY to the agent. Updates — (re)setting
 * the QR via `dataUrl` or marking the login captured via `done` — REQUIRE that
 * writer credential; the read token alone can never write. This stops anyone who
 * merely obtained the forwarded /connect/<token> link from swapping in their own
 * login QR (account takeover) or sending `done` to abort the onboarding (DoS).
 *
 * Every call resets the TTL, so the link lives as long as `connect` keeps it
 * fresh. Returns the read token + writer credential (the same pair when updating).
 */
export function putQr(opts: { dataUrl?: string; token?: string; done?: boolean }): { token: string; writer: string; expiresInSec: number } {
  const { dataUrl, done } = opts;
  if (dataUrl !== undefined && (typeof dataUrl !== "string" || !DATAURL_RE.test(dataUrl))) {
    throw new Error("qr_data_url must be a base64 data:image URL (png/jpeg/webp)");
  }
  if (dataUrl && dataUrl.length > MAX_DATAURL_LEN) throw new Error("qr image too large");
  pruneExpired();

  let readToken: string;
  let e: Entry;
  if (opts.token !== undefined) {
    // Update path: `token` is the writer credential `<readToken>.<secret>`. The
    // session can only be reached by presenting its secret half — the public
    // read token (everything before the dot) is not, on its own, a write key.
    const cred = String(opts.token);
    const dot = cred.indexOf(".");
    readToken = dot > 0 ? cred.slice(0, dot) : "";
    const secret = dot > 0 ? cred.slice(dot + 1) : "";
    const existing = readToken ? fresh(readToken) : null;
    if (!existing || !secret || !safeEqual(secret, existing.writer)) {
      throw new Error("invalid or expired writer credential");
    }
    e = existing;
  } else {
    // Create path: mint a public read token (goes in the link) and a private
    // writer secret (agent-only, never in the link).
    evictIfFull();
    readToken = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    e = { dataUrl: null, state: "waiting", expiresAt: 0, writer: secret };
    store.set(readToken, e);
  }

  if (done) e.state = "completed";
  else if (dataUrl) { e.dataUrl = dataUrl; e.state = "ready"; }
  e.expiresAt = Date.now() + TTL_MS;
  return { token: readToken, writer: `${readToken}.${e.writer}`, expiresInSec: Math.round(TTL_MS / 1000) };
}

export interface QrStatus { state: State; qr: string | null; expires_in_sec: number; }
export function getQrSession(token: string): QrStatus | null {
  const e = fresh(token);
  if (!e) return null;
  return { state: e.state, qr: e.dataUrl, expires_in_sec: Math.max(0, Math.round((e.expiresAt - Date.now()) / 1000)) };
}

const PAGE_HEAD =
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Log in to TikTok — Palmyr</title><style>` +
  `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
  `background:#112d32;color:#e8e3d8;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}` +
  `.card{text-align:center;padding:32px;max-width:360px}` +
  `h1{font-size:20px;font-weight:600;margin:0 0 6px}` +
  `.sub{color:#a89774;margin:0 0 20px}` +
  `.qr{background:#fff;padding:16px;border-radius:16px;display:inline-block}` +
  `.qr img{display:block;width:240px;height:240px}` +
  `.steps{margin-top:20px;color:#cfc8b8;font-size:14px;line-height:1.8}` +
  `.notice{margin:18px auto 0;padding:12px;border:1px solid #5f7a7f;border-radius:10px;` +
  `color:#cfc8b8;font-size:12px;line-height:1.5;text-align:left}` +
  `.foot{margin-top:22px;color:#5f7a7f;font-size:12px}` +
  `</style></head><body><div class="card">`;

/**
 * Render the hand-off page. It polls `/connect/<token>/status` and live-updates
 * the QR, so a rotated code is always current and the link never shows stale.
 */
export function renderQrPage(token: string): string {
  const t = JSON.stringify(token);
  return (
    PAGE_HEAD +
    `<h1>Log in to TikTok</h1><p class="sub" id="sub">Preparing your login code…</p>` +
    `<div class="qr" id="qrbox" style="display:none"><img id="qr" alt="TikTok login QR"></div>` +
    `<div class="steps">1. Open TikTok on your phone<br>` +
    `2. Profile → ☰ menu → Scan QR code<br>3. Confirm login</div>` +
    `<div class="notice"><strong>Location check:</strong> The browser running the agent and the phone scanning this code should use the same country or a nearby region, ideally the account's usual region. TikTok may refuse distant logins. Align the VPS/browser exit and phone IP before scanning, and follow TikTok's Terms.</div>` +
    `<p class="foot">Keep this page open — the code refreshes automatically.</p>` +
    `<script>(function(){var T=${t};var sub=document.getElementById('sub'),box=document.getElementById('qrbox'),img=document.getElementById('qr');` +
    `function tick(){fetch('/connect/'+T+'/status',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(s){` +
    `if(s.state==='completed'){sub.textContent='✓ Logged in — you can close this tab.';box.style.display='none';return;}` +
    `if(s.state==='ready'&&s.qr){if(img.src!==s.qr)img.src=s.qr;box.style.display='inline-block';sub.textContent='Scan this with the TikTok app';}` +
    `else{sub.textContent='Preparing your login code…';}setTimeout(tick,4000);}).catch(function(){sub.textContent='This link has expired — ask your agent for a fresh one.';box.style.display='none';});}` +
    `tick();})();</script>` +
    `</div></body></html>`
  );
}

export function renderExpiredPage(): string {
  return (
    PAGE_HEAD +
    `<h1>Link expired</h1>` +
    `<p class="sub">This TikTok login link is no longer active.</p>` +
    `<div class="steps">Ask your agent for a fresh link and try again.</div>` +
    `</div></body></html>`
  );
}
