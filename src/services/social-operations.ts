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
import { randomUUID, randomBytes } from "crypto";

/**
 * Generate a strong password satisfying the strictest interpretation of X's
 * complexity rules. 32 chars from upper/lower/digits/symbols with one of each
 * class guaranteed, then shuffled. Used by transfer-rotates-password flows
 * for both pool and registered accounts.
 */
export function generateStrongPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+";
  const alphabet = upper + lower + digits + symbols;
  const bytes = randomBytes(32);
  let out = "";
  out += upper[bytes[0] % upper.length];
  out += lower[bytes[1] % lower.length];
  out += digits[bytes[2] % digits.length];
  out += symbols[bytes[3] % symbols.length];
  for (let i = 4; i < 32; i++) out += alphabet[bytes[i] % alphabet.length];
  const arr = out.split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 512 * 1024 * 1024; // 512 MB — X's documented hard cap
const MAX_IMAGES_PER_TWEET = 4;

interface ImageInput {
  image_base64?: string;   // raw base64 or data: URL
  image_url?: string;       // https URL — server fetches
}

interface VideoInput {
  video_base64?: string;   // raw base64 or data: URL
  video_url?: string;       // https URL — server fetches
}

/**
 * Per-tweet attachment. X allows EITHER 1-4 images OR exactly 1 video — never
 * a mix and never more than 4 items total. Each entry must have exactly one
 * of {image_*, video_*}.
 */
type MediaInput = ImageInput | VideoInput;

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

  const dir = "/tmp/palmyr-uploads";
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

/**
 * Materialise a video from base64 or URL into a temp file. Mirrors
 * materializeImage but with video MIME-type validation, larger byte budget,
 * and a longer fetch timeout (videos take longer to download than images).
 */
async function materializeVideo(
  input: VideoInput
): Promise<{ filePath: string; cleanup: () => void }> {
  if (!input.video_base64 && !input.video_url) {
    throw new Error("video_base64 or video_url is required");
  }

  const fs = await import("fs");
  const path = await import("path");

  const dir = "/tmp/palmyr-uploads";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let buf: Buffer;
  let ext = "mp4";

  if (input.video_base64) {
    const dataUrlMatch = input.video_base64.match(/^data:video\/([\w-]+);base64,(.+)$/);
    if (dataUrlMatch) {
      ext = dataUrlMatch[1].toLowerCase();
      buf = Buffer.from(dataUrlMatch[2], "base64");
    } else {
      buf = Buffer.from(input.video_base64, "base64");
    }
  } else {
    const resp = await fetchSsrfSafe(input.video_url!, { timeoutMs: 120000, maxBytes: MAX_VIDEO_BYTES });
    if (!resp.ok) throw new Error(`Failed to fetch video: HTTP ${resp.status}`);
    const contentType = resp.headers.get("content-type") || "";
    if (!/^video\//.test(contentType)) {
      throw new Error(`URL did not return a video (content-type: ${contentType})`);
    }
    ext = contentType.split("/")[1]?.split(";")[0]?.toLowerCase() || "mp4";
    buf = Buffer.from(await resp.arrayBuffer());
  }

  if (buf.length > MAX_VIDEO_BYTES) {
    throw new Error(`Video too large (${buf.length} bytes, max ${MAX_VIDEO_BYTES})`);
  }

  // X accepts mp4 and mov. Normalize unknown subtypes to mp4 — the actual
  // codec inside may not match the extension, but X will reject at upload time
  // with a clear error if the codec is unsupported.
  if (!["mp4", "mov", "quicktime", "m4v"].includes(ext)) ext = "mp4";

  const filePath = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(filePath, buf);

  const cleanup = () => {
    try { fs.unlinkSync(filePath); } catch { /* noop */ }
  };

  return { filePath, cleanup };
}

/**
 * Validate a media array against X's per-tweet rules. Returns an error
 * string if invalid, or null if OK. Empty arrays are valid (no attachment).
 */
function validateMediaArray(media: MediaInput[]): string | null {
  if (media.length === 0) return null;
  if (media.length > MAX_IMAGES_PER_TWEET) {
    return `Too many media items (max ${MAX_IMAGES_PER_TWEET}, got ${media.length})`;
  }
  const videos = media.filter(m => "video_base64" in m || "video_url" in m);
  const images = media.filter(m => "image_base64" in m || "image_url" in m);
  if (videos.length > 0 && images.length > 0) {
    return "Cannot mix images and video in the same tweet (X allows one or the other, not both)";
  }
  if (videos.length > 1) {
    return `Max 1 video per tweet (got ${videos.length})`;
  }
  for (let i = 0; i < media.length; i++) {
    const m = media[i] as any;
    const hasImage = !!(m.image_base64 || m.image_url);
    const hasVideo = !!(m.video_base64 || m.video_url);
    if (!hasImage && !hasVideo) {
      return `Media item ${i + 1}: must have image_base64/image_url or video_base64/video_url`;
    }
  }
  return null;
}

/**
 * Materialise every entry in a media array into local file paths, with a
 * single combined cleanup that removes them all. Cleans up partial state if
 * any individual materialise fails partway through.
 */
async function materializeMedia(
  inputs: MediaInput[]
): Promise<{ filePaths: string[]; cleanup: () => void }> {
  const results: Array<{ filePath: string; cleanup: () => void }> = [];
  try {
    for (const input of inputs) {
      const isVideo = "video_base64" in input || "video_url" in input;
      results.push(isVideo
        ? await materializeVideo(input as VideoInput)
        : await materializeImage(input as ImageInput));
    }
    return {
      filePaths: results.map(r => r.filePath),
      cleanup: () => results.forEach(r => r.cleanup()),
    };
  } catch (e) {
    // Cleanup any successful materialisations before propagating.
    results.forEach(r => r.cleanup());
    throw e;
  }
}

async function debugShot(page: any, tag: string): Promise<string | undefined> {
  try {
    const fs = await import("fs");
    const dir = "/tmp/palmyr-social-shots";
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

/**
 * X community IDs are snowflake-ish (long numeric strings, typically 18-19
 * digits but allow 15-30 to be safe). Reject obviously bad inputs early.
 */
function validateCommunityId(communityId?: string): string | null {
  if (communityId === undefined) return null;
  if (!/^\d{15,30}$/.test(communityId)) {
    return `community_id must be a numeric ID (15-30 digits, got: ${communityId})`;
  }
  return null;
}

/**
 * Where to land when starting a compose session. Community URLs auto-scope
 * any post made from their inline composer to that community — we don't need
 * to manipulate an audience-selector dropdown.
 */
function composeStartUrl(communityId?: string): string {
  return communityId
    ? `https://x.com/i/communities/${communityId}`
    : "https://x.com/home";
}

export async function postTweet(
  req: OpRequest & { text: string; media?: MediaInput[]; community_id?: string }
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

  const communityErr = validateCommunityId(req.community_id);
  if (communityErr) {
    return { success: false, error: communityErr, error_code: "INVALID_INPUT" };
  }

  // Validate media early so we fail fast before launching a browser session.
  const media = req.media || [];
  const mediaErr = validateMediaArray(media);
  if (mediaErr) {
    return { success: false, error: mediaErr, error_code: "INVALID_INPUT" };
  }

  // Materialise media to disk before opening the session — saves browser
  // launch time if the input is malformed (bad URL, oversized file, etc.).
  let materialized: { filePaths: string[]; cleanup: () => void } | null = null;
  if (media.length > 0) {
    try {
      materialized = await materializeMedia(media);
    } catch (e: any) {
      return { success: false, error: e.message, error_code: "INVALID_INPUT" };
    }
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
    });
  } catch (e: any) {
    materialized?.cleanup();
    return { success: false, error: e.message, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(composeStartUrl(req.community_id), {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // Community pages sometimes require clicking a "Post" trigger before the
    // inline composer mounts. Try the inline textarea first; if it doesn't
    // appear, fall back to clicking a primary post button to open the modal.
    let textarea = page
      .locator('[data-testid="tweetTextarea_0"]:visible')
      .first();
    try {
      await textarea.waitFor({ state: "visible", timeout: req.community_id ? 8000 : 20000 });
    } catch {
      if (req.community_id) {
        const openCompose = page
          .locator(
            '[data-testid="SideNav_NewTweet_Button"]:visible, ' +
            'a[href="/compose/post"]:visible, ' +
            'a[href="/compose/tweet"]:visible'
          )
          .first();
        try {
          await openCompose.waitFor({ state: "visible", timeout: 5000 });
          await openCompose.click({ timeout: 5000 });
          textarea = page.locator('[data-testid="tweetTextarea_0"]:visible').first();
          await textarea.waitFor({ state: "visible", timeout: 15000 });
        } catch {
          const shot = await debugShot(page, "post-community-textarea-missing");
          return {
            success: false,
            error:
              `Community compose textarea did not appear at /i/communities/${req.community_id}. ` +
              `Verify membership and that the community exists. Screenshot: ${shot}`,
            error_code: "UI_TIMEOUT",
          };
        }
      } else {
        const shot = await debugShot(page, "post-textarea-missing");
        return {
          success: false,
          error: `Compose textarea not visible on /home. Screenshot: ${shot}`,
          error_code: "UI_TIMEOUT",
        };
      }
    }
    await textarea.click();
    await textarea.pressSequentially(req.text, { delay: 30 });
    await page.waitForTimeout(800);

    // Attach media after typing text — X's compose hides the file input until
    // the box has focus. setInputFiles works on the hidden <input type="file">
    // directly, no need to click the visible attach button.
    if (materialized && materialized.filePaths.length > 0) {
      const fileInput = page
        .locator(
          '[data-testid="fileInput"], ' +
          'input[type="file"][data-testid="attachments"], ' +
          '[data-testid="toolBar"] input[type="file"], ' +
          'input[type="file"]'
        )
        .first();
      try {
        await fileInput.waitFor({ state: "attached", timeout: 10000 });
      } catch {
        const shot = await debugShot(page, "post-media-input-not-found");
        return {
          success: false,
          error: `Compose file input not found. X may have changed the attachment UI. Screenshot: ${shot}`,
          error_code: "UI_TIMEOUT",
        };
      }
      try {
        await fileInput.setInputFiles(materialized.filePaths);
      } catch (e: any) {
        const shot = await debugShot(page, "post-media-attach-failed");
        return {
          success: false,
          error: `Failed to attach media files: ${e.message}. Screenshot: ${shot}`,
          error_code: "UI_TIMEOUT",
        };
      }
      // X's compose disables the post button while uploads are in progress.
      // The waitFor on postButton below will block until uploads complete (or
      // timeout if anything goes wrong). For videos this can take 10-60s.
      await page.waitForTimeout(1500);
    }

    const postButton = page
      .locator(
        '[data-testid="tweetButtonInline"]:not([aria-disabled="true"]):visible, ' +
        '[data-testid="tweetButton"]:not([aria-disabled="true"]):visible'
      )
      .first();

    // Media uploads keep the post button disabled until X finishes processing.
    // Videos take longest — bump the wait window when video is attached.
    const hasVideo = media.some(m => "video_base64" in m || "video_url" in m);
    const postReadyTimeout = hasVideo ? 120000 : (media.length > 0 ? 45000 : 10000);

    let buttonReady = true;
    try {
      await postButton.waitFor({ state: "visible", timeout: postReadyTimeout });
    } catch {
      buttonReady = false;
    }

    if (!buttonReady) {
      const shot = await debugShot(page, "post-button-not-visible");
      return {
        success: false,
        error:
          `Post button never became enabled` +
          (media.length > 0 ? ` (waited ${postReadyTimeout}ms for media upload)` : "") +
          `. Screenshot: ${shot}`,
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
    materialized?.cleanup();
    await close();
  }
}

/* ─── postThread: publish a chain of 2-25 tweets as a native X thread ── */

/**
 * Post a thread by composing all tweets in one session, then submitting once.
 * Uses X's native "Add" button so we issue a single click for the whole chain
 * — no per-tweet navigation, no reply-URL lookups.
 *
 * X fires one CreateTweet response per tweet during submission. We collect
 * all of them, fail on the first error, and return the IDs in submission order.
 */
export async function postTweetThread(
  req: OpRequest & { texts: string[]; community_id?: string }
): Promise<OpResult<{ tweet_ids: string[]; tweet_urls: string[]; x_error_code?: number; x_http_status?: number }>> {
  if (!Array.isArray(req.texts) || req.texts.length === 0) {
    return { success: false, error: "texts must be a non-empty array", error_code: "INVALID_INPUT" };
  }
  if (req.texts.length === 1) {
    // Degenerate: a "thread" of one is just a tweet. Delegate.
    const r = await postTweet({ ...req, text: req.texts[0] });
    if (!r.success) return r as any;
    return {
      success: true,
      data: {
        tweet_ids: r.data?.tweet_id ? [r.data.tweet_id] : [],
        tweet_urls: r.data?.tweet_url ? [r.data.tweet_url] : [],
      },
    };
  }
  if (req.texts.length > 25) {
    return { success: false, error: `Thread length capped at 25 (got ${req.texts.length})`, error_code: "INVALID_INPUT" };
  }
  for (let i = 0; i < req.texts.length; i++) {
    const t = req.texts[i];
    if (!t || !t.trim()) {
      return { success: false, error: `Thread tweet ${i + 1} is empty`, error_code: "INVALID_INPUT" };
    }
    if (t.length > 280) {
      return { success: false, error: `Thread tweet ${i + 1} exceeds 280 chars (got ${t.length})`, error_code: "INVALID_INPUT" };
    }
  }

  const communityErr = validateCommunityId(req.community_id);
  if (communityErr) {
    return { success: false, error: communityErr, error_code: "INVALID_INPUT" };
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
    await page.goto(composeStartUrl(req.community_id), { waitUntil: "domcontentloaded", timeout: 45000 });

    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // Type the first tweet. On community pages the inline composer may need
    // to be opened via a side-nav button — handled the same way as postTweet.
    let firstBox = page.locator('[data-testid="tweetTextarea_0"]:visible').first();
    try {
      await firstBox.waitFor({ state: "visible", timeout: req.community_id ? 8000 : 20000 });
    } catch {
      if (req.community_id) {
        const openCompose = page
          .locator(
            '[data-testid="SideNav_NewTweet_Button"]:visible, ' +
            'a[href="/compose/post"]:visible, ' +
            'a[href="/compose/tweet"]:visible'
          )
          .first();
        try {
          await openCompose.waitFor({ state: "visible", timeout: 5000 });
          await openCompose.click({ timeout: 5000 });
          firstBox = page.locator('[data-testid="tweetTextarea_0"]:visible').first();
          await firstBox.waitFor({ state: "visible", timeout: 15000 });
        } catch {
          const shot = await debugShot(page, "thread-community-textarea-missing");
          return {
            success: false,
            error:
              `Thread compose textarea did not appear at /i/communities/${req.community_id}. ` +
              `Verify membership and that the community exists. Screenshot: ${shot}`,
            error_code: "UI_TIMEOUT",
          };
        }
      } else {
        const shot = await debugShot(page, "thread-textarea-missing");
        return {
          success: false,
          error: `Thread compose textarea not visible on /home. Screenshot: ${shot}`,
          error_code: "UI_TIMEOUT",
        };
      }
    }
    await firstBox.click();
    await firstBox.pressSequentially(req.texts[0], { delay: 30 });
    await page.waitForTimeout(500);

    // Add tweets 2..N. The "Add" button has data-testid="addButton" in the
    // current compose UI; fall back to the labeled button if testid missing.
    for (let i = 1; i < req.texts.length; i++) {
      const addButton = page
        .locator('[data-testid="addButton"]:visible, button[aria-label="Add post"]:visible')
        .first();
      try {
        await addButton.waitFor({ state: "visible", timeout: 10000 });
      } catch {
        const shot = await debugShot(page, `thread-add-btn-missing-${i}`);
        return {
          success: false,
          error: `Add-tweet button not found before tweet ${i + 1}. X may have changed compose UI. Screenshot: ${shot}`,
          error_code: "UI_TIMEOUT",
        };
      }
      await addButton.click({ timeout: 5000 });

      const nextBox = page.locator(`[data-testid="tweetTextarea_${i}"]:visible`).first();
      try {
        await nextBox.waitFor({ state: "visible", timeout: 10000 });
      } catch {
        const shot = await debugShot(page, `thread-textarea-missing-${i}`);
        return {
          success: false,
          error: `Textarea ${i + 1} did not appear after Add click. Screenshot: ${shot}`,
          error_code: "UI_TIMEOUT",
        };
      }
      await nextBox.click();
      await nextBox.pressSequentially(req.texts[i], { delay: 30 });
      await page.waitForTimeout(300);
    }

    // Locate the post button (becomes "Post all" for threads but testid stays).
    const postButton = page
      .locator(
        '[data-testid="tweetButtonInline"]:not([aria-disabled="true"]):visible, ' +
        '[data-testid="tweetButton"]:not([aria-disabled="true"]):visible'
      )
      .first();
    try {
      await postButton.waitFor({ state: "visible", timeout: 10000 });
    } catch {
      const shot = await debugShot(page, "thread-post-btn-not-ready");
      return {
        success: false,
        error: `Post-thread button never became enabled. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    // Collect every CreateTweet response that fires during submission. X posts
    // them sequentially (each next one references the previous tweet's ID),
    // so we may see N responses staggered by ~1-3s each.
    const expectedCount = req.texts.length;
    const collected: ApiResult[] = [];
    const collector = (resp: any) => {
      if (resp.request().method() !== "POST") return;
      if (!/\/CreateTweet/.test(resp.url())) return;
      // Process async — don't block the listener.
      (async () => {
        const status = resp.status();
        let json: any = null;
        try { json = await resp.json(); } catch {
          try { json = { raw: await resp.text() }; } catch { /* noop */ }
        }
        const errors = json?.errors;
        const errorMessage = Array.isArray(errors) && errors[0]?.message ? errors[0].message : undefined;
        const errorCode = Array.isArray(errors) && errors[0]?.code ? errors[0].code : undefined;
        collected.push({ ok: resp.ok() && !errorMessage, status, json, errorMessage, errorCode });
      })();
    };
    page.on("response", collector);

    try {
      await postButton.click({ timeout: 5000 });
    } catch (e: any) {
      page.off("response", collector);
      return { success: false, error: `Click on post-thread failed: ${e.message}`, error_code: "UI_TIMEOUT" };
    }

    // Wait for all expected responses or timeout. Budget ~8s per tweet, min 30s.
    const deadline = Date.now() + Math.max(30000, expectedCount * 8000);
    while (collected.length < expectedCount && Date.now() < deadline) {
      await page.waitForTimeout(500);
    }

    page.off("response", collector);

    if (collected.length === 0) {
      const shot = await debugShot(page, "thread-no-api-calls");
      return {
        success: false,
        error: `No CreateTweet API calls observed after thread submit. X likely blocked. Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
      };
    }

    // Fail on first error response.
    const firstFailure = collected.find(r => !r.ok);
    if (firstFailure) {
      const partial = collected
        .filter(r => r.ok)
        .map(r => r.json?.data?.create_tweet?.tweet_results?.result?.rest_id)
        .filter((id): id is string => !!id);
      return {
        success: false,
        error: `X rejected a thread tweet: ${firstFailure.errorMessage || `HTTP ${firstFailure.status}`}` +
          (partial.length ? ` (${partial.length} of ${expectedCount} tweets posted before failure)` : ""),
        error_code: mapXError(firstFailure.status, firstFailure.errorCode),
        data: {
          x_error_code: firstFailure.errorCode,
          x_http_status: firstFailure.status,
          tweet_ids: partial,
          tweet_urls: partial.map(id => `https://x.com/i/web/status/${id}`),
        } as any,
      };
    }

    const tweetIds = collected
      .map(r => r.json?.data?.create_tweet?.tweet_results?.result?.rest_id)
      .filter((id): id is string => !!id);

    if (tweetIds.length < expectedCount) {
      return {
        success: false,
        error: `Thread submitted but only ${tweetIds.length}/${expectedCount} tweet IDs returned — partial state.`,
        error_code: "UNKNOWN",
        data: {
          tweet_ids: tweetIds,
          tweet_urls: tweetIds.map(id => `https://x.com/i/web/status/${id}`),
        } as any,
      };
    }

    return {
      success: true,
      data: {
        tweet_ids: tweetIds,
        tweet_urls: tweetIds.map(id => `https://x.com/i/web/status/${id}`),
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
      // X frequently returns "Internal error" with no code on profile-update
      // rejections — capture everything we can so the caller has something
      // to debug with: HTTP status, every error in the array (not just [0]),
      // raw response body, and a screenshot of whatever X showed in the UI.
      const shot = await debugShot(page, "profile-update-rejected");
      const allErrors: Array<{ code?: number; message?: string }> =
        Array.isArray(apiResult.json?.errors) ? apiResult.json.errors : [];
      const bodySnippet = (() => {
        try {
          return JSON.stringify(apiResult.json).slice(0, 500);
        } catch {
          return undefined;
        }
      })();
      return {
        success: false,
        error: `X rejected profile update: ${apiResult.errorMessage || `HTTP ${apiResult.status}`}`,
        error_code: mapXError(apiResult.status, apiResult.errorCode),
        data: {
          x_error_code: apiResult.errorCode,
          x_http_status: apiResult.status,
          x_errors: allErrors,
          x_body_snippet: bodySnippet,
          submitted_fields: Object.fromEntries(provided),
          screenshot: shot,
        },
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

/* ─── changePassword: rotate password + (optionally) revoke other sessions ─ */

/**
 * Rotate an X account's password by driving the settings UI. Used by the
 * /x/accounts/:id/transfer route to make the previous owner's cached cookies
 * and exported password worthless before flipping the DB owner.
 *
 * Flow:
 *   1. Open authenticated session with the current cookies.
 *   2. Navigate to https://x.com/settings/password.
 *   3. Fill current / new / confirm password fields.
 *   4. Toggle "Log out of other sessions" if requested (invalidates every
 *      auth_token on every other device, including the exported one the
 *      previous owner saved locally).
 *   5. Submit and watch for the API response.
 *   6. On success, refresh cookies — X rotates ct0 and may rotate auth_token
 *      on password change, so we capture the fresh values for the new owner.
 *
 * Returns the new cookie set + auth_token when X reports success. Caller
 * gates DB writes on `success === true`: if anything fails (X 4xx, captcha,
 * UI moved), the old owner keeps the account untouched.
 */
export async function changePassword(
  req: OpRequest & {
    current_password: string;
    new_password: string;
    log_out_other_sessions?: boolean;
  }
): Promise<OpResult<{ cookies: any[]; auth_token: string | null; ct0: string | null }>> {
  if (!req.current_password) {
    return { success: false, error: "current_password is required", error_code: "INVALID_INPUT" };
  }
  // X enforces 8+ chars; we ask for 12+ since we generate the new password.
  if (!req.new_password || req.new_password.length < 12) {
    return { success: false, error: "new_password must be at least 12 characters", error_code: "INVALID_INPUT" };
  }
  if (req.new_password === req.current_password) {
    return { success: false, error: "new_password must differ from current_password", error_code: "INVALID_INPUT" };
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

  const { page, ctx, close } = session as any;
  try {
    await page.goto("https://x.com/settings/password", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    if (isSessionExpiredUrl(page.url())) {
      return { success: false, error: "Cookies expired — re-run twitter login.", error_code: "SESSION_EXPIRED" };
    }

    // X's password settings has three password fields in order: current, new,
    // confirm new. Specific name attributes vary across UI revisions, so target
    // by index over all visible password inputs as a robust fallback.
    const pwInputs = page.locator('input[type="password"]:visible');
    let inputCount = 0;
    try {
      await pwInputs.first().waitFor({ state: "visible", timeout: 20000 });
      inputCount = await pwInputs.count();
    } catch {
      const diag = await debugShot(page, "password-no-inputs");
      return {
        success: false,
        error: `Password inputs never rendered on /settings/password. Screenshot: ${diag}`,
        error_code: "UI_TIMEOUT",
      };
    }

    if (inputCount < 3) {
      const diag = await debugShot(page, "password-too-few-inputs");
      return {
        success: false,
        error: `Expected 3 password inputs, found ${inputCount}. X may have changed the UI. Screenshot: ${diag}`,
        error_code: "UI_TIMEOUT",
      };
    }

    // Fill current → new → confirm. Use type() instead of fill() because X's
    // form listens for real keydown events to enable the Save button.
    await pwInputs.nth(0).click();
    await pwInputs.nth(0).type(req.current_password, { delay: 30 });
    await pwInputs.nth(1).click();
    await pwInputs.nth(1).type(req.new_password, { delay: 30 });
    await pwInputs.nth(2).click();
    await pwInputs.nth(2).type(req.new_password, { delay: 30 });
    await page.waitForTimeout(600);

    // "Log out of other sessions" — an opt-in toggle that, when on, instructs
    // X to invalidate every auth_token belonging to this account on every
    // OTHER device. Critical for transfer: the previous owner has exported
    // cookies + auth_token locally; without this they'd retain access until
    // the cookies happened to expire on X's side.
    if (req.log_out_other_sessions) {
      // X uses a switch role for this toggle; selectors vary.
      const toggle = page
        .locator(
          'input[type="checkbox"]:visible, ' +
          '[role="switch"]:visible, ' +
          'input[name*="logout"]:visible, ' +
          'input[name*="log_out"]:visible'
        )
        .first();
      const toggleExists = await toggle.count().catch(() => 0);
      if (toggleExists > 0) {
        const isOn = await toggle.isChecked().catch(() => false);
        if (!isOn) {
          await toggle.click({ timeout: 5000 }).catch(() => {});
        }
      }
      // If the toggle isn't found, X may not be offering it on this account;
      // we don't fail — the password change alone still invalidates the
      // previous owner's saved password.
    }

    const saveButton = page
      .locator(
        'button:has-text("Save"):not([aria-disabled="true"]):visible, ' +
        '[data-testid="settingsDetailSave"]:not([aria-disabled="true"]):visible, ' +
        'div[role="button"]:has-text("Save"):not([aria-disabled="true"]):visible'
      )
      .first();
    try {
      await saveButton.waitFor({ state: "visible", timeout: 10000 });
    } catch {
      const diag = await debugShot(page, "password-save-not-enabled");
      return {
        success: false,
        error: `Save button never enabled. Inputs may have rejected the values. Screenshot: ${diag}`,
        error_code: "UI_TIMEOUT",
      };
    }

    // Track POSTs so we can diagnose if the pattern doesn't match.
    const seenPosts: string[] = [];
    const requestLog = (r: any) => {
      if (r.method() === "POST") {
        const u = r.url();
        if (/x\.com|twitter\.com/.test(u)) seenPosts.push(u);
      }
    };
    page.on("request", requestLog);

    const apiResult = await submitAndAwaitXApi(
      page,
      async () => { await saveButton.click({ timeout: 5000 }); },
      /change_password|update_password|UpdatePassword|password_reset/
    );

    page.off("request", requestLog);

    if (!apiResult) {
      const shot = await debugShot(page, "password-no-api-call");
      return {
        success: false,
        error:
          `No password-change API call observed. Observed POSTs: ${seenPosts.slice(0, 10).join(" | ") || "(none)"}. ` +
          `Screenshot: ${shot}`,
        error_code: "UI_TIMEOUT",
        data: { cookies: [], auth_token: null, ct0: null },
      };
    }

    if (!apiResult.ok) {
      const errMsg = apiResult.errorMessage || `HTTP ${apiResult.status}`;
      // X returns 403 on a wrong current_password — flag explicitly so the
      // caller can surface "wrong current password" rather than a generic 401.
      const code = mapXError(apiResult.status, apiResult.errorCode);
      return {
        success: false,
        error: `X rejected password change: ${errMsg}`,
        error_code: code,
      };
    }

    // Give X a beat to set the new session cookies before harvest. Without
    // this we sometimes capture the pre-rotation auth_token.
    await page.waitForTimeout(1500);

    const cookies = await ctx.cookies();
    const authTokenCookie = cookies.find((c: any) => c.name === "auth_token");
    const ct0Cookie = cookies.find((c: any) => c.name === "ct0");

    return {
      success: true,
      data: {
        cookies,
        auth_token: authTokenCookie?.value || null,
        ct0: ct0Cookie?.value || null,
      },
    };
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
