/**
 * Shared browser runtime for server-side social account operations.
 *
 * All X/TikTok commands (login, post, bio, follow, etc.) launch through
 * this module so they share: the stealth plugin, the per-account sticky
 * residential proxy, the UA/locale/timezone fingerprint.
 */

type Browser = any;
type BrowserContext = any;
type Page = any;

let cachedChromium: any;

export async function getStealthChromium(): Promise<any> {
  if (cachedChromium) return cachedChromium;
  const { chromium } = await import("playwright-extra");
  const stealthMod = await import("puppeteer-extra-plugin-stealth");
  const StealthPlugin = (stealthMod as any).default || (stealthMod as any);
  chromium.use(StealthPlugin());
  cachedChromium = chromium;
  return chromium;
}

/**
 * Build an IPRoyal proxy config pinned to a stable session ID. The session
 * ID should be the account's **portable** identity — for pool accounts this
 * is set at pool-add time and preserved across ownership handoff so the
 * residential IP stays identical. For local-only accounts the caller can
 * just pass the account_id.
 */
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
  const perAccountPassword = `${baseSecret}_country-${country}_session-${sessionKey}_lifetime-168h`;

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
  const chromium = await getStealthChromium();
  const sessionKey = opts.proxySessionId || opts.accountId;
  const proxy = buildProxyConfig(sessionKey, { country: opts.country });

  // The "new" headless mode ships the full real Chrome renderer — the legacy
  // `headless: true` runs a stripped-down build that platform anti-bot
  // systems (TikTok specifically) fingerprint. `headless: "new"` closes
  // most of the easy tells. When `SOCIAL_HEADFUL=1` is set in env, we skip
  // headless entirely — useful when running with Xvfb on the VPS to get
  // indistinguishable-from-real-Chrome behavior.
  const headless = process.env.SOCIAL_HEADFUL === "1" ? false : ("new" as any);
  const browser = await chromium.launch({
    headless,
    proxy,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });

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

  const ctx = await browser.newContext({
    userAgent: opts.userAgent || uaForKey(sessionKey),
    viewport,
    locale: opts.locale || profile.locale,
    timezoneId: opts.timezoneId || profile.timezoneId,
    extraHTTPHeaders: {
      "accept-language": (opts.locale || profile.locale) + "," + (opts.locale || profile.locale).split("-")[0] + ";q=0.9",
    },
  });

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

  const page = await ctx.newPage();

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
