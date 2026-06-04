/**
 * Local real-browser TikTok login — the agent-smooth alternative to fighting
 * TikTok's anti-bot from a headless VPS session (the old `tiktok login` form
 * driver perma-spun ~70% of the time).
 *
 * The idea (borrowed from Hermes Agent's `/browser connect`): don't emulate a
 * human, *be* one. We launch the operator's real Chrome/Edge/Brave — real
 * fingerprint, real home IP — point it at TikTok's login page, and let the
 * human solve login + captcha + 2FA themselves (free, and unbeatable by any
 * solver). The moment a `sessionid` cookie appears we harvest the full jar and
 * hand it back; the caller drops it into the same encrypted session cache that
 * `post`/`follow`/`like` already read, so every downstream op is unchanged.
 *
 * Why CDP and not Playwright: TikTok's `sessionid` is HttpOnly, so a
 * `document.cookie` scrape can never see it. CDP's `Network.getAllCookies`
 * reads HttpOnly cookies directly — and it rides the `ws` dependency the CLI
 * already ships, so this adds zero install weight.
 *
 * Agent contract: this never blocks forever (bounded by `timeoutMs`) and never
 * needs a keystroke (it auto-detects the session). The caller gets a single
 * structured result it can branch on.
 */
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";
import http from "http";
import WebSocket from "ws";

/** Cookie shape the server's `openAuthenticatedSession` expects (Playwright addCookies). */
export interface HarvestedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface ConnectOptions {
  /** ISO-3166 alpha-2 (informational here; the account already carries it). */
  country?: string;
  /** Hard ceiling on how long we wait for the human to finish login. */
  timeoutMs?: number;
  /** Explicit browser binary; overrides auto-detection and PALMYR_BROWSER_PATH. */
  browserPath?: string;
  /**
   * Launch the browser with --no-sandbox. Auto-enabled when running as root on
   * Linux (Chromium refuses to start the sandbox as root and exits instantly);
   * set explicitly for other headless / CI environments.
   */
  noSandbox?: boolean;
  /**
   * Use TikTok's QR login instead of a typed login. Opens a real (headed)
   * browser on the QR page — headed because TikTok refuses QR-auth into a
   * headless session — extracts the QR (PNG + data-URL) for a human to scan with
   * the TikTok app, then captures the session. No captcha, no password. On a
   * headless server, run under a virtual display (xvfb).
   */
  qr?: boolean;
  /**
   * Called once with the QR data-URL the moment it's extracted (QR mode), so the
   * caller can host it / relay a link while connect keeps waiting for the scan.
   */
  onQr?: (dataUrl: string) => void | Promise<void>;
  /**
   * Remote interactive login: instead of QR, stream the real (headed) browser as
   * JPEG frames so a human on any device can do the email/password/captcha/2FA
   * login themselves through a hand-off link. Lands on the typed-login page.
   */
  remote?: boolean;
  /**
   * Relay tick for remote mode. Called repeatedly with the latest browser frame
   * (base64 JPEG + viewport size in CSS px); returns the human's queued input
   * events for connect to replay over CDP. The caller wires this to the server
   * hand-off (push frame + drain input in one round-trip).
   */
  pushFrameAndPullInput?: (frame: { b64: string; vw: number; vh: number } | null) => Promise<RelayInputEvent[]>;
  /** Human-facing progress lines. Caller routes these to stderr so stdout stays clean JSON. */
  onProgress?: (msg: string) => void;
}

/** A human input event relayed from the hand-off page (normalized [0,1] coords). */
export type RelayInputEvent =
  | { t: "m"; k: "down" | "up" | "move"; x: number; y: number; b?: number; n?: number }
  | { t: "w"; x: number; y: number; dx: number; dy: number }
  | { t: "x"; s: string }
  | { t: "k"; k: "down" | "up"; key: string; code: string; vk?: number };

export interface ConnectResult {
  success: boolean;
  cookies?: HarvestedCookie[];
  cookiesCaptured?: number;
  sessionidPresent?: boolean;
  /** Which browser we drove (chrome/edge/brave/chromium/custom). */
  browser?: string;
  /** Country inferred from the real browser env — locale region, then timezone. Undefined if undetectable. */
  detectedCountry?: string;
  detectedLocale?: string;
  detectedTimezone?: string;
  /** QR-login mode: saved QR PNG path + its data-URL, for relaying to a human to scan. */
  qrPngPath?: string;
  qrDataUrl?: string;
  reason?:
    | "no_local_browser"
    | "launch_failed"
    | "cdp_failed"
    | "login_timeout"
    | "aborted";
  error?: string;
}

/* ─── Browser discovery ──────────────────────────────────────────────────── */

interface BrowserCandidate {
  path: string;
  name: string;
}

/**
 * Find a Chromium-family browser. Only returns paths that exist on disk, so a
 * null result is a reliable "no browser here" signal (→ graceful handoff to the
 * manual import path rather than a doomed launch).
 */
function findBrowser(explicit?: string): BrowserCandidate | null {
  const tryList: BrowserCandidate[] = [];

  const override = explicit || process.env.PALMYR_BROWSER_PATH;
  if (override) tryList.push({ path: override, name: "custom" });

  const plat = process.platform;
  if (plat === "win32") {
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"];
    tryList.push(
      { path: join(pf, "Google\\Chrome\\Application\\chrome.exe"), name: "chrome" },
      { path: join(pf86, "Google\\Chrome\\Application\\chrome.exe"), name: "chrome" },
      ...(local ? [{ path: join(local, "Google\\Chrome\\Application\\chrome.exe"), name: "chrome" }] : []),
      { path: join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"), name: "edge" },
      { path: join(pf, "Microsoft\\Edge\\Application\\msedge.exe"), name: "edge" },
      ...(local ? [{ path: join(local, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), name: "brave" }] : []),
    );
  } else if (plat === "darwin") {
    tryList.push(
      { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "chrome" },
      { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "edge" },
      { path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", name: "brave" },
      { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", name: "chromium" },
    );
  } else {
    // Linux — enumerate common absolute locations across distros/snap.
    for (const dir of ["/usr/bin", "/usr/local/bin", "/snap/bin", "/opt/google/chrome"]) {
      tryList.push(
        { path: join(dir, "google-chrome"), name: "chrome" },
        { path: join(dir, "google-chrome-stable"), name: "chrome" },
        { path: join(dir, "chromium"), name: "chromium" },
        { path: join(dir, "chromium-browser"), name: "chromium" },
        { path: join(dir, "microsoft-edge"), name: "edge" },
        { path: join(dir, "brave-browser"), name: "brave" },
        { path: join(dir, "chrome"), name: "chrome" },
      );
    }
  }

  for (const c of tryList) {
    try {
      if (existsSync(c.path)) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/* ─── Small helpers ──────────────────────────────────────────────────────── */

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

function httpGetJson(url: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** CDP `sameSite` → Playwright's accepted set; omit anything unexpected. */
function normalizeSameSite(v: any): HarvestedCookie["sameSite"] | undefined {
  if (v === "Strict" || v === "Lax" || v === "None") return v;
  return undefined;
}

/** CDP cookie → the clean Playwright-injectable shape (drops size/priority/etc.). */
function normalizeCookie(c: any): HarvestedCookie {
  const out: HarvestedCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
  };
  // CDP gives expires in Unix seconds, or -1 for a session cookie — omit those.
  if (typeof c.expires === "number" && c.expires > 0) out.expires = Math.floor(c.expires);
  const ss = normalizeSameSite(c.sameSite);
  if (ss) out.sameSite = ss;
  return out;
}

function isTikTokCookie(domain: string): boolean {
  return domain.replace(/^\./, "").toLowerCase().endsWith("tiktok.com");
}

/**
 * Timezone → ISO country, mirroring the server's COUNTRY_PROFILES set (plus the
 * extra US/CA/AU zones a single capital-city entry misses). Only consulted when
 * the browser locale has no region subtag, so it doesn't need to be exhaustive.
 */
const TZ_COUNTRY: Record<string, string> = {
  "America/New_York": "us", "America/Chicago": "us", "America/Denver": "us",
  "America/Los_Angeles": "us", "America/Phoenix": "us", "America/Anchorage": "us",
  "America/Toronto": "ca", "America/Vancouver": "ca", "America/Edmonton": "ca",
  "Europe/London": "gb", "Europe/Dublin": "ie",
  "Australia/Sydney": "au", "Australia/Melbourne": "au", "Australia/Perth": "au", "Australia/Brisbane": "au",
  "Pacific/Auckland": "nz",
  "Europe/Berlin": "de", "Europe/Vienna": "at", "Europe/Zurich": "ch",
  "Europe/Paris": "fr", "Europe/Brussels": "be", "Europe/Amsterdam": "nl",
  "Europe/Madrid": "es", "Europe/Rome": "it", "Europe/Lisbon": "pt",
  "Europe/Warsaw": "pl", "Europe/Prague": "cz", "Europe/Stockholm": "se",
  "Europe/Oslo": "no", "Europe/Copenhagen": "dk", "Europe/Helsinki": "fi",
  "Europe/Athens": "gr", "Europe/Bucharest": "ro", "Europe/Budapest": "hu",
  "Europe/Istanbul": "tr", "Europe/Moscow": "ru", "Europe/Kyiv": "ua",
  "America/Sao_Paulo": "br", "America/Mexico_City": "mx", "America/Argentina/Buenos_Aires": "ar",
  "Asia/Tokyo": "jp", "Asia/Seoul": "kr", "Asia/Kolkata": "in", "Asia/Jakarta": "id",
  "Asia/Manila": "ph", "Asia/Bangkok": "th", "Asia/Ho_Chi_Minh": "vn", "Asia/Singapore": "sg",
  "Asia/Kuala_Lumpur": "my", "Asia/Dubai": "ae", "Asia/Riyadh": "sa", "Asia/Jerusalem": "il",
  "Africa/Johannesburg": "za",
};

/**
 * Infer the account's country from the live browser. Locale region subtag is
 * the primary signal (e.g. `en-US` → us, `pt-BR` → br) since modern browsers
 * almost always include it; timezone is the fallback when they don't.
 */
function countryFromBrowser(locale?: string, timezone?: string): string | undefined {
  if (locale) {
    const m = locale.match(/[-_]([A-Za-z]{2})(?:$|[-_])/);
    if (m) return m[1].toLowerCase();
  }
  if (timezone && TZ_COUNTRY[timezone]) return TZ_COUNTRY[timezone];
  return undefined;
}

/* ─── Minimal CDP client over a single page target ───────────────────────── */

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private listeners = new Map<string, ((params: any) => void)[]>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: any) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
        else p.resolve(msg.result);
      } else if (typeof msg.method === "string") {
        const ls = this.listeners.get(msg.method);
        if (ls) for (const fn of ls) { try { fn(msg.params); } catch { /* listener errors are non-fatal */ } }
      }
    });
    ws.on("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
    ws.on("error", () => {
      /* surfaced via close */
    });
  }

  static connect(wsUrl: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const onErr = (e: any) => reject(e);
      ws.once("error", onErr);
      ws.once("open", () => {
        ws.removeListener("error", onErr);
        resolve(new CdpSession(ws));
      });
    });
  }

  /** Subscribe to a CDP event (e.g. "Page.screencastFrame"). */
  on(method: string, fn: (params: any) => void): void {
    const a = this.listeners.get(method) || [];
    a.push(fn);
    this.listeners.set(method, a);
  }

  send(method: string, params: Record<string, any> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("CDP socket closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }), (e) => {
        if (e) {
          this.pending.delete(id);
          reject(e);
        }
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

/** Pick the first inspectable page target from CDP's target list. */
async function findPageTarget(port: number): Promise<string | null> {
  try {
    const targets = await httpGetJson(`http://127.0.0.1:${port}/json`);
    if (!Array.isArray(targets)) return null;
    const page = targets.find(
      (t: any) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string",
    );
    return page?.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

/**
 * Extract TikTok's login QR from `/login/qrcode`. The QR is a same-origin
 * <canvas> inside [data-e2e="qr-code"] (verified against the live page), so
 * `canvas.toDataURL()` works; fall back to a CDP element screenshot if the
 * canvas is ever tainted or swapped for an <img>. Polls until it renders.
 */
async function extractTikTokQr(cdp: CdpSession): Promise<{ dataUrl?: string }> {
  for (let i = 0; i < 12; i++) {
    try {
      const ev = await cdp.send("Runtime.evaluate", {
        expression:
          `(()=>{const c=document.querySelector('[data-e2e="qr-code"] canvas')||document.querySelector('canvas');` +
          `if(!c||!c.width)return '';try{return c.toDataURL('image/png');}catch(e){return 'TAINTED';}})()`,
        returnByValue: true,
      });
      const v = ev?.result?.value;
      if (typeof v === "string" && v.startsWith("data:image")) return { dataUrl: v };
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
  // Fallback: screenshot the QR element region.
  try {
    const boxEv = await cdp.send("Runtime.evaluate", {
      expression:
        `(()=>{const e=document.querySelector('[data-e2e="qr-code"]')||document.querySelector('canvas');` +
        `if(!e)return '';const r=e.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`,
      returnByValue: true,
    });
    const v = boxEv?.result?.value;
    if (typeof v === "string" && v) {
      const b = JSON.parse(v);
      if (b.w > 0) {
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 },
        });
        if (shot?.data) return { dataUrl: "data:image/png;base64," + shot.data };
      }
    }
  } catch {
    /* give up — caller reports no QR */
  }
  return {};
}

function saveQrPng(dataUrl: string): string {
  const b64 = dataUrl.split(",")[1] || "";
  const path = join(tmpdir(), `palmyr-tiktok-qr-${Date.now()}.png`);
  writeFileSync(path, Buffer.from(b64, "base64"));
  return path;
}

/* ─── Remote-login input replay (screencast mode) ────────────────────────── */

const BTN_NAME = (b?: number) => (b === 2 ? "right" : b === 1 ? "middle" : "left");
const BTN_MASK = (b?: number) => (b === 2 ? 2 : b === 1 ? 4 : 1); // CDP buttons bitmask: left=1,right=2,middle=4

/**
 * Replay one human input event into the live browser via CDP. Normalized coords
 * are scaled to the screencast viewport (CSS px). Printable text goes through
 * insertText (reliable for password fields); control keys through key events.
 * `st.buttons` tracks held mouse buttons so drags (slider captchas) carry the
 * right `buttons` bitmask through move events.
 */
async function dispatchInput(
  cdp: CdpSession,
  ev: RelayInputEvent,
  vw: number,
  vh: number,
  st: { buttons: number },
): Promise<void> {
  try {
    if (ev.t === "m") {
      const x = ev.x * vw, y = ev.y * vh;
      if (ev.k === "down") {
        st.buttons |= BTN_MASK(ev.b);
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: BTN_NAME(ev.b), buttons: st.buttons, clickCount: ev.n || 1 });
      } else if (ev.k === "up") {
        const after = st.buttons & ~BTN_MASK(ev.b);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: BTN_NAME(ev.b), buttons: after, clickCount: ev.n || 1 });
        st.buttons = after;
      } else {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: st.buttons });
      }
    } else if (ev.t === "w") {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x * vw, y: ev.y * vh, deltaX: ev.dx, deltaY: ev.dy });
    } else if (ev.t === "x") {
      await cdp.send("Input.insertText", { text: ev.s });
    } else if (ev.t === "k") {
      await cdp.send("Input.dispatchKeyEvent", {
        type: ev.k === "down" ? "keyDown" : "keyUp",
        key: ev.key,
        code: ev.code,
        windowsVirtualKeyCode: ev.vk || 0,
        nativeVirtualKeyCode: ev.vk || 0,
      });
    }
  } catch {
    /* one bad event must never break the relay loop */
  }
}

/* ─── Main entry ─────────────────────────────────────────────────────────── */

export async function connectTikTok(opts: ConnectOptions = {}): Promise<ConnectResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const progress = opts.onProgress ?? (() => {});

  const browser = findBrowser(opts.browserPath);
  if (!browser) {
    return {
      success: false,
      reason: "no_local_browser",
      error:
        "No Chrome/Edge/Brave found. Install one, pass --browser-path, or import cookies manually from DevTools.",
    };
  }
  if (opts.browserPath && !existsSync(opts.browserPath)) {
    return { success: false, reason: "no_local_browser", error: `--browser-path not found: ${opts.browserPath}` };
  }

  let port: number;
  try {
    port = await getFreePort();
  } catch (e: any) {
    return { success: false, reason: "launch_failed", error: e.message };
  }

  // Fresh, throwaway profile dir — this is what forces a brand-new browser
  // process that actually owns the debug port. Launching against the user's
  // normal profile while their browser is already open would just open a tab
  // in the existing process and ignore --remote-debugging-port entirely.
  let userDataDir: string;
  try {
    userDataDir = mkdtempSync(join(tmpdir(), "palmyr-tiktok-"));
  } catch (e: any) {
    return { success: false, reason: "launch_failed", error: `could not create temp profile: ${e.message}` };
  }

  // Chromium won't start its sandbox as root and exits immediately — and many
  // container / CI / agent shells run as root. Detect that (or an explicit
  // opt-in) and drop the sandbox so the browser actually launches. On a normal
  // non-root desktop the sandbox stays on.
  const isRootPosix =
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0;
  const noSandbox = opts.noSandbox === true || isRootPosix;

  // QR mode lands on TikTok's QR-login page; typed login on the form page.
  const landingUrl = opts.qr
    ? "https://www.tiktok.com/login/qrcode"
    : "https://www.tiktok.com/login/phone-or-email/email";

  // Always run HEADED. TikTok refuses to authorize a login into a headless
  // session — headless Chrome's UA literally contains "HeadlessChrome", which it
  // detects and rejects ("Couldn't log in. Try another login method"). A headed
  // window presents a normal Chrome UA with no automation tells. On a server,
  // run under a virtual display (xvfb). --disable-blink-features keeps
  // navigator.webdriver clean across Chrome versions.
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,800", // realistic, non-zero geometry (a headless tell)
    ...(noSandbox ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    landingUrl,
  ];

  let child: ChildProcess;
  try {
    child = spawn(browser.path, args, { stdio: "ignore", detached: false });
  } catch (e: any) {
    cleanupDir(userDataDir);
    return { success: false, reason: "launch_failed", error: `${browser.name} launch failed: ${e.message}` };
  }

  let childExited = false;
  child.on("exit", () => (childExited = true));

  if (noSandbox) progress("launched with --no-sandbox (root / headless environment detected).");
  if (opts.qr) {
    progress(`opened ${browser.name} — fetching TikTok's login QR (a window opens; scan from it or the saved image)…`);
  } else if (opts.remote) {
    progress(`opened ${browser.name} on the server — streaming it to your hand-off link for your human to log in.`);
    progress("capturing automatically the moment they're signed in…");
  } else {
    progress(`opened ${browser.name} — log in to TikTok (solve any captcha / 2FA yourself).`);
    progress("capturing automatically the moment you're signed in… (window will close on success)");
  }

  const deadline = Date.now() + timeoutMs;
  let cdp: CdpSession | null = null;
  let qrPngPath: string | undefined;
  let qrDataUrl: string | undefined;
  let result: ConnectResult = { success: false, reason: "login_timeout", error: "timed out waiting for login", browser: browser.name };

  // Remote (screencast) relay state.
  let lastFrame: { b64: string; vw: number; vh: number } | null = null;
  let lastVw = 1280, lastVh = 800; // viewport (CSS px) for scaling normalized input
  let screencastOn = false;
  const inputState = { buttons: 0 };

  try {
    while (Date.now() < deadline) {
      // The human closed the window before finishing → don't hang out the clock.
      if (childExited) {
        result = {
          success: false,
          reason: "aborted",
          error:
            "browser closed before a session was captured. On a headless / root box the browser can exit instantly — ensure a display is available (e.g. xvfb) and the sandbox is off (auto on root Linux, or pass --no-sandbox).",
          browser: browser.name,
        };
        break;
      }

      // (Re)attach if we have no live CDP session — covers the brief startup
      // window and the case where the user navigated in a way that recycled
      // the page target.
      if (!cdp || cdp.closed) {
        const wsUrl = await findPageTarget(port);
        if (wsUrl) {
          try {
            cdp = await CdpSession.connect(wsUrl);
            await cdp.send("Network.enable");
            if (opts.qr) { try { await cdp.send("Page.enable"); } catch { /* screenshot fallback only */ } }
            screencastOn = false; // (re)start the screencast on this fresh target (remote mode)
          } catch {
            cdp = null;
          }
        }
      }

      if (cdp && !cdp.closed) {
        // QR mode: surface the QR once, as soon as it renders, so the agent can
        // forward it to a human while we keep polling for the scan.
        // Re-extract each loop so a ROTATED QR is pushed to the hand-off link
        // (TikTok cycles the code every few minutes); onQr fires only on change.
        if (opts.qr) {
          const { dataUrl } = await extractTikTokQr(cdp);
          if (dataUrl && dataUrl !== qrDataUrl) {
            const first = !qrDataUrl;
            qrDataUrl = dataUrl;
            if (first) {
              try { qrPngPath = saveQrPng(dataUrl); } catch { /* path optional */ }
              progress("QR live on your hand-off link — your human scans it with the TikTok app; I capture the session automatically once they confirm.");
            }
            try { await opts.onQr?.(dataUrl); } catch { /* hosting optional; capture still works */ }
          }
        }

        // Remote mode: (re)start the screencast on this target, then each tick
        // push the latest frame to the hand-off link and replay whatever input
        // the human queued. The frame handler acks every frame (CDP stops
        // streaming otherwise) and tracks the viewport for input scaling.
        if (opts.remote) {
          if (!screencastOn) {
            try {
              await cdp.send("Page.enable");
              cdp.on("Page.screencastFrame", (p: any) => {
                const vw = p?.metadata?.deviceWidth || lastVw;
                const vh = p?.metadata?.deviceHeight || lastVh;
                if (vw) lastVw = vw;
                if (vh) lastVh = vh;
                if (typeof p?.data === "string") lastFrame = { b64: p.data, vw, vh };
                if (p?.sessionId != null) cdp!.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
              });
              await cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 900, maxHeight: 1600, everyNthFrame: 1 });
              screencastOn = true;
              progress("live browser is streaming to your hand-off link — your human logs in there; I capture the session automatically.");
            } catch { /* transient; retry next tick */ }
          }
          if (opts.pushFrameAndPullInput) {
            try {
              const events = await opts.pushFrameAndPullInput(lastFrame);
              if (Array.isArray(events)) for (const ev of events) await dispatchInput(cdp, ev, lastVw, lastVh, inputState);
            } catch { /* relay hiccup; keep waiting */ }
          }
        }

        try {
          const { cookies } = await cdp.send("Network.getAllCookies");
          const ttCookies: any[] = (cookies || []).filter((c: any) => isTikTokCookie(c.domain));
          const sessionid = ttCookies.find(
            (c: any) => c.name === "sessionid" && typeof c.value === "string" && c.value.length > 10,
          );
          if (sessionid) {
            const harvested = ttCookies.map(normalizeCookie);

            // Infer the account's country from the real browser env so the
            // operator/agent never has to supply --country. Best-effort: if the
            // eval fails, the caller falls back to its own default.
            let detectedLocale: string | undefined;
            let detectedTimezone: string | undefined;
            try {
              const ev = await cdp.send("Runtime.evaluate", {
                expression:
                  "JSON.stringify({l:navigator.language,t:Intl.DateTimeFormat().resolvedOptions().timeZone})",
                returnByValue: true,
              });
              const v = ev?.result?.value;
              if (typeof v === "string") {
                const parsed = JSON.parse(v);
                detectedLocale = typeof parsed.l === "string" ? parsed.l : undefined;
                detectedTimezone = typeof parsed.t === "string" ? parsed.t : undefined;
              }
            } catch {
              /* detection is best-effort */
            }

            result = {
              success: true,
              cookies: harvested,
              cookiesCaptured: harvested.length,
              sessionidPresent: true,
              browser: browser.name,
              detectedLocale,
              detectedTimezone,
              detectedCountry: countryFromBrowser(detectedLocale, detectedTimezone),
            };
            progress(
              `captured ${harvested.length} cookies (sessionid present)` +
                (result.detectedCountry ? `; detected country: ${result.detectedCountry}.` : "."),
            );
            break;
          }
        } catch {
          // Transient — socket may have closed mid-poll; loop re-attaches.
          cdp = null;
        }
      }

      await sleep(opts.remote ? 120 : 2000);
    }
    // Carry the QR artifacts onto whatever we return (incl. timeout) so the
    // caller always has the QR that was generated.
    if (qrPngPath && !result.qrPngPath) result.qrPngPath = qrPngPath;
    if (qrDataUrl && !result.qrDataUrl) result.qrDataUrl = qrDataUrl;
  } finally {
    if (cdp) cdp.close();
    if (!childExited) {
      try {
        child.kill();
      } catch {
        /* noop */
      }
    }
    cleanupDir(userDataDir);
  }

  return result;
}

function cleanupDir(dir: string): void {
  // Chrome may briefly hold a lock on the profile dir after kill; a failed
  // cleanup is harmless (OS temp reclaims it), so swallow errors.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}
