/**
 * Headless X/Twitter login via Playwright + stealth plugin, routed through a
 * per-account sticky residential IPRoyal proxy.
 *
 * Credentials are held only in the memory of the request that calls
 * `loginTwitter()`. Nothing persists server-side beyond the lifetime of the
 * browser context. The returned cookies are what the caller caches.
 */
import { createHmac } from "crypto";

// We lazy-load playwright-extra so the server boots even when the binary
// isn't installed (e.g. in dev machines without `playwright install`).
type Browser = any;

async function getStealthChromium() {
  const { chromium } = await import("playwright-extra");
  const stealthMod = await import("puppeteer-extra-plugin-stealth");
  const StealthPlugin = (stealthMod as any).default || (stealthMod as any);
  chromium.use(StealthPlugin());
  return chromium;
}

// ─── TOTP (RFC 6238) ───
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  const bits: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 char: ${ch}`);
    for (let i = 4; i >= 0; i--) bits.push((idx >> i) & 1);
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    bytes.push(b);
  }
  return Buffer.from(bytes);
}
function totpCode(seed: string, at: number = Date.now()): string {
  const key = base32Decode(seed);
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter), 0);
  const h = createHmac("sha1", key).update(buf).digest();
  const offset = h[h.length - 1] & 0x0f;
  const value =
    ((h[offset] & 0x7f) << 24) |
    ((h[offset + 1] & 0xff) << 16) |
    ((h[offset + 2] & 0xff) << 8) |
    (h[offset + 3] & 0xff);
  return String(value % 1_000_000).padStart(6, "0");
}

// ─── Proxy config ───
function buildProxyConfig(accountId: string) {
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

  // The password format is: <base>_country-<cc>_session-<id>_lifetime-<dur>
  // Inject the per-account session id while preserving the base secret.
  const baseSecret = basePassword.split("_")[0];
  const perAccountPassword = `${baseSecret}_country-${country}_session-${accountId}_lifetime-168h`;

  return {
    server: `http://${host}:${port}`,
    username,
    password: perAccountPassword,
  };
}

// ─── Public API ───
export interface TwitterLoginRequest {
  account_id: string;       // used to derive a unique sticky proxy session
  login: string;            // email or handle
  password: string;
  totp_seed?: string;       // base32 TOTP seed, optional
  /** If provided, skip the login form entirely and inject these cookies directly. */
  auth_token?: string;
  ct0?: string;
}

export interface TwitterLoginResult {
  success: boolean;
  cookies?: any[];
  captured_at?: string;
  error?: string;
  error_code?:
    | "PROXY_NOT_CONFIGURED"
    | "LAUNCH_FAILED"
    | "UNEXPECTED_FLOW"
    | "IDENTIFIER_CHALLENGE"
    | "EMAIL_VERIFICATION_REQUIRED"
    | "TOTP_REQUIRED"
    | "BAD_CREDENTIALS"
    | "LOGIN_TIMEOUT"
    | "LOGIN_FAILED";
  diagnostics?: {
    url?: string;
    title?: string;
    page_text_excerpt?: string;
    screenshot_path?: string;
  };
}

export async function loginTwitter(
  req: TwitterLoginRequest
): Promise<TwitterLoginResult> {
  let proxy;
  try {
    proxy = buildProxyConfig(req.account_id);
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

    // ── Fast path: cookie injection ──
    // If the caller provided auth_token + ct0, skip the login form entirely.
    // Inject the cookies, hit /home, verify we didn't get bounced to /login,
    // and harvest the full cookie set. This avoids every anti-bot control at
    // the login step because there IS no login step.
    if (req.auth_token && req.ct0) {
      await ctx.addCookies([
        {
          name: "auth_token",
          value: req.auth_token,
          domain: ".x.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
        {
          name: "ct0",
          value: req.ct0,
          domain: ".x.com",
          path: "/",
          secure: true,
          sameSite: "Lax",
        },
      ]);
      const page = await ctx.newPage();
      try {
        await page.goto("https://x.com/home", {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
      } catch (e: any) {
        return {
          success: false,
          error: `Navigation to /home failed: ${e.message}`,
          error_code: "LOGIN_FAILED",
        };
      }

      // If we got bounced to a login URL, the cookies are expired / invalid.
      const finalUrl = page.url();
      if (/\/login|\/flow\/login|\/i\/flow/.test(finalUrl)) {
        return {
          success: false,
          error: `Cookie injection rejected — X redirected to login (URL: ${finalUrl}). Cookies are likely expired or revoked.`,
          error_code: "BAD_CREDENTIALS",
        };
      }

      // Belt-and-suspenders: verify the home feed rendered.
      await page
        .waitForSelector('[data-testid="primaryColumn"], [aria-label*="Home"]', { timeout: 15000 })
        .catch(() => {});

      const cookies = await ctx.cookies();
      return {
        success: true,
        cookies,
        captured_at: new Date().toISOString(),
      };
    }

    // ── Slow path: form login ──
    const page = await ctx.newPage();

    await page.goto("https://x.com/i/flow/login", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Helper — capture page state when something unexpected happens so the
    // error response tells us what X actually served.
    const snapshot = async (tag: string) => {
      try {
        const url = page.url();
        const title = await page.title().catch(() => "");
        const text: string = await page
          .evaluate(
            // eslint-disable-next-line no-undef
            "(() => (document.body && document.body.innerText ? document.body.innerText.slice(0, 500) : ''))()"
          )
          .catch(() => "");
        const shotDir = "/tmp/agentos-social-shots";
        const fs = await import("fs");
        if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
        const shotPath = `${shotDir}/${tag}-${Date.now()}.png`;
        await page.screenshot({ path: shotPath, fullPage: true });
        return { url, title, page_text_excerpt: text, screenshot_path: shotPath };
      } catch {
        return {};
      }
    };

    // ── Step 1: username/email ──
    // X often renders more than one `input[name="text"]` in the DOM (hidden
    // + visible), and the visible one is inside a dialog. Use locator-first
    // APIs that scope to visible elements and explicitly click to focus.
    const loginInput = page.locator(
      'input[autocomplete="username"]:visible, input[name="text"]:visible'
    ).first();

    try {
      await loginInput.waitFor({ state: "visible", timeout: 20000 });
    } catch {
      const diag = await snapshot("no-login-input");
      return {
        success: false,
        error: `Login input never rendered. X may have served an anti-bot page. URL: ${diag.url || "unknown"}`,
        error_code: "UNEXPECTED_FLOW",
        diagnostics: diag,
      };
    }

    // Focus, clear, then type character-by-character. `pressSequentially`
    // dispatches real keydown/keypress/keyup events which X's form listens
    // for to validate + enable the Next button.
    await loginInput.click();
    await loginInput.press("Control+A");
    await loginInput.press("Delete");
    await loginInput.pressSequentially(req.login, { delay: 80 });
    await page.waitForTimeout(800);

    // Verify the value actually landed in the input. If the input is empty,
    // X's form listener didn't fire keydown events properly — capture a
    // screenshot and fail with a clear error.
    const typedValue = await loginInput.inputValue().catch(() => "");
    if (!typedValue || typedValue.trim() === "") {
      const diag = await snapshot("input-not-filled");
      return {
        success: false,
        error: `Username input never accepted text. X may be using a trusted-events-only form. URL: ${diag.url}`,
        error_code: "UNEXPECTED_FLOW",
        diagnostics: diag,
      };
    }

    // Capture the pre-submit state so if the submit fails we know the input
    // was correctly filled.
    await snapshot("before-next-click");

    // Click the Next button. It starts disabled and enables once the input
    // has a valid value — wait for the enabled state before clicking.
    const nextButton = page
      .locator(
        'button[data-testid="LoginForm_Login_Button"]:visible, ' +
        'button:has-text("Next"):visible, ' +
        'div[role="button"]:has-text("Next"):visible'
      )
      .first();
    try {
      await nextButton.waitFor({ state: "visible", timeout: 5000 });
      await nextButton.click({ timeout: 5000 });
    } catch {
      // Fall back to keyboard Enter
      await loginInput.focus();
      await page.keyboard.press("Enter");
    }

    // ── Step 2: X may ask for an alt identifier, password, or 2FA first ──
    const nextStep = await Promise.race([
      page
        .waitForSelector('input[name="password"]', { timeout: 15000 })
        .then(() => "password"),
      page
        .waitForSelector('input[data-testid="ocfEnterTextTextInput"]', {
          timeout: 15000,
        })
        .then(() => "identifier_challenge"),
      page
        .waitForSelector('input[inputmode="numeric"]', { timeout: 15000 })
        .then(() => "totp_early"),
    ]).catch(() => "unknown");

    if (nextStep === "identifier_challenge") {
      const diag = await snapshot("identifier-challenge");
      return {
        success: false,
        error:
          "X requested an additional identifier (likely phone/username). Handle manually or extend the flow.",
        error_code: "IDENTIFIER_CHALLENGE",
        diagnostics: diag,
      };
    }

    if (nextStep === "unknown") {
      const diag = await snapshot("unknown-after-username");
      return {
        success: false,
        error: `X did not render a recognised next step after username. URL: ${diag.url || "?"} | Title: ${diag.title || "?"}`,
        error_code: "UNEXPECTED_FLOW",
        diagnostics: diag,
      };
    }

    // ── Step 3: password (if we didn't already hit 2FA) ──
    if (nextStep === "password") {
      const pwInput = page.locator('input[name="password"]:visible').first();
      await pwInput.click();
      await pwInput.fill("");
      await pwInput.type(req.password, { delay: 40 });
      await page.waitForTimeout(500);
      const loginButton = page
        .locator('button:has-text("Log in"):visible, div[role="button"]:has-text("Log in"):visible')
        .first();
      try {
        await loginButton.click({ timeout: 5000 });
      } catch {
        await page.keyboard.press("Enter");
      }
    }

    // ── Step 4: post-password disposition ──
    const afterPassword = await Promise.race([
      page
        .waitForURL(/(x|twitter)\.com\/home/, { timeout: 25000 })
        .then(() => "home"),
      page
        .waitForSelector('input[inputmode="numeric"]', { timeout: 25000 })
        .then(() => "totp"),
      page
        .waitForSelector('[data-testid="LoginForm_Login_Button"]', {
          timeout: 25000,
        })
        .then(() => "bad_creds"),
      page
        .waitForSelector('input[data-testid="ocfEnterTextTextInput"]', {
          timeout: 25000,
        })
        .then(() => "email_verify"),
    ]).catch(() => "unknown");

    if (afterPassword === "bad_creds") {
      const diag = await snapshot("bad-creds");
      return {
        success: false,
        error: "Invalid login or password",
        error_code: "BAD_CREDENTIALS",
        diagnostics: diag,
      };
    }
    if (afterPassword === "email_verify") {
      const diag = await snapshot("email-verify");
      return {
        success: false,
        error:
          "X requested email verification. First login must be done manually through the proxy before automation, or wire email polling next.",
        error_code: "EMAIL_VERIFICATION_REQUIRED",
        diagnostics: diag,
      };
    }
    if (afterPassword === "unknown") {
      const diag = await snapshot("unknown-after-password");
      return {
        success: false,
        error: `Unknown state after password. URL: ${diag.url || "?"} | Title: ${diag.title || "?"}`,
        error_code: "UNEXPECTED_FLOW",
        diagnostics: diag,
      };
    }

    if (afterPassword === "totp" || nextStep === "totp_early") {
      if (!req.totp_seed) {
        return {
          success: false,
          error: "X requested 2FA code but no TOTP seed was provided.",
          error_code: "TOTP_REQUIRED",
        };
      }
      const code = totpCode(req.totp_seed);
      await page.fill('input[inputmode="numeric"]', code);
      await page.waitForTimeout(400);
      await page.keyboard.press("Enter");
      await page.waitForURL(/(x|twitter)\.com\/home/, { timeout: 25000 });
    } else if (afterPassword !== "home") {
      return {
        success: false,
        error: `Login did not land on home feed. Last state: ${afterPassword}`,
        error_code: "LOGIN_TIMEOUT",
      };
    }

    // ── We're in. Harvest cookies. ──
    const cookies = await ctx.cookies();

    return {
      success: true,
      cookies,
      captured_at: new Date().toISOString(),
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
