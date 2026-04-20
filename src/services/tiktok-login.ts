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
import { getStealthChromium, buildProxyConfig } from "./social-runtime";
import { solveTikTokCaptcha, isCaptchaSolverConfigured } from "./captcha-solver";

type Browser = any;

export interface TikTokLoginRequest {
  account_id: string;
  /** Overrides account_id when pinning the proxy session. Preserves IP lineage across pool handoff. */
  proxy_session_id?: string;
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
    | "SMS_VERIFICATION_REQUIRED"
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
  const hasCookies = Boolean(req.sessionid);
  const hasFormCreds = Boolean(req.login && req.password);

  if (!hasCookies && !hasFormCreds) {
    return {
      success: false,
      error: "Provide either { sessionid } for cookie-injection login, or { login, password } for form login.",
      error_code: "MISSING_CREDENTIALS",
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

    // ── Form-login path ───────────────────────────────────────────────
    // Fill username + password, submit, handle captcha via CapSolver.
    if (!hasCookies) {
      try {
        // TikTok's email-login page renders an email + password input pair.
        // The selectors below have been stable since early 2025.
        const emailInput = page.locator('input[name="username"], input[type="text"]').first();
        await emailInput.waitFor({ state: "visible", timeout: 20000 });
        await emailInput.click();
        await emailInput.fill(req.login!);

        const passwordInput = page.locator('input[type="password"]').first();
        await passwordInput.waitFor({ state: "visible", timeout: 10000 });
        await passwordInput.click();
        await passwordInput.fill(req.password!);

        await page.waitForTimeout(400);

        const loginButton = page
          .locator('button[data-e2e="login-button"], button[type="submit"]')
          .first();
        await loginButton.click({ timeout: 8000 });
      } catch (e: any) {
        const diag = await snapshot("form-fill-failed");
        return {
          success: false,
          error: `Could not fill / submit login form: ${e.message}`,
          error_code: "LOGIN_FAILED",
          diagnostics: diag,
        };
      }

      // After submit we can land in one of three places:
      //   a) Captcha — handle via CapSolver below
      //   b) SMS verification page — bail out, not auto-solvable
      //   c) Home feed — success, no captcha was needed
      //
      // We check for captcha first because it's the most common gate.
      try {
        await Promise.race([
          page.locator('[id*="captcha"], [class*="captcha-verify"], iframe[src*="captcha"]').first().waitFor({ state: "visible", timeout: 8000 }),
          page.locator('text=/verification code|check your email|SMS/i').first().waitFor({ state: "visible", timeout: 8000 }),
          page.locator('[data-e2e="profile-icon"], [data-e2e="upload-icon"]').first().waitFor({ state: "visible", timeout: 8000 }),
          page.locator('text=/incorrect|does not match|wrong password|Maximum number of attempts/i').first().waitFor({ state: "visible", timeout: 8000 }),
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

      // SMS / email code challenge.
      const codeChallenge = await page
        .locator('text=/Enter the verification code|verification code|check your email/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (codeChallenge) {
        const diag = await snapshot("sms-verification");
        return {
          success: false,
          error: "TikTok requested an SMS / email verification code. That code lives in the account's email — you need to retrieve it manually once before this account can be automated.",
          error_code: "SMS_VERIFICATION_REQUIRED",
          diagnostics: diag,
        };
      }

      // Captcha gate.
      const captchaElement = page.locator('[id*="captcha"], [class*="captcha-verify"], iframe[src*="captcha"]').first();
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
  // 1. Find the captcha container. TikTok uses different wrappers over time;
  //    try the known ones in order.
  const container = page
    .locator('[id^="captcha_container"], [class*="captcha-verify-container"], .captcha_verify_container')
    .first();

  await container.waitFor({ state: "visible", timeout: 10000 });

  // 2. Extract the two images. `bodyImage` = background, `pieceImage` = the
  //    moving slider piece. For whirl captchas the piece image may be null.
  const images: { body?: string; piece?: string } = await page.evaluate(
    `(() => {
      const root = document.querySelector('[id^="captcha_container"], [class*="captcha-verify-container"], .captcha_verify_container');
      if (!root) return {};
      const imgs = root.querySelectorAll('img');
      const out = {};
      if (imgs[0]) out.body = imgs[0].src;
      if (imgs[1]) out.piece = imgs[1].src;
      return out;
    })()`
  );

  if (!images.body) {
    throw new Error("Could not extract captcha background image from DOM");
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
  await page.waitForTimeout(1500);
}
