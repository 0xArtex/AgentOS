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

/* ─── delete: delete one of your own tweets by URL ────────────────────── */

export async function deleteTweet(
  req: OpRequest & { tweet_url: string }
): Promise<OpResult> {
  if (!req.tweet_url || !/\/status\/\d+/.test(req.tweet_url)) {
    return { success: false, error: "tweet_url must be a full X tweet URL", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({ accountId: req.account_id, cookies: req.cookies });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(req.tweet_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // Open the "..." menu on the tweet
    const caretButton = page.locator('[data-testid="caret"]:visible').first();
    await caretButton.waitFor({ state: "visible", timeout: 20000 });
    await caretButton.click({ timeout: 5000 });

    // Click Delete in the dropdown
    const deleteMenuItem = page
      .locator('[data-testid="Dropdown"] [role="menuitem"]:has-text("Delete"):visible, [role="menuitem"]:has-text("Delete"):visible')
      .first();
    await deleteMenuItem.waitFor({ state: "visible", timeout: 10000 });
    await deleteMenuItem.click({ timeout: 5000 });

    // Confirm in the modal
    const confirmButton = page.locator('[data-testid="confirmationSheetConfirm"]:visible').first();
    await confirmButton.waitFor({ state: "visible", timeout: 10000 });

    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await confirmButton.click({ timeout: 5000 }); },
      /\/DeleteTweet/
    );

    if (!apiResult) {
      const shot = await debugShot(page, "delete-no-api-call");
      return {
        success: false,
        error: `No DeleteTweet API call observed. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (!apiResult.ok) {
      return {
        success: false,
        error: `X rejected the delete: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
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

/* ─── unfollow: stop following a user ──────────────────────────────────── */

export async function unfollowUser(
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
    session = await openAuthenticatedSession({ accountId: req.account_id, cookies: req.cookies });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    const notFollowing = await page
      .locator('[data-testid$="-follow"]:visible')
      .first()
      .isVisible()
      .catch(() => false);
    if (notFollowing) {
      return { success: true, data: { already_not_following: true } };
    }

    const unfollowButton = page.locator('[data-testid$="-unfollow"]:visible').first();
    await unfollowButton.waitFor({ state: "visible", timeout: 20000 });

    // X may or may not show a confirmation modal depending on viewport /
    // account state. Set up API interception before the first click so we
    // catch the request whether it fires from the button OR the modal
    // confirm. Regex is broad because X's unfollow endpoint lives on legacy
    // v1.1 (friendships/destroy) on most accounts but sometimes routes via
    // different GraphQL operation names.
    const responsePromise = page
      .waitForResponse(
        (resp: any) =>
          /friendships\/destroy|UnfollowUser|DisconnectUser|SubscribeUser/.test(resp.url()) &&
          resp.request().method() === "POST",
        { timeout: 25000 }
      )
      .catch(() => null);

    await unfollowButton.click({ timeout: 5000 });

    // Optional confirmation modal — handle if it appears within 3s.
    let modalAppeared = false;
    try {
      const confirmButton = page.locator('[data-testid="confirmationSheetConfirm"]:visible').first();
      await confirmButton.waitFor({ state: "visible", timeout: 3000 });
      modalAppeared = true;
      await confirmButton.click({ timeout: 5000 });
    } catch {
      // No modal — the initial click fired the API directly (or nothing happened).
    }

    // Take a diagnostic screenshot ~1s after the final click so if the API
    // never fires, we can see what X actually rendered.
    setTimeout(() => { debugShot(page, `unfollow-post-click-modal-${modalAppeared}`); }, 1500);

    const resp = await responsePromise;
    const apiResult = resp
      ? await (async () => {
          const status = resp.status();
          let json: any = null;
          try { json = await resp.json(); } catch { try { json = { raw: await resp.text() }; } catch {} }
          const errors = json?.errors;
          const errorMessage = Array.isArray(errors) && errors[0]?.message ? errors[0].message : undefined;
          const errorCode = Array.isArray(errors) && errors[0]?.code ? errors[0].code : undefined;
          return { ok: resp.ok() && !errorMessage, status, json, errorMessage, errorCode };
        })()
      : null;

    if (!apiResult) {
      const shot = await debugShot(page, "unfollow-no-api-call");
      return {
        success: false,
        error: `No unfollow API call observed. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (!apiResult.ok) {
      return {
        success: false,
        error: `X rejected the unfollow: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
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

/* ─── updateProfile: change bio / display name / location / website ────── */

export async function updateProfile(
  req: OpRequest & {
    bio?: string;
    display_name?: string;
    location?: string;
    website?: string;
  }
): Promise<OpResult> {
  const fields: Array<[string, string | undefined]> = [
    ["bio", req.bio],
    ["display_name", req.display_name],
    ["location", req.location],
    ["website", req.website],
  ];
  const provided = fields.filter(([, v]) => v !== undefined);
  if (provided.length === 0) {
    return { success: false, error: "At least one of bio/display_name/location/website is required", error_code: "INVALID_INPUT" };
  }
  if (req.bio !== undefined && req.bio.length > 160) {
    return { success: false, error: `bio exceeds 160 chars (got ${req.bio.length})`, error_code: "INVALID_INPUT" };
  }
  if (req.display_name !== undefined && (req.display_name.length === 0 || req.display_name.length > 50)) {
    return { success: false, error: "display_name must be 1-50 chars", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({ accountId: req.account_id, cookies: req.cookies });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    // Navigate to own profile — X routes to the logged-in user's page.
    await page.goto("https://x.com/settings/profile", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(async () => {
      // Fallback path: go to home then click profile link
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    });

    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // Ensure we're in the profile editor modal. X lazy-loads the settings UI
    // through a modal on some viewports and a full page on others. We look for
    // a known field on either.
    await page
      .locator('input[name="displayName"], [data-testid="UserName-edit"], [name="description"]')
      .first()
      .waitFor({ state: "visible", timeout: 20000 })
      .catch(() => {});

    if (req.display_name !== undefined) {
      const nameInput = page.locator('input[name="displayName"]:visible, input[data-testid="UserName-edit"]:visible').first();
      await nameInput.waitFor({ state: "visible", timeout: 10000 });
      await nameInput.click();
      await nameInput.press("Control+A");
      await nameInput.press("Delete");
      await nameInput.pressSequentially(req.display_name, { delay: 25 });
    }

    if (req.bio !== undefined) {
      const bioInput = page.locator('textarea[name="description"]:visible, [data-testid="UserDescription-edit"]:visible').first();
      await bioInput.waitFor({ state: "visible", timeout: 10000 });
      await bioInput.click();
      await bioInput.press("Control+A");
      await bioInput.press("Delete");
      await bioInput.pressSequentially(req.bio, { delay: 25 });
    }

    if (req.location !== undefined) {
      const locInput = page.locator('input[name="location"]:visible').first();
      await locInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await locInput.click();
      await locInput.press("Control+A");
      await locInput.press("Delete");
      await locInput.pressSequentially(req.location, { delay: 25 });
    }

    if (req.website !== undefined) {
      const urlInput = page.locator('input[name="url"]:visible').first();
      await urlInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await urlInput.click();
      await urlInput.press("Control+A");
      await urlInput.press("Delete");
      await urlInput.pressSequentially(req.website, { delay: 25 });
    }

    // Save
    const saveButton = page
      .locator(
        '[data-testid="Profile_Save_Button"]:visible, ' +
        'button:has-text("Save"):visible'
      )
      .first();
    await saveButton.waitFor({ state: "visible", timeout: 10000 });

    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await saveButton.click({ timeout: 5000 }); },
      /\/UpdateProfile|account\/update_profile/
    );

    if (!apiResult) {
      const shot = await debugShot(page, "profile-no-api-call");
      return {
        success: false,
        error: `No profile update API call observed. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (!apiResult.ok) {
      return {
        success: false,
        error: `X rejected profile update: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
        error_code: mapXError(apiResult.status, apiResult.errorCode),
      };
    }

    return {
      success: true,
      data: Object.fromEntries(provided),
    };
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
