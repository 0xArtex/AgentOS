/**
 * Headless TikTok login via Playwright + stealth plugin, routed through a
 * per-account sticky residential proxy.
 *
 * Cookie-injection only. TikTok's form-login path pushes aggressively into
 * SMS / email / captcha challenges that can't be reliably solved in-browser
 * at scale — the only viable model is to import an account that already has
 * a live `sessionid`, inject it, and verify it lands on the home feed.
 */
import { getStealthChromium, buildProxyConfig } from "./social-runtime";

type Browser = any;

export interface TikTokLoginRequest {
  account_id: string;
  /** Overrides account_id when pinning the proxy session. Preserves IP lineage across pool handoff. */
  proxy_session_id?: string;
  /** Main auth cookie. 40-char hex; required. */
  sessionid: string;
  /** CSRF cookie. Hex. */
  tt_csrf_token?: string;
  /** Device fingerprint cookie — if the seller includes it, use it for IP-device consistency. */
  tt_webid_v2?: string;
  /** Any extra cookies the seller shipped (e.g. `msToken`, `s_v_web_id`). Passed through verbatim. */
  extra_cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>;
}

export interface TikTokLoginResult {
  success: boolean;
  cookies?: any[];
  captured_at?: string;
  /** Username TikTok showed for the session — useful for verifying we got the right account. */
  observed_username?: string;
  error?: string;
  error_code?:
    | "PROXY_NOT_CONFIGURED"
    | "LAUNCH_FAILED"
    | "BAD_CREDENTIALS"
    | "CAPTCHA_CHALLENGE"
    | "ACCOUNT_BLOCKED"
    | "LOGIN_TIMEOUT"
    | "LOGIN_FAILED";
  diagnostics?: {
    url?: string;
    title?: string;
    page_text_excerpt?: string;
    screenshot_path?: string;
  };
}

export async function loginTikTok(
  req: TikTokLoginRequest
): Promise<TikTokLoginResult> {
  if (!req.sessionid || !/^[a-f0-9]{24,64}$/i.test(req.sessionid)) {
    return {
      success: false,
      error: "sessionid must be a 24-64 char hex cookie",
      error_code: "BAD_CREDENTIALS",
    };
  }

  const sessionKey = req.proxy_session_id || req.account_id;
  let proxy;
  try {
    proxy = buildProxyConfig(sessionKey);
  } catch (e: any) {
    return {
      success: false,
      error: e.message,
      error_code: "PROXY_NOT_CONFIGURED",
    };
  }

  let browser: Browser;
  try {
    const chromium = await getStealthChromium();
    browser = await chromium.launch({ headless: true, proxy });
  } catch (e: any) {
    return {
      success: false,
      error: `Failed to launch Chromium: ${e.message}`,
      error_code: "LAUNCH_FAILED",
    };
  }

  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Inject the auth cookies.
    const cookies: any[] = [
      {
        name: "sessionid",
        value: req.sessionid,
        domain: ".tiktok.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ];
    if (req.tt_csrf_token) {
      cookies.push({
        name: "tt_csrf_token",
        value: req.tt_csrf_token,
        domain: ".tiktok.com",
        path: "/",
        secure: true,
        sameSite: "Lax",
      });
    }
    if (req.tt_webid_v2) {
      cookies.push({
        name: "tt_webid_v2",
        value: req.tt_webid_v2,
        domain: ".tiktok.com",
        path: "/",
        secure: true,
        sameSite: "Lax",
      });
    }
    if (req.extra_cookies && req.extra_cookies.length) {
      for (const c of req.extra_cookies) {
        cookies.push({
          name: c.name,
          value: c.value,
          domain: c.domain || ".tiktok.com",
          path: c.path || "/",
          secure: true,
          sameSite: "Lax",
        });
      }
    }
    await ctx.addCookies(cookies);

    const page = await ctx.newPage();

    try {
      await page.goto("https://www.tiktok.com/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    } catch (e: any) {
      return {
        success: false,
        error: `Navigation to /foryou failed: ${e.message}`,
        error_code: "LOGIN_FAILED",
      };
    }

    // Diagnostic helper — snapshot + text/url at any failure point.
    const snapshot = async (tag: string) => {
      try {
        const url = page.url();
        const title = await page.title().catch(() => "");
        const text: string = await page
          .evaluate("(() => (document.body && document.body.innerText ? document.body.innerText.slice(0, 500) : ''))()")
          .catch(() => "");
        const shotDir = "/tmp/agentos-social-shots";
        const fs = await import("fs");
        if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
        const shotPath = `${shotDir}/tiktok-${tag}-${Date.now()}.png`;
        await page.screenshot({ path: shotPath, fullPage: true });
        return { url, title, page_text_excerpt: text, screenshot_path: shotPath };
      } catch {
        return {};
      }
    };

    // Detect redirect to login page — means cookies are dead.
    const currentUrl = page.url();
    if (/\/login/.test(currentUrl)) {
      const diag = await snapshot("redirected-to-login");
      return {
        success: false,
        error: `Cookie injection rejected — TikTok redirected to login (URL: ${currentUrl}). sessionid is expired or revoked.`,
        error_code: "BAD_CREDENTIALS",
        diagnostics: diag,
      };
    }

    // Detect captcha wall.
    const captchaVisible = await page
      .locator('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]')
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    if (captchaVisible) {
      const diag = await snapshot("captcha-challenge");
      return {
        success: false,
        error: "TikTok is serving a captcha challenge. Resolve manually through the proxy once, then re-import.",
        error_code: "CAPTCHA_CHALLENGE",
        diagnostics: diag,
      };
    }

    // Positive signal — the profile/upload buttons only render when authed.
    // `[data-e2e="profile-icon"]` and `[data-e2e="upload-icon"]` are stable
    // identifiers used by TikTok's web UI for the top-nav auth buttons.
    const authed = await Promise.race([
      page
        .locator('[data-e2e="profile-icon"], [data-e2e="upload-icon"], [data-e2e="nav-profile"]')
        .first()
        .waitFor({ state: "visible", timeout: 15000 })
        .then(() => true),
      page
        .locator('[data-e2e="top-login-button"], a[href*="/login"]')
        .first()
        .waitFor({ state: "visible", timeout: 15000 })
        .then(() => false),
    ]).catch(() => null);

    if (authed !== true) {
      const diag = await snapshot("no-auth-signal");
      return {
        success: false,
        error: "Could not detect authenticated UI after cookie injection. sessionid may be dead or the region is challenge-walled.",
        error_code: "LOGIN_TIMEOUT",
        diagnostics: diag,
      };
    }

    // Try to read the logged-in username (for display only — not security-critical).
    let observedUsername: string | undefined;
    try {
      observedUsername = await page
        .evaluate(
          `(() => {
            const link = document.querySelector('a[href^="/@"]');
            if (!link) return undefined;
            const href = link.getAttribute('href') || '';
            const m = href.match(/^\\/@([A-Za-z0-9._]+)/);
            return m ? m[1] : undefined;
          })()`
        )
        .catch(() => undefined);
    } catch { /* noop */ }

    const capturedCookies = await ctx.cookies();

    return {
      success: true,
      cookies: capturedCookies,
      captured_at: new Date().toISOString(),
      observed_username: observedUsername,
    };
  } catch (e: any) {
    return {
      success: false,
      error: e.message || String(e),
      error_code: "LOGIN_FAILED",
    };
  } finally {
    try {
      await browser.close();
    } catch {}
  }
}
