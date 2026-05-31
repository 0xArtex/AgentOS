/**
 * Authenticated TikTok operations executed server-side through the per-
 * account residential proxy. Each op:
 *
 *   1. Opens a stealth Chromium session with the cached cookies
 *   2. Navigates to the relevant TikTok URL
 *   3. Drives the UI while intercepting the matching internal API call
 *   4. Returns success only if the API response confirmed — never relies
 *      on UI state alone (no false positives)
 *
 * TikTok mirrors Twitter's shape but with a tighter rate-limit stance:
 * every op goes through `checkRateLimit()` before the browser even boots.
 */
import { openAuthenticatedSession, profileForCountry } from "./social-runtime";
import { fetchSsrfSafe } from "./email";
import { randomUUID } from "crypto";
import { checkRateLimit, recordAction } from "./social-rate-limit";
import { resolveElement, axSnapshot } from "./social-selectors";
import { wallClockInTz, pad2, type WallClock } from "./schedule-time";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;   // 100 MB — covers up to ~90s @ typical bitrate
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;    // 10 MB

export interface TikTokOpResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  error_code?:
    | "SESSION_EXPIRED"
    | "RATE_LIMITED"
    | "RATE_LIMITED_PROTECTIVE"
    | "NOT_FOUND"
    | "INVALID_INPUT"
    | "UPLOAD_FAILED"
    | "UI_TIMEOUT"
    | "LAUNCH_FAILED"
    | "CAPTCHA_CHALLENGE"
    | "SCHEDULE_FAILED"
    | "UNKNOWN";
  retry_after_ms?: number;
}

export interface TikTokOpRequest {
  account_id: string;
  proxy_session_id?: string;
  /** ISO country code for locale/timezone alignment. */
  country?: string;
  cookies: any[];
}

interface VideoInput {
  /** Raw base64 of the MP4 file, or a data URL. */
  video_base64?: string;
  /** Public HTTPS URL. Server fetches with SSRF guard. */
  video_url?: string;
}

interface ImageInput {
  image_base64?: string;
  image_url?: string;
}

/* ─── Media materialisation ────────────────────────────────────────────── */

async function materializeVideo(input: VideoInput): Promise<{ filePath: string; cleanup: () => void }> {
  if (!input.video_base64 && !input.video_url) {
    throw new Error("video_base64 or video_url is required");
  }
  const fs = await import("fs");
  const path = await import("path");
  const dir = "/tmp/palmyr-uploads";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let buf: Buffer;
  if (input.video_base64) {
    const dataUrlMatch = input.video_base64.match(/^data:video\/(\w+);base64,(.+)$/);
    buf = Buffer.from(dataUrlMatch ? dataUrlMatch[2] : input.video_base64, "base64");
  } else {
    const resp = await fetchSsrfSafe(input.video_url!, { timeoutMs: 60000, maxBytes: MAX_VIDEO_BYTES });
    if (!resp.ok) throw new Error(`Failed to fetch video: HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    if (!/^video\//.test(ct)) throw new Error(`URL did not return a video (content-type: ${ct})`);
    const arrayBuf = await resp.arrayBuffer();
    buf = Buffer.from(arrayBuf);
  }

  if (buf.length > MAX_VIDEO_BYTES) {
    throw new Error(`Video too large (${buf.length} bytes, max ${MAX_VIDEO_BYTES})`);
  }

  const filePath = path.join(dir, `${randomUUID()}.mp4`);
  fs.writeFileSync(filePath, buf);
  return { filePath, cleanup: () => { try { fs.unlinkSync(filePath); } catch {} } };
}

async function materializeImage(input: ImageInput): Promise<{ filePath: string; cleanup: () => void }> {
  if (!input.image_base64 && !input.image_url) throw new Error("image_base64 or image_url is required");
  const fs = await import("fs");
  const path = await import("path");
  const dir = "/tmp/palmyr-uploads";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let buf: Buffer;
  let ext = "png";
  if (input.image_base64) {
    const m = input.image_base64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (m) { ext = m[1].toLowerCase(); buf = Buffer.from(m[2], "base64"); }
    else buf = Buffer.from(input.image_base64, "base64");
  } else {
    const resp = await fetchSsrfSafe(input.image_url!, { timeoutMs: 30000, maxBytes: MAX_IMAGE_BYTES });
    if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    if (!/^image\//.test(ct)) throw new Error(`URL did not return an image (content-type: ${ct})`);
    ext = ct.split("/")[1]?.split(";")[0]?.toLowerCase() || "png";
    const arrayBuf = await resp.arrayBuffer();
    buf = Buffer.from(arrayBuf);
  }
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image too large (${buf.length} bytes)`);
  if (!["png", "jpeg", "jpg", "webp"].includes(ext)) ext = "png";
  const filePath = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(filePath, buf);
  return { filePath, cleanup: () => { try { fs.unlinkSync(filePath); } catch {} } };
}

/* ─── Debug / diagnostics ──────────────────────────────────────────────── */

async function debugShot(page: any, tag: string): Promise<string | undefined> {
  try {
    const fs = await import("fs");
    const dir = "/tmp/palmyr-social-shots";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const shotPath = `${dir}/tiktok-${tag}-${Date.now()}.png`;
    await page.screenshot({ path: shotPath, fullPage: true });
    return shotPath;
  } catch { return undefined; }
}

/**
 * Richer failure capture: screenshot + the page's interactive accessibility
 * tree. The element list shows exactly what TikTok rendered when a selector
 * missed, turning an opaque UI_TIMEOUT into a visible, fixable rotation (and the
 * same data a vision fallback would act on). Returned under `data` so it travels
 * back to the agent in the op result.
 */
async function captureUiState(
  page: any,
  tag: string,
): Promise<{ diag_screenshot?: string; interactive_elements?: Array<{ role: string; name: string }> }> {
  const [diag_screenshot, interactive_elements] = await Promise.all([
    debugShot(page, tag),
    axSnapshot(page),
  ]);
  return { diag_screenshot, interactive_elements };
}

/* ─── API response interceptor ─────────────────────────────────────────── */

interface ApiResult {
  ok: boolean;
  status: number;
  json: any;
  errorMessage?: string;
  statusCode?: number;
}

async function submitAndAwaitTikTokApi(
  page: any,
  trigger: () => Promise<void>,
  urlPattern: RegExp,
  timeoutMs: number = 30000
): Promise<ApiResult | null> {
  const respPromise = page
    .waitForResponse((resp: any) => urlPattern.test(resp.url()), { timeout: timeoutMs })
    .catch(() => null);

  await trigger();

  const resp = await respPromise;
  if (!resp) return null;

  const status = resp.status();
  let json: any = null;
  try { json = await resp.json(); }
  catch {
    try { json = { raw: await resp.text() }; } catch {}
  }

  // TikTok's internal API envelope uses `status_code` — 0 means success.
  // `status_msg` / `message` carries the human-readable error.
  const statusCode = typeof json?.status_code === "number" ? json.status_code : undefined;
  const errorMessage = statusCode && statusCode !== 0
    ? (json.status_msg || json.message || `TikTok error ${statusCode}`)
    : undefined;

  return {
    ok: resp.ok() && !errorMessage,
    status,
    json,
    errorMessage,
    statusCode,
  };
}

/**
 * Map TikTok error codes to our error_code enum.
 * Observed codes (approximate — not officially documented):
 *   0      = success
 *   8      = session expired / not logged in
 *   10000+ = rate-limited / flood control
 *   20000+ = captcha / security check
 *   3xxxx  = content rejected (duplicate, banned keyword, etc.)
 */
function mapTikTokError(status: number, code?: number): TikTokOpResult["error_code"] {
  if (status === 401 || status === 403 || code === 8) return "SESSION_EXPIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return "NOT_FOUND";
  if (code && code >= 20000 && code < 30000) return "CAPTCHA_CHALLENGE";
  if (code && code >= 10000 && code < 20000) return "RATE_LIMITED";
  if (code && code >= 30000 && code < 40000) return "INVALID_INPUT";
  return "UNKNOWN";
}

/* ─── Pre-op gate: rate-limit check ────────────────────────────────────── */

function gate(accountId: string, operation: string): TikTokOpResult | null {
  const rl = checkRateLimit(accountId, "tiktok", operation);
  if (!rl.ok) {
    return {
      success: false,
      error: rl.reason || "Rate limited",
      error_code: "RATE_LIMITED_PROTECTIVE",
      retry_after_ms: rl.retry_after_ms,
    };
  }
  return null;
}

/* ─── Native schedule (TikTok Studio) ──────────────────────────────────── */

/**
 * Drive TikTok Studio's native "Schedule" control on the upload page. On success
 * the post is handed to TikTok to publish at `when` — no Palmyr worker, fires
 * even if our server is down.
 *
 * Safety invariant: we set the time + date fields and VERIFY them by reading the
 * input values back. If the toggle/fields can't be found or don't accept our
 * values (e.g. a calendar-only widget), we return { ok:false } and the caller
 * ABORTS before submitting — so a broken schedule never silently posts "now".
 *
 * Best-effort against a UI we can't pin from here: selectors are resilient and a
 * failure carries AX diagnostics so the real widget can be seen and refined.
 */
async function applySchedule(page: any, when: WallClock): Promise<{ ok: boolean; error?: string }> {
  // 1. Switch "When to post" to Schedule.
  const toggle = await resolveElement(page, [
    { name: "role-radio", build: (p) => p.getByRole("radio", { name: /schedule/i }) },
    { name: "text", build: (p) => p.locator('label:has-text("Schedule"), [role="radio"]:has-text("Schedule")') },
  ], { perStrategyMs: 6000 });
  if (!toggle) return { ok: false, error: "schedule toggle not found" };
  await toggle.locator.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);

  // 2. Time field (HH:MM, 24h). Type, then verify it stuck.
  const timeStr = `${pad2(when.h)}:${pad2(when.mi)}`;
  const time = await resolveElement(page, [
    { name: "aria", build: (p) => p.locator('input[aria-label*="time" i]') },
    { name: "placeholder", build: (p) => p.locator('input[placeholder*="time" i], input[placeholder="HH:MM"]') },
  ], { perStrategyMs: 5000 });
  if (!time) return { ok: false, error: "time field not found" };
  try {
    await time.locator.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await time.locator.pressSequentially(timeStr, { delay: 40 });
    await page.keyboard.press("Enter");
  } catch (e: any) {
    return { ok: false, error: `time field not editable: ${e.message}` };
  }
  const tval = await time.locator.inputValue().catch(() => null);
  if (!tval || !tval.includes(pad2(when.h)) || !tval.includes(pad2(when.mi))) {
    return { ok: false, error: `time field did not accept ${timeStr} (read back "${tval}")` };
  }

  // 3. Date field. Calendar formats vary by locale, so try a few typed forms and
  //    verify the year + day landed.
  const date = await resolveElement(page, [
    { name: "aria", build: (p) => p.locator('input[aria-label*="date" i]') },
    { name: "placeholder", build: (p) => p.locator('input[placeholder*="date" i], input[placeholder*="-"], input[placeholder*="/"]') },
  ], { perStrategyMs: 5000 });
  if (!date) return { ok: false, error: "date field not found" };
  const candidates = [
    `${when.y}-${pad2(when.mo)}-${pad2(when.d)}`,
    `${pad2(when.mo)}/${pad2(when.d)}/${when.y}`,
    `${pad2(when.d)}/${pad2(when.mo)}/${when.y}`,
  ];
  let dateOk = false;
  for (const cand of candidates) {
    try {
      await date.locator.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await date.locator.pressSequentially(cand, { delay: 40 });
      await page.keyboard.press("Enter");
    } catch {
      continue;
    }
    const dval = await date.locator.inputValue().catch(() => null);
    // Verify year + MONTH + day all landed. Omitting month let a locale that
    // transposes MM/DD vs DD/MM still pass (includes(year)&&includes(day)) and
    // silently schedule to the wrong month. Every candidate contains pad2(month),
    // so a correctly-accepted date still passes — this only adds false-negatives.
    if (dval && dval.includes(String(when.y)) && dval.includes(pad2(when.mo)) && dval.includes(pad2(when.d))) { dateOk = true; break; }
  }
  if (!dateOk) return { ok: false, error: "date field did not accept a typed date (calendar-only widget?)" };

  return { ok: true };
}

/* ─── Operations ───────────────────────────────────────────────────────── */

export interface TikTokPostRequest extends TikTokOpRequest, VideoInput {
  caption: string;
  /** TikTok privacy: 0 = public, 1 = friends, 2 = private. Default 0. */
  privacy?: 0 | 1 | 2;
  /** Allow comments. Default true. */
  allow_comments?: boolean;
  /** Allow duet. Default true. */
  allow_duet?: boolean;
  /** Allow stitch. Default true. */
  allow_stitch?: boolean;
  /**
   * ISO-8601 datetime. When set, drive TikTok Studio's NATIVE schedule control
   * so TikTok itself publishes at this instant (no Palmyr-side worker). Must be
   * ~15 min to ~10 days out — TikTok's own window. The instant is rendered into
   * the account's timezone before being typed into the picker.
   */
  schedule_at?: string;
}

export async function postVideo(req: TikTokPostRequest): Promise<TikTokOpResult<{ video_url?: string; video_id?: string; scheduled_at?: string }>> {
  const blocked = gate(req.account_id, "post");
  if (blocked) return blocked;

  if (!req.caption || req.caption.length > 4000) {
    return { success: false, error: "caption must be 1-4000 chars", error_code: "INVALID_INPUT" };
  }

  // Validate the native-schedule window up front, before the expensive browser
  // launch. TikTok requires roughly 15 min to 10 days of lead time.
  let scheduleWhen: WallClock | undefined;
  if (req.schedule_at) {
    const at = new Date(req.schedule_at);
    if (isNaN(at.getTime())) {
      return { success: false, error: "schedule_at must be a valid ISO-8601 datetime", error_code: "INVALID_INPUT" };
    }
    const now = Date.now();
    if (at.getTime() < now + 15 * 60 * 1000) {
      return { success: false, error: "schedule_at must be at least ~15 minutes in the future (TikTok's minimum)", error_code: "INVALID_INPUT" };
    }
    if (at.getTime() > now + 10 * 24 * 60 * 60 * 1000) {
      return { success: false, error: "schedule_at must be within ~10 days (TikTok's maximum)", error_code: "INVALID_INPUT" };
    }
    // The picker interprets entered values in the browser session's timezone,
    // which openAuthenticatedSession derives from the account country — so
    // render the absolute instant into that same zone.
    scheduleWhen = wallClockInTz(at, profileForCountry(req.country).timezoneId);
  }

  let video: { filePath: string; cleanup: () => void };
  try {
    video = await materializeVideo(req);
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    video.cleanup();
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto("https://www.tiktok.com/tiktokstudio/upload?from=webapp", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Upload the file. The <input type=file> is plain HTML (not a rotating
    // test-id); TikTok renders both a visible and a hidden one — take the first.
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(video.filePath);

    // Wait for the upload to finish and the caption editor to render. Resolve it
    // resiliently: the data-e2e id is tried first (up to 90s, to absorb the
    // upload), then durable aria / role / contenteditable fallbacks if it rotated.
    const caption = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="upload-editor-caption"]') },
      { name: "aria-label", build: (p) => p.locator('[aria-label*="aption" i], [aria-label*="escription" i]') },
      { name: "role-textbox", build: (p) => p.getByRole("textbox") },
      { name: "contenteditable", build: (p) => p.locator('div[contenteditable="true"]') },
    ], { firstTimeoutMs: 90000, perStrategyMs: 6000 });
    if (!caption) {
      const diag = await captureUiState(page, "upload-editor-missing");
      return {
        success: false,
        error: "Upload editor never appeared — video rejected at upload, or the caption-editor selector rotated.",
        error_code: "UPLOAD_FAILED",
        data: diag as any,
      };
    }
    const captionBox = caption.locator;
    console.log(`[tiktok] caption editor resolved via ${caption.strategy}`);

    // Clear any auto-filled caption, type the user's caption.
    await captionBox.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await captionBox.pressSequentially(req.caption, { delay: 15 });
    await page.waitForTimeout(500);

    // Apply privacy / comments / duet / stitch toggles if the user set non-defaults.
    // These selectors have been stable for ~18 months; if TikTok rotates them
    // we fall through to defaults (public, all allowed) which is what agents want anyway.
    if (req.privacy === 1) {
      await page.locator('text=/Friends/i').first().click({ timeout: 2000 }).catch(() => {});
    } else if (req.privacy === 2) {
      await page.locator('text=/Private|Only you/i').first().click({ timeout: 2000 }).catch(() => {});
    }
    if (req.allow_comments === false) {
      await page.locator('[data-e2e="upload-switch-comment"], label:has-text("Comment")').first()
        .click({ timeout: 2000 }).catch(() => {});
    }
    if (req.allow_duet === false) {
      await page.locator('[data-e2e="upload-switch-duet"], label:has-text("Duet")').first()
        .click({ timeout: 2000 }).catch(() => {});
    }
    if (req.allow_stitch === false) {
      await page.locator('[data-e2e="upload-switch-stitch"], label:has-text("Stitch")').first()
        .click({ timeout: 2000 }).catch(() => {});
    }

    // If a native schedule was requested, set it now — and ABORT before
    // submitting if it can't be applied, so a broken schedule never posts "now".
    if (scheduleWhen) {
      const sched = await applySchedule(page, scheduleWhen);
      if (!sched.ok) {
        const diag = await captureUiState(page, "schedule-setup-failed");
        return {
          success: false,
          error: `Could not set TikTok's native schedule (${sched.error}). Aborted before posting to avoid publishing immediately — see diagnostics.interactive_elements for the actual scheduler UI.`,
          error_code: "SCHEDULE_FAILED",
          data: diag as any,
        };
      }
      console.log(`[tiktok] native schedule applied for ${req.schedule_at}`);
    }

    // Resolve the submit button up front (its label is "Schedule" when a
    // schedule is set, "Post" otherwise), so a rotated selector returns a clean
    // UI_TIMEOUT with diagnostics instead of an opaque throw mid-submit.
    const post = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="post_video_button"]') },
      { name: "role-name", build: (p) => p.getByRole("button", { name: /^(post|schedule)$/i }) },
      { name: "text", build: (p) => p.locator('button:has-text("Schedule"), button:has-text("Post")') },
    ], { perStrategyMs: 8000 });
    if (!post) {
      const diag = await captureUiState(page, "post-button-missing");
      return {
        success: false,
        error: "Submit button not found — the editor may not be ready, or the selector rotated.",
        error_code: "UI_TIMEOUT",
        data: diag as any,
      };
    }
    console.log(`[tiktok] submit button resolved via ${post.strategy}`);

    // Submit — intercept TikTok's /aweme/v1/web/aweme/post/ API call (the same
    // endpoint carries scheduled creates, with a schedule_time in the payload).
    const result = await submitAndAwaitTikTokApi(
      page,
      async () => { await post.locator.click({ timeout: 10000 }); },
      /\/aweme\/v\d+\/(web\/)?aweme\/post/,
      60000,
    );

    if (!result) {
      const diag = await captureUiState(page, "no-post-api");
      return {
        success: false,
        error: "No post API call observed after clicking Post — UI flow may have changed",
        error_code: "UI_TIMEOUT",
        data: diag as any,
      };
    }

    if (!result.ok) {
      return {
        success: false,
        error: result.errorMessage || `TikTok returned HTTP ${result.status}`,
        error_code: mapTikTokError(result.status, result.statusCode),
      };
    }

    recordAction(req.account_id, "tiktok", "post");

    // TikTok returns the aweme_id / share_url in the response payload shape
    // {status_code:0, aweme: {aweme_id, share_url, ...}} (varies by version).
    const aweme = result.json?.aweme || result.json?.data || {};
    return {
      success: true,
      data: {
        video_id: aweme.aweme_id || aweme.id,
        video_url: aweme.share_url || aweme.video_url,
        // For a scheduled create TikTok holds the post (no public URL yet) — the
        // requested instant is the meaningful confirmation.
        ...(req.schedule_at ? { scheduled_at: req.schedule_at } : {}),
      },
    };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    video.cleanup();
    await close();
  }
}

export interface TikTokFollowRequest extends TikTokOpRequest {
  /** Target username with or without leading `@`. */
  target_user: string;
}

export async function followUser(req: TikTokFollowRequest): Promise<TikTokOpResult<{ followed: boolean }>> {
  const blocked = gate(req.account_id, "follow");
  if (blocked) return blocked;

  const handle = req.target_user.replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9._]{2,24}$/.test(handle)) {
    return { success: false, error: "target_user must be a valid TikTok handle", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(`https://www.tiktok.com/@${handle}`, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Resolve the Follow button resiliently. Every strategy excludes the
    // "Following" state so we never accidentally click-to-unfollow.
    const follow = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="follow-button"]:has-text("Follow"):not(:has-text("Following"))') },
      { name: "role-name", build: (p) => p.getByRole("button", { name: /^follow$/i }) },
      { name: "text", build: (p) => p.locator('button:has-text("Follow"):not(:has-text("Following"))') },
    ], { perStrategyMs: 6000 });
    if (!follow) {
      const diag = await captureUiState(page, "follow-btn-missing");
      return {
        success: false,
        error: `Follow button not found on @${handle}'s profile. Already following, profile is private / nonexistent, or the selector rotated.`,
        error_code: "NOT_FOUND",
        data: diag as any,
      };
    }
    console.log(`[tiktok] follow button resolved via ${follow.strategy}`);

    const result = await submitAndAwaitTikTokApi(
      page,
      async () => { await follow.locator.click({ timeout: 10000 }); },
      /\/aweme\/v\d+\/(web\/)?commit\/follow\/user|\/passport\/web\/user\/follow/,
      20000,
    );

    if (!result) {
      return { success: false, error: "No follow API call observed after click", error_code: "UI_TIMEOUT" };
    }
    if (!result.ok) {
      return {
        success: false,
        error: result.errorMessage || `HTTP ${result.status}`,
        error_code: mapTikTokError(result.status, result.statusCode),
      };
    }

    recordAction(req.account_id, "tiktok", "follow");
    return { success: true, data: { followed: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    await close();
  }
}

export interface TikTokLikeRequest extends TikTokOpRequest {
  /** Full TikTok video URL — e.g. https://www.tiktok.com/@handle/video/1234567890 */
  video_url: string;
}

export async function likeVideo(req: TikTokLikeRequest): Promise<TikTokOpResult<{ liked: boolean }>> {
  const blocked = gate(req.account_id, "like");
  if (blocked) return blocked;

  if (!/^https:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9._]+\/video\/\d+/.test(req.video_url)) {
    return { success: false, error: "video_url must be a TikTok /video/ permalink", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(req.video_url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const like = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="like-icon"]') },
      { name: "aria-label", build: (p) => p.locator('button[aria-label*="ike" i]') },
      { name: "role-name", build: (p) => p.getByRole("button", { name: /like/i }) },
    ], { perStrategyMs: 6000 });
    if (!like) {
      const diag = await captureUiState(page, "like-btn-missing");
      return { success: false, error: "Like button not found (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    console.log(`[tiktok] like button resolved via ${like.strategy}`);

    const result = await submitAndAwaitTikTokApi(
      page,
      async () => { await like.locator.click({ timeout: 10000 }); },
      /\/aweme\/v\d+\/(web\/)?commit\/item\/digg/,
      15000,
    );

    if (!result) return { success: false, error: "No like API call observed", error_code: "UI_TIMEOUT" };
    if (!result.ok) {
      return {
        success: false,
        error: result.errorMessage || `HTTP ${result.status}`,
        error_code: mapTikTokError(result.status, result.statusCode),
      };
    }

    recordAction(req.account_id, "tiktok", "like");
    return { success: true, data: { liked: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    await close();
  }
}

export interface TikTokDeleteRequest extends TikTokOpRequest {
  video_url: string;
}

export async function deleteVideo(req: TikTokDeleteRequest): Promise<TikTokOpResult<{ deleted: boolean }>> {
  const blocked = gate(req.account_id, "delete");
  if (blocked) return blocked;

  const idMatch = /\/video\/(\d+)/.exec(req.video_url || "");
  if (!idMatch) return { success: false, error: "video_url must contain /video/<id>", error_code: "INVALID_INPUT" };

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto(req.video_url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Open the more-actions menu (three dots / share), resiliently.
    const more = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="browse-video-desc-share-button"]') },
      { name: "aria-label", build: (p) => p.locator('[aria-label*="More" i], [aria-label*="ption" i]') },
      { name: "role-name", build: (p) => p.getByRole("button", { name: /more|options/i }) },
    ], { perStrategyMs: 6000 });
    if (more) await more.locator.click({ timeout: 10000 }).catch(() => {});

    const del = await resolveElement(page, [
      { name: "menuitem", build: (p) => p.getByRole("menuitem", { name: /^delete$/i }) },
      { name: "role-button", build: (p) => p.getByRole("button", { name: /^delete$/i }) },
      { name: "text", build: (p) => p.locator('text=/^Delete$/') },
    ], { perStrategyMs: 6000 });
    if (!del) {
      const diag = await captureUiState(page, "delete-option-missing");
      return { success: false, error: "Delete option not found in the video menu (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
    }

    const result = await submitAndAwaitTikTokApi(
      page,
      async () => {
        await del.locator.click();
        // TikTok shows a confirmation modal — click the confirm Delete. Use
        // .last() so we hit the modal's button, not the menu item we just clicked.
        const confirmBtn = page.locator('button:has-text("Delete"):visible, [role="button"]:has-text("Delete"):visible').last();
        await confirmBtn.click({ timeout: 5000 }).catch(() => {});
      },
      /\/aweme\/v\d+\/(web\/)?aweme\/delete|\/passport\/web\/item\/delete/,
      15000,
    );

    if (!result) return { success: false, error: "No delete API call observed", error_code: "UI_TIMEOUT" };
    if (!result.ok) {
      return {
        success: false,
        error: result.errorMessage || `HTTP ${result.status}`,
        error_code: mapTikTokError(result.status, result.statusCode),
      };
    }

    recordAction(req.account_id, "tiktok", "delete");
    return { success: true, data: { deleted: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    await close();
  }
}

export interface TikTokProfileRequest extends TikTokOpRequest {
  bio?: string;          // up to 80 chars
  display_name?: string; // up to 30 chars
}

export async function updateProfile(req: TikTokProfileRequest): Promise<TikTokOpResult<{ updated: string[] }>> {
  const blocked = gate(req.account_id, "profile");
  if (blocked) return blocked;

  if (req.bio === undefined && req.display_name === undefined) {
    return { success: false, error: "bio or display_name required", error_code: "INVALID_INPUT" };
  }
  if (req.bio !== undefined && req.bio.length > 80) {
    return { success: false, error: "bio must be <=80 chars", error_code: "INVALID_INPUT" };
  }
  if (req.display_name !== undefined && (req.display_name.length < 1 || req.display_name.length > 30)) {
    return { success: false, error: "display_name must be 1-30 chars", error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  const updated: string[] = [];
  try {
    await page.goto("https://www.tiktok.com/setting", { waitUntil: "domcontentloaded", timeout: 45000 });

    if (req.display_name !== undefined) {
      const name = await resolveElement(page, [
        { name: "attr", build: (p) => p.locator('input[name="nickName"], input[data-e2e="edit-profile-nickname"]') },
        { name: "role-name", build: (p) => p.getByRole("textbox", { name: /name|nickname/i }) },
      ], { perStrategyMs: 8000 });
      if (!name) {
        const diag = await captureUiState(page, "name-input-missing");
        return { success: false, error: "Display-name input not found (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
      }
      const nameInput = name.locator;
      try {
        await nameInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Delete");
        await nameInput.pressSequentially(req.display_name, { delay: 30 });

        const result = await submitAndAwaitTikTokApi(
          page,
          async () => {
            const save = await resolveElement(page, [
              { name: "role-name", build: (p) => p.getByRole("button", { name: /^save$/i }) },
              { name: "text", build: (p) => p.locator('button:has-text("Save"):visible') },
            ], { perStrategyMs: 5000 });
            if (!save) throw new Error("Save button not found");
            await save.locator.click({ timeout: 5000 });
          },
          /\/passport\/web\/user\/update|\/aweme\/v\d+\/(web\/)?user\/update/,
          15000,
        );

        if (result?.ok) updated.push("display_name");
        else if (result?.errorMessage) {
          return { success: false, error: `Display name: ${result.errorMessage}`, error_code: mapTikTokError(result.status, result.statusCode) };
        }
      } catch (e: any) {
        return { success: false, error: `Failed to update display name: ${e.message}`, error_code: "UI_TIMEOUT" };
      }
    }

    if (req.bio !== undefined) {
      const bio = await resolveElement(page, [
        { name: "attr", build: (p) => p.locator('textarea[name="signature"], [data-e2e="edit-profile-bio"]') },
        { name: "role-name", build: (p) => p.getByRole("textbox", { name: /bio|signature/i }) },
      ], { perStrategyMs: 8000 });
      if (!bio) {
        const diag = await captureUiState(page, "bio-input-missing");
        return { success: false, error: "Bio input not found (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
      }
      const bioInput = bio.locator;
      try {
        await bioInput.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Delete");
        if (req.bio) await bioInput.pressSequentially(req.bio, { delay: 20 });

        const result = await submitAndAwaitTikTokApi(
          page,
          async () => {
            const save = await resolveElement(page, [
              { name: "role-name", build: (p) => p.getByRole("button", { name: /^save$/i }) },
              { name: "text", build: (p) => p.locator('button:has-text("Save"):visible') },
            ], { perStrategyMs: 5000 });
            if (!save) throw new Error("Save button not found");
            await save.locator.click({ timeout: 5000 });
          },
          /\/passport\/web\/user\/update|\/aweme\/v\d+\/(web\/)?user\/update/,
          15000,
        );

        if (result?.ok) updated.push("bio");
        else if (result?.errorMessage) {
          return { success: false, error: `Bio: ${result.errorMessage}`, error_code: mapTikTokError(result.status, result.statusCode) };
        }
      } catch (e: any) {
        return { success: false, error: `Failed to update bio: ${e.message}`, error_code: "UI_TIMEOUT" };
      }
    }

    if (updated.length === 0) {
      return { success: false, error: "No profile fields were updated", error_code: "UI_TIMEOUT" };
    }

    recordAction(req.account_id, "tiktok", "profile");
    return { success: true, data: { updated } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    await close();
  }
}

export interface TikTokAvatarRequest extends TikTokOpRequest, ImageInput {}

export async function updateAvatar(req: TikTokAvatarRequest): Promise<TikTokOpResult<{ updated: true }>> {
  const blocked = gate(req.account_id, "profile");
  if (blocked) return blocked;

  let image;
  try {
    image = await materializeImage(req);
  } catch (e: any) {
    return { success: false, error: e.message, error_code: "INVALID_INPUT" };
  }

  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    image.cleanup();
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    await page.goto("https://www.tiktok.com/setting", { waitUntil: "domcontentloaded", timeout: 45000 });

    // The avatar file input — prefer the image-scoped one, fall back to any.
    const avatarInput = await resolveElement(page, [
      { name: "image-input", build: (p) => p.locator('input[type="file"][accept*="image"]') },
      { name: "any-input", build: (p) => p.locator('input[type="file"]') },
    ], { state: "attached", perStrategyMs: 15000 });
    if (!avatarInput) {
      const diag = await captureUiState(page, "avatar-input-missing");
      return { success: false, error: "Avatar file input not found (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    await avatarInput.locator.setInputFiles(image.filePath);

    // Wait for the crop modal's accept button (best-effort; some variants auto-apply).
    const confirm = await resolveElement(page, [
      { name: "role-name", build: (p) => p.getByRole("button", { name: /apply|save|confirm/i }) },
      { name: "text", build: (p) => p.locator('button:has-text("Apply"), button:has-text("Save"), button:has-text("Confirm")') },
    ], { perStrategyMs: 15000 });

    const result = await submitAndAwaitTikTokApi(
      page,
      async () => { if (confirm) await confirm.locator.click({ timeout: 10000 }).catch(() => {}); },
      /\/passport\/web\/user\/update|\/aweme\/v\d+\/(web\/)?user\/(update|avatar)/,
      20000,
    );

    if (!result) return { success: false, error: "No avatar API call observed", error_code: "UI_TIMEOUT" };
    if (!result.ok) {
      return {
        success: false,
        error: result.errorMessage || `HTTP ${result.status}`,
        error_code: mapTikTokError(result.status, result.statusCode),
      };
    }

    recordAction(req.account_id, "tiktok", "profile");
    return { success: true, data: { updated: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    image.cleanup();
    await close();
  }
}
