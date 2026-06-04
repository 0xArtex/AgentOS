/**
 * Live login hand-off for `tiktok connect` — two modes, one session model.
 *
 * QR mode (`--qr`): the agent creates a session UP FRONT, gets a stable
 * `/connect/<token>` link to forward to a human instantly, and `connect` keeps
 * refreshing the rotating QR; the human's page polls and live-updates so the QR
 * is never stale.
 *
 * Screen mode (`--remote`): for the interactive email/password/2FA login that
 * can't be driven headless. `connect` streams the real (VPS) browser as JPEG
 * frames into the session; the human opens the same `/connect/<token>` link on
 * any device, sees the live browser, and their clicks/keystrokes are queued back
 * for `connect` to replay over CDP. No remote desktop, no VNC.
 *
 * In-memory + guarded (TTL, size caps, entry cap, strict validation) so it can't
 * be abused as a general relay. The token is the only capability — unguessable
 * (16 random bytes), short-lived, and scoped to one login.
 */
import { randomBytes } from "crypto";

type Mode = "qr" | "screen";
type State = "waiting" | "ready" | "completed";

/** A human input event, relayed page → server → `connect` (which dispatches it
 * over CDP). Coords are normalized [0,1] so they're resolution-independent. */
export type InputEvent =
  | { t: "m"; k: "down" | "up" | "move"; x: number; y: number; b?: number; n?: number }
  | { t: "w"; x: number; y: number; dx: number; dy: number }
  | { t: "x"; s: string } // typed text (insertText)
  | { t: "k"; k: "down" | "up"; key: string; code: string; vk?: number };

interface Entry {
  mode: Mode;
  state: State;
  expiresAt: number;
  // QR mode
  dataUrl: string | null;
  // Screen mode
  frame: string | null; // latest JPEG, raw base64 (no data: prefix)
  seq: number;
  vw: number;
  vh: number;
  inputQueue: InputEvent[];
}

const store = new Map<string, Entry>();
const TTL_MS = 15 * 60 * 1000; // reset on every update — gives the human ample time
const MAX_ENTRIES = 500;
const MAX_DATAURL_LEN = 200_000; // QR PNG is a few KB
const MAX_FRAME_LEN = 2_000_000; // ~1.5 MB base64 — a downscaled JPEG is far smaller
const MAX_QUEUE = 400; // input events buffered between connect ticks; drop oldest past this
const DATAURL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const B64_RE = /^[A-Za-z0-9+/=]+$/;

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
function newEntry(mode: Mode): { token: string; e: Entry } {
  pruneExpired();
  evictIfFull();
  const token = randomBytes(16).toString("hex");
  const e: Entry = { mode, state: "waiting", expiresAt: Date.now() + TTL_MS, dataUrl: null, frame: null, seq: 0, vw: 0, vh: 0, inputQueue: [] };
  store.set(token, e);
  return { token, e };
}

/* ─── QR mode (unchanged contract) ───────────────────────────────────────── */

/**
 * Create a QR session (no QR yet) so the agent gets a link immediately, or
 * update an existing one. `dataUrl` (re)sets the QR; `done` marks it captured.
 * Every call resets the TTL.
 */
export function putQr(opts: { dataUrl?: string; token?: string; done?: boolean }): { token: string; expiresInSec: number } {
  const { dataUrl, done } = opts;
  if (dataUrl !== undefined && (typeof dataUrl !== "string" || !DATAURL_RE.test(dataUrl))) {
    throw new Error("qr_data_url must be a base64 data:image URL (png/jpeg/webp)");
  }
  if (dataUrl && dataUrl.length > MAX_DATAURL_LEN) throw new Error("qr image too large");

  let e = opts.token ? fresh(opts.token) : null;
  if (e && e.mode !== "qr") e = null; // never repurpose a screencast session as a QR one
  let token = opts.token && e ? opts.token : undefined;
  if (!token || !e) { const c = newEntry("qr"); token = c.token; e = c.e; }
  if (done) e.state = "completed";
  else if (dataUrl) { e.dataUrl = dataUrl; e.state = "ready"; }
  e.expiresAt = Date.now() + TTL_MS;
  return { token, expiresInSec: Math.round(TTL_MS / 1000) };
}

export interface QrStatus { state: State; qr: string | null; expires_in_sec: number; }
export function getQrSession(token: string): QrStatus | null {
  const e = fresh(token);
  if (!e) return null;
  return { state: e.state, qr: e.dataUrl, expires_in_sec: Math.max(0, Math.round((e.expiresAt - Date.now()) / 1000)) };
}

/* ─── Screen mode ────────────────────────────────────────────────────────── */

/** Create a screencast hand-off session up front (agent gets the link instantly). */
export function createScreenSession(): { token: string; expiresInSec: number } {
  const { token } = newEntry("screen");
  return { token, expiresInSec: Math.round(TTL_MS / 1000) };
}

/**
 * `connect` pushes the latest browser frame and, in the same round-trip, drains
 * any input the human queued. `done` marks the login captured. Returns the
 * drained input for `connect` to replay, or null if the token is unknown/expired.
 */
export function pushFrame(token: string, opts: { frame?: string; vw?: number; vh?: number; done?: boolean }): { input: InputEvent[]; state: State } | null {
  const e = fresh(token);
  if (!e || e.mode !== "screen") return null;
  const { frame, vw, vh, done } = opts;
  if (frame !== undefined) {
    if (typeof frame !== "string" || !B64_RE.test(frame)) throw new Error("frame must be base64 jpeg bytes");
    if (frame.length > MAX_FRAME_LEN) throw new Error("frame too large");
    e.frame = frame;
    e.seq++;
    if (typeof vw === "number" && vw > 0) e.vw = Math.min(8000, Math.round(vw));
    if (typeof vh === "number" && vh > 0) e.vh = Math.min(8000, Math.round(vh));
    if (e.state === "waiting") e.state = "ready";
  }
  if (done) e.state = "completed";
  e.expiresAt = Date.now() + TTL_MS;
  const input = e.inputQueue;
  e.inputQueue = [];
  return { input, state: e.state };
}

/** The human's page enqueues clicks/keys here; validated + capped. */
export function enqueueInput(token: string, events: unknown): { ok: true; state: State } | null {
  const e = fresh(token);
  if (!e || e.mode !== "screen") return null;
  if (!Array.isArray(events)) throw new Error("events must be an array");
  for (const raw of events.slice(0, MAX_QUEUE)) {
    const ev = sanitizeInput(raw);
    if (ev) e.inputQueue.push(ev);
  }
  if (e.inputQueue.length > MAX_QUEUE) e.inputQueue.splice(0, e.inputQueue.length - MAX_QUEUE);
  return { ok: true, state: e.state };
}

/** Reject anything that isn't a well-formed, bounded input event. */
function sanitizeInput(raw: any): InputEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const num01 = (v: any) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
  if (raw.t === "m") {
    const x = num01(raw.x), y = num01(raw.y);
    if (x === null || y === null) return null;
    if (raw.k !== "down" && raw.k !== "up" && raw.k !== "move") return null;
    const ev: InputEvent = { t: "m", k: raw.k, x, y };
    if (typeof raw.b === "number" && raw.b >= 0 && raw.b <= 2) ev.b = raw.b | 0;
    if (typeof raw.n === "number" && raw.n >= 1 && raw.n <= 3) ev.n = raw.n | 0;
    return ev;
  }
  if (raw.t === "w") {
    const x = num01(raw.x), y = num01(raw.y);
    if (x === null || y === null) return null;
    const dx = typeof raw.dx === "number" && isFinite(raw.dx) ? Math.max(-2000, Math.min(2000, raw.dx)) : 0;
    const dy = typeof raw.dy === "number" && isFinite(raw.dy) ? Math.max(-2000, Math.min(2000, raw.dy)) : 0;
    return { t: "w", x, y, dx, dy };
  }
  if (raw.t === "x") {
    if (typeof raw.s !== "string" || raw.s.length === 0 || raw.s.length > 256) return null;
    return { t: "x", s: raw.s };
  }
  if (raw.t === "k") {
    if (raw.k !== "down" && raw.k !== "up") return null;
    if (typeof raw.key !== "string" || raw.key.length > 32) return null;
    const code = typeof raw.code === "string" && raw.code.length <= 32 ? raw.code : "";
    const ev: InputEvent = { t: "k", k: raw.k, key: raw.key, code };
    if (typeof raw.vk === "number" && raw.vk >= 0 && raw.vk <= 255) ev.vk = raw.vk | 0;
    return ev;
  }
  return null;
}

export interface LiveStatus { state: State; mode: Mode; seq: number; frame: string | null; vw: number; vh: number; expires_in_sec: number; }
export function getLive(token: string): LiveStatus | null {
  const e = fresh(token);
  if (!e) return null;
  return { state: e.state, mode: e.mode, seq: e.seq, frame: e.frame, vw: e.vw, vh: e.vh, expires_in_sec: Math.max(0, Math.round((e.expiresAt - Date.now()) / 1000)) };
}

/** Which page to render for a token (so the route can pick QR vs screen). */
export function sessionMode(token: string): Mode | null {
  const e = fresh(token);
  return e ? e.mode : null;
}

/* ─── Rendered pages ─────────────────────────────────────────────────────── */

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
 * Render the QR hand-off page. It polls `/connect/<token>/status` and
 * live-updates the QR, so a rotated code is always current.
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

const SCREEN_STYLE =
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Log in to TikTok — Palmyr</title><style>` +
  `*{box-sizing:border-box}html,body{margin:0;height:100%}` +
  `body{background:#0c2226;color:#e8e3d8;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;` +
  `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:14px}` +
  `#bar{font-size:14px;color:#a89774;min-height:18px;text-align:center}` +
  `#wrap{position:relative;line-height:0;max-width:100%;border-radius:12px;overflow:hidden;` +
  `box-shadow:0 10px 40px rgba(0,0,0,.45);background:#fff}` +
  `#screen{display:block;max-width:100%;max-height:82vh;width:auto;height:auto;cursor:default;` +
  `-webkit-user-select:none;user-select:none;-webkit-user-drag:none;touch-action:none}` +
  `#screen:focus{outline:none}` +
  `#wait{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#5f7a7f;font-size:14px}` +
  `.foot{font-size:12px;color:#5f7a7f;text-align:center;max-width:520px;line-height:1.6}` +
  `</style></head><body>`;

/**
 * Render the live-browser hand-off page. Shows the streamed JPEG and forwards
 * pointer + keyboard input back as normalized coords. Frames are polled; input
 * is batched and flushed on a short interval so it stays well under rate limits.
 */
export function renderScreenPage(token: string): string {
  const t = JSON.stringify(token);
  // Inline client. Compact but commented. Sends normalized [0,1] coords; the
  // CLI scales them to the browser viewport. Printable keys → text events;
  // control keys → key events. Mouse moves are sent only while dragging.
  const js =
    `(function(){var T=${t};` +
    `var img=document.getElementById('screen'),bar=document.getElementById('bar'),wait=document.getElementById('wait');` +
    `var seq=-1,done=false,buf=[],dragging=false,lastMove=0;` +
    // control keys → Windows virtual-key codes for CDP
    `var VK={Enter:13,Tab:9,Backspace:8,Delete:46,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34};` +
    `function norm(e){var r=img.getBoundingClientRect();if(!r.width||!r.height)return null;` +
    `var x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;` +
    `return{x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))};}` +
    `function push(ev){buf.push(ev);if(buf.length>300)buf.shift();}` +
    `function flush(){if(!buf.length||done)return;var ev=buf;buf=[];` +
    `fetch('/connect/'+T+'/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:ev})}).catch(function(){});}` +
    `setInterval(flush,70);` +
    // pointer
    `img.addEventListener('mousedown',function(e){e.preventDefault();img.focus();var p=norm(e);if(!p)return;` +
    `push({t:'m',k:'move',x:p.x,y:p.y});push({t:'m',k:'down',x:p.x,y:p.y,b:e.button,n:e.detail||1});dragging=true;flush();});` +
    `window.addEventListener('mouseup',function(e){var p=norm(e);if(!p)return;push({t:'m',k:'up',x:p.x,y:p.y,b:e.button});dragging=false;flush();});` +
    `img.addEventListener('mousemove',function(e){if(!dragging)return;var now=Date.now();if(now-lastMove<28)return;lastMove=now;` +
    `var p=norm(e);if(p)push({t:'m',k:'move',x:p.x,y:p.y});});` +
    `img.addEventListener('contextmenu',function(e){e.preventDefault();});` +
    `img.addEventListener('wheel',function(e){e.preventDefault();var p=norm(e);if(!p)return;push({t:'w',x:p.x,y:p.y,dx:e.deltaX,dy:e.deltaY});},{passive:false});` +
    // keyboard (img is focusable via tabindex)
    `img.addEventListener('keydown',function(e){` +
    `if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();push({t:'x',s:e.key});flush();return;}` +
    `if(VK[e.key]!==undefined){e.preventDefault();push({t:'k',k:'down',key:e.key,code:e.code||e.key,vk:VK[e.key]});push({t:'k',k:'up',key:e.key,code:e.code||e.key,vk:VK[e.key]});flush();}});` +
    `img.addEventListener('paste',function(e){var txt=(e.clipboardData||window.clipboardData).getData('text');if(txt){e.preventDefault();push({t:'x',s:txt.slice(0,256)});flush();}});` +
    // frame poll
    `function tick(){fetch('/connect/'+T+'/live',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(s){` +
    `if(s.state==='completed'){done=true;bar.textContent='✓ Logged in — you can close this tab.';wait.style.display='none';return;}` +
    `if(s.frame&&s.seq!==seq){seq=s.seq;img.src='data:image/jpeg;base64,'+s.frame;wait.style.display='none';bar.textContent='Live — type and click as if this were your own browser';}` +
    `else if(!s.frame){bar.textContent='Opening the login page on the server…';}` +
    `setTimeout(tick,250);}).catch(function(){done=true;bar.textContent='This link has expired — ask your agent for a fresh one.';wait.style.display='none';});}` +
    `img.setAttribute('tabindex','0');setTimeout(function(){try{img.focus();}catch(e){}},300);tick();})();`;
  return (
    SCREEN_STYLE +
    `<div id="bar">Connecting to the login page…</div>` +
    `<div id="wrap"><img id="screen" alt="Live browser"><div id="wait">Waiting for the browser…</div></div>` +
    `<p class="foot">You're controlling a real browser running on the agent's server. Log in normally — solve any captcha or 2FA here. ` +
    `The agent captures the session automatically the moment you're signed in. Nothing is stored on this page.</p>` +
    `<script>${js}</script></body></html>`
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
