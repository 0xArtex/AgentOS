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
import { fetchSsrfSafe } from "./email";
import { randomUUID } from "crypto";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

interface ImageInput {
  image_base64?: string;   // raw base64 or data: URL
  image_url?: string;       // https URL — server fetches
}

/**
 * Materialise an image from either base64 or a URL into a temp file path
 * the server-side browser can upload. Returns the path + a cleanup fn.
 */
async function materializeImage(
  input: ImageInput
): Promise<{ filePath: string; cleanup: () => void }> {
  if (!input.image_base64 && !input.image_url) {
    throw new Error("image_base64 or image_url is required");
  }

  const fs = await import("fs");
  const path = await import("path");

  const dir = "/tmp/agentos-uploads";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let buf: Buffer;
  let ext = "png";

  if (input.image_base64) {
    const dataUrlMatch = input.image_base64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (dataUrlMatch) {
      ext = dataUrlMatch[1].toLowerCase();
      buf = Buffer.from(dataUrlMatch[2], "base64");
    } else {
      buf = Buffer.from(input.image_base64, "base64");
    }
  } else {
    // SSRF-safe fetch: rejects private IPs, follows redirects manually,
    // re-validates each hop. See src/services/email.ts:fetchSsrfSafe.
    const resp = await fetchSsrfSafe(input.image_url!, { timeoutMs: 30000, maxBytes: MAX_IMAGE_BYTES });
    if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
    const contentType = resp.headers.get("content-type") || "";
    if (!/^image\//.test(contentType)) {
      throw new Error(`URL did not return an image (content-type: ${contentType})`);
    }
    ext = contentType.split("/")[1]?.split(";")[0]?.toLowerCase() || "png";
    const arrayBuf = await resp.arrayBuffer();
    buf = Buffer.from(arrayBuf);
  }

  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${buf.length} bytes, max ${MAX_IMAGE_BYTES})`);
  }

  // Whitelist extensions X accepts
  if (!["png", "jpeg", "jpg", "webp", "gif"].includes(ext)) ext = "png";

  const filePath = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(filePath, buf);

  const cleanup = () => {
    try { fs.unlinkSync(filePath); } catch { /* noop */ }
  };

  return { filePath, cleanup };
}

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
  /** Portable IP-lineage key. Overrides account_id for proxy session. */
  proxy_session_id?: string;
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
      proxySessionId: req.proxy_session_id,
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
      proxySessionId: req.proxy_session_id,
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
      proxySessionId: req.proxy_session_id,
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
      proxySessionId: req.proxy_session_id,
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
    session = await openAuthenticatedSession({ accountId: req.account_id, proxySessionId: req.proxy_session_id, cookies: req.cookies });
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

/* ─── listMyTweets: list the agent's own recent tweets ───────────────── */

interface ListedTweet {
  tweet_url: string;
  tweet_id: string;
  posted_at: string;
  text: string;
}

export async function listMyTweets(
  req: OpRequest & { limit?: number }
): Promise<OpResult<{ tweets: ListedTweet[] }>> {
  // Clamp limit to [1, 50] with default 20.
  const requestedLimit = typeof req.limit === "number" && Number.isFinite(req.limit) ? req.limit : 20;
  const limit = Math.max(1, Math.min(50, Math.floor(requestedLimit)));

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
    });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    // Resolve the logged-in user's handle. X redirects bare /home → settings if
    // unauth; for an authenticated session it lands on the home feed and the
    // sidebar profile link points to /<handle>. Reading from the feed avoids a
    // dependency on the request body knowing the handle.
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // The "Profile" sidebar link (data-testid="AppTabBar_Profile_Link") has
    // href="/<handle>". Wait for it before reading.
    const profileLink = page.locator('[data-testid="AppTabBar_Profile_Link"]').first();
    await profileLink.waitFor({ state: "attached", timeout: 20000 });
    const profileHref = await profileLink.getAttribute("href").catch(() => null);
    const handle = profileHref?.replace(/^\//, "").trim();
    if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      const shot = await debugShot(page, "list-my-tweets-no-handle");
      return {
        success: false,
        error: `Could not resolve logged-in handle from sidebar (got: ${profileHref}). Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    // Navigate to the user's own profile timeline.
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // Wait for at least one tweet card to render.
    const firstTweet = page.locator('article[data-testid="tweet"]').first();
    try {
      await firstTweet.waitFor({ state: "visible", timeout: 20000 });
    } catch {
      const shot = await debugShot(page, "list-my-tweets-empty");
      return {
        success: false,
        error: `No tweets visible on @${handle}'s profile. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    // Scroll-and-collect loop. We accumulate by tweet_id (dedupe) until we
    // have `limit` own original tweets or the timeline stops growing.
    const collected = new Map<string, ListedTweet>();
    const handleLower = handle.toLowerCase();
    const maxScrolls = 30; // Hard cap so we never scroll forever.
    let stagnantRounds = 0;

    // Page-context evaluator: runs in Chromium so `document`/`window` exist
    // there. Built as a self-invoking expression (IIFE) so `page.evaluate(str)`
    // evaluates it as a CALL and returns the array; passing a function-literal
    // string + a second argument doesn't work — Playwright treats string-form
    // as an expression and ignores extra args, so we inline `handleLower`.
    const evalScript = `(() => {
      const selfHandleLower = ${JSON.stringify(handleLower)};
      const out = [];
      const cards = document.querySelectorAll('article[data-testid="tweet"]');
      for (const card of Array.from(cards)) {
        const links = card.querySelectorAll('a[href*="/status/"]');
        let tweet_id = "";
        let permalinkHandle = "";
        for (const a of Array.from(links)) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/^\\/([A-Za-z0-9_]+)\\/status\\/(\\d+)/);
          if (m) {
            permalinkHandle = m[1];
            tweet_id = m[2];
            break;
          }
        }
        if (!tweet_id || !permalinkHandle) continue;

        const socialContext = card.querySelector('[data-testid="socialContext"]');
        const socialText = (socialContext && socialContext.textContent || "").toLowerCase();
        const is_retweet = socialText.indexOf("repost") !== -1 || socialText.indexOf("retweet") !== -1;
        const is_pinned = socialText.indexOf("pinned") !== -1;
        const is_reply_to_other = permalinkHandle.toLowerCase() !== selfHandleLower;

        const timeEl = card.querySelector("time");
        const posted_at = (timeEl && timeEl.getAttribute("datetime")) || "";

        const textEl = card.querySelector('[data-testid="tweetText"]');
        const text = ((textEl && textEl.textContent) || "").trim();

        out.push({
          tweet_url: "https://x.com/" + permalinkHandle + "/status/" + tweet_id,
          tweet_id: tweet_id,
          posted_at: posted_at,
          text: text,
          is_pinned: is_pinned,
          is_retweet: is_retweet,
          is_reply_to_other: is_reply_to_other,
        });
      }
      return out;
    })()`;

    for (let i = 0; i < maxScrolls && collected.size < limit; i++) {
      const harvested: Array<ListedTweet & { is_pinned: boolean; is_retweet: boolean; is_reply_to_other: boolean }> =
        await page.evaluate(evalScript);

      const beforeSize = collected.size;
      for (const t of harvested) {
        if (t.is_retweet || t.is_reply_to_other) continue;
        if (!t.tweet_id) continue;
        if (collected.has(t.tweet_id)) continue;
        collected.set(t.tweet_id, {
          tweet_url: t.tweet_url,
          tweet_id: t.tweet_id,
          posted_at: t.posted_at,
          text: t.text,
        });
      }

      if (collected.size === beforeSize) {
        stagnantRounds++;
        if (stagnantRounds >= 3) break; // No new tweets after 3 scrolls — end of timeline.
      } else {
        stagnantRounds = 0;
      }

      if (collected.size >= limit) break;

      // Scroll down to load more. Wait a beat for X's lazy loader.
      await page.evaluate(`window.scrollBy(0, window.innerHeight * 0.9)`);
      await page.waitForTimeout(800);
    }

    // Sort oldest-first by posted_at (ISO 8601 sorts lexicographically).
    // Tweets without a posted_at end up first; tweet_id is a snowflake that
    // already encodes time, so use it as a stable secondary sort.
    const tweets = Array.from(collected.values())
      .sort((a, b) => {
        if (a.posted_at && b.posted_at && a.posted_at !== b.posted_at) {
          return a.posted_at < b.posted_at ? -1 : 1;
        }
        // Snowflake IDs increase monotonically with time.
        return a.tweet_id.length === b.tweet_id.length
          ? (a.tweet_id < b.tweet_id ? -1 : a.tweet_id > b.tweet_id ? 1 : 0)
          : a.tweet_id.length - b.tweet_id.length;
      })
      .slice(0, limit);

    return { success: true, data: { tweets } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UI_TIMEOUT" };
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
    session = await openAuthenticatedSession({ accountId: req.account_id, proxySessionId: req.proxy_session_id, cookies: req.cookies });
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
    await page.waitForTimeout(1000);

    // Edge case: if the target has paid subscriptions enabled (e.g. @elonmusk),
    // X may open a "Subscribe - $X/month" modal instead of the unfollow
    // confirmation. Detect and surface that cleanly rather than spinning for
    // an API call that never fires.
    const subscribeModal = await page
      .locator('[role="dialog"]:has-text("Subscribe"):has-text("/month")')
      .first()
      .isVisible()
      .catch(() => false);
    if (subscribeModal) {
      return {
        success: false,
        error:
          `X opened a paid-subscription modal instead of the unfollow prompt. ` +
          `@${handle} runs paid subscriptions and X blocks automated unfollow on monetised accounts. ` +
          `Unfollow manually via the web UI if needed.`,
        error_code: "INVALID_INPUT",
      };
    }

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

    // Diagnostic screenshot ~1s after the final click in case the API
    // never fires.
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
    session = await openAuthenticatedSession({ accountId: req.account_id, proxySessionId: req.proxy_session_id, cookies: req.cookies });
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
      // X's UI requires a fully-qualified URL. The LLM planner often emits a
      // bare domain ('arianne.dev'); prepend https:// so we don't fail X's
      // "Url is not valid" check on something we can normalize ourselves.
      // Pass an empty string through as-is so callers can clear the field.
      const normalized = req.website === ""
        ? ""
        : /^https?:\/\//i.test(req.website)
          ? req.website
          : `https://${req.website}`;
      const urlInput = page.locator('input[name="url"]:visible').first();
      await urlInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await urlInput.click();
      await urlInput.press("Control+A");
      await urlInput.press("Delete");
      await urlInput.pressSequentially(normalized, { delay: 25 });
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

/* ─── changeUsername: change the @handle ─────────────────────────────── */

export async function changeUsername(
  req: OpRequest & { new_username: string; password: string }
): Promise<OpResult<{ new_username?: string; observed_posts?: string[] }>> {
  const handle = req.new_username.replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9_]{4,15}$/.test(handle)) {
    return {
      success: false,
      error: "new_username must be 4-15 chars, A-Z / 0-9 / _",
      error_code: "INVALID_INPUT",
    };
  }
  if (!req.password) {
    return { success: false, error: "password is required for username change", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({ accountId: req.account_id, proxySessionId: req.proxy_session_id, cookies: req.cookies });
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto("https://x.com/settings/screen_name", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // Username input. X uses `name="typedScreenName"` on the settings screen.
    const usernameInput = page
      .locator(
        'input[name="typedScreenName"]:visible, ' +
        'input[name="screen_name"]:visible, ' +
        'input[data-testid="UserName-edit"]:visible'
      )
      .first();
    await usernameInput.waitFor({ state: "visible", timeout: 20000 });
    await usernameInput.click();
    await usernameInput.press("Control+A");
    await usernameInput.press("Delete");
    await usernameInput.pressSequentially(handle, { delay: 35 });

    // X validates availability live; wait a moment for the check.
    await page.waitForTimeout(1500);

    // Check for inline error (e.g. "That username has been taken.")
    const takenError = await page
      .locator('text=/has been taken|not available|invalid username/i')
      .first()
      .isVisible()
      .catch(() => false);
    if (takenError) {
      return {
        success: false,
        error: `Username @${handle} is unavailable or invalid on X.`,
        error_code: "INVALID_INPUT",
      };
    }

    // Log all POSTs during save to aid debugging if the pattern doesn't match.
    const seenPosts: string[] = [];
    const requestLog = (r: any) => {
      if (r.method() === "POST") {
        const u = r.url();
        if (/x\.com|twitter\.com/.test(u)) seenPosts.push(u);
      }
    };
    page.on("request", requestLog);

    // Find the Save button (only enabled when input is valid + available).
    const saveButton = page
      .locator(
        'button:has-text("Save"):not([aria-disabled="true"]):visible, ' +
        '[data-testid="Profile_Save_Button"]:not([aria-disabled="true"]):visible'
      )
      .first();
    await saveButton.waitFor({ state: "visible", timeout: 10000 });

    // Intercept the settings update request. X posts to either the REST
    // `account/settings.json` or the newer GraphQL `UpdateScreenName`.
    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await saveButton.click({ timeout: 5000 }); },
      /account\/settings|account\/update_profile|UpdateScreenName|update_screen_name/
    );

    // X may show a password re-auth modal. If it does, fill the password and
    // submit, then wait for the settings API again.
    let effectiveApiResult = apiResult;
    const passwordInput = page.locator('input[type="password"]:visible, input[name="password"]:visible').first();
    const passwordVisible = await passwordInput.isVisible().catch(() => false);
    if (passwordVisible) {
      await passwordInput.click();
      await passwordInput.fill(req.password);
      await page.waitForTimeout(400);

      const confirmButton = page
        .locator('button:has-text("Confirm"):visible, button:has-text("Save"):visible, button[type="submit"]:visible')
        .first();
      const retryResult = await submitAndAwaitXApi(
        page,
        async () => { await confirmButton.click({ timeout: 5000 }); },
        /account\/settings|account\/update_profile|UpdateScreenName|update_screen_name/
      );
      if (retryResult) effectiveApiResult = retryResult;
    }

    page.off("request", requestLog);

    if (!effectiveApiResult) {
      const shot = await debugShot(page, "username-no-api-call");
      return {
        success: false,
        error:
          `No settings API call observed after save. Observed POSTs: ${seenPosts.slice(0, 10).join(" | ") || "(none)"}. ` +
          `Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
        data: { observed_posts: seenPosts },
      };
    }

    if (!effectiveApiResult.ok) {
      return {
        success: false,
        error: `X rejected username change: ${effectiveApiResult.errorMessage || `HTTP ${effectiveApiResult.status}`}`,
        error_code: mapXError(effectiveApiResult.status, effectiveApiResult.errorCode),
      };
    }

    return { success: true, data: { new_username: handle } };
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "UI_TIMEOUT" };
  } finally {
    await close();
  }
}

/* ─── updateAvatar / updateBanner: set profile picture or header image ── */

async function updateProfileImage(
  req: OpRequest & ImageInput,
  kind: "avatar" | "banner"
): Promise<OpResult> {
  let materialized: { filePath: string; cleanup: () => void };
  try {
    materialized = await materializeImage(req);
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({ accountId: req.account_id, proxySessionId: req.proxy_session_id, cookies: req.cookies });
  } catch (e: any) {
    materialized.cleanup();
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page
      .goto("https://x.com/settings/profile", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(async () => {
        await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
      });

    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // X renders two `<input type="file">` elements on the profile editor —
    // one for the banner (header), one for the avatar. Both can share the
    // same testid ("fileInput") but sit in different containers and render
    // the banner FIRST. Target via container scoping, then legacy testid,
    // then positional fallback (banner is always index 0, avatar index 1).
    const containerTestId = kind === "avatar" ? "photoInputAvatarItem" : "photoInputBannerItem";
    const legacyTestId = kind === "avatar" ? "photoInput" : "headerInput";

    let fileInput = page
      .locator(`[data-testid="${containerTestId}"] input[type="file"]`)
      .first();
    if ((await fileInput.count()) === 0) {
      fileInput = page.locator(`input[type="file"][data-testid="${legacyTestId}"]`).first();
    }
    if ((await fileInput.count()) === 0) {
      // Positional fallback: banner = 0, avatar = 1
      fileInput = page.locator('input[type="file"]').nth(kind === "avatar" ? 1 : 0);
    }

    await fileInput.waitFor({ state: "attached", timeout: 20000 });
    await fileInput.setInputFiles(materialized.filePath);

    // X opens a crop / apply modal after upload. Find its Apply button.
    const applyButton = page
      .locator(
        '[data-testid="applyButton"]:visible, ' +
        'button:has-text("Apply"):visible, ' +
        '[data-testid="saveEditProfilePicture"]:visible'
      )
      .first();
    await applyButton.waitFor({ state: "visible", timeout: 20000 });
    await applyButton.click({ timeout: 5000 });

    // Now the top-level Save on the profile editor.
    const saveButton = page
      .locator(
        '[data-testid="Profile_Save_Button"]:visible, ' +
        'button:has-text("Save"):visible'
      )
      .first();
    await saveButton.waitFor({ state: "visible", timeout: 15000 });

    // X's specific endpoint patterns for each image kind. Keep these tight
    // because a generic `update_profile.json` also fires on Save for
    // bio/name changes — matching that creates a false positive.
    const apiPattern =
      kind === "avatar"
        ? /update_profile_image|UpdateProfileImage/
        : /update_profile_banner|UpdateProfileBanner/;

    // Log every POST to X's domains during the op, regardless of match.
    const seenPosts: string[] = [];
    const requestLog = (req: any) => {
      if (req.method() === "POST") {
        const u = req.url();
        if (/x\.com|twitter\.com/.test(u)) seenPosts.push(u);
      }
    };
    page.on("request", requestLog);

    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await saveButton.click({ timeout: 5000 }); },
      apiPattern
    );

    page.off("request", requestLog);

    if (!apiResult) {
      const shot = await debugShot(page, `${kind}-no-api-call`);
      return {
        success: false,
        error:
          `No ${kind} update API call observed. ` +
          `Observed POSTs during op: ${seenPosts.slice(0, 10).join(" | ") || "(none)"}. ` +
          `Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (!apiResult.ok) {
      return {
        success: false,
        error: `X rejected ${kind} update: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
        error_code: mapXError(apiResult.status, apiResult.errorCode),
      };
    }

    return { success: true, data: { kind, observed_posts: seenPosts.slice(0, 10) } };
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "UI_TIMEOUT" };
  } finally {
    materialized.cleanup();
    await close();
  }
}

export async function updateAvatar(req: OpRequest & ImageInput): Promise<OpResult> {
  return updateProfileImage(req, "avatar");
}

export async function updateBanner(req: OpRequest & ImageInput): Promise<OpResult> {
  return updateProfileImage(req, "banner");
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
      proxySessionId: req.proxy_session_id,
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
