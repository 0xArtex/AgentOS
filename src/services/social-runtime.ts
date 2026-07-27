/**
 * Shared browser runtime for server-side social account operations.
 *
 * All X/TikTok commands (login, post, bio, follow, etc.) launch through
 * this module so they share: the stealth plugin, the per-account sticky
 * residential proxy, the UA/locale/timezone fingerprint.
 */

import { isSelfHosted } from "./self-hosted";

type Browser = any;
type BrowserContext = any;
type Page = any;

let cachedChromium: any;

export async function getStealthChromium(): Promise<any> {
  if (cachedChromium) return cachedChromium;
  const { chromium } = await import("playwright-extra");
  const stealthMod = await import("puppeteer-extra-plugin-stealth");
  const StealthPlugin = (stealthMod as any).default || (stealthMod as any);
  const plugin = StealthPlugin();
  // We spoof WebGL ourselves — per-account and matched to the account's UA OS
  // (see webglForKey + the init script in openAuthenticatedSession). The
  // plugin's built-in evasion hardcodes ONE Intel renderer for every account: a
  // cross-account pattern, and a mismatch whenever the UA isn't Intel/desktop.
  // Disable it so the two don't both proxy getParameter.
  try { plugin.enabledEvasions.delete("webgl.vendor"); } catch { /* older plugin shape */ }
  chromium.use(plugin);
  cachedChromium = chromium;
  return chromium;
}

/**
 * Global cap on concurrent headless browsers. Every social op (login, post,
 * follow, …) launches its own Chromium; without a ceiling a fleet of agents
 * posting at once spawns N browsers + N video uploads and exhausts the box
 * (RAM/CPU/proxy bandwidth) long before any platform ban. Honors
 * SOCIAL_BROWSER_MAX_CONCURRENCY (default 3).
 */
function maxConcurrentBrowsers(): number {
  const n = parseInt(process.env.SOCIAL_BROWSER_MAX_CONCURRENCY || "3", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
// Hosted-connect browsers idle for up to ~10 min waiting on a human phone scan,
// so they get their OWN small pool — a slow connect must NEVER starve posts/ops
// (which share the 'op' pool). Without this, a few concurrent connects froze the
// whole social subsystem (and were a trivially cheap availability/DoS vector).
function maxConnectBrowsers(): number {
  const n = parseInt(process.env.SOCIAL_CONNECT_MAX_CONCURRENCY || "2", 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

interface BrowserPool { inUse: number; waiters: Array<() => void>; max: () => number; }
const POOLS: Record<string, BrowserPool> = {
  op: { inUse: 0, waiters: [], max: maxConcurrentBrowsers },
  connect: { inUse: 0, waiters: [], max: maxConnectBrowsers },
};

function acquireBrowserSlot(pool: string): Promise<void> {
  const p = POOLS[pool] || POOLS.op;
  if (p.inUse < p.max()) {
    p.inUse++;
    return Promise.resolve();
  }
  // At capacity — queue until a slot frees. releaseBrowserSlot() hands the
  // permit straight to the next waiter, so inUse stays unchanged on wake.
  return new Promise<void>((resolve) => p.waiters.push(resolve));
}

function releaseBrowserSlot(pool: string): void {
  const p = POOLS[pool] || POOLS.op;
  const next = p.waiters.shift();
  if (next) { next(); return; }   // hand the permit directly to the next waiter
  p.inUse = Math.max(0, p.inUse - 1);
}

/**
 * Launch a stealth Chromium under a named concurrency pool ('op' default, or
 * 'connect' for the long-idling QR-connect browsers). The returned browser's
 * `close()` releases the slot exactly once, so callers that close in a `finally`
 * get correct accounting for free.
 */
export async function launchStealthBrowser(launchOpts: any, pool: string = "op"): Promise<any> {
  const chromium = await getStealthChromium();
  await acquireBrowserSlot(pool);
  let browser: any;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    releaseBrowserSlot(pool);
    throw e;
  }
  let released = false;
  const origClose = browser.close.bind(browser);
  browser.close = async (...args: any[]) => {
    try {
      return await origClose(...args);
    } finally {
      if (!released) { released = true; releaseBrowserSlot(pool); }
    }
  };
  return browser;
}

/**
 * Build an IPRoyal proxy config pinned to a stable session ID. The session
 * ID should be the account's **portable** identity — for pool accounts this
 * is set at pool-add time and preserved across ownership handoff so the
 * residential IP stays identical. For local-only accounts the caller can
 * just pass the account_id.
 */
/**
 * Per-account exit generation. Bumping it changes the proxy session id, which
 * makes the vendor hand out a DIFFERENT residential exit for that account.
 *
 * Stickiness exists for a good reason — an account whose IP hops between
 * countries mid-session is a flag — so the exit is pinned by default and only
 * rotated when it has demonstrably stopped working.
 *
 * That failure is real and was the cause of TikTok's follow and like operations
 * failing for months. Measured directly: with identical cookies, browser and
 * stealth configuration, the account's pinned exit could not deliver TikTok's
 * JS bundles, so the page's interactive controls never rendered; a fresh
 * session key rendered them and logged in correctly, and switching back to the
 * pinned key failed again. The exit had been pinned for a week
 * (`lifetime-168h`) and heavily used, and a burned exit stays burned.
 *
 * In-memory only: a process restart returns to the base exit, which is the
 * right default because most exits are fine and stickiness is worth keeping.
 */
const proxyGeneration = new Map<string, number>();

/** Move an account onto a different residential exit. Returns the new generation. */
export function rotateProxyExit(sessionKey: string): number {
  const next = (proxyGeneration.get(sessionKey) ?? 0) + 1;
  proxyGeneration.set(sessionKey, next);
  console.warn(`[social-runtime] rotating proxy exit for ${sessionKey} → generation ${next}`);
  return next;
}

/** Current generation for an account (0 = its original pinned exit). */
export function proxyExitGeneration(sessionKey: string): number {
  return proxyGeneration.get(sessionKey) ?? 0;
}

export function buildProxyConfig(
  sessionKey: string,
  opts?: { country?: string }
) {
  const host = process.env.IPROYAL_HOST;
  const port = process.env.IPROYAL_PORT;
  const username = process.env.IPROYAL_USERNAME;
  const basePassword = process.env.IPROYAL_PASSWORD;
  const country = opts?.country || process.env.IPROYAL_DEFAULT_COUNTRY || "us";

  if (!host || !port || !username || !basePassword) {
    throw new Error(
      "IPROYAL_* env not configured. Set IPROYAL_HOST, IPROYAL_PORT, IPROYAL_USERNAME, IPROYAL_PASSWORD."
    );
  }

  const baseSecret = basePassword.split("_")[0];
  // The generation suffix is what actually moves the account to a new exit —
  // the vendor keys stickiness on this session string.
  const generation = proxyGeneration.get(sessionKey) ?? 0;
  const session = generation > 0 ? `${sessionKey}-g${generation}` : sessionKey;
  const perAccountPassword = `${baseSecret}_country-${country}_session-${session}_lifetime-168h`;

  return {
    server: `http://${host}:${port}`,
    username,
    password: perAccountPassword,
  };
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Pool of real Chrome user agents. We hash the account's stable key into
 * this pool so each account consistently uses the same UA (TikTok flags
 * rapid UA rotation as bot-like) but different accounts get different UAs
 * (so one-UA-for-everyone doesn't pattern-match either).
 */
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

function uaForKey(key: string): string {
  // Simple stable hash → UA index. Same account = same UA across sessions.
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return UA_POOL[Math.abs(hash) % UA_POOL.length];
}

/**
 * Country → browser profile mapping.
 *
 * Keeps the residential proxy exit IP, the browser locale, and the timezone
 * aligned. TikTok (and to a lesser extent X) fingerprints this triplet — a
 * German IP browsing in `en-US` / `America/New_York` is a flag.
 *
 * Country codes are ISO 3166-1 alpha-2 (lowercase). Unknown countries fall
 * back to the US profile.
 */
interface CountryProfile {
  locale: string;
  timezoneId: string;
}

const COUNTRY_PROFILES: Record<string, CountryProfile> = {
  us: { locale: "en-US", timezoneId: "America/New_York" },
  ca: { locale: "en-CA", timezoneId: "America/Toronto" },
  gb: { locale: "en-GB", timezoneId: "Europe/London" },
  ie: { locale: "en-IE", timezoneId: "Europe/Dublin" },
  au: { locale: "en-AU", timezoneId: "Australia/Sydney" },
  nz: { locale: "en-NZ", timezoneId: "Pacific/Auckland" },
  de: { locale: "de-DE", timezoneId: "Europe/Berlin" },
  at: { locale: "de-AT", timezoneId: "Europe/Vienna" },
  ch: { locale: "de-CH", timezoneId: "Europe/Zurich" },
  fr: { locale: "fr-FR", timezoneId: "Europe/Paris" },
  be: { locale: "fr-BE", timezoneId: "Europe/Brussels" },
  nl: { locale: "nl-NL", timezoneId: "Europe/Amsterdam" },
  es: { locale: "es-ES", timezoneId: "Europe/Madrid" },
  it: { locale: "it-IT", timezoneId: "Europe/Rome" },
  pt: { locale: "pt-PT", timezoneId: "Europe/Lisbon" },
  pl: { locale: "pl-PL", timezoneId: "Europe/Warsaw" },
  cz: { locale: "cs-CZ", timezoneId: "Europe/Prague" },
  se: { locale: "sv-SE", timezoneId: "Europe/Stockholm" },
  no: { locale: "nb-NO", timezoneId: "Europe/Oslo" },
  dk: { locale: "da-DK", timezoneId: "Europe/Copenhagen" },
  fi: { locale: "fi-FI", timezoneId: "Europe/Helsinki" },
  gr: { locale: "el-GR", timezoneId: "Europe/Athens" },
  ro: { locale: "ro-RO", timezoneId: "Europe/Bucharest" },
  hu: { locale: "hu-HU", timezoneId: "Europe/Budapest" },
  tr: { locale: "tr-TR", timezoneId: "Europe/Istanbul" },
  ru: { locale: "ru-RU", timezoneId: "Europe/Moscow" },
  ua: { locale: "uk-UA", timezoneId: "Europe/Kyiv" },
  br: { locale: "pt-BR", timezoneId: "America/Sao_Paulo" },
  mx: { locale: "es-MX", timezoneId: "America/Mexico_City" },
  ar: { locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires" },
  jp: { locale: "ja-JP", timezoneId: "Asia/Tokyo" },
  kr: { locale: "ko-KR", timezoneId: "Asia/Seoul" },
  in: { locale: "en-IN", timezoneId: "Asia/Kolkata" },
  id: { locale: "id-ID", timezoneId: "Asia/Jakarta" },
  ph: { locale: "en-PH", timezoneId: "Asia/Manila" },
  th: { locale: "th-TH", timezoneId: "Asia/Bangkok" },
  vn: { locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" },
  sg: { locale: "en-SG", timezoneId: "Asia/Singapore" },
  my: { locale: "en-MY", timezoneId: "Asia/Kuala_Lumpur" },
  ae: { locale: "en-AE", timezoneId: "Asia/Dubai" },
  sa: { locale: "ar-SA", timezoneId: "Asia/Riyadh" },
  il: { locale: "he-IL", timezoneId: "Asia/Jerusalem" },
  za: { locale: "en-ZA", timezoneId: "Africa/Johannesburg" },
};

export function profileForCountry(country?: string): CountryProfile {
  const c = (country || "us").toLowerCase().trim();
  return COUNTRY_PROFILES[c] || COUNTRY_PROFILES.us;
}

function stableHash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Realistic modern-Chrome ANGLE WebGL strings grouped by OS, so the spoofed GPU
 * is consistent with the account's user-agent platform. 37445 = UNMASKED_VENDOR,
 * 37446 = UNMASKED_RENDERER. (The UA pool's Macs are all Intel Macs, so the mac
 * bucket is Intel/AMD Mac GPUs — never Apple Silicon, which would contradict the
 * "Intel Mac OS X" UA.)
 */
const WEBGL_BY_OS: Record<string, Array<{ vendor: string; renderer: string }>> = {
  win: [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  ],
  mac: [
    { vendor: "Google Inc. (Intel Inc.)", renderer: "ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1 Metal - 88)" },
    { vendor: "Google Inc. (Intel Inc.)", renderer: "ANGLE (Intel Inc., Intel(R) UHD Graphics 630, OpenGL 4.1 Metal - 88)" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon Pro 5500M OpenGL Engine, OpenGL 4.1 Metal - 88)" },
  ],
  linux: [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB/PCIe/SSE2, OpenGL 4.6.0 NVIDIA 535.146.02)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1)" },
  ],
};

function osFromUa(ua: string): "win" | "mac" | "linux" {
  if (/Windows/i.test(ua)) return "win";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  return "linux";
}

/** Pick a stable, UA-OS-consistent WebGL vendor/renderer for an account. */
export function webglForKey(sessionKey: string, ua: string): { vendor: string; renderer: string } {
  const list = WEBGL_BY_OS[osFromUa(ua)];
  return list[stableHash(sessionKey + ":webgl") % list.length];
}

export interface OpenSessionOptions {
  /** Stable identifier for the account locally. */
  accountId: string;
  /**
   * Portable proxy-session key. If set, overrides `accountId` when building
   * the IPRoyal sticky session. Used to preserve the residential IP across
   * pool ownership handoff. Falls back to `accountId` when omitted.
   */
  proxySessionId?: string;
  cookies: any[];
  userAgent?: string;
  timezoneId?: string;
  locale?: string;
  country?: string;
  /** Concurrency pool for the launched browser ('op' default, 'connect' for the
   *  long-idling hosted-QR-connect flow so it can't starve posts/ops). */
  pool?: string;
  /** Launch headless (default true). The hosted QR-connect flow sets this false
   *  so TikTok will AUTHORIZE the login (it refuses headless at the authorize
   *  step) — that requires a real/virtual display (Xvfb) on the host. */
  headless?: boolean;
  /** Load images/media/fonts (default false). They are blocked by default: they
   *  are pure bandwidth on a metered residential proxy and, worse, they starve
   *  the JS bundles that render the interactive UI. Set true only where pixels
   *  genuinely matter, e.g. the avatar crop dialog. */
  loadMedia?: boolean;
}

export interface OpenedSession {
  browser: Browser;
  ctx: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Launch a stealth Chromium, route through the account's sticky proxy,
 * inject the provided cookies, and return a ready-to-use page.
 */
export async function openAuthenticatedSession(
  opts: OpenSessionOptions
): Promise<OpenedSession> {
  const sessionKey = opts.proxySessionId || opts.accountId;
  // Proxy is required in prod (the server runs on a VPS whose IP differs from
  // where the session was minted). Self-hosted on the operator's own machine,
  // the session was minted on this same IP — so launch direct when no proxy is
  // configured and the explicit self-hosted flag is set. Prod is unchanged.
  let proxy: any;
  try {
    proxy = buildProxyConfig(sessionKey, { country: opts.country });
  } catch (e) {
    if (isSelfHosted()) proxy = undefined;
    else throw e;
  }

  const browser = await launchStealthBrowser({
    headless: opts.headless ?? true,
    proxy,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  }, opts.pool || "op");

  // Derive locale + timezone from the account's country if the caller didn't
  // pin them explicitly. Keeps exit-IP geography aligned with the browser
  // environment — platforms flag mismatched triplets (IP: DE, locale: en-US).
  const profile = profileForCountry(opts.country);

  // Pick a stable-per-account viewport from a small set of real sizes. 1920x1080
  // is the single most common desktop resolution (easy to flag as "default").
  const viewportKey = sessionKey + ":vp";
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1680, height: 1050 },
  ];
  let vpHash = 0;
  for (let i = 0; i < viewportKey.length; i++) vpHash = ((vpHash << 5) - vpHash + viewportKey.charCodeAt(i)) | 0;
  const viewport = viewports[Math.abs(vpHash) % viewports.length];

  const ua = opts.userAgent || uaForKey(sessionKey);
  let ctx, page;
  try {
    ctx = await browser.newContext({
      userAgent: ua,
      viewport,
      locale: opts.locale || profile.locale,
      timezoneId: opts.timezoneId || profile.timezoneId,
      extraHTTPHeaders: {
        "accept-language": (opts.locale || profile.locale) + "," + (opts.locale || profile.locale).split("-")[0] + ";q=0.9",
      },
    });

    // Spoof a per-account, UA-OS-consistent WebGL GPU before any page script
    // runs. On a GPU-less VPS the real UNMASKED_RENDERER is "Google SwiftShader"
    // (an instant server tell). We replace UNMASKED_VENDOR/RENDERER with a Proxy
    // over the *native* getParameter, then make Function.prototype.toString
    // report the original's native source (WITH the method name) for our proxy —
    // so neither the value nor the override is detectable. Passed as a string
    // body because tsconfig has no DOM lib (same convention as the evaluate()
    // helpers elsewhere).
    const webgl = webglForKey(sessionKey, ua);
    await ctx.addInitScript(
      `(() => {
        const V = ${JSON.stringify(webgl.vendor)}, R = ${JSON.stringify(webgl.renderer)};
        const proto1 = self.WebGLRenderingContext && self.WebGLRenderingContext.prototype;
        const proto2 = self.WebGL2RenderingContext && self.WebGL2RenderingContext.prototype;
        if (!proto1 && !proto2) return;
        const FTS = Function.prototype.toString;
        // Registry of our fakes -> the native source string they must report.
        // Patch Function.prototype.toString once so .toString() AND
        // Function.prototype.toString.call(fn) both yield the native string.
        let reg = self.__pmNative;
        if (!reg) {
          reg = new WeakMap();
          try { Object.defineProperty(self, '__pmNative', { value: reg }); } catch (e) { self.__pmNative = reg; }
          const patched = function toString() {
            if (reg.has(this)) return reg.get(this);
            return FTS.call(this);
          };
          try { reg.set(patched, FTS.call(FTS)); } catch (e) {}
          try { Object.defineProperty(Function.prototype, 'toString', { value: patched, writable: true, configurable: true }); } catch (e) {}
        }
        const patch = (proto) => {
          if (!proto || !proto.getParameter) return;
          const orig = proto.getParameter;
          let nativeStr; try { nativeStr = FTS.call(orig); } catch (e) { nativeStr = 'function getParameter() { [native code] }'; }
          const proxied = new Proxy(orig, {
            apply(target, thisArg, args) {
              const p = args && args[0];
              if (p === 37445) return V;
              if (p === 37446) return R;
              return Reflect.apply(target, thisArg, args);
            }
          });
          reg.set(proxied, nativeStr);
          try { Object.defineProperty(proto, 'getParameter', { value: proxied, writable: true, configurable: true }); } catch (e) {}
        };
        patch(proto1); patch(proto2);
      })();`
    );

    if (opts.cookies && opts.cookies.length > 0) {
      // Cookies may ship with an `expires` field that Playwright rejects; coerce.
      const cookies = opts.cookies.map((c: any) => {
        const { expires, expirationDate, ...rest } = c;
        const out: any = { ...rest };
        if (typeof expirationDate === "number") out.expires = expirationDate;
        else if (typeof expires === "number" && expires > 0) out.expires = expires;
        return out;
      });
      await ctx.addCookies(cookies);
    }

    page = await ctx.newPage();
    trackPendingRequests(page);
    await blockHeavyResources(page, opts.loadMedia === true);
  } catch (e) {
    // Setup failed after launch — close the browser so its concurrency slot is
    // released (launchStealthBrowser ties slot release to close()).
    await browser.close().catch(() => {});
    throw e;
  }

  return {
    browser,
    ctx,
    page,
    close: async () => {
      try {
        await browser.close();
      } catch {
        /* noop */
      }
    },
  };
}

export function isSessionExpiredUrl(url: string): boolean {
  return /\/login|\/flow\/login|\/i\/flow/.test(url);
}

// ─── Resource blocking ───────────────────────────────────────────────────────
//
// Nothing intercepted requests before this, so every image, font and autoplaying
// video traversed the metered residential proxy — unbounded bandwidth on a
// $0.001 operation, and no per-op cost accounting anywhere.
//
// It also broke operations outright. A profile page issues dozens of parallel
// requests; a residential proxy session has far fewer usable connections than
// that, so the decorative bulk starved the JS bundles that render the
// interactive UI. Traced directly: TikTok's webapp scripts sat pending for 39
// seconds and never arrived, while the same URL through the same proxy fetched
// in 1.4 seconds by curl. The action buttons stayed empty skeletons, and follow
// and like failed for months blaming a rotated selector.
//
// Scripts, stylesheets, XHR and fetch are never blocked — they are what builds
// the page we act on. Callers that genuinely need pixels (avatar crop) pass
// `loadMedia: true`.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

/**
 * Resource type is not sufficient on its own. Video bodies are served over
 * `fetch` (mime_type=video_mp4 from the webapp-prime CDN) and telemetry over
 * `xhr`, so both slip past a type-only filter and keep competing for the
 * proxy's connections — a single autoplaying video is orders of magnitude more
 * bytes than every script on the page combined.
 */
const BLOCKED_URL_PATTERNS: RegExp[] = [
  /\/video\/tos\//i,                 // video bodies (served as fetch)
  /webapp-prime\.tiktok\.com\/video/i,
  /mime_type=video_/i,
  /mon\.tiktokv\.com/i,              // slardar monitoring/telemetry beacons
  /\/monitor_(web|browser)\//i,
  /log\.?(tiktokv|byteoversea)\.com/i,
];

async function blockHeavyResources(page: any, loadMedia: boolean): Promise<void> {
  try {
    await page.route("**/*", (route: any) => {
      const req = route.request();
      const url = String(req.url());
      // Telemetry is never wanted, even when a caller needs pixels.
      if (BLOCKED_URL_PATTERNS.some(re => re.test(url))) return route.abort().catch(() => {});
      if (!loadMedia && BLOCKED_RESOURCE_TYPES.has(req.resourceType())) return route.abort().catch(() => {});
      return route.continue().catch(() => {});
    });
  } catch {
    /* best-effort — never fail an op because interception could not be installed */
  }
}

// ─── Pending-request tracking ────────────────────────────────────────────────
//
// When a readiness probe fails, the useful question is not "which selector did
// we try" but "what was the page still waiting for". Follow and like fail with
// their action controls mounted but empty while every piece of public content
// renders — the signature of a client-side fetch that never returns. Without
// this, identifying WHICH fetch is guesswork, and guessing is what produced
// three wrong diagnoses of this bug already.
//
// Bounded so a long-lived page can't grow it without limit; oldest entries are
// dropped first since the freshest stalls are the informative ones.
const MAX_TRACKED_REQUESTS = 300;

interface PendingRequest { url: string; method: string; resourceType: string; startedAt: number; }

function trackPendingRequests(page: any): void {
  const pending = new Map<any, PendingRequest>();
  (page as any).__palmyrPending = pending;
  try {
    page.on("request", (req: any) => {
      if (pending.size >= MAX_TRACKED_REQUESTS) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      pending.set(req, {
        url: String(req.url()).slice(0, 300),
        method: req.method?.() || "GET",
        resourceType: req.resourceType?.() || "other",
        startedAt: Date.now(),
      });
    });
    const done = (req: any) => pending.delete(req);
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  } catch {
    /* listener attach is best-effort — never fail an op over diagnostics */
  }
}

/**
 * Requests still in flight, oldest (longest-stalled) first. XHR/fetch are what
 * matter for a hydration stall, so they sort ahead of media and images.
 */
export function pendingRequests(page: any, limit = 12): Array<{ url: string; method: string; resourceType: string; ageMs: number }> {
  const pending: Map<any, PendingRequest> | undefined = (page as any)?.__palmyrPending;
  if (!pending || pending.size === 0) return [];
  const now = Date.now();
  const rank = (t: string) => (t === "xhr" || t === "fetch" ? 0 : t === "document" || t === "script" ? 1 : 2);
  return [...pending.values()]
    .map(r => ({ url: r.url, method: r.method, resourceType: r.resourceType, ageMs: now - r.startedAt }))
    .sort((a, b) => rank(a.resourceType) - rank(b.resourceType) || b.ageMs - a.ageMs)
    .slice(0, limit);
}
