/**
 * Server-hosted TikTok QR connect.
 *
 * The problem this solves: `tiktok connect` historically drove the QR-login
 * browser on the CLIENT machine. On a headless VPS that browser sits on a
 * datacenter IP with a server fingerprint, and TikTok blocks the login. The
 * clean alternative — proven to work headless (the QR page renders fine through
 * a residential proxy; the *phone* does the auth, so headless is fine here even
 * though the credential form refuses it) — is to run the QR browser SERVER-SIDE
 * through the account's residential proxy:
 *
 *   POST /social/tiktok/connect  →  202 { operation_id, connect_url, claim_token }
 *      server opens a stealth browser through the account's proxy, loads the QR
 *      login page, and pushes the QR into the existing /connect/<token> page.
 *   human opens connect_url → scans with the TikTok app → confirms on phone.
 *   worker detects the sessionid cookie → harvests the jar → status 'completed'.
 *   CLI polls (free) until 'completed', then POST .../claim { claim_token } →
 *      receives the cookie jar ONCE, writes its local encrypted vault.
 *
 * Why the session is born right: the QR is requested — and the session issued —
 * from the SAME residential IP the account will operate from. No geo-jump (the
 * weakness of cookie-import), no datacenter login (the weakness of VPS connect).
 *
 * Security: the status poll is the free, unauthenticated operation poll (the
 * operation_id UUID is the capability) and NEVER returns cookies. The session is
 * delivered only via `claim`, gated by a separate secret `claim_token` returned
 * once to the authenticated creator of the connect — so a leaked operation_id
 * can't yield a full account session. Cookies are wiped from the row on claim.
 */
import { randomUUID, randomBytes, timingSafeEqual } from "crypto";
import { db } from "../db";
import { openAuthenticatedSession } from "./social-runtime";
import { putQr } from "./qr-handoff";

export type TikTokConnectStatus = "waiting" | "completed" | "failed" | "expired";

export interface TikTokConnectJobRow {
  id: string;
  account_id: string;
  owner: string;
  qr_token: string;
  claim_token: string;
  status: TikTokConnectStatus;
  cookies_json: string | null;
  claimed: number;
  error: string | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tiktok_connect_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    qr_token TEXT NOT NULL,
    claim_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting'
      CHECK(status IN ('waiting','completed','failed','expired')),
    cookies_json TEXT,
    claimed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tiktok_connect_owner ON tiktok_connect_jobs(owner);
  CREATE INDEX IF NOT EXISTS idx_tiktok_connect_status ON tiktok_connect_jobs(status);
`);

const nowIso = () => new Date().toISOString();

export function getConnectJob(id: string): TikTokConnectJobRow | null {
  const row = db.prepare("SELECT * FROM tiktok_connect_jobs WHERE id = ?").get(id) as TikTokConnectJobRow | undefined;
  return row || null;
}

// How long the worker keeps the browser open waiting for a phone scan. Matches
// the CLI's QR window + the hand-off TTL (~15 min). Polls every ~2.5s.
const CONNECT_WINDOW_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2500;

export interface ConnectJobInput {
  account_id: string;
  owner: string;
  proxySessionId?: string;
  country?: string;
}

// Dependency seam — tests inject a fake session opener / qr push to exercise the
// state machine without a real browser.
export interface ConnectDeps {
  openSession: typeof openAuthenticatedSession;
  pushQr: (opts: { dataUrl?: string; token?: string; done?: boolean }) => unknown;
}
function defaultDeps(): ConnectDeps {
  return { openSession: openAuthenticatedSession, pushQr: putQr };
}

/**
 * Create a connect job + its QR hand-off token, and kick the background worker.
 * Returns the row plus the secret claim_token (surfaced ONCE to the caller).
 */
export function createConnectJob(input: ConnectJobInput, deps: ConnectDeps = defaultDeps()): TikTokConnectJobRow {
  // Idempotent / anti-spam: if this owner already has a 'waiting' connect for
  // this account inside the window, return it instead of spawning a second
  // browser. Two stealth browsers on one residential IP is itself a fingerprint
  // risk, and it multiplies connect-pool pressure. (Different owner → its own job.)
  const windowCutoff = new Date(Date.now() - CONNECT_WINDOW_MS).toISOString();
  const existing = db.prepare(
    "SELECT * FROM tiktok_connect_jobs WHERE account_id=? AND owner=? AND status='waiting' AND created_at > ? ORDER BY created_at DESC LIMIT 1"
  ).get(input.account_id, input.owner, windowCutoff) as TikTokConnectJobRow | undefined;
  if (existing) return existing;

  const id = randomUUID();
  const claim_token = randomBytes(24).toString("hex");
  // Mint the hand-off token now so the caller gets a /connect/<token> link
  // immediately, before the QR renders.
  const { token: qr_token } = deps.pushQr({}) as { token: string };
  db.prepare(
    `INSERT INTO tiktok_connect_jobs (id, account_id, owner, qr_token, claim_token, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'waiting', ?)`
  ).run(id, input.account_id, input.owner, qr_token, claim_token, nowIso());
  scheduleWorker(id, input, deps);
  return getConnectJob(id)!;
}

function scheduleWorker(id: string, input: ConnectJobInput, deps: ConnectDeps): void {
  setImmediate(() => {
    runConnectJob(id, input, deps).catch((e) => {
      try {
        db.prepare(
          "UPDATE tiktok_connect_jobs SET status='failed', error=?, error_code='worker_exception', completed_at=? WHERE id=? AND status='waiting'"
        ).run(String(e?.message || e), nowIso(), id);
      } catch { /* recovery sweep will catch it */ }
    });
  });
}

// Extract the QR as a PNG data-URL. Screenshotting the element is robust to how
// TikTok renders it (img data-url / canvas / svg all rasterize to PNG), and PNG
// satisfies the hand-off store's data-URL validation.
async function extractQrDataUrl(page: any): Promise<string | null> {
  const selectors = [
    '[data-e2e="qr-code"]',
    '[data-e2e="qr-code"] img',
    '[data-e2e="qr-code"] canvas',
    'img[src^="data:image"]',
    'canvas',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      await loc.waitFor({ state: "visible", timeout: 1500 }).catch(() => {});
      const buf = await loc.screenshot({ type: "png", timeout: 4000 });
      if (buf && buf.length > 0) return `data:image/png;base64,${buf.toString("base64")}`;
    } catch { /* try next selector */ }
  }
  return null;
}

function isTikTokCookie(domain: string): boolean {
  return /(^|\.)tiktok\.com$/i.test((domain || "").replace(/^\./, "."));
}

export async function runConnectJob(jobId: string, input: ConnectJobInput, deps: ConnectDeps = defaultDeps()): Promise<void> {
  const job = getConnectJob(jobId);
  if (!job || job.status !== "waiting") return;
  db.prepare("UPDATE tiktok_connect_jobs SET started_at=? WHERE id=? AND started_at IS NULL").run(nowIso(), jobId);

  let session: { ctx: any; page: any; close: () => Promise<void> } | null = null;
  try {
    session = await deps.openSession({
      accountId: input.account_id,
      proxySessionId: input.proxySessionId,
      cookies: [],
      country: input.country,
      pool: "connect", // own pool — a 10-min QR wait must not starve posts/ops
    });
    const { ctx, page } = session;

    await page.goto("https://www.tiktok.com/login/qrcode", { waitUntil: "domcontentloaded", timeout: 45000 });

    const deadline = Date.now() + CONNECT_WINDOW_MS;
    let lastQr = "";
    while (Date.now() < deadline) {
      // Re-check the job hasn't been cancelled/expired out from under us.
      const cur = getConnectJob(jobId);
      if (!cur || cur.status !== "waiting") return;

      // Refresh the QR shown to the human (TikTok rotates it every ~minute).
      try {
        const dataUrl = await extractQrDataUrl(page);
        if (dataUrl && dataUrl !== lastQr) {
          lastQr = dataUrl;
          try { deps.pushQr({ dataUrl, token: job.qr_token }); } catch { /* size/format guard — skip this frame */ }
        }
      } catch { /* transient; retry next tick */ }

      // Has the phone confirmed? sessionid appears in the jar on success.
      let cookies: any[] = [];
      try { cookies = await ctx.cookies(); } catch { cookies = []; }
      // sessionid is the completion SIGNAL only — persist the FULL jar (TikTok
      // sets session-critical cookies on sibling domains too, e.g. .tiktokv.com;
      // the proven login/connect flows keep the whole jar, so we match them).
      const tt = cookies.filter((c: any) => isTikTokCookie(c.domain));
      const sid = tt.find((c: any) => c.name === "sessionid" && typeof c.value === "string" && c.value.length > 10);
      if (sid) {
        db.prepare(
          "UPDATE tiktok_connect_jobs SET status='completed', cookies_json=?, completed_at=? WHERE id=? AND status='waiting'"
        ).run(JSON.stringify(cookies), nowIso(), jobId);
        try { deps.pushQr({ token: job.qr_token, done: true }); } catch { /* cosmetic */ }
        return;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Window elapsed with no scan.
    db.prepare(
      "UPDATE tiktok_connect_jobs SET status='expired', error='no scan within the connect window', error_code='connect_timeout', completed_at=? WHERE id=? AND status='waiting'"
    ).run(nowIso(), jobId);
  } catch (e: any) {
    db.prepare(
      "UPDATE tiktok_connect_jobs SET status='failed', error=?, error_code='connect_error', completed_at=? WHERE id=? AND status='waiting'"
    ).run(String(e?.message || e), nowIso(), jobId);
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

export interface ClaimResult {
  ok: boolean;
  cookies?: any[];
  reason?: string;
}

// Constant-time secret comparison (the claim_token bears a full session).
function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Deliver the harvested session ONCE to the authenticated creator. Verifies the
 * secret claim_token, returns the cookie jar, then wipes it from the row so the
 * session never lingers server-side.
 */
export function claimConnectJob(id: string, claimToken: string): ClaimResult {
  const job = getConnectJob(id);
  if (!job) return { ok: false, reason: "not_found" };
  if (!constantTimeEq(job.claim_token, claimToken)) return { ok: false, reason: "bad_claim_token" };
  if (job.status !== "completed" || !job.cookies_json) {
    return { ok: false, reason: job.status === "completed" ? "already_claimed" : `not_ready:${job.status}` };
  }
  const cookies = JSON.parse(job.cookies_json);
  // One-time: wipe the jar so a replayed claim can't re-leak it.
  db.prepare("UPDATE tiktok_connect_jobs SET cookies_json=NULL, claimed=1 WHERE id=?").run(id);
  return { ok: true, cookies };
}

// Recovery: a 'waiting' job orphaned by a restart (or a hung worker) has a dead
// or stuck browser, so it can never complete. Mark it expired; the user re-runs
// connect. The $0.01 connect fee is a non-refundable abuse gate (it bounds
// browser/proxy spam) — no session was delivered, but there's intentionally no
// refund here. Runs at startup AND on a timer so stuck rows are reaped promptly.
const STUCK_AGE_MS = CONNECT_WINDOW_MS + 60_000;

export async function recoverStuckConnectJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_AGE_MS).toISOString();
  const stuck = db
    .prepare("SELECT id FROM tiktok_connect_jobs WHERE status='waiting' AND created_at < ?")
    .all(cutoff) as Array<{ id: string }>;
  if (stuck.length === 0) return;
  console.log(`[tiktok-connect] expiring ${stuck.length} stuck connect job(s) on startup`);
  for (const { id } of stuck) {
    db.prepare(
      "UPDATE tiktok_connect_jobs SET status='expired', error='server restarted before scan', error_code='server_restarted', completed_at=? WHERE id=? AND status='waiting'"
    ).run(nowIso(), id);
  }
}

export function startTikTokConnectRecovery(): void {
  setImmediate(() => {
    recoverStuckConnectJobs().catch((e) => console.error("[tiktok-connect] startup recovery error:", e?.message || String(e)));
  });
  // Periodic sweep so an orphaned/hung 'waiting' row is reaped without waiting
  // for a restart. unref so it never keeps the process alive (tests).
  setInterval(() => {
    recoverStuckConnectJobs().catch((e) => console.error("[tiktok-connect] periodic recovery error:", e?.message || String(e)));
  }, 5 * 60 * 1000).unref();
}
