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

    // Submit via Ctrl/Cmd+Enter keyboard shortcut — more reliable than the
    // button across X's flow variants.
    const isMac = process.platform === "darwin";
    await textarea.press(isMac ? "Meta+Enter" : "Control+Enter");

    let submitted = false;
    try {
      await page.waitForFunction(
        'document.querySelector(\'[data-testid="tweetTextarea_0"]\') === null || document.querySelector(\'[data-testid="tweetTextarea_0"]\').innerText.trim() === ""',
        { timeout: 10000 }
      );
      submitted = true;
    } catch {
      const postButton = page
        .locator('[data-testid="tweetButtonInline"]:not([aria-disabled="true"]):visible')
        .first();
      try {
        await postButton.waitFor({ state: "visible", timeout: 5000 });
        await postButton.click({ timeout: 5000 });
        await page.waitForFunction(
          'document.querySelector(\'[data-testid="tweetTextarea_0"]\') === null || document.querySelector(\'[data-testid="tweetTextarea_0"]\').innerText.trim() === ""',
          { timeout: 10000 }
        );
        submitted = true;
      } catch {}
    }

    if (!submitted) {
      return {
        success: false,
        error: "Post composed but submission did not clear the textarea — X likely rejected or silently ignored it.",
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

    // Primary: keyboard shortcut. X accepts Ctrl/Cmd+Enter to submit from any
    // focused compose textarea. Works reliably regardless of which viewport /
    // button variant X is rendering.
    const isMac = process.platform === "darwin";
    await replyBox.press(isMac ? "Meta+Enter" : "Control+Enter");

    // Success signal: the textarea's value is cleared (X resets on submit).
    // If the button stayed enabled and text stayed there, the submit didn't
    // go through.
    let submitted = false;
    try {
      await page.waitForFunction(
        'document.querySelector(\'[data-testid="tweetTextarea_0"]\') === null || document.querySelector(\'[data-testid="tweetTextarea_0"]\').innerText.trim() === ""',
        { timeout: 10000 }
      );
      submitted = true;
    } catch {
      // Keyboard didn't take; fall back to clicking the inline submit button.
      const replyButton = page
        .locator(
          '[data-testid="tweetButtonInline"]:not([aria-disabled="true"]):visible, ' +
          '[data-testid="tweetButton"]:not([aria-disabled="true"]):visible'
        )
        .first();
      try {
        await replyButton.waitFor({ state: "visible", timeout: 5000 });
        await replyButton.click({ timeout: 5000 });
        await page.waitForFunction(
          'document.querySelector(\'[data-testid="tweetTextarea_0"]\') === null || document.querySelector(\'[data-testid="tweetTextarea_0"]\').innerText.trim() === ""',
          { timeout: 10000 }
        );
        submitted = true;
      } catch {}
    }

    if (!submitted) {
      return {
        success: false,
        error: "Reply composed but submission did not clear the textarea — X likely rejected or silently ignored it.",
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
