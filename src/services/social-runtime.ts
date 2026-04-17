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

export function buildProxyConfig(accountId: string) {
  const host = process.env.IPROYAL_HOST;
  const port = process.env.IPROYAL_PORT;
  const username = process.env.IPROYAL_USERNAME;
  const basePassword = process.env.IPROYAL_PASSWORD;
  const country = process.env.IPROYAL_DEFAULT_COUNTRY || "us";

  if (!host || !port || !username || !basePassword) {
    throw new Error(
      "IPROYAL_* env not configured. Set IPROYAL_HOST, IPROYAL_PORT, IPROYAL_USERNAME, IPROYAL_PASSWORD."
    );
  }

  const baseSecret = basePassword.split("_")[0];
  const perAccountPassword = `${baseSecret}_country-${country}_session-${accountId}_lifetime-168h`;

  return {
    server: `http://${host}:${port}`,
    username,
    password: perAccountPassword,
  };
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface OpenSessionOptions {
  accountId: string;
  cookies: any[];
  userAgent?: string;
  timezoneId?: string;
  locale?: string;
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
  const proxy = buildProxyConfig(opts.accountId);
  const browser = await chromium.launch({ headless: true, proxy });
  const ctx = await browser.newContext({
    userAgent: opts.userAgent || DEFAULT_UA,
    viewport: { width: 1920, height: 1080 },
    locale: opts.locale || "en-US",
    timezoneId: opts.timezoneId || "America/New_York",
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
