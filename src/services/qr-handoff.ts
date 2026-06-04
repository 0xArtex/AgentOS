/**
 * Live login hand-off for `tiktok connect --qr`.
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
import { randomBytes } from "crypto";

type State = "waiting" | "ready" | "completed";
interface Entry { dataUrl: string | null; state: State; expiresAt: number; }

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

/**
 * Create a session (no QR yet) so the agent gets a link immediately, or update
 * an existing one. `dataUrl` (re)sets the QR; `done` marks the login captured.
 * Every call resets the TTL, so the link lives as long as `connect` keeps it
 * fresh. Returns the token (same one when updating).
 */
export function putQr(opts: { dataUrl?: string; token?: string; done?: boolean }): { token: string; expiresInSec: number } {
  const { dataUrl, done } = opts;
  if (dataUrl !== undefined && (typeof dataUrl !== "string" || !DATAURL_RE.test(dataUrl))) {
    throw new Error("qr_data_url must be a base64 data:image URL (png/jpeg/webp)");
  }
  if (dataUrl && dataUrl.length > MAX_DATAURL_LEN) throw new Error("qr image too large");
  pruneExpired();

  let token = opts.token && store.has(opts.token) ? opts.token : undefined;
  if (!token) {
    evictIfFull();
    token = randomBytes(16).toString("hex");
    store.set(token, { dataUrl: null, state: "waiting", expiresAt: 0 });
  }
  const e = store.get(token)!;
  if (done) e.state = "completed";
  else if (dataUrl) { e.dataUrl = dataUrl; e.state = "ready"; }
  e.expiresAt = Date.now() + TTL_MS;
  return { token, expiresInSec: Math.round(TTL_MS / 1000) };
}

export interface QrStatus { state: State; qr: string | null; expires_in_sec: number; }
export function getQrSession(token: string): QrStatus | null {
  const e = store.get(token);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { store.delete(token); return null; }
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
