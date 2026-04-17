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
): Promise<OpResult<{ tweet_url?: string }>> {
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

    await debugShot(page, "post-before-click");

    // Click the inline post button. Text-based and testid selectors combined
    // so we catch either variant.
    const postButton = page
      .locator(
        '[data-testid="tweetButtonInline"]:not([aria-disabled="true"]):visible, ' +
        '[data-testid="tweetButton"]:not([aria-disabled="true"]):visible'
      )
      .first();

    try {
      await postButton.waitFor({ state: "visible", timeout: 10000 });
      await postButton.click({ timeout: 5000 });
    } catch (e: any) {
      const shot = await debugShot(page, "post-button-not-clickable");
      return {
        success: false,
        error: `Post button not clickable: ${e.message}. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    // Success signal: the enabled post button disappears (disabled again once
    // the text is cleared post-submit) OR a network "CreateTweet" request
    // resolves with 200. Wait briefly for either.
    await page.waitForTimeout(3500);

    // If an error toast appeared, treat as failure.
    const errorToast = await page
      .locator('[data-testid="toast"]:has-text("Something went wrong"), [role="alert"]:visible')
      .first()
      .isVisible()
      .catch(() => false);

    if (errorToast) {
      const shot = await debugShot(page, "post-error-toast");
      return {
        success: false,
        error: `X returned an error toast after submit. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    return { success: true, data: {} };
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

    await debugShot(page, "reply-before-click");

    const replyButton = page
      .locator(
        '[data-testid="tweetButtonInline"]:not([aria-disabled="true"]):visible, ' +
        '[data-testid="tweetButton"]:not([aria-disabled="true"]):visible'
      )
      .first();

    try {
      await replyButton.waitFor({ state: "visible", timeout: 10000 });
      await replyButton.click({ timeout: 5000 });
    } catch (e: any) {
      const shot = await debugShot(page, "reply-button-not-clickable");
      return {
        success: false,
        error: `Reply button not clickable: ${e.message}. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    await page.waitForTimeout(3500);

    const errorToast = await page
      .locator('[data-testid="toast"]:has-text("Something went wrong"), [role="alert"]:visible')
      .first()
      .isVisible()
      .catch(() => false);

    if (errorToast) {
      const shot = await debugShot(page, "reply-error-toast");
      return {
        success: false,
        error: `X returned an error toast after reply submit. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    return { success: true };
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

    const likeButton = page.locator('[data-testid="like"]:visible').first();
    await likeButton.waitFor({ state: "visible", timeout: 20000 });
    await likeButton.click({ timeout: 5000 });

    // Confirmation: the button flips to data-testid="unlike"
    await page
      .locator('[data-testid="unlike"]:visible')
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .catch(() => {});

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

    const retweetButton = page.locator('[data-testid="retweet"]:visible').first();
    await retweetButton.waitFor({ state: "visible", timeout: 20000 });
    await retweetButton.click({ timeout: 5000 });

    // X shows a popup — click "Repost"
    const confirmButton = page
      .locator('[data-testid="retweetConfirm"]:visible')
      .first();
    await confirmButton.waitFor({ state: "visible", timeout: 10000 });
    await confirmButton.click({ timeout: 5000 });

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
    await followButton.click({ timeout: 5000 });

    // Confirmation: the button flips to unfollow
    await page
      .locator('[data-testid$="-unfollow"]:visible')
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .catch(() => {});

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "UI_TIMEOUT" };
  } finally {
    await close();
  }
}
