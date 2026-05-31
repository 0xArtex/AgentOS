/**
 * Ephemeral QR hand-off for `tiktok connect --qr`.
 *
 * An agent running `connect --qr` extracts TikTok's login QR locally, POSTs it
 * here, and gets back a short token. It forwards `https://<host>/connect/<token>`
 * to its human, who opens it and scans the QR with the TikTok app. The agent's
 * own browser then captures the session (unchanged).
 *
 * Deliberately tiny + in-memory: TikTok QRs expire in minutes anyway, so there's
 * no value in persisting. Guards (short TTL, small size cap, entry cap, strict
 * data-URL validation) keep this from being usable as a general image host.
 */
import { randomBytes } from "crypto";

interface Entry {
  dataUrl: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();
const TTL_MS = 5 * 60 * 1000; // TikTok QRs lapse fast; 5 min is generous
const MAX_ENTRIES = 500;
const MAX_DATAURL_LEN = 200_000; // ~150 KB; a 170px PNG QR is a few KB
const DATAURL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of store) if (now > v.expiresAt) store.delete(k);
}

export function putQr(dataUrl: string): { token: string; expiresInSec: number } {
  if (typeof dataUrl !== "string" || !DATAURL_RE.test(dataUrl)) {
    throw new Error("qr_data_url must be a base64 data:image URL (png/jpeg/webp)");
  }
  if (dataUrl.length > MAX_DATAURL_LEN) throw new Error("qr image too large");
  pruneExpired();
  if (store.size >= MAX_ENTRIES) {
    // Evict the soonest-to-expire entry to bound memory.
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, v] of store) if (v.expiresAt < oldestAt) { oldestAt = v.expiresAt; oldestKey = k; }
    if (oldestKey) store.delete(oldestKey);
  }
  const token = randomBytes(16).toString("hex");
  store.set(token, { dataUrl, expiresAt: Date.now() + TTL_MS });
  return { token, expiresInSec: TTL_MS / 1000 };
}

export function getQr(token: string): string | null {
  const e = store.get(token);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { store.delete(token); return null; }
  return e.dataUrl;
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

/** Render the QR page. `dataUrl` is validated on store, so it's safe in src. */
export function renderQrPage(dataUrl: string): string {
  return (
    PAGE_HEAD +
    `<h1>Log in to TikTok</h1><p class="sub">Scan this with the TikTok app</p>` +
    `<div class="qr"><img src="${dataUrl}" alt="TikTok login QR"></div>` +
    `<div class="steps">1. Open TikTok on your phone<br>` +
    `2. Profile → ☰ menu → scan QR code<br>3. Confirm login</div>` +
    `<p class="foot">This code expires in a few minutes.</p>` +
    `</div></body></html>`
  );
}

export function renderExpiredPage(): string {
  return (
    PAGE_HEAD +
    `<h1>Link expired</h1>` +
    `<p class="sub">This TikTok login QR has expired or was already used.</p>` +
    `<div class="steps">Ask for a fresh link and try again.</div>` +
    `</div></body></html>`
  );
}
