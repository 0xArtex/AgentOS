/**
 * Server-side TikTok login, into the account's OWN persistent profile.
 *
 * The existing `tiktok connect` runs a browser on the operator's machine,
 * captures the cookie jar, and ships it to the server — where every subsequent
 * operation replays it from a different browser behind a residential proxy. So
 * the platform sees a session minted on one device at a home IP and then used
 * exclusively by another device at a proxy IP, forever. That incoherence is
 * baked in at the moment of login, and no amount of care afterwards removes it.
 *
 * Here the browser that authenticates IS the browser that will act: same
 * persistent profile, same proxy exit, same fingerprint. The session never
 * becomes a cookie jar in transit — it simply stays in the profile, which is
 * also why nothing here exports credentials.
 *
 * The human still scans a QR; only the browser holding it moved.
 */
import { putQr } from "./qr-handoff";
import { openAuthenticatedSession } from "./social-runtime";

/** How long we keep a login browser open waiting for a human to scan. */
const CONNECT_WINDOW_MS = 10 * 60 * 1000;
/** How often we re-read the QR (TikTok rotates it) and check for a session. */
const POLL_MS = 4000;

export type ConnectState = "starting" | "awaiting_scan" | "completed" | "failed";

interface ConnectRun {
  token: string;
  accountId: string;
  owner?: string;
  state: ConnectState;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

// Keyed by the PUBLIC read token, matching the /connect/<token> link the human
// is given. Bounded by the QR store's own entry cap and pruned on completion.
const runs = new Map<string, ConnectRun>();

export function getServerConnect(token: string): ConnectRun | undefined {
  return runs.get(token);
}

/**
 * Read TikTok's login QR. It renders into a same-origin <canvas> inside
 * `[data-e2e="qr-code"]`, so `toDataURL()` works; fall back to screenshotting
 * the element if that is ever tainted or swapped for an <img>.
 */
async function extractQr(page: any): Promise<string | null> {
  const viaCanvas: string = await page.evaluate(
    `(() => {
      const c = document.querySelector('[data-e2e="qr-code"] canvas') || document.querySelector('canvas');
      if (!c || !c.width) return '';
      try { return c.toDataURL('image/png'); } catch (e) { return ''; }
    })()`,
  ).catch(() => "");
  if (typeof viaCanvas === "string" && viaCanvas.startsWith("data:image")) return viaCanvas;

  try {
    const el = page.locator('[data-e2e="qr-code"], canvas').first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      const buf = await el.screenshot({ timeout: 5000 });
      return "data:image/png;base64," + Buffer.from(buf).toString("base64");
    }
  } catch {
    /* caller treats a null as "not rendered yet" and polls again */
  }
  return null;
}

/** True once TikTok has set a real session cookie on this context. */
async function sessionCaptured(ctx: any): Promise<boolean> {
  const cookies = await ctx.cookies().catch(() => []);
  return cookies.some((c: any) => c.name === "sessionid" && typeof c.value === "string" && c.value.length > 10);
}

/**
 * Drive the login browser until the human scans or the window closes. Runs
 * detached — the caller already has its hand-off link and must not wait.
 */
async function driveConnect(run: ConnectRun, writer: string, opts: { country?: string; proxySessionId?: string }): Promise<void> {
  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: run.accountId,
      cookies: [],
      country: opts.country,
      proxySessionId: opts.proxySessionId,
      // Its own pool: a login idles for up to ten minutes waiting on a human
      // and must never starve posts and ops.
      pool: "connect",
      // TikTok refuses to AUTHORISE a scan from a headless browser, so this
      // needs a real or virtual display (Xvfb) on the host.
      headless: false,
      // The login page is visual — the QR is what we came for.
      loadMedia: true,
      // Without the account's own profile there is nowhere for the captured
      // session to live once this browser closes.
      persistentProfile: true,
    });
  } catch (e: any) {
    run.state = "failed";
    run.error = `could not open a login browser: ${e?.message || e}`;
    return;
  }

  const { ctx, page, close } = session;
  const deadline = Date.now() + CONNECT_WINDOW_MS;
  console.log(
    `[tiktok-connect] login browser up for ${run.accountId} ` +
    `(exit country ${opts.country || process.env.IPROYAL_DEFAULT_COUNTRY || "us"})`,
  );
  try {
    await page.goto("https://www.tiktok.com/login/qrcode", { waitUntil: "domcontentloaded", timeout: 45000 });

    let lastQr: string | null = null;
    let publishedAt = 0;
    while (Date.now() < deadline) {
      // Check for the session FIRST: if the human has already scanned there is
      // no QR left to publish and we would otherwise wait a whole extra poll.
      if (await sessionCaptured(ctx)) {
        try { putQr({ token: writer, done: true }); } catch { /* link may have expired; the profile is what matters */ }
        run.state = "completed";
        run.completedAt = Date.now();
        console.log(`[tiktok-connect] captured a session for ${run.accountId} into its own profile`);
        return;
      }

      // TikTok answers a REFUSED scan on the browser side too, and that message
      // is the only server-visible account of why. Without capturing it the
      // only evidence is whatever the human reports from their phone, which is
      // how a refusal previously told us nothing at all.
      const refusal: string = await page.evaluate(
        `(() => {
          const t = (document.body && document.body.innerText) || '';
          const m = t.match(/[^\\n]*(couldn'?t log ?in|could not log ?in|try another login method|too many attempts|something went wrong)[^\\n]*/i);
          return m ? m[0].trim().slice(0, 200) : '';
        })()`,
      ).catch(() => "");
      if (refusal) {
        run.state = "failed";
        run.error = `TikTok refused the login: ${refusal}`;
        console.error(
          `[tiktok-connect] REFUSED for ${run.accountId} after ${Math.round((Date.now() - publishedAt) / 1000)}s — "${refusal}". ` +
          `QR login is phishing-sensitive: TikTok weighs the distance between the scanning phone and the browser being authorised, ` +
          `so an exit country that does not match the human's is the first thing to check ` +
          `(this run used ${opts.country || process.env.IPROYAL_DEFAULT_COUNTRY || "us"}).`,
        );
        return;
      }

      const qr = await extractQr(page);
      // Republish only on change — TikTok rotates the code, and an unchanged
      // image would just reset the hand-off TTL for no reason.
      if (qr && qr !== lastQr) {
        lastQr = qr;
        try {
          putQr({ token: writer, dataUrl: qr });
          if (run.state === "starting") {
            run.state = "awaiting_scan";
            publishedAt = Date.now();
            console.log(`[tiktok-connect] QR published for ${run.accountId}; waiting for a human to scan`);
          }
        } catch (e: any) {
          run.state = "failed";
          run.error = `hand-off link rejected the QR: ${e?.message || e}`;
          console.error(`[tiktok-connect] hand-off rejected the QR for ${run.accountId}: ${run.error}`);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    run.state = "failed";
    run.error = "nobody scanned the code before the login window closed";
    console.warn(`[tiktok-connect] window closed unscanned for ${run.accountId}`);
  } catch (e: any) {
    run.state = "failed";
    run.error = e?.message || String(e);
    console.error(`[tiktok-connect] login failed for ${run.accountId}: ${run.error}`);
  } finally {
    await close().catch(() => {});
  }
}

export interface StartConnectResult {
  token: string;
  connect_url: string;
  expires_in_sec: number;
}

/**
 * Begin a server-side login and return the hand-off link immediately. The
 * browser work continues in the background; the human's page polls
 * /connect/<token>/status, and this run's own state is readable via
 * getServerConnect().
 */
export function startServerConnect(opts: {
  accountId: string;
  owner?: string;
  country?: string;
  proxySessionId?: string;
  baseUrl?: string;
}): StartConnectResult {
  const created = putQr({});
  const run: ConnectRun = {
    token: created.token,
    accountId: opts.accountId,
    owner: opts.owner,
    state: "starting",
    startedAt: Date.now(),
  };
  runs.set(created.token, run);

  // Detached on purpose: the caller needs its link now, not in ten minutes.
  void driveConnect(run, created.writer, { country: opts.country, proxySessionId: opts.proxySessionId })
    .catch((e) => {
      run.state = "failed";
      run.error = e?.message || String(e);
    })
    .finally(() => {
      // Keep the record briefly so a poll after completion still gets an
      // answer, then let it go.
      setTimeout(() => runs.delete(created.token), 5 * 60 * 1000).unref?.();
    });

  const base = (opts.baseUrl || "https://palmyr.ai").replace(/\/+$/, "");
  return {
    token: created.token,
    connect_url: `${base}/connect/${created.token}`,
    expires_in_sec: created.expiresInSec,
  };
}
