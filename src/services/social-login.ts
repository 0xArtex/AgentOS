/**
 * Headless X/Twitter login via Playwright + stealth plugin, routed through a
 * per-account sticky residential IPRoyal proxy.
 *
 * Credentials are held only in the memory of the request that calls
 * `loginTwitter()`. Nothing persists server-side beyond the lifetime of the
 * browser context. The returned cookies are what the caller caches.
 */
import { createHmac } from "crypto";
import { buildProxyConfig, launchStealthBrowser } from "./social-runtime";
import { isSelfHosted } from "./self-hosted";

type Browser = any;

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

// ─── DOM helpers for X's "jetfuel" onboarding login flow ───
// evaluate() bodies are passed as strings on purpose: tsconfig has no DOM lib,
// so referencing `document` from a real closure wouldn't type-check (same
// convention the snapshot() helper below already uses).

/**
 * X renders its login form twice — a full-page copy behind a translucent
 * data-testid="mask" overlay PLUS the live modal in #layers on top — and plants
 * an aria-hidden decoy <input name="password"> as autofill bait. So neither
 * `.first()` nor `:visible` reliably picks the element a human can actually type
 * into (opacity:0 still counts as "visible" to Playwright). Tag the instance
 * that is genuinely topmost at its own centre point and return a locator for it.
 */
async function tagInteractable(page: any, selector: string, tag: string): Promise<any | null> {
  const sel = JSON.stringify(selector);
  const tg = JSON.stringify(tag);
  const js = `(() => {
    const els = Array.from(document.querySelectorAll(${sel}));
    const onTop = els.find((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return t === el || el.contains(t);
    });
    const pick = onTop || els.find((el) => { const r = el.getBoundingClientRect(); return !!(r.width && r.height); });
    if (!pick) return false;
    pick.setAttribute("data-pmlogin", ${tg});
    return true;
  })()`;
  const ok = await page.evaluate(js).catch(() => false);
  return ok ? page.locator(`[data-pmlogin="${tag}"]`) : null;
}

/**
 * Prefer a stable selector inside X's live modal. The jetfuel flow can rerender
 * an input immediately after it is tagged, which makes an attribute-based
 * locator stale. The hit-tested tag remains a fallback for legacy layouts.
 */
export async function selectLoginInput(page: any, selector: string, tag: string): Promise<any | null> {
  const layered = page.locator("#layers").locator(selector).last();
  try {
    await layered.waitFor({ state: "visible", timeout: 3000 });
    return layered;
  } catch {
    return tagInteractable(page, selector, tag);
  }
}

/**
 * Focus the resolved input and type through the page keyboard. This avoids
 * Playwright's pointer-actionability wait, which X's modal overlay can block
 * even when the real field is visible and focusable.
 */
export async function typeFocusedInput(
  page: any,
  input: any,
  value: string,
  delay: number
): Promise<void> {
  await input.focus({ timeout: 5000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(value, { delay });
}

/** Compare in memory only; callers must never include either value in logs. */
export async function inputHasExpectedValue(input: any, expected: string): Promise<boolean> {
  const actual = await input.inputValue().catch(() => "");
  return actual === expected;
}

/**
 * Detect X's soft anti-automation interstitials ("We've temporarily limited
 * your login", unusual-activity, rate-limit) from visible page text, so they're
 * surfaced as RATE_LIMITED instead of a mystery "unknown flow".
 */
async function detectThrottle(page: any): Promise<string> {
  const js = `(() => {
    const t = (document.body && document.body.innerText) || "";
    return /temporarily limited|unusual login|unusual activity|try again later|rate.?limit|too many/i.test(t)
      ? t.replace(/\\s+/g, " ").trim().slice(0, 160) : "";
  })()`;
  return await page.evaluate(js).catch(() => "");
}

// ─── Public API ───
export interface TwitterLoginRequest {
  account_id: string;       // used to derive a unique sticky proxy session
  /** Overrides account_id when pinning the IPRoyal session. Preserves IP lineage across pool handoff. */
  proxy_session_id?: string;
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
  /** Authenticated @handle discovered from X's profile navigation link. */
  username?: string;
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
    | "RATE_LIMITED"
    | "LOGIN_FAILED";
  diagnostics?: {
    phase?: string;
    url?: string;
    title?: string;
    page_text_excerpt?: string;
    screenshot_path?: string;
  };
}

const X_RESERVED_PATHS = new Set([
  "compose",
  "explore",
  "home",
  "i",
  "login",
  "messages",
  "notifications",
  "search",
  "settings",
]);

// X keeps an aria-hidden password input on the identifier screen for browser
// autofill. Every selector branch must exclude it, including the newer jf id,
// or the flow advances before the real password screen has rendered.
export const TWITTER_PASSWORD_SELECTOR =
  'input[name="password"]:not([aria-hidden="true"]), #jf-input-password:not([aria-hidden="true"])';

/** Parse an authenticated profile navigation href without accepting X routes. */
export function usernameFromProfileHref(href?: string | null): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, "https://x.com");
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "x.com" && hostname !== "www.x.com" && hostname !== "twitter.com" && hostname !== "www.twitter.com") {
      return undefined;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return undefined;
    const username = decodeURIComponent(segments[0]).replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) return undefined;
    if (X_RESERVED_PATHS.has(username.toLowerCase())) return undefined;
    return username;
  } catch {
    return undefined;
  }
}

async function detectAuthenticatedUsername(page: any): Promise<string | undefined> {
  const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]').first();
  await profileLink.waitFor({ state: "attached", timeout: 12000 }).catch(() => {});
  return usernameFromProfileHref(await profileLink.getAttribute("href").catch(() => null));
}

/** Reduce browser exceptions to a phase-only diagnostic; never echo inputs. */
export function loginFailureForPhase(phase: string, error: unknown): TwitterLoginResult {
  const err = error as any;
  const message = String(err?.message || err || "");
  const timedOut = err?.name === "TimeoutError" || /timeout|timed out|exceeded/i.test(message);
  return {
    success: false,
    error: `X login ${timedOut ? "timed out" : "failed"} during ${phase}.`,
    error_code: timedOut ? "LOGIN_TIMEOUT" : "LOGIN_FAILED",
    diagnostics: { phase },
  };
}

export async function loginTwitter(
  req: TwitterLoginRequest
): Promise<TwitterLoginResult> {
  const sessionKey = req.proxy_session_id || req.account_id;
  let proxy;
  try {
    proxy = buildProxyConfig(sessionKey);
  } catch (e: any) {
    // Self-hosted single-operator mode runs on the operator's own IP — no
    // residential proxy required. Prod still requires it.
    if (isSelfHosted()) proxy = undefined;
    else return {
      success: false,
      error: e.message,
      error_code: "PROXY_NOT_CONFIGURED",
    };
  }

  let browser: Browser;
  try {
    browser = await launchStealthBrowser({ headless: true, proxy });
  } catch (e: any) {
    return {
      success: false,
      error: `Failed to launch Chromium: ${e.message}`,
      error_code: "LAUNCH_FAILED",
    };
  }

  let phase = "create_context";
  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // ── Fast path: cookie injection ──
    // If the caller provided auth_token, skip the login form entirely.
    // Inject the cookie, hit /home, verify we didn't get bounced to /login,
    // and harvest the full cookie set. This avoids every anti-bot control at
    // the login step because there IS no login step.
    //
    // `ct0` is optional: marketplaces that bundle the auth_token cookie
    // often omit ct0 because it's a CSRF token that X re-issues on every
    // session. If we have it we inject it; if not, the first authenticated
    // request fetches a fresh ct0 from X and the harvest step at the end
    // captures it. auth_token alone is enough to establish the session.
    if (req.auth_token) {
      phase = "inject_cookies";
      const injected: any[] = [
        {
          name: "auth_token",
          value: req.auth_token,
          domain: ".x.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ];
      if (req.ct0) {
        injected.push({
          name: "ct0",
          value: req.ct0,
          domain: ".x.com",
          path: "/",
          secure: true,
          sameSite: "Lax",
        });
      }
      await ctx.addCookies(injected);
      const page = await ctx.newPage();
      phase = "open_home_with_cookies";
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

      phase = "harvest_cookies";
      const cookies = await ctx.cookies();
      phase = "detect_username";
      const username = await detectAuthenticatedUsername(page);
      return {
        success: true,
        cookies,
        username,
        captured_at: new Date().toISOString(),
      };
    }

    // ── Slow path: form login ──
    const page = await ctx.newPage();

    phase = "open_login";
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
        const shotDir = "/tmp/palmyr-social-shots";
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
    // X migrated /i/flow/login to its new "jetfuel" onboarding modal (it lands
    // on /i/jf/onboarding/web?mode=login). The field there is
    // input[name="username_or_email"] (autocomplete="username webauthn") — which
    // neither the legacy input[name="text"] nor the *exact* [autocomplete=
    // "username"] match, which is what produced the old "anti-bot page" timeout.
    // The form is also rendered twice (a full-page copy behind a translucent
    // data-testid="mask" + the live modal in #layers), so we tag the topmost
    // interactable instance rather than guessing .first()/.last(). Legacy
    // selectors are kept so an old-flow rollout still logs in.
    const USERNAME_SELECTOR =
      'input[name="username_or_email"], input[autocomplete~="username"], input[name="text"]';

    phase = "wait_for_login_input";
    try {
      await page.locator(USERNAME_SELECTOR).first().waitFor({ state: "visible", timeout: 20000 });
    } catch {
      const throttle = await detectThrottle(page);
      const diag = await snapshot("no-login-input");
      return {
        success: false,
        error: throttle
          ? `X throttled the login before the form rendered: "${throttle}"`
          : `Login input never rendered (URL: ${diag.url || "unknown"}).`,
        error_code: throttle ? "RATE_LIMITED" : "UNEXPECTED_FLOW",
        diagnostics: diag,
      };
    }

    phase = "select_login_input";
    const loginInput = await selectLoginInput(page, USERNAME_SELECTOR, "user");
    if (!loginInput) {
      const diag = await snapshot("no-login-input");
      return {
        success: false,
        error: `Login input matched but no interactable instance was found. URL: ${diag.url || "unknown"}`,
        error_code: "UNEXPECTED_FLOW",
        diagnostics: diag,
      };
    }

    // Focus, clear, then type character-by-character. `pressSequentially`
    // dispatches real keydown/keypress/keyup events which X's form listens
    // for to validate + enable the Next button.
    phase = "fill_login_input";
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
    phase = "snapshot_before_login_submit";
    await snapshot("before-next-click");

    // Submit. New flow: the only type="submit" inside #layers is the "Continue"
    // button (the SSO buttons are type="button"), so that selector targets it
    // without matching "Continue with phone/Google/Apple". Legacy: the testid /
    // "Next" button ("Next" is not a substring of any other button, so has-text
    // is safe). Enter submits the single-field form as a last resort.
    phase = "submit_login_identifier";
    const nextButton = page
      .locator(
        '#layers button[type="submit"]:visible, ' +
        'button[data-testid="LoginForm_Login_Button"]:visible, ' +
        'button:has-text("Next"):visible, ' +
        'div[role="button"]:has-text("Next"):visible'
      )
      .last();
    try {
      await nextButton.waitFor({ state: "visible", timeout: 6000 });
      await nextButton.click({ timeout: 5000 });
    } catch {
      // Fall back to keyboard Enter
      await loginInput.focus();
      await page.keyboard.press("Enter");
    }

    // ── Step 2: X may ask for an alt identifier, password, or 2FA first ──
    // Exclude the aria-hidden decoy <input name="password"> the jf flow plants on
    // the username screen, and accept the new #jf-input-password id alongside the
    // legacy name.
    phase = "wait_for_password_or_challenge";
    const nextStep = await Promise.race([
      page
        .waitForSelector(TWITTER_PASSWORD_SELECTOR, { timeout: 15000 })
        .then(() => "password"),
      page
        .waitForSelector('input[data-testid="ocfEnterTextTextInput"]', {
          timeout: 15000,
        })
        .then(() => "identifier_challenge"),
      page
        .waitForSelector('input[inputmode="numeric"]:not([aria-hidden="true"])', { timeout: 15000 })
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
      const throttle = await detectThrottle(page);
      const diag = await snapshot("unknown-after-username");
      return {
        success: false,
        error: throttle
          ? `X throttled the login after username: "${throttle}"`
          : `X did not render a recognised next step after username. URL: ${diag.url || "?"} | Title: ${diag.title || "?"}`,
        error_code: throttle ? "RATE_LIMITED" : "UNEXPECTED_FLOW",
        diagnostics: diag,
      };
    }

    // ── Step 3: password (if we didn't already hit 2FA) ──
    if (nextStep === "password") {
      phase = "fill_password";
      // Same decoy/dual-render hazard as the username field — pick the real,
      // topmost password input, never the aria-hidden autofill bait.
      const PW_SELECTOR = TWITTER_PASSWORD_SELECTOR;
      await page.locator(PW_SELECTOR).first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      const pwInput =
        (await selectLoginInput(page, PW_SELECTOR, "pw")) ||
        page.locator(PW_SELECTOR).first();
      await typeFocusedInput(page, pwInput, req.password, 40);
      phase = "verify_password_input";
      if (!(await inputHasExpectedValue(pwInput, req.password))) {
        return {
          success: false,
          error: "X's password field did not retain the entered value; login was not submitted.",
          error_code: "UNEXPECTED_FLOW",
          diagnostics: { phase },
        };
      }
      await page.waitForTimeout(500);
      // New flow: #layers type="submit". Legacy: a "Log in" button ("Log in" is
      // not a substring of the SSO buttons, so has-text is safe).
      phase = "submit_password";
      const loginButton = page
        .locator(
          '#layers button[type="submit"]:visible, ' +
          'button:has-text("Log in"):visible, ' +
          'div[role="button"]:has-text("Log in"):visible'
        )
        .last();
      try {
        await loginButton.click({ timeout: 5000 });
      } catch {
        await page.keyboard.press("Enter");
      }
    }

    // ── Step 4: post-password disposition ──
    phase = "wait_after_password";
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
      const throttle = await detectThrottle(page);
      const diag = await snapshot("unknown-after-password");
      return {
        success: false,
        error: throttle
          ? `X throttled the login after password: "${throttle}"`
          : `Unknown state after password. URL: ${diag.url || "?"} | Title: ${diag.title || "?"}`,
        error_code: throttle ? "RATE_LIMITED" : "UNEXPECTED_FLOW",
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
      phase = "generate_totp";
      const code = totpCode(req.totp_seed);
      // 2FA field can be dual-rendered too — target the real, topmost numeric
      // input rather than page.fill() (which throws on multiple matches).
      const otpInput =
        (await selectLoginInput(page, 'input[inputmode="numeric"]:not([aria-hidden="true"])', "otp")) ||
        page.locator('input[inputmode="numeric"]:not([aria-hidden="true"])').first();
      phase = "fill_totp";
      await otpInput.click().catch(() => {});
      await otpInput.fill("");
      await otpInput.type(code, { delay: 60 });
      await page.waitForTimeout(400);
      phase = "submit_totp";
      await page.keyboard.press("Enter");
      phase = "wait_for_home_after_totp";
      await page.waitForURL(/(x|twitter)\.com\/home/, { timeout: 25000 });
    } else if (afterPassword !== "home") {
      return {
        success: false,
        error: `Login did not land on home feed. Last state: ${afterPassword}`,
        error_code: "LOGIN_TIMEOUT",
      };
    }

    // ── We're in. Harvest cookies. ──
    phase = "harvest_cookies";
    const cookies = await ctx.cookies();
    phase = "detect_username";
    const username = await detectAuthenticatedUsername(page);

    return {
      success: true,
      cookies,
      username,
      captured_at: new Date().toISOString(),
    };
  } catch (e: any) {
    return loginFailureForPhase(phase, e);
  } finally {
    try {
      await browser.close();
    } catch {}
  }
}
