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
import { existsSync, mkdtempSync, rmSync } from "fs";
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
  /** Human-facing progress lines. Caller routes these to stderr so stdout stays clean JSON. */
  onProgress?: (msg: string) => void;
}

export interface ConnectResult {
  success: boolean;
  cookies?: HarvestedCookie[];
  cookiesCaptured?: number;
  sessionidPresent?: boolean;
  /** Which browser we drove (chrome/edge/brave/chromium/custom). */
  browser?: string;
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

/* ─── Minimal CDP client over a single page target ───────────────────────── */

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
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

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "https://www.tiktok.com/login/phone-or-email/email",
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

  progress(`opened ${browser.name} — log in to TikTok (solve any captcha / 2FA yourself).`);
  progress("capturing automatically the moment you're signed in… (window will close on success)");

  const deadline = Date.now() + timeoutMs;
  let cdp: CdpSession | null = null;
  let result: ConnectResult = { success: false, reason: "login_timeout", error: "timed out waiting for login", browser: browser.name };

  try {
    while (Date.now() < deadline) {
      // The human closed the window before finishing → don't hang out the clock.
      if (childExited) {
        result = { success: false, reason: "aborted", error: "browser closed before a session was captured", browser: browser.name };
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
          } catch {
            cdp = null;
          }
        }
      }

      if (cdp && !cdp.closed) {
        try {
          const { cookies } = await cdp.send("Network.getAllCookies");
          const ttCookies: any[] = (cookies || []).filter((c: any) => isTikTokCookie(c.domain));
          const sessionid = ttCookies.find(
            (c: any) => c.name === "sessionid" && typeof c.value === "string" && c.value.length > 10,
          );
          if (sessionid) {
            const harvested = ttCookies.map(normalizeCookie);
            result = {
              success: true,
              cookies: harvested,
              cookiesCaptured: harvested.length,
              sessionidPresent: true,
              browser: browser.name,
            };
            progress(`captured ${harvested.length} cookies (sessionid present).`);
            break;
          }
        } catch {
          // Transient — socket may have closed mid-poll; loop re-attaches.
          cdp = null;
        }
      }

      await sleep(2000);
    }
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
