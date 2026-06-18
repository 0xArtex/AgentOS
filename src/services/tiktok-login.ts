/**
 * Headless TikTok login via Playwright + stealth plugin, routed through a
 * per-account sticky residential proxy.
 *
 * Two paths:
 *   1. Cookie injection — caller ships a live `sessionid` (fastest, most
 *      reliable when available). Skips every anti-bot control on login.
 *   2. Form login — caller ships `{login, password}`. We drive the login
 *      form, and if TikTok gates it with a captcha we hand the challenge
 *      off to CapSolver (env `CAPSOLVER_API_KEY`). Works on marketplace-
 *      format accounts (`login:password:email:email_pw`) that never come
 *      with cookies.
 *
 * Both paths end the same way: harvest the full cookie jar + confirm the
 * authed UI rendered.
 */
import { buildProxyConfig, profileForCountry, launchStealthBrowser } from "./social-runtime";
import { isSelfHosted } from "./self-hosted";
import { solveTikTokCaptcha, isCaptchaSolverConfigured } from "./captcha-solver";
import { fetchVerificationCode } from "./email-reader";

/** Small random pause between UI actions to look less robotic. */
function humanDelay(min: number = 400, max: number = 1200): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

/**
 * Simulate a few seconds of human-style "looking around" on the page —
 * random mouse movements and a small scroll. Anti-bot systems track
 * pre-click mouse entropy; a cursor that teleports straight to the submit
 * button gets flagged even if every other signal looks fine.
 */
async function humanBrowse(page: any, durationMs: number = 2000): Promise<void> {
  const start = Date.now();
  const viewport = page.viewportSize() || { width: 1920, height: 1080 };

  while (Date.now() - start < durationMs) {
    const x = Math.floor(Math.random() * viewport.width);
    const y = Math.floor(Math.random() * viewport.height * 0.8);
    await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 15) });
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 280));
  }
  // Small scroll — humans usually scroll at least once before interacting.
  await page.mouse.wheel(0, 40 + Math.floor(Math.random() * 120));
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
  await page.mouse.wheel(0, -(20 + Math.floor(Math.random() * 80)));
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
}

/**
 * Move the mouse towards a target element along a slightly-curved, variable-
 * speed path, then click. Real humans don't straight-line-teleport the cursor.
 */
async function humanClick(page: any, locator: any, opts: { clickDelayMs?: number } = {}): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) {
    await locator.click();
    return;
  }
  // Pick a click point slightly offset from center — real users never click dead center.
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

  // Approach in 2-3 segments so the path has a slight curve.
  const waypoints = 2 + Math.floor(Math.random() * 2);
  for (let i = 1; i <= waypoints; i++) {
    const progress = i / waypoints;
    const jitterX = (Math.random() - 0.5) * 40;
    const jitterY = (Math.random() - 0.5) * 40;
    await page.mouse.move(
      box.x + box.width / 2 + (targetX - box.x - box.width / 2) * progress + jitterX,
      box.y + box.height / 2 + (targetY - box.y - box.height / 2) * progress + jitterY,
      { steps: 5 + Math.floor(Math.random() * 10) },
    );
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 80));
  }
  await page.mouse.move(targetX, targetY, { steps: 3 });
  await new Promise((r) => setTimeout(r, (opts.clickDelayMs ?? 50) + Math.random() * 200));
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
  await page.mouse.up();
}

type Browser = any;

export interface TikTokLoginRequest {
  account_id: string;
  /** Overrides account_id when pinning the proxy session. Preserves IP lineage across pool handoff. */
  proxy_session_id?: string;
  /** ISO-3166 alpha-2 country (e.g. "de", "fr"). Drives proxy exit, locale, timezone. */
  country?: string;
  /** Cookie-injection path: main auth cookie. 40-char hex. */
  sessionid?: string;
  /** CSRF cookie. Hex. */
  tt_csrf_token?: string;
  /** Device fingerprint cookie — if the seller includes it, use it for IP-device consistency. */
  tt_webid_v2?: string;
  /** Any extra cookies the seller shipped (e.g. `msToken`, `s_v_web_id`). Passed through verbatim. */
  extra_cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>;
  /** Form-login path: TikTok username (or email for email-based login). */
  login?: string;
  /** Form-login path: TikTok password. */
  password?: string;
  /**
   * Bind email + password. When provided, the server can auto-solve TikTok's
   * "Verify it's really you" device-verification challenge by reading the
   * code out of the email inbox via IMAP.
   */
  email?: string;
  email_password?: string;
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
    | "MISSING_CREDENTIALS"
    | "BAD_CREDENTIALS"
    | "CAPTCHA_CHALLENGE"
    | "CAPTCHA_SOLVER_NOT_CONFIGURED"
    | "CAPTCHA_SOLVE_FAILED"
    | "EMAIL_VERIFICATION_REQUIRED"
    | "EMAIL_VERIFICATION_FAILED"
    | "EMAIL_AUTH_FAILED"
    | "SMS_VERIFICATION_REQUIRED"
    | "ACCOUNT_BLOCKED"
    | "LOGIN_TIMEOUT"
    | "LOGIN_FAILED"
    | "FORM_LOGIN_DISABLED";
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
  const hasCookies = Boolean(req.sessionid);
  const hasFormCreds = Boolean(req.login && req.password);

  if (!hasCookies && !hasFormCreds) {
    return {
      success: false,
      error: "Provide either { sessionid } for cookie-injection login, or { login, password } for form login.",
      error_code: "MISSING_CREDENTIALS",
    };
  }

  // Headless form-login (typing username/password) trips TikTok's anti-bot
  // (~70% perma-spin) and naive retries can lock the account for 15-60 min. It
  // is disabled by default so an unattended agent can never route through it;
  // use QR connect (`palmyr tiktok connect <user>`) or cookie injection
  // ({ sessionid }). A human-supervised run can opt back in via env flag.
  if (hasFormCreds && !hasCookies && process.env.PALMYR_ALLOW_TIKTOK_FORM_LOGIN !== "1") {
    return {
      success: false,
      error:
        "TikTok form-login is disabled (unreliable — it frequently spins and can lock the account). " +
        "Connect via QR (`palmyr tiktok connect <user>`) or provide a fresh { sessionid }. " +
        "Set PALMYR_ALLOW_TIKTOK_FORM_LOGIN=1 to override in a supervised run.",
      error_code: "FORM_LOGIN_DISABLED",
    };
  }

  if (hasCookies && !/^[a-f0-9]{24,64}$/i.test(req.sessionid!)) {
    return {
      success: false,
      error: "sessionid must be a 24-64 char hex cookie",
      error_code: "BAD_CREDENTIALS",
    };
  }

  const sessionKey = req.proxy_session_id || req.account_id;
  let proxy;
  try {
    proxy = buildProxyConfig(sessionKey, { country: req.country });
  } catch (e: any) {
    // Self-hosted single-operator mode runs on the operator's own IP — no
    // residential proxy required (matches openAuthenticatedSession). Prod still
    // requires it.
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

  try {
    const profile = profileForCountry(req.country);
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: profile.locale,
      timezoneId: profile.timezoneId,
      extraHTTPHeaders: {
        "accept-language": `${profile.locale},${profile.locale.split("-")[0]};q=0.9`,
      },
    });

    // ── Cookie-injection path ─────────────────────────────────────────
    if (hasCookies) {
      const cookies: any[] = [
        {
          name: "sessionid",
          value: req.sessionid!,
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
    }

    const page = await ctx.newPage();

    // Different landing URL depending on path: cookie path lands on /, form
    // path lands on /login/phone-or-email/email to drive the email form.
    const landingUrl = hasCookies
      ? "https://www.tiktok.com/"
      : "https://www.tiktok.com/login/phone-or-email/email";

    try {
      await page.goto(landingUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    } catch (e: any) {
      return {
        success: false,
        error: `Navigation to ${landingUrl} failed: ${e.message}`,
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
        const shotDir = "/tmp/palmyr-social-shots";
        const fs = await import("fs");
        if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
        const shotPath = `${shotDir}/tiktok-${tag}-${Date.now()}.png`;
        await page.screenshot({ path: shotPath, fullPage: true });
        return { url, title, page_text_excerpt: text, screenshot_path: shotPath };
      } catch {
        return {};
      }
    };

    // ── Form-login path ───────────────────────────────────────────────
    // Fill username + password, submit, handle captcha via CapSolver.
    if (!hasCookies) {
      try {
        // TikTok's login form uses React with trusted-event validation — the
        // Log in button stays `disabled` unless real keydown/keypress/keyup
        // events fire. `fill()` sets the value via JS and bypasses them, so
        // we type character-by-character with `pressSequentially`.
        // Humans don't submit instantly after page load — they read, move the
        // cursor around, scroll a bit. Simulate 2-3s of that before touching
        // anything. Anti-bot systems (TikTok specifically) track pre-click
        // mouse entropy; zero-entropy sessions get silently dropped.
        await humanBrowse(page, 2500);

        const emailInput = page.locator('input[name="username"], input[type="text"]').first();
        await emailInput.waitFor({ state: "visible", timeout: 20000 });
        await humanClick(page, emailInput);
        await humanDelay(150, 350);
        await emailInput.press("Control+A");
        await emailInput.press("Delete");
        // Randomise per-keystroke delay for a more human typing cadence.
        await emailInput.pressSequentially(req.login!, { delay: 45 + Math.random() * 60 });

        // Pause between fields — humans don't tab instantly.
        await humanDelay(800, 1800);

        const passwordInput = page.locator('input[type="password"]').first();
        await passwordInput.waitFor({ state: "visible", timeout: 10000 });
        await humanClick(page, passwordInput);
        await humanDelay(150, 350);
        await passwordInput.press("Control+A");
        await passwordInput.press("Delete");
        await passwordInput.pressSequentially(req.password!, { delay: 55 + Math.random() * 70 });

        // Blur the password field so React runs its on-blur validators
        // (some TikTok variants only enable the submit button after blur).
        await page.keyboard.press("Tab");
        await humanDelay(600, 1400);

        const loginButton = page
          .locator('button[data-e2e="login-button"], button[type="submit"]')
          .first();
        // Wait for React to enable the button now that inputs have real values.
        await loginButton.waitFor({ state: "visible", timeout: 5000 });

        // Poll for `disabled` attribute clearing (up to 10s). If it never
        // clears, TikTok's form still considers our inputs invalid — don't
        // hammer retries on a disabled button, each retry counts as an
        // attempt and trips TikTok's rate limit for 15-60 min.
        let enabled = false;
        const enableStart = Date.now();
        while (Date.now() - enableStart < 10000) {
          const disabled = await loginButton.getAttribute("disabled").catch(() => null);
          if (disabled === null) { enabled = true; break; }
          await page.waitForTimeout(250);
        }
        if (!enabled) {
          const diag = await snapshot("login-button-stuck-disabled");
          return {
            success: false,
            error: "Login button stayed disabled — TikTok's form validation rejected the input shape. Likely a captcha or field format changed; do not retry without investigating.",
            error_code: "LOGIN_FAILED",
            diagnostics: diag,
          };
        }

        // Pause + human-style click — stops the bot-classifier from seeing a
        // fills-form-and-immediately-submits pattern.
        await humanDelay(400, 900);
        await humanClick(page, loginButton, { clickDelayMs: 100 });
      } catch (e: any) {
        const diag = await snapshot("form-fill-failed");
        return {
          success: false,
          error: `Could not fill / submit login form: ${e.message}`,
          error_code: "LOGIN_FAILED",
          diagnostics: diag,
        };
      }

      // After submit we can land in one of several places:
      //   a) Captcha — handle via CapSolver below
      //   b) SMS / email verification page — bail out, not auto-solvable
      //   c) Home feed — success, no captcha was needed
      //   d) Inline error (bad creds, rate-limited)
      //
      // Critical: TikTok's backend can take 30-60s on fresh residential IPs
      // before responding — the submit button sits with a spinner until it
      // does. Race the possible terminal states against a long (60s) timeout
      // instead of giving up after 8s and reporting "no signal".
      try {
        await Promise.race([
          // URL left the login page (usually means success or challenge redirect)
          page.waitForURL((u: any) => {
            const s = typeof u === "string" ? u : u.toString();
            return !s.includes("/login/phone-or-email") && !s.includes("/login/email");
          }, { timeout: 60000 }),
          // Captcha appeared — all TikTok variants.
          page.locator('text=/Drag the slider to fit the puzzle/i, text=/Slide the piece to complete the puzzle/i, [id*="captcha"], [class*="captcha-verify"], [class*="captcha_verify"], iframe[src*="captcha"], .secsdk-captcha-drag-icon').first().waitFor({ state: "visible", timeout: 60000 }),
          // Authed nav visible
          page.locator('[data-e2e="profile-icon"], [data-e2e="upload-icon"]').first().waitFor({ state: "visible", timeout: 60000 }),
          // Device-verification modal
          page.locator('text=/Verify it.?s really you|Verify identity/i').first().waitFor({ state: "visible", timeout: 60000 }),
          // Any known inline error
          page.locator('text=/incorrect|does not match|wrong password|Maximum number of attempts|Too many attempts/i').first().waitFor({ state: "visible", timeout: 60000 }),
        ]).catch(() => null);
      } catch { /* noop */ }

      // Rate-limit check — TikTok shows "Maximum number of attempts reached.
      // Try again later." after too many failed login attempts from an IP or
      // on an account. Cooldown is typically 15-60 minutes. Bail fast so the
      // caller doesn't keep hammering and extending the lock.
      const rateLimited = await page
        .locator('text=/Maximum number of attempts|Try again later|too many attempts/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (rateLimited) {
        const diag = await snapshot("tiktok-rate-limited");
        return {
          success: false,
          error: "TikTok has rate-limited this account/IP: 'Maximum number of attempts reached. Try again later.' Wait 15-60 minutes before retrying, or try a different account.",
          error_code: "ACCOUNT_BLOCKED",
          diagnostics: diag,
        };
      }

      // Bad-credential check.
      const credError = await page
        .locator('text=/incorrect|does not match|wrong password|Account does not exist/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (credError) {
        const diag = await snapshot("bad-creds");
        return {
          success: false,
          error: "TikTok rejected the login: wrong username/email or password.",
          error_code: "BAD_CREDENTIALS",
          diagnostics: diag,
        };
      }

      // Device-verification modal ("Verify it's really you"). TikTok shows
      // this on first login from a new IP/device. It offers Email (and
      // sometimes Phone) as verification channels. We click Email, poll the
      // bind inbox via IMAP, extract the code, submit it.
      const deviceVerify = await page
        .locator('text=/Verify it.?s really you|verify your identity|Enter the verification code|we.?ll send a code/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (deviceVerify) {
        if (!req.email || !req.email_password) {
          const diag = await snapshot("device-verification-no-email");
          return {
            success: false,
            error: "TikTok requires device verification via email, but no email credentials were supplied. Re-import the account with --credentials-line that includes email + email password.",
            error_code: "EMAIL_VERIFICATION_REQUIRED",
            diagnostics: diag,
          };
        }

        try {
          await solveDeviceVerification(page, req, snapshot);
        } catch (e: any) {
          const diag = await snapshot("email-verification-failed");
          const message = String(e?.message || e);
          const code = /AUTH|authenticat/i.test(message)
            ? "EMAIL_AUTH_FAILED"
            : "EMAIL_VERIFICATION_FAILED";
          return {
            success: false,
            error: `Email auto-solve failed: ${message}`,
            error_code: code,
            diagnostics: diag,
          };
        }

        // Post-verification — wait for the authed UI OR another challenge.
        await Promise.race([
          page.locator('[data-e2e="profile-icon"], [data-e2e="upload-icon"]').first().waitFor({ state: "visible", timeout: 45000 }),
          page.locator('text=/verification code|incorrect|Maximum number of attempts/i').first().waitFor({ state: "visible", timeout: 45000 }),
        ]).catch(() => null);
      }

      // Captcha gate. TikTok has multiple variants:
      //   - Classic slider ("Slide the piece to complete the puzzle")
      //   - Whirl / 3D rotate ("Drag the slider to fit the puzzle")
      //   - Shape-select ("Select the 2 [objects] that...")
      // All three show up in the DOM without a `captcha` class/id — we detect
      // by the visible prompt text OR by the drag-slider element that every
      // variant shares.
      const captchaSelectors = [
        'text=/Drag the slider to fit the puzzle/i',
        'text=/Slide the piece to complete the puzzle/i',
        'text=/Select the .* that match/i',
        '[id*="captcha"]',
        '[class*="captcha-verify"]',
        '[class*="captcha_verify"]',
        'iframe[src*="captcha"]',
        '.secsdk-captcha-drag-icon',
      ].join(', ');
      const captchaElement = page.locator(captchaSelectors).first();
      const captchaPresent = await captchaElement.isVisible({ timeout: 500 }).catch(() => false);

      if (captchaPresent) {
        if (!isCaptchaSolverConfigured()) {
          const diag = await snapshot("captcha-no-solver");
          return {
            success: false,
            error: "TikTok is serving a captcha but CAPSOLVER_API_KEY is not configured on the server.",
            error_code: "CAPTCHA_SOLVER_NOT_CONFIGURED",
            diagnostics: diag,
          };
        }

        try {
          await solveCaptcha(page, req, snapshot);
        } catch (e: any) {
          const diag = await snapshot("captcha-solve-failed");
          return {
            success: false,
            error: `Captcha solve failed: ${e.message}`,
            error_code: "CAPTCHA_SOLVE_FAILED",
            diagnostics: diag,
          };
        }

        // Post-captcha: wait for home feed or another challenge.
        await Promise.race([
          page.locator('[data-e2e="profile-icon"], [data-e2e="upload-icon"]').first().waitFor({ state: "visible", timeout: 20000 }),
          page.locator('text=/Enter the verification code|check your email/i').first().waitFor({ state: "visible", timeout: 20000 }),
        ]).catch(() => null);

        const secondCodeChallenge = await page
          .locator('text=/Enter the verification code|check your email/i')
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);
        if (secondCodeChallenge) {
          const diag = await snapshot("sms-after-captcha");
          return {
            success: false,
            error: "Captcha solved, but TikTok still requested an email/SMS code. Manual intervention required once.",
            error_code: "SMS_VERIFICATION_REQUIRED",
            diagnostics: diag,
          };
        }
      }
    }

    // Detect redirect to login page — means cookies are dead (cookie path only).
    const currentUrl = page.url();
    if (hasCookies && /\/login/.test(currentUrl)) {
      const diag = await snapshot("redirected-to-login");
      return {
        success: false,
        error: `Cookie injection rejected — TikTok redirected to login (URL: ${currentUrl}). sessionid is expired or revoked.`,
        error_code: "BAD_CREDENTIALS",
        diagnostics: diag,
      };
    }

    // Final captcha wall check (cookie path — shouldn't happen but defend).
    const captchaVisible = hasCookies && await page
      .locator('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]')
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    if (captchaVisible) {
      const diag = await snapshot("captcha-challenge");
      return {
        success: false,
        error: "TikTok is serving a captcha challenge on the cookie-path session. Re-import with a fresher sessionid.",
        error_code: "CAPTCHA_CHALLENGE",
        diagnostics: diag,
      };
    }

    // Positive signal — the profile/upload buttons only render when authed.
    // `[data-e2e="profile-icon"]` and `[data-e2e="upload-icon"]` are stable
    // identifiers used by TikTok's web UI for the top-nav auth buttons.
    // Wait up to 30s because TikTok can redirect through an intermediate
    // verification page before landing on /foryou.
    const authed = await Promise.race([
      page
        .locator('[data-e2e="profile-icon"], [data-e2e="upload-icon"], [data-e2e="nav-profile"]')
        .first()
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => true),
      page
        .locator('[data-e2e="top-login-button"], a[href*="/login"]')
        .first()
        .waitFor({ state: "visible", timeout: 30000 })
        .then(() => false),
    ]).catch(() => null);

    // NOTE (known gap): the `[data-e2e="nav-profile"]`/`upload-icon` left-nav
    // links also render for ANONYMOUS users, so this signal can resolve
    // authed=true on a logged-out page — a dead/fake sessionid reports a false
    // "success". A proper fix (gate on a logged-in-only signal — top-right
    // profile avatar absence-of-"Log in", or a server-set auth cookie) needs
    // validation against a real logged-in session, which isn't available here.
    if (authed !== true) {
      const diag = await snapshot("no-auth-signal");
      const pathMsg = hasCookies
        ? "sessionid may be dead or the region is challenge-walled"
        : "the form-login flow may have been blocked by an unhandled challenge (captcha variant, device verification, or geography mismatch)";
      return {
        success: false,
        error: `Could not detect authenticated UI (${hasCookies ? "cookie" : "form"} path). ${pathMsg}. Check diagnostics.screenshot_path for the exact TikTok page state.`,
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

/**
 * Solve a TikTok captcha currently visible on the page.
 *
 * Handles the two forms TikTok shows on login:
 *   - Slider: drag the moving piece to fit the gap in the background
 *   - Whirl: rotate the image to upright (we treat rotate as a slider angle)
 *
 * Extracts the challenge images from the page DOM, ships them to CapSolver,
 * then replays the returned coordinates as real mouse drags. Throws on any
 * failure — caller should capture diagnostics and return CAPTCHA_SOLVE_FAILED.
 */
async function solveCaptcha(
  page: any,
  req: TikTokLoginRequest,
  snapshot: (tag: string) => Promise<any>
): Promise<void> {
  await snapshot("captcha-start");
  // 1. Find the captcha container. TikTok uses different wrappers per variant:
  //    - Classic slider: `[id^="captcha_container"]`
  //    - 3D rotate ("Drag to fit the puzzle"): often a modal with the drag icon
  //    - Generic: anything containing `.secsdk-captcha-drag-icon`
  const containerSelectors = [
    '[id^="captcha_container"]',
    '[class*="captcha-verify-container"]',
    '.captcha_verify_container',
    // 3D rotate variant lives inside the drag-icon's scroll container
    '[class*="captcha-disable-scroll"]',
    '[class*="captcha_verify"]',
    // Last-resort: the outermost parent of the drag icon
    '.secsdk-captcha-drag-icon',
  ];
  const container = page.locator(containerSelectors.join(", ")).first();
  await container.waitFor({ state: "visible", timeout: 10000 });

  // 2. Extract images. Different variants expose them differently:
  //    - Classic slider: two <img> tags (background + piece)
  //    - 3D rotate: one <img> with the rotatable disc; piece may be null
  //    When no <img> is found, fall back to a screenshot of the captcha area.
  let images: { body?: string; piece?: string } = await page.evaluate(
    `(() => {
      const root = document.querySelector('${containerSelectors.join(", ")}');
      if (!root) return {};
      const imgs = root.querySelectorAll('img');
      const out = {};
      if (imgs[0]) out.body = imgs[0].src;
      if (imgs[1]) out.piece = imgs[1].src;
      return out;
    })()`
  );

  // Fallback: screenshot the captcha box if we couldn't find <img> src's.
  // CapSolver accepts base64 images for its AntiTiktokTask.
  if (!images.body) {
    const box = await container.boundingBox();
    if (box) {
      const shotBuf = await page.screenshot({ clip: box });
      images.body = "data:image/png;base64," + shotBuf.toString("base64");
    }
  }

  if (!images.body) {
    const fallbackDiag = await snapshot("captcha-image-not-extracted");
    throw new Error(`Could not extract captcha image from DOM or screenshot. Diag: ${fallbackDiag.screenshot_path}`);
  }

  // Images are usually https URLs — download them and re-base64 for the solver.
  async function urlToB64(src: string): Promise<string> {
    if (src.startsWith("data:")) return src.split(",")[1] || "";
    const buf = await page.request.get(src).then((r: any) => r.body());
    return Buffer.from(buf).toString("base64");
  }
  const bodyImage = await urlToB64(images.body);
  const pieceImage = images.piece ? await urlToB64(images.piece) : undefined;

  // 3. Ship to CapSolver.
  const solution = await solveTikTokCaptcha({
    websiteURL: page.url(),
    bodyImage,
    pieceImage,
  });

  // Log the solution so we can debug wrong angles / coordinates.
  console.log(`[tiktok-captcha] CapSolver returned: ${JSON.stringify(solution)}`);
  await snapshot("captcha-before-drag");

  // 4. Apply the solution. Slider = drag the piece `x` px right. Whirl = drag
  //    the rotation handle proportional to `angle`. Shape = click points.
  if (solution.type === "slider") {
    // Find the draggable slider handle.
    const handle = page
      .locator('[class*="drag"], [class*="slider"][draggable], .secsdk-captcha-drag-icon')
      .first();
    const box = await handle.boundingBox();
    if (!box) throw new Error("Could not locate slider handle bounding box");

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const targetX = startX + solution.solution.x;

    // Human-like drag with jitter — move in small steps rather than a single
    // mouse.move, which TikTok's detection flags as bot-like.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const jitter = (Math.random() - 0.5) * 4;
      await page.mouse.move(startX + (targetX - startX) * progress, startY + jitter, { steps: 1 });
      await page.waitForTimeout(15 + Math.random() * 15);
    }
    await page.mouse.up();
  } else if (solution.type === "whirl") {
    // Whirl uses the same drag slider but driven by angle → x displacement.
    // Most TikTok whirl widgets have a fixed track width of ~300px for 360°.
    const pxPerDegree = 300 / 360;
    const handle = page
      .locator('[class*="drag"], .secsdk-captcha-drag-icon')
      .first();
    const box = await handle.boundingBox();
    if (!box) throw new Error("Could not locate whirl handle bounding box");

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const targetX = startX + solution.solution.angle * pxPerDegree;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const steps = 25;
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      await page.mouse.move(startX + (targetX - startX) * progress, startY, { steps: 1 });
      await page.waitForTimeout(20 + Math.random() * 20);
    }
    await page.mouse.up();
  } else if (solution.type === "shape") {
    // Shape-select: click each point in turn.
    const root = await container.boundingBox();
    if (!root) throw new Error("Could not locate shape captcha bounding box");
    for (const pt of solution.solution.points) {
      await page.mouse.click(root.x + pt.x, root.y + pt.y);
      await page.waitForTimeout(200);
    }
  }

  // 5. Wait a beat for the page to accept the solution.
  await page.waitForTimeout(2000);
  await snapshot("captcha-after-drag");
}

/**
 * Drive TikTok's "Verify it's really you" flow end-to-end:
 *   1. Click the Email option in the modal
 *   2. TikTok sends a numeric code to the bind inbox
 *   3. Poll the inbox via IMAP until the code arrives
 *   4. Paste it into TikTok's code input and submit
 *
 * Throws on any failure (including IMAP connect/auth, timeout, unexpected UI).
 */
async function solveDeviceVerification(
  page: any,
  req: TikTokLoginRequest,
  snapshot: (tag: string) => Promise<any>
): Promise<void> {
  // 1. Click the Email verification option. TikTok renders it as a clickable
  //    card row containing the text "Email" plus a redacted email address
  //    (e.g. "s***d@rambler.ru"). We locate a container that has BOTH pieces
  //    of text and click it — this is robust across UI variants.
  //
  //    Fallback chain: strict row match → button/role match → plain "Email"
  //    text click (which usually bubbles to the handler). Each step tries a
  //    less specific locator if the previous one didn't resolve.
  const attempts: Array<() => Promise<void>> = [
    // Preferred: a container with the "Email" label AND an email address visible.
    async () => {
      await page
        .locator('div:has(> span:text-is("Email")):has-text("@"), div:has(> div:text-is("Email")):has-text("@")')
        .first()
        .click({ timeout: 5000 });
    },
    // Next: any clickable element containing "Email" + "@".
    async () => {
      await page
        .locator('button, div[role="button"], [tabindex="0"]')
        .filter({ hasText: /Email/ })
        .filter({ hasText: /@/ })
        .first()
        .click({ timeout: 5000 });
    },
    // Next: the literal "Email" text — Playwright will bubble the click to
    // the ancestor handler that TikTok attached.
    async () => {
      await page.locator('text=/^Email$/').first().click({ timeout: 5000 });
    },
    // Last-ditch: click anything that says "Email" (not exact match).
    async () => {
      await page.getByText(/Email/i).first().click({ timeout: 5000 });
    },
  ];

  let clicked = false;
  for (const attempt of attempts) {
    try { await attempt(); clicked = true; break; } catch { /* try next */ }
  }
  if (!clicked) {
    const diag = await snapshot("email-option-not-found");
    throw new Error(`Could not click Email verification option — TikTok UI variant not recognised. See screenshot at ${diag.screenshot_path}`);
  }

  // 2. TikTok shows a "Send code" / "Get code" button on the next screen. Click
  //    it so the email actually gets dispatched. Some variants auto-send on
  //    entering the screen — skip gracefully if the button isn't there.
  await page.waitForTimeout(500);
  const sendButton = page
    .locator('button:has-text("Send code"), button:has-text("Get code"), button:has-text("Resend")')
    .first();
  await sendButton.click({ timeout: 3000 }).catch(() => { /* auto-sent */ });

  await page.waitForTimeout(1500);
  await snapshot("verification-code-sent");

  // Check for "Send code failed" — TikTok refusing to dispatch the email
  // because this account/IP has been flagged for suspicious activity or
  // hit an internal rate cap. No point polling IMAP if no email is coming.
  const sendFailed = await page
    .locator('text=/Send code failed|Failed to send|Too many requests|try again later/i')
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (sendFailed) {
    const diag = await snapshot("send-code-failed");
    throw new Error(`TikTok refused to send the verification email ("Send code failed"). Account is likely flagged from prior failed attempts — wait several hours or try a fresh account. Diag: ${diag.screenshot_path}`);
  }

  // 3. Poll the inbox for the code. Use the TikTok sender filter so we don't
  //    pick up unrelated mail that happens to contain digit sequences.
  //    Timeout 3 min — most mail arrives in 10-60s, but Russian providers
  //    can be slow on spike hours. Retries are handled inside fetchVerificationCode.
  const codeResult = await fetchVerificationCode({
    email: req.email!,
    password: req.email_password!,
    minDigits: 4,
    maxDigits: 8,
    fromContains: "tiktok",
    timeoutMs: 180 * 1000,
    pollIntervalMs: 4000,
  });

  if (!codeResult.success || !codeResult.code) {
    throw new Error(codeResult.error || "Could not retrieve verification code from email");
  }

  // 4. Enter the code. TikTok renders this as a single text input with a
  //    placeholder like "Enter 6-digit code". Some older variants used a
  //    multi-cell layout — handle both for resilience.
  //
  //    Wait up to 8s for the input to render — TikTok shows a loading
  //    spinner while it's dispatching the email, and the input only appears
  //    once the "Send code" call completes.
  const singleInputSelectors = [
    'input[placeholder*="digit" i]',
    'input[placeholder*="code" i]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]:not([name="username"]):not([name="password"])',
    'input[name="captcha_code"]',
  ].join(", ");

  const singleInput = page.locator(singleInputSelectors).first();
  const singleVisible = await singleInput
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (singleVisible) {
    await singleInput.click();
    await singleInput.press("Control+A");
    await singleInput.press("Delete");
    await singleInput.pressSequentially(codeResult.code, { delay: 80 });
  } else {
    // Multi-cell fallback.
    const cells = page.locator('input[maxlength="1"][inputmode="numeric"]');
    const count = await cells.count();
    if (count < codeResult.code.length) {
      throw new Error(`Could not find verification code input — neither single-input nor multi-cell layout matched (found 0 cells, expected selector for single input: "${singleInputSelectors}")`);
    }
    for (let i = 0; i < codeResult.code.length; i++) {
      await cells.nth(i).fill(codeResult.code[i]);
      await page.waitForTimeout(50 + Math.random() * 80);
    }
  }

  // Brief pause — TikTok's React re-renders + enables the submit button
  // after receiving input events.
  await page.waitForTimeout(500);

  // 5. Submit. The "Next" button enables once the 6-digit code is fully
  //    entered; poll for it to be enabled before clicking.
  const submitBtn = page
    .locator('button:has-text("Next"), button:has-text("Submit"), button:has-text("Verify"), button:has-text("Confirm"), button[type="submit"]:not([data-e2e="login-button"])')
    .first();

  try {
    await submitBtn.waitFor({ state: "visible", timeout: 5000 });
    // Poll for the disabled attribute to clear (up to 5s).
    const enableStart = Date.now();
    while (Date.now() - enableStart < 5000) {
      const disabled = await submitBtn.getAttribute("disabled").catch(() => null);
      if (disabled === null) break;
      await page.waitForTimeout(200);
    }
    await submitBtn.click({ timeout: 5000 });
  } catch {
    /* auto-submitted or locator changed — let the outer auth check decide */
  }
}
