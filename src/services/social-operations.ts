/**
 * Authenticated X/Twitter operations executed server-side through the
 * per-account residential proxy. Each operation:
 *
 *   1. Opens a stealth Chromium session with the cached cookies
 *   2. Navigates to the relevant X URL
 *   3. Performs the UI flow (click compose, type, submit)
 *   4. Closes the browser and returns a result
 *
 * Phase 2 scope: post, reply, like, retweet, follow. Bio / name / pfp /
 * banner come in a follow-up since they need the profile settings UI.
 */
import { openAuthenticatedSession, isSessionExpiredUrl } from "./social-runtime";

async function debugShot(page: any, tag: string): Promise<string | undefined> {
  try {
    const fs = await import("fs");
    const dir = "/tmp/agentos-social-shots";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const shotPath = `${dir}/${tag}-${Date.now()}.png`;
    await page.screenshot({ path: shotPath, fullPage: true });
    return shotPath;
  } catch {
    return undefined;
  }
}

/**
 * Intercept X's network response for a specific operation while we trigger it
 * via a UI click. Waits up to `timeoutMs` for a POST to a URL matching the
 * given pattern. Returns the parsed JSON body and status code, plus any X
 * error payload extracted from `.errors`.
 */
interface ApiResult {
  ok: boolean;
  status: number;
  json: any;
  errorMessage?: string;
  errorCode?: number;
}

async function submitAndAwaitXApi(
  page: any,
  trigger: () => Promise<void>,
  urlPattern: RegExp,
  timeoutMs: number = 25000
): Promise<ApiResult | null> {
  const responsePromise = page
    .waitForResponse(
      (resp: any) => urlPattern.test(resp.url()) && resp.request().method() === "POST",
      { timeout: timeoutMs }
    )
    .catch(() => null);

  await trigger();

  const resp = await responsePromise;
  if (!resp) return null;

  const status = resp.status();
  let json: any = null;
  try {
    json = await resp.json();
  } catch {
    try {
      const text = await resp.text();
      json = { raw: text };
    } catch {
      json = null;
    }
  }

  const errors = json?.errors;
  const errorMessage = Array.isArray(errors) && errors[0]?.message ? errors[0].message : undefined;
  const errorCode = Array.isArray(errors) && errors[0]?.code ? errors[0].code : undefined;

  return {
    ok: resp.ok() && !errorMessage,
    status,
    json,
    errorMessage,
    errorCode,
  };
}

/**
 * Map X's standard error codes to our error_code enum.
 * https://developer.x.com/en/docs/authentication/api-reference/error-codes
 */
function mapXError(status: number, xCode?: number): "SESSION_EXPIRED" | "RATE_LIMITED" | "NOT_FOUND" | "INVALID_INPUT" | "UNKNOWN" {
  if (status === 401 || status === 403 || xCode === 64 || xCode === 89) return "SESSION_EXPIRED";
  if (status === 429 || xCode === 88 || xCode === 226) return "RATE_LIMITED";
  if (status === 404 || xCode === 34 || xCode === 17) return "NOT_FOUND";
  if (xCode === 170 || xCode === 187) return "INVALID_INPUT";
  return "UNKNOWN";
}

export interface OpResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  error_code?:
    | "SESSION_EXPIRED"
    | "RATE_LIMITED"
    | "NOT_FOUND"
    | "INVALID_INPUT"
    | "UI_TIMEOUT"
    | "LAUNCH_FAILED"
    | "UNKNOWN";
}

export interface OpRequest {
  account_id: string;
  cookies: any[];
}

/* ─── post: publish a tweet from the home feed compose box ────────────── */

export async function postTweet(
  req: OpRequest & { text: string }
): Promise<OpResult<{ tweet_url?: string; tweet_id?: string; x_error_code?: number; x_http_status?: number }>> {
  if (!req.text || !req.text.trim()) {
    return { success: false, error: "text is required", error_code: "INVALID_INPUT" };
  }
  if (req.text.length > 280) {
    return {
      success: false,
      error: `Tweet text exceeds 280 characters (got ${req.text.length})`,
      error_code: "INVALID_INPUT",
    };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      cookies: req.cookies,
    });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    const textarea = page
      .locator('[data-testid="tweetTextarea_0"]:visible')
      .first();
    await textarea.waitFor({ state: "visible", timeout: 20000 });
    await textarea.click();
    await textarea.pressSequentially(req.text, { delay: 30 });
    await page.waitForTimeout(800);

    const postButton = page
      .locator(
        '[data-testid="tweetButtonInline"]:not([aria-disabled="true"]):visible, ' +
        '[data-testid="tweetButton"]:not([aria-disabled="true"]):visible'
      )
      .first();

    let buttonReady = true;
    try {
      await postButton.waitFor({ state: "visible", timeout: 10000 });
    } catch {
      buttonReady = false;
    }

    if (!buttonReady) {
      const shot = await debugShot(page, "post-button-not-visible");
      return {
        success: false,
        error: `Post button never became enabled. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    // Click the button AND intercept the CreateTweet API response atomically.
    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await postButton.click({ timeout: 5000 }); },
      /\/CreateTweet/
    );

    if (!apiResult) {
      const shot = await debugShot(page, "post-no-api-call");
      return {
        success: false,
        error: `No CreateTweet API call observed after click. X likely blocked the submit. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (!apiResult.ok) {
      return {
        success: false,
        error: `X rejected the tweet: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
        error_code: mapXError(apiResult.status, apiResult.errorCode),
        data: { x_error_code: apiResult.errorCode, x_http_status: apiResult.status },
      };
    }

    const tweetId: string | undefined = apiResult.json?.data?.create_tweet?.tweet_results?.result?.rest_id;
    if (!tweetId) {
      return {
        success: false,
        error: "CreateTweet returned 200 but no tweet ID in response — ambiguous state.",
        error_code: "UNKNOWN",
        data: apiResult.json,
      };
    }

    return {
      success: true,
      data: {
        tweet_id: tweetId,
        tweet_url: `https://x.com/i/web/status/${tweetId}`,
      },
    };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UI_TIMEOUT" };
  } finally {
    await close();
  }
}

/* ─── reply: reply to a specific tweet by URL ─────────────────────────── */

export async function replyToTweet(
  req: OpRequest & { tweet_url: string; text: string }
): Promise<OpResult> {
  if (!req.tweet_url || !/\/status\/\d+/.test(req.tweet_url)) {
    return { success: false, error: "tweet_url must be a full X tweet URL", error_code: "INVALID_INPUT" };
  }
  if (!req.text || req.text.length > 280) {
    return { success: false, error: "text is required and must be <= 280 chars", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      cookies: req.cookies,
    });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(req.tweet_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    const replyBox = page.locator('[data-testid="tweetTextarea_0"]:visible').first();
    await replyBox.waitFor({ state: "visible", timeout: 20000 });
    await replyBox.click();
    await replyBox.pressSequentially(req.text, { delay: 30 });
    await page.waitForTimeout(800);

    const replyButton = page
      .locator(
        '[data-testid="tweetButtonInline"]:not([aria-disabled="true"]):visible, ' +
        '[data-testid="tweetButton"]:not([aria-disabled="true"]):visible'
      )
      .first();

    let buttonReady = true;
    try {
      await replyButton.waitFor({ state: "visible", timeout: 10000 });
    } catch {
      buttonReady = false;
    }

    if (!buttonReady) {
      const shot = await debugShot(page, "reply-button-not-visible");
      return {
        success: false,
        error: `Reply button never became enabled. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await replyButton.click({ timeout: 5000 }); },
      /\/CreateTweet/
    );

    if (!apiResult) {
      const shot = await debugShot(page, "reply-no-api-call");
      return {
        success: false,
        error: `No CreateTweet API call observed after click. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (!apiResult.ok) {
      return {
        success: false,
        error: `X rejected the reply: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
        error_code: mapXError(apiResult.status, apiResult.errorCode),
        data: { x_error_code: apiResult.errorCode, x_http_status: apiResult.status },
      };
    }

    const tweetId: string | undefined = apiResult.json?.data?.create_tweet?.tweet_results?.result?.rest_id;
    return {
      success: true,
      data: tweetId ? {
        tweet_id: tweetId,
        tweet_url: `https://x.com/i/web/status/${tweetId}`,
      } : {},
    };
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "UI_TIMEOUT" };
  } finally {
    await close();
  }
}

/* ─── like: like a tweet by URL ───────────────────────────────────────── */

export async function likeTweet(
  req: OpRequest & { tweet_url: string }
): Promise<OpResult> {
  if (!req.tweet_url || !/\/status\/\d+/.test(req.tweet_url)) {
    return { success: false, error: "tweet_url must be a full X tweet URL", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      cookies: req.cookies,
    });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(req.tweet_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    const likeButton = page.locator('[data-testid="like"]:visible, [data-testid="unlike"]:visible').first();
    await likeButton.waitFor({ state: "visible", timeout: 20000 });

    // Already liked? data-testid="unlike" appears when it's already liked.
    const alreadyLiked = await page
      .locator('[data-testid="unlike"]:visible')
      .first()
      .isVisible()
      .catch(() => false);
    if (alreadyLiked) {
      return { success: true, data: { already_liked: true } };
    }

    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await likeButton.click({ timeout: 5000 }); },
      /\/FavoriteTweet/
    );

    if (!apiResult) {
      const shot = await debugShot(page, "like-no-api-call");
      return {
        success: false,
        error: `No FavoriteTweet API call observed. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (!apiResult.ok) {
      return {
        success: false,
        error: `X rejected the like: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
        error_code: mapXError(apiResult.status, apiResult.errorCode),
      };
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "UI_TIMEOUT" };
  } finally {
    await close();
  }
}

/* ─── retweet: retweet a tweet by URL ─────────────────────────────────── */

export async function retweetTweet(
  req: OpRequest & { tweet_url: string }
): Promise<OpResult> {
  if (!req.tweet_url || !/\/status\/\d+/.test(req.tweet_url)) {
    return { success: false, error: "tweet_url must be a full X tweet URL", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      cookies: req.cookies,
    });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(req.tweet_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    const retweetButton = page.locator('[data-testid="retweet"]:visible, [data-testid="unretweet"]:visible').first();
    await retweetButton.waitFor({ state: "visible", timeout: 20000 });

    const alreadyRetweeted = await page
      .locator('[data-testid="unretweet"]:visible')
      .first()
      .isVisible()
      .catch(() => false);
    if (alreadyRetweeted) {
      return { success: true, data: { already_retweeted: true } };
    }

    await retweetButton.click({ timeout: 5000 });
    const confirmButton = page.locator('[data-testid="retweetConfirm"]:visible').first();
    await confirmButton.waitFor({ state: "visible", timeout: 10000 });

    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await confirmButton.click({ timeout: 5000 }); },
      /\/CreateRetweet/
    );

    if (!apiResult) {
      const shot = await debugShot(page, "retweet-no-api-call");
      return {
        success: false,
        error: `No CreateRetweet API call observed. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (!apiResult.ok) {
      return {
        success: false,
        error: `X rejected the retweet: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
        error_code: mapXError(apiResult.status, apiResult.errorCode),
      };
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "UI_TIMEOUT" };
  } finally {
    await close();
  }
}

/* ─── follow: follow another user by handle ───────────────────────────── */

export async function followUser(
  req: OpRequest & { target_user: string }
): Promise<OpResult> {
  if (!req.target_user) {
    return { success: false, error: "target_user is required", error_code: "INVALID_INPUT" };
  }
  const handle = req.target_user.replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return { success: false, error: `Invalid handle: ${handle}`, error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      cookies: req.cookies,
    });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // If already following, the button will be "unfollow"
    const alreadyFollowing = await page
      .locator('[data-testid$="-unfollow"]:visible')
      .first()
      .isVisible()
      .catch(() => false);
    if (alreadyFollowing) {
      return { success: true, data: { already_following: true } };
    }

    const followButton = page.locator('[data-testid$="-follow"]:visible').first();
    await followButton.waitFor({ state: "visible", timeout: 20000 });

    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await followButton.click({ timeout: 5000 }); },
      /\/friendships\/create|\/FollowUser/
    );

    if (!apiResult) {
      const shot = await debugShot(page, "follow-no-api-call");
      return {
        success: false,
        error: `No friendships/create API call observed. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (!apiResult.ok) {
      return {
        success: false,
        error: `X rejected the follow: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
        error_code: mapXError(apiResult.status, apiResult.errorCode),
      };
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "UI_TIMEOUT" };
  } finally {
    await close();
  }
}
