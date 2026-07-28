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
import { openAuthenticatedSession, profileForCountry, pendingRequests } from "./social-runtime";
import { fetchSsrfSafe } from "./email";
import { randomUUID } from "crypto";
import { checkRateLimit, recordAction } from "./social-rate-limit";
import { resolveElement, axSnapshot, waitForHydrated, HYDRATION_PROBES } from "./social-selectors";
import { wallClockInTz, pad2, type WallClock } from "./schedule-time";
import { recordSample, postedAtFromVideoId } from "./tiktok-metrics";

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
    /**
     * The page loaded but the content the op needed never rendered, so NOTHING
     * about the target's state was actually observed. Distinct from NOT_FOUND,
     * which asserts we looked at rendered content and the thing was absent —
     * conflating the two is what let "already following" and "already deleted"
     * be reported about accounts and posts nobody had checked.
     */
    | "NOT_READY"
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
): Promise<{
  diag_screenshot?: string;
  interactive_elements?: Array<{ role: string; name: string }>;
  controls?: string;
  pending?: Array<{ url: string; method: string; resourceType: string; ageMs: number }>;
}> {
  const [diag_screenshot, interactive_elements] = await Promise.all([
    debugShot(page, tag),
    axSnapshot(page),
  ]);
  // Rich control dump (data-e2e / aria-label / tag / text) — more complete than
  // the AX tree for pinning a rotated selector. Logged to the server console.
  const controls: string = await page.evaluate(`(()=>{
    const els=[...document.querySelectorAll('button,[role="button"],[data-e2e],input,textarea')].filter(e=>e.getClientRects().length>0);
    const seen=new Set(); const out=[];
    for(const e of els){ const t=(e.textContent||'').trim().slice(0,24); const de=e.getAttribute('data-e2e'); const al=e.getAttribute('aria-label'); if(!de&&!al&&!t)continue; const k=e.tagName+'|'+de+'|'+al+'|'+t; if(seen.has(k))continue; seen.add(k); out.push((de?'@'+de:'')+(al?' [al='+al+']':'')+' <'+e.tagName.toLowerCase()+(e.name?' name='+e.name:'')+'> '+t); if(out.length>=45)break; }
    return out.join('  ||  ');
  })()`).catch(() => "");
  if (controls) console.log("[tiktok] " + tag + " controls: " + controls);
  // What the page was still waiting on. For a readiness failure this is the
  // signal that actually identifies the cause — a mounted-but-empty control
  // means a fetch never returned, and this names it.
  const stalled = pendingRequests(page);
  if (stalled.length > 0) {
    console.log(
      "[tiktok] " + tag + " pending: " +
      stalled.map(r => `${r.resourceType} ${r.method} ${r.url} (${Math.round(r.ageMs / 1000)}s)`).join("  ||  "),
    );
  }
  return { diag_screenshot, interactive_elements, controls, pending: stalled };
}

/**
 * TikTok Studio pops intro / promo / consent modals (`TUXModal-overlay`) that
 * intercept pointer events — especially on a fresh profile — so a click on the
 * caption box or Post button silently times out. Best-effort dismiss before we
 * interact: try a close/affirmative button, else press Escape. Returns true if a
 * modal was present.
 */
async function dismissBlockingModal(page: any, windowMs: number = 12000): Promise<boolean> {
  // The "Turn on automatic content checks?" modal (Cancel/Turn on) appears a few
  // seconds AFTER the upload finishes — not necessarily when the editor first
  // renders — and a "New features" toast can stack on it. So POLL for an overlay
  // across a window and dismiss whatever appears, proceeding only once it's been
  // clear for a couple of checks. "Cancel" dismisses the content-checks prompt
  // without enabling the optional checks (we just want to post).
  // Dismiss inside page JS via a programmatic .click() — a real mouse click is
  // defeated by the overlay's pointer-event interception, but el.click() still
  // fires React's handler. We scan each visible overlay for a dismiss button by
  // exact label and click it; logs the buttons it sees for diagnosis.
  let dismissed = false;
  let consecutiveClear = 0;
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline && consecutiveClear < 2) {
    const res: string = await page.evaluate(`(()=>{
      const ovs=[...document.querySelectorAll('.TUXModal-overlay,.react-joyride__overlay')].filter(o=>o.getClientRects().length>0);
      if(!ovs.length) return JSON.stringify({open:0});
      // react-joyride explicit skip/close first (its buttons sit OUTSIDE the overlay).
      for(const id of ['button-skip','button-close']){
        const el=document.querySelector('[data-test-id="'+id+'"]');
        if(el && el.getClientRects().length){ el.click(); return JSON.stringify({open:ovs.length, clicked:id}); }
      }
      // text-labelled dismiss buttons anywhere (TUX "Cancel", joyride "Got it"/"Skip"/"Next").
      const labels=['cancel','skip','skip all','skip tour','got it','no thanks','not now','maybe later','close','dismiss','done','finish','next'];
      const btns=[...document.querySelectorAll('button,[role="button"]')].filter(b=>b.getClientRects().length>0);
      const seen=btns.map(b=>(b.textContent||'').trim()).filter(Boolean).slice(0,15);
      for(const b of btns){ const t=(b.textContent||'').trim().toLowerCase(); if(labels.includes(t)){ b.click(); return JSON.stringify({open:ovs.length, clicked:t, buttons:seen}); } }
      const x=document.querySelector('[aria-label*="lose" i],[aria-label*="dismiss" i],[aria-label*="kip" i]');
      if(x && x.getClientRects().length){ x.click(); return JSON.stringify({open:ovs.length, clicked:'[aria]', buttons:seen}); }
      return JSON.stringify({open:ovs.length, clicked:null, buttons:seen});
    })()`).catch((e: any) => JSON.stringify({ err: String(e?.message || e) }));
    console.log("[tiktok] modal-dismiss: " + res);
    let parsed: any = {};
    try { parsed = JSON.parse(res); } catch {}
    if (parsed.open) {
      consecutiveClear = 0;
      if (parsed.clicked) dismissed = true;
      else await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(700);
    } else {
      consecutiveClear++;
      await page.waitForTimeout(500);
    }
  }
  return dismissed;
}

/**
 * Set the "Who can see this post" audience. It's a
 * `button[role="combobox"][aria-haspopup="dialog"]` showing the current value
 * ("Everyone" by default); we open it and pick the option, then VERIFY the
 * trigger now shows the wanted value. Returns ok=false if it can't be confirmed
 * — the caller ABORTS rather than publish to the wrong audience.
 */
async function setPrivacy(page: any, privacy: 1 | 2): Promise<{ ok: boolean; value?: string; error?: string }> {
  // Audience options are [role="option"]; the private one is exactly "Only you".
  const wanted = privacy === 2 ? /only you/i : /friends/i;
  // Scope to the "Who can see this post" row — there are other comboboxes on the
  // page (e.g. Location), so a bare .first() grabs the wrong one.
  const label = page.getByText(/Who can see this post/i).first();
  if (!(await label.isVisible({ timeout: 4000 }).catch(() => false))) {
    return { ok: false, error: "'Who can see this post' label not found" };
  }
  const row = label.locator('xpath=ancestor::*[.//button[@role="combobox" and @aria-haspopup="dialog"]][1]');
  const trigger = row.locator('button[role="combobox"][aria-haspopup="dialog"]').first();
  // The value lives in a child div, not the button's textContent — read it off
  // the whole row (minus the label).
  const readValue = async () =>
    String((await row.textContent().catch(() => "")) || "").replace(/who can see this post/i, "").trim();
  if (!(await trigger.isVisible({ timeout: 3000 }).catch(() => false))) {
    return { ok: false, error: "audience dropdown not found in the row" };
  }
  await trigger.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(700);
  const opt = await resolveElement(page, [
    { name: "role-option", build: (p) => p.getByRole("option", { name: wanted }) },
    { name: "dialog-text", build: (p) => p.locator('[role="dialog"],[role="listbox"]').getByText(wanted) },
  ], { perStrategyMs: 2500 });
  if (!opt) {
    await page.keyboard.press("Escape").catch(() => {});
    return { ok: false, error: "audience option not found in the dropdown" };
  }
  await opt.locator.click({ timeout: 4000 }).catch(() => {});
  // Wait for the dropdown to close before reading back — a fixed sleep races the
  // value update under latency.
  await page.locator('[role="option"]').first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
  const shown = await readValue();
  return { ok: wanted.test(shown), value: shown.slice(0, 40) };
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
  // 1. Select "Schedule" — JS-click the radio input by value. This fired the
  //    consent modal reliably in testing; a label/real click did not.
  const sel: string = await page.evaluate(`(()=>{const r=document.querySelector('input[name="postSchedule"][value="schedule"]');if(!r)return 'no-radio';r.click();return r.checked?'checked':'clicked';})()`).catch(() => "err");
  if (sel === "no-radio") return { ok: false, error: "'Schedule' option not found" };
  await page.waitForTimeout(1100);

  // 2. Consent modal "Allow your video to be saved for scheduled posting?" —
  //    click Allow (NOT Cancel): real click first, JS-click fallback.
  let allowed = false;
  const allowBtn = page.locator('button:has-text("Allow")').first();
  if (await allowBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await allowBtn.click({ timeout: 3000 }).catch(() => {});
    allowed = true;
  } else {
    allowed = await page.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/allow/i.test((x.textContent||'').trim())&&(x.textContent||'').trim().length<20);if(b){b.click();return true;}return false;})()`).catch(() => false);
  }
  await page.waitForTimeout(1300);

  // Reveal the date/time picker (a button[aria-haspopup=dialog] that isn't a
  // Select__trigger dropdown), then read its inputs.
  await page.locator('button[aria-haspopup="dialog"]:not(.Select__trigger)').first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(900);

  // 3. Date + time are plain text inputs (TUXTextInputCore-input): "YYYY-MM-DD"
  //    and "HH:MM" (24h, 5-min granularity). Type, then VERIFY — abort on
  //    mismatch so we never publish at the wrong time.
  let hh = when.h, mi = Math.round(when.mi / 5) * 5;
  if (mi === 60) { mi = 0; hh = (hh + 1) % 24; }
  const timeStr = `${pad2(hh)}:${pad2(mi)}`;
  const dateStr = `${when.y}-${pad2(when.mo)}-${pad2(when.d)}`;

  const findFields = async (): Promise<{ t: any; d: any }> => {
    let t: any = null, d: any = null;
    const fields = page.locator("input.TUXTextInputCore-input");
    const c = await fields.count().catch(() => 0);
    for (let i = 0; i < c; i++) {
      const v = String((await fields.nth(i).inputValue().catch(() => "")) || "");
      if (/^\d{1,2}:\d{2}/.test(v)) t = fields.nth(i);
      else if (/^\d{4}-\d{2}-\d{2}/.test(v)) d = fields.nth(i);
    }
    return { t, d };
  };
  let timeInput: any = null, dateInput: any = null;
  for (let attempt = 0; attempt < 4 && (!timeInput || !dateInput); attempt++) {
    const f = await findFields();
    timeInput = timeInput || f.t; dateInput = dateInput || f.d;
    if (!timeInput || !dateInput) await page.waitForTimeout(800);
  }
  console.log(`[tiktok] schedule: radio=${sel} allow=${allowed} time_field=${!!timeInput} date_field=${!!dateInput}`);
  if (!timeInput || !dateInput) return { ok: false, error: "date/time fields not found after enabling Schedule" };

  // Escape closes the date calendar (and keeps the typed date), but it REVERTS
  // the time picker — so only Escape for the date field; commit the time by
  // blurring (click a neutral label) instead.
  const setField = async (input: any, value: string, esc: boolean) => {
    await input.click().catch(() => {});
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await input.pressSequentially(value, { delay: 50 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    if (esc) { await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(200); }
  };
  await setField(dateInput, dateStr, true);

  // Time is a scroll picker (tiktok-timepicker), not free-text — open it and
  // click the hour cell (1st option-list, 24 items) + minute cell (2nd list, 12
  // items at 5-min steps).
  await timeInput.click().catch(() => {});
  await page.waitForTimeout(800);
  const lists = page.locator(".tiktok-timepicker-option-list");
  const hourItem = lists.nth(0).locator(".tiktok-timepicker-option-item", { hasText: new RegExp(`^${pad2(hh)}$`) }).first();
  await hourItem.scrollIntoViewIfNeeded().catch(() => {});
  await hourItem.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  const minItem = lists.nth(1).locator(".tiktok-timepicker-option-item", { hasText: new RegExp(`^${pad2(mi)}$`) }).first();
  await minItem.scrollIntoViewIfNeeded().catch(() => {});
  await minItem.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  // close the picker by blurring onto a neutral label
  await page.getByText(/Who can see this post/i).first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(400);

  const dv = String((await dateInput.inputValue().catch(() => "")) || "");
  const tv = String((await timeInput.inputValue().catch(() => "")) || "");
  if (!dv.startsWith(dateStr)) return { ok: false, error: `date field shows "${dv}", expected ${dateStr}` };
  if (!tv.startsWith(timeStr)) return { ok: false, error: `time field shows "${tv}", expected ${timeStr}` };
  console.log(`[tiktok] schedule set to ${dateStr} ${timeStr}`);
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

/**
 * Resolve a published video's URL + id from the Studio content manager (the
 * post redirect lands there but carries no id). Matches the row by caption
 * (polled, since a new row can take a moment to appear), falling back to the
 * newest post.
 *
 * `matched` reports HOW the result was obtained, and callers must respect it.
 * The newest-post fallback is sound when we already know a post published and
 * only need its URL — it is catastrophic as evidence that a *specific* post
 * landed. Returning it unlabelled meant the reconciliation oracle could never
 * answer "not posted" for any account with prior content: an ambiguous post
 * that never published was marked `posted`, handed the previous video's URL,
 * and never refunded. The documented safety property — "we never blind-refund a
 * post that landed" — was inverted into "we never refund a post that didn't".
 */
export async function findPostedVideo(
  page: any,
  caption: string,
): Promise<{ video_id?: string; video_url?: string; matched: "caption" | "newest" | "none" }> {
  if (!/tiktokstudio\/(content|posts)/i.test(String(page.url()))) {
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  }
  await page.locator('a[href*="/video/"]').first().waitFor({ timeout: 15000 }).catch(() => {});
  const key = (caption || "").trim().slice(0, 24).toLowerCase();
  let href: string | null = null;
  let matched: "caption" | "newest" | "none" = "caption";
  if (key) {
    for (let i = 0; i < 4 && !href; i++) {
      href = await page.evaluate(`(()=>{
        const links=[...document.querySelectorAll('a[href*="/video/"]')];
        const m = links.find(a => (a.textContent||'').trim().toLowerCase().includes(${JSON.stringify(key)}));
        return m ? m.getAttribute('href') : null;
      })()`).catch(() => null);
      if (!href) await page.waitForTimeout(1500);
    }
  }
  if (!href) {
    // Fallback: the NEWEST post — don't assume the list is sorted newest-first.
    // TikTok video ids are time-ordered, so the largest id is newest. Compare as
    // numeric strings (by length, then lexicographically) — 19-digit ids overflow
    // JS Number precision.
    href = await page.evaluate(`(()=>{
      let best=null, bestId='';
      for (const a of document.querySelectorAll('a[href*="/video/"]')) {
        const m=/\\/video\\/(\\d+)/.exec(a.getAttribute('href')||'');
        if(!m) continue;
        const id=m[1];
        if(id.length>bestId.length || (id.length===bestId.length && id>bestId)){ bestId=id; best=a; }
      }
      return best ? best.getAttribute('href') : null;
    })()`).catch(() => null);
    matched = href ? "newest" : "none";
  }
  if (!href) return { matched: "none" };
  const full = href.startsWith("http") ? href : `https://www.tiktok.com${href}`;
  const idm = /\/video\/(\d+)/.exec(full);
  return { video_url: full, video_id: idm ? idm[1] : undefined, matched };
}

/**
 * Reconciliation oracle for the async post worker: "did a video with this
 * caption actually publish?" Opens a fresh authenticated session and scrapes
 * the Studio content manager via findPostedVideo. Used when a post attempt is
 * AMBIGUOUS (submit was clicked but no confirmation observed, or the op threw
 * mid-flight) so we never blind-refund a post that actually landed, nor leave a
 * payer charged for one that didn't — the TikTok analogue of the registrar
 * getInfo oracle in domain-registration. Best-effort: `determined:false` means
 * we couldn't open a session / scrape (treat as unresolved, never as proof).
 */
export async function checkPostedByCaption(
  req: TikTokOpRequest & { caption: string }
): Promise<TikTokOpResult<{ determined: boolean; posted: boolean; video_url?: string; video_id?: string }>> {
  let session;
  try {
    session = await openAuthenticatedSession({
      accountId: req.account_id,
      proxySessionId: req.proxy_session_id,
      cookies: req.cookies,
      country: req.country,
    });
  } catch (e: any) {
    // Can't open a session — outcome stays unresolved (not "not posted").
    return { success: true, data: { determined: false, posted: false } };
  }
  const { page, close } = session;
  try {
    await page.goto("https://www.tiktok.com/tiktokstudio/content", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    }).catch(() => {});
    const found = await findPostedVideo(page, req.caption);
    // ONLY a caption match is proof that THIS post landed. The newest-post
    // fallback returns whatever the account most recently published, which for
    // any account with prior content is someone else's evidence — accepting it
    // here is what made this oracle unable to ever answer "not posted".
    const posted = found.matched === "caption";
    if (found.matched === "newest") {
      console.warn(
        `[tiktok] reconcile: no row matched the caption for ${req.account_id}; ` +
        `ignoring the newest-post fallback and reporting NOT posted`,
      );
    }
    return {
      success: true,
      data: posted
        ? { determined: true, posted: true, video_url: found.video_url, video_id: found.video_id }
        : { determined: true, posted: false },
    };
  } catch {
    return { success: true, data: { determined: false, posted: false } };
  } finally {
    await close().catch(() => {});
  }
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

    // Clear any blocking intro/consent modal before interacting with the editor.
    if (await dismissBlockingModal(page)) console.log("[tiktok] dismissed a blocking modal overlay");

    // Clear any auto-filled caption, type the user's caption.
    await captionBox.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await captionBox.pressSequentially(req.caption, { delay: 15 });
    await page.waitForTimeout(500);

    // Set the native schedule FIRST — doing it after the privacy dropdown leaves
    // the page in a state where the Schedule radio won't engage. ABORT before
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

    // Apply privacy / comments / duet / stitch toggles if the user set non-defaults.
    if (req.privacy === 1 || req.privacy === 2) {
      const pr = await setPrivacy(page, req.privacy);
      if (!pr.ok) {
        const diag = await captureUiState(page, "privacy-set-failed");
        return {
          success: false,
          error: `Could not set audience to ${req.privacy === 2 ? "Only you" : "Friends"} (control showed "${pr.value || pr.error}"). Aborted before posting to avoid publishing to the wrong audience.`,
          error_code: "INVALID_INPUT",
          data: diag as any,
        };
      }
      console.log(`[tiktok] audience set to "${pr.value}"`);
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

    // A modal may have re-appeared after typing/scheduling — clear it before submit.
    await dismissBlockingModal(page);

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
      // TikTok Studio redirects to the content/posts page on a successful post
      // (its upload XHR isn't the classic /aweme/post path), so treat that
      // redirect — or a success toast — as success rather than a false negative.
      const url = String(page.url());
      const posted = /tiktokstudio\/(content|posts)/i.test(url)
        || await page.locator('text=/your (video|post).*(posted|uploaded|scheduled|published)|posted successfully|scheduled successfully/i')
             .first().isVisible({ timeout: 3000 }).catch(() => false);
      if (posted) {
        recordAction(req.account_id, "tiktok", "post");
        console.log(`[tiktok] post confirmed via redirect/toast (url=${url})`);
        // The redirect doesn't carry the new video's id, so (for instant posts)
        // look it up in the content manager we just landed on. Best-effort:
        // never fail the post over it.
        //
        // Only a CAPTION match may be published as this post's URL. The newest
        // -post fallback is a guess, and when the new row simply hasn't rendered
        // yet that guess is the account's PREVIOUS video — which then gets
        // written to the caller's post log as the URL of the video they just
        // made. A successful post with no URL is recoverable; a successful post
        // carrying a link to unrelated content is not.
        const resolved = req.schedule_at ? undefined : await findPostedVideo(page, req.caption).catch(() => undefined);
        if (resolved && resolved.matched === "newest") {
          console.warn(
            `[tiktok] post confirmed but its row had not rendered; omitting video_url rather than returning the previous video's`,
          );
        }
        const found = resolved?.matched === "caption"
          ? { video_url: resolved.video_url, video_id: resolved.video_id }
          : undefined;
        return {
          success: true,
          data: {
            ...(found || {}),
            ...(req.schedule_at ? { scheduled_at: req.schedule_at } : {}),
          },
        };
      }
      const diag = await captureUiState(page, "no-post-api");
      return {
        success: false,
        error: "No post confirmation observed after clicking Post — UI flow may have changed.",
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
    const diag = await captureUiState(page, "post-unknown-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
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

    // The action buttons are auth-gated and hydrate LAST — long after the
    // profile's name, counts, bio and video grid have painted. Every strategy
    // below matches on the literal text "Follow", so running them against an
    // unlabelled skeleton button cannot succeed no matter how long they wait.
    // Gate on the row being genuinely rendered first; without this the op
    // reported "already following / selector rotated" on a perfectly healthy
    // session, which is what it did on every attempt in production.
    const actionsReady = await waitForHydrated(page, HYDRATION_PROBES.profileActions, { timeoutMs: 30000 });
    if (!actionsReady) {
      const diag = await captureUiState(page, "follow-actions-not-hydrated");
      return {
        success: false,
        error: `@${handle}'s profile loaded but its action buttons never rendered, so the follow control could not be read. This is a page-readiness failure, not a confirmed state of the account.`,
        error_code: "NOT_READY",
        data: diag as any,
      };
    }

    // TikTok pops intro/promo modals over the profile — "especially on a fresh
    // profile", as dismissBlockingModal's own header notes — and a TUXModal
    // overlay swallows the click on a button that is otherwise visible,
    // enabled and stable. Playwright then retries for ten seconds and fails
    // with a click timeout that looks nothing like "a modal was in the way".
    // The post flow already dismisses these; the public-site ops never did.
    if (await dismissBlockingModal(page, 6000)) console.log("[tiktok] dismissed a modal covering the follow control");

    // Resolve the Follow button resiliently. Every strategy excludes the
    // "Following" state so we never accidentally click-to-unfollow.
    const follow = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="follow-button"]:has-text("Follow"):not(:has-text("Following"))') },
      { name: "role-name", build: (p) => p.getByRole("button", { name: /^follow$/i }) },
      { name: "text-exact", build: (p) => p.getByText(/^Follow$/) },
      { name: "text", build: (p) => p.locator('button:has-text("Follow"):not(:has-text("Following")), [role="button"]:has-text("Follow"):not(:has-text("Following"))') },
    ], { perStrategyMs: 8000 });
    if (!follow) {
      // The row IS rendered (probe passed) and no actionable Follow control is
      // in it — so an existing relationship is now a supported conclusion
      // rather than a guess. Report it as success: the caller's intent, that we
      // follow this account, already holds.
      // Text-based, matching the probe: the live page carried no
      // data-e2e="follow-button" at all, so anchoring this on that attribute
      // would make the check silently unreachable.
      const already = await page.evaluate(`(() => {
        const els = document.querySelectorAll('button, [role="button"]');
        for (const el of els) {
          if (el.querySelector('button, [role="button"]')) continue;
          if (/^(following|friends|requested)$/i.test((el.textContent || '').trim())) return true;
        }
        return false;
      })()`).catch(() => false);
      if (already) {
        console.log(`[tiktok] already following @${handle} — treating as satisfied`);
        return { success: true, data: { followed: true } };
      }
      const diag = await captureUiState(page, "follow-btn-missing");
      return {
        success: false,
        error: `No follow control on @${handle}'s profile after it rendered. The profile may be private, restricted or nonexistent, or the selector rotated.`,
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
      // API endpoint may differ — confirm by the button flipping out of "Follow"
      // (to Following / Friends / Requested).
      const flipped = await page.locator('[data-e2e="follow-button"]:has-text("Following"), [data-e2e="follow-button"]:has-text("Friends"), [data-e2e="follow-button"]:has-text("Requested")')
        .first().isVisible({ timeout: 4000 }).catch(() => false);
      if (flipped) {
        recordAction(req.account_id, "tiktok", "follow");
        console.log("[tiktok] follow confirmed via button flip");
        return { success: true, data: { followed: true } };
      }
      const diag = await captureUiState(page, "follow-no-confirm");
      return { success: false, error: "No follow confirmation observed after click (no API, button didn't flip).", error_code: "UI_TIMEOUT", data: diag as any };
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

    // Same readiness trap as follow: the engagement rail hydrates after the
    // video shell. Observed live — a failed like's diagnostics contained just
    // two elements, the recommend container and the video section, with no
    // action rail at all. Resolving against that reports a rotated selector for
    // a page that had simply not finished rendering.
    const railReady = await waitForHydrated(page, HYDRATION_PROBES.videoActions, { timeoutMs: 30000 });
    if (!railReady) {
      const diag = await captureUiState(page, "like-rail-not-hydrated");
      return {
        success: false,
        error: "The video page loaded but its engagement controls never rendered, so the like state could not be read.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }

    if (await dismissBlockingModal(page, 6000)) console.log("[tiktok] dismissed a modal covering the like control");

    const like = await resolveElement(page, [
      { name: "data-e2e", build: (p) => p.locator('[data-e2e="like-icon"]') },
      { name: "aria-label", build: (p) => p.locator('button[aria-label*="ike" i]') },
      { name: "role-name", build: (p) => p.getByRole("button", { name: /like/i }) },
    ], { perStrategyMs: 6000 });
    if (!like) {
      const diag = await captureUiState(page, "like-btn-missing");
      return { success: false, error: "No like control on the video page after it rendered (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    console.log(`[tiktok] like button resolved via ${like.strategy}`);

    const result = await submitAndAwaitTikTokApi(
      page,
      async () => { await like.locator.click({ timeout: 10000 }); },
      /commit\/item\/digg|\/digg(\/|\?|$)/i,
      15000,
    );

    if (!result) {
      const diag = await captureUiState(page, "like-no-api");
      return { success: false, error: "No like API call observed (digg endpoint not seen).", error_code: "UI_TIMEOUT", data: diag as any };
    }
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

  const videoId = idMatch[1];
  const { page, close } = session;
  try {
    // Deletion lives in the TikTok Studio post manager — NOT the public
    // /video/ watch page, whose "..." menu only has player options + Report.
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 45000 });

    // This wait used to accept the search box OR a post link — and the search
    // box is part of the navigation shell, so it was satisfied before a single
    // row existed. The `.catch(() => {})` then swallowed even a real timeout.
    // Live proof: a delete of a video that demonstrably WAS in the content
    // manager (analytics listed it a minute earlier) failed with "already
    // deleted", and its diagnostics contained only the Studio nav buttons and
    // zero rows. Gate on rows actually being present.
    const listState = await waitForHydrated(page, HYDRATION_PROBES.studioContent, { timeoutMs: 30000 });
    if (!listState) {
      const diag = await captureUiState(page, "delete-list-not-hydrated");
      return {
        success: false,
        error: "The content manager never finished rendering, so the post list could not be read. The post's existence was not determined.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }

    // Match the post's row by the video id carried in its title link. Presence
    // in the DOM is the test, not Playwright visibility: the list is rendered
    // and we only need the anchor to exist to walk to its row.
    const titleLink = page.locator(`a[href*="/video/${videoId}"]`).first();
    if ((await titleLink.count().catch(() => 0)) === 0) {
      const diag = await captureUiState(page, "delete-row-missing");
      return { success: false, error: `Post ${videoId} is not in the content manager listing (already deleted, or on a later page).`, error_code: "NOT_FOUND", data: diag as any };
    }

    // Row = nearest ancestor that also holds the privacy (TUXButton) control;
    // the "..." more-trigger is the last (icon-only) button in that row.
    const row = titleLink.locator('xpath=ancestor::*[.//button[contains(@class,"TUXButton")]][1]');
    const moreBtn = row.locator("button").last();
    await moreBtn.click({ timeout: 8000 });
    await page.waitForTimeout(800);

    // Popup menu (Pin to top / Download / Delete) — the red "Delete" raises a
    // confirm dialog (it does NOT delete on its own).
    const menuDelete = await resolveElement(page, [
      { name: "menuitem", build: (p) => p.getByRole("menuitem", { name: /^delete$/i }) },
      { name: "text", build: (p) => p.getByText(/^Delete$/) },
    ], { perStrategyMs: 5000 });
    if (!menuDelete) {
      const diag = await captureUiState(page, "delete-menu-missing");
      return { success: false, error: "Delete not found in the post's '...' menu (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    await menuDelete.locator.click({ timeout: 5000 });
    await page.waitForTimeout(800);

    // Confirm dialog → the LAST visible "Delete" button actually performs it
    // (the menu item we just clicked is now hidden, so :visible scopes us to
    // the dialog button).
    const confirm = page.locator('button:has-text("Delete"):visible, [role="button"]:has-text("Delete"):visible').last();
    await confirm.click({ timeout: 6000 });

    // The row detaching is the first signal — but a row can also detach from a
    // re-sort/repaginate, so reload and re-confirm the post is genuinely gone.
    await titleLink.waitFor({ state: "detached", timeout: 12000 }).catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.locator('input[placeholder*="Search for post" i], a[href*="/video/"]').first().waitFor({ timeout: 15000 }).catch(() => {});
    const stillThere = await page.locator(`a[href*="/video/${videoId}"]`).first().isVisible({ timeout: 5000 }).catch(() => false);
    if (stillThere) {
      const diag = await captureUiState(page, "delete-still-present");
      return { success: false, error: "Clicked delete but the post still appears in the content manager.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    recordAction(req.account_id, "tiktok", "delete");
    console.log(`[tiktok] deleted post ${videoId} via Studio content manager`);
    return { success: true, data: { deleted: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    await close();
  }
}

/**
 * Reach the logged-in user's own profile (via the left-nav profile link — no
 * username needed) and open the "Edit profile" modal. Bio, display name and
 * avatar all live behind this single modal (TikTok moved them off /setting).
 * Returns true once the modal's Save button is present.
 */
async function openEditProfileModal(page: any): Promise<boolean> {
  // Resolve our own profile URL from the nav link, then navigate to it
  // directly — more reliable than clicking, which the SPA can race or an
  // overlay can intercept.
  if (!/tiktok\.com\/@[\w.]/.test(String(page.url()))) {
    await page.goto("https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    const navLink = page.locator('a[data-e2e="nav-profile"]').first();
    // waitFor (not isVisible) so we poll until the SPA nav hydrates.
    await navLink.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    // The href hydrates from a bare "/@" placeholder to "/@<username>" a beat
    // after the link appears — poll until a real username is present, else the
    // direct navigation 404s.
    let href: string | null = null;
    for (let i = 0; i < 12; i++) {
      href = await navLink.getAttribute("href").catch(() => null);
      if (href && /\/@[\w.]+/.test(href)) break;
      await page.waitForTimeout(700);
    }
    if (href && /\/@[\w.]+/.test(href)) {
      const url = href.startsWith("http") ? href : `https://www.tiktok.com${href}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    } else {
      // Fallback: let the SPA navigate (it knows the username internally).
      await navLink.click().catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
  // The profile can transiently render "Something went wrong" or a bare splash
  // on first load — reload-and-retry a few times before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    const entrance = page.locator('[data-e2e="edit-profile-entrance"]').first();
    if (await entrance.waitFor({ state: "visible", timeout: 12000 }).then(() => true).catch(() => false)) {
      await entrance.click({ timeout: 8000 }).catch(() => {});
      if (await page.locator('[data-e2e="edit-profile-save"]').first()
        .waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false)) {
        return true;
      }
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  return false;
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
    // Name + bio share one "Edit profile" modal on the profile page.
    const opened = await openEditProfileModal(page);
    if (!opened) {
      const diag = await captureUiState(page, "edit-profile-entrance-missing");
      return { success: false, error: "Could not open the Edit-profile modal (session may be logged out).", error_code: "UI_TIMEOUT", data: diag as any };
    }

    if (req.display_name !== undefined) {
      const nameInput = page.locator('input[data-e2e="edit-profile-name"], input[placeholder="Name" i]').first();
      if (!(await nameInput.isVisible({ timeout: 6000 }).catch(() => false))) {
        const diag = await captureUiState(page, "name-input-missing");
        return { success: false, error: "Name input not found in the Edit-profile modal.", error_code: "UI_TIMEOUT", data: diag as any };
      }
      await nameInput.fill(req.display_name);
      updated.push("display_name");
    }

    if (req.bio !== undefined) {
      const bioInput = page.locator('textarea[data-e2e="edit-profile-bio-input"], textarea[placeholder="Bio" i]').first();
      if (!(await bioInput.isVisible({ timeout: 6000 }).catch(() => false))) {
        const diag = await captureUiState(page, "bio-input-missing");
        return { success: false, error: "Bio input not found in the Edit-profile modal.", error_code: "UI_TIMEOUT", data: diag as any };
      }
      await bioInput.fill(req.bio);
      updated.push("bio");
    }

    if (updated.length === 0) {
      return { success: false, error: "No profile fields were updated", error_code: "UI_TIMEOUT" };
    }

    // If the requested value(s) already match, TikTok keeps Save disabled — that
    // is a no-op success (we're already in the desired state).
    const save = page.locator('[data-e2e="edit-profile-save"]').first();
    await save.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500); // let the button's enabled-state settle after fill
    if (await save.isDisabled().catch(() => false)) {
      recordAction(req.account_id, "tiktok", "profile");
      console.log(`[tiktok] profile values already current (Save disabled) — ${updated.join(", ")}`);
      return { success: true, data: { updated } };
    }

    // Save. A bio TikTok dislikes is rejected INLINE (the modal stays open), so
    // the modal-stays-open check catches bad-bio rejections directly.
    await save.click({ timeout: 8000 });
    const closed = await save.waitFor({ state: "detached", timeout: 12000 }).then(() => true).catch(() => false);
    if (!closed) {
      const diag = await captureUiState(page, "profile-save-stuck");
      return { success: false, error: "Clicked Save but the Edit-profile modal didn't close — TikTok rejected the value.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    // Read-back guard for the DISPLAY NAME only: TikTok SILENTLY rejects a
    // nickname change when it's on cooldown (~once a week) — the modal closes
    // regardless, so the only tell is the title not changing. (Bio rejections are
    // inline, caught above, so bio needs no read-back.) Resilient to the profile's
    // flaky loads: judge only once the title actually renders; if it never does,
    // trust the closed modal rather than false-failing.
    if (req.display_name !== undefined) {
      const want = req.display_name.trim().toLowerCase();
      let verdict: "applied" | "mismatch" | "unknown" = "unknown";
      for (let attempt = 0; attempt < 2 && verdict === "unknown"; attempt++) {
        for (let i = 0; i < 6; i++) {
          const title = ((await page.locator('[data-e2e="user-title"]').first().textContent({ timeout: 3000 }).catch(() => "")) || "").trim();
          if (title) { verdict = title.toLowerCase() === want ? "applied" : "mismatch"; break; }
          await page.waitForTimeout(700);
        }
        if (verdict === "unknown") await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      }
      if (verdict === "mismatch") {
        const toast = ((await page.locator('[class*="Toast" i], [role="alert"]').first().textContent({ timeout: 1500 }).catch(() => "")) || "").trim();
        return {
          success: false,
          error: `Display name did not apply${toast ? ` (TikTok: "${toast}")` : " — TikTok limits nickname changes to about once a week"}.`,
          error_code: "RATE_LIMITED",
        };
      }
    }

    recordAction(req.account_id, "tiktok", "profile");
    console.log(`[tiktok] updated profile (${updated.join(", ")}) via Edit-profile modal`);
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
      // The crop dialog renders the uploaded image and success is verified by
      // the avatar actually changing — this is the one op where pixels matter.
      loadMedia: true,
    });
  } catch (e: any) {
    image.cleanup();
    return { success: false, error: `Failed to open session: ${e.message}`, error_code: "LAUNCH_FAILED" };
  }

  const { page, close } = session;
  try {
    // Avatar lives behind the same "Edit profile" modal as bio/name.
    const opened = await openEditProfileModal(page);
    if (!opened) {
      const diag = await captureUiState(page, "edit-profile-entrance-missing");
      return { success: false, error: "Could not open the Edit-profile modal (session may be logged out).", error_code: "UI_TIMEOUT", data: diag as any };
    }

    // Snapshot the current avatar URL (profile renders behind the modal) so we
    // can confirm it actually changed after save.
    const beforeSrc = await page.locator('[data-e2e="user-avatar"] img').first().getAttribute("src").catch(() => null);

    // The modal's hidden file input — setInputFiles works without clicking the
    // edit-icon first.
    const fileInput = page.locator('input[type="file"]').first();
    if (!(await fileInput.count())) {
      const diag = await captureUiState(page, "avatar-input-missing");
      return { success: false, error: "Avatar file input not found in the Edit-profile modal.", error_code: "UI_TIMEOUT", data: diag as any };
    }
    await fileInput.setInputFiles(image.filePath);
    await page.waitForTimeout(1500);

    // Uploading opens a crop/preview dialog — confirm it (Apply/Confirm/Done).
    // Prefer those over "Save" so we don't accidentally hit the modal's own
    // Save button, which sits behind the crop dialog.
    const cropConfirm = await resolveElement(page, [
      { name: "role", build: (p) => p.getByRole("button", { name: /^(apply|confirm|done)$/i }) },
      { name: "text", build: (p) => p.locator('button:visible', { hasText: /^(Apply|Confirm|Done)$/ }) },
    ], { perStrategyMs: 8000 });
    if (cropConfirm) {
      await cropConfirm.locator.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }

    // Save the modal; success = it dismisses.
    const save = page.locator('[data-e2e="edit-profile-save"], button:has-text("Save"):visible').first();
    await save.click({ timeout: 8000 }).catch(() => {});
    const closed = await page.locator('[data-e2e="edit-profile-save"]').first()
      .waitFor({ state: "detached", timeout: 12000 }).then(() => true).catch(() => false);
    if (!closed) {
      const diag = await captureUiState(page, "avatar-save-stuck");
      return { success: false, error: "Uploaded the avatar but the modal didn't close after Save.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    // Read-back guard: the modal closes even if the crop step was skipped or the
    // upload was silently dropped. Reload for the server-canonical avatar and
    // confirm the URL changed. Only fail on a positively-unchanged avatar; if the
    // (flaky) profile never renders the img, trust the closed modal.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    let verdict: "changed" | "same" | "unknown" = "unknown";
    for (let i = 0; i < 8; i++) {
      const nowSrc = await page.locator('[data-e2e="user-avatar"] img').first().getAttribute("src").catch(() => null);
      if (nowSrc) {
        if (nowSrc !== beforeSrc) { verdict = "changed"; break; }
        verdict = "same"; // rendered but still the old URL — keep polling for propagation
      }
      await page.waitForTimeout(900);
    }
    if (verdict === "same") {
      const diag = await captureUiState(page, "avatar-not-applied");
      return { success: false, error: "Avatar upload did not take — the profile photo is unchanged after save.", error_code: "UI_TIMEOUT", data: diag as any };
    }

    recordAction(req.account_id, "tiktok", "profile");
    console.log("[tiktok] updated avatar via Edit-profile modal");
    return { success: true, data: { updated: true } };
  } catch (e: any) {
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN" };
  } finally {
    image.cleanup();
    await close();
  }
}

export interface TikTokAnalyticsRequest extends TikTokOpRequest {}

/**
 * Scrape per-post engagement (views / likes / comments) from the Studio content
 * manager — a READ, so it's not subject to the protective post cap. Returns one
 * row per post with the public URL + id so the caller can join to the post-log
 * and track/ categorize over time. (Deep per-post analytics — watch time,
 * completion, traffic source — layer on top of this in a follow-up.)
 */
export async function analyzePosts(req: TikTokAnalyticsRequest): Promise<TikTokOpResult<{ posts: any[]; scraped_at: string }>> {
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
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 45000 });

    // The old wait here swallowed its own timeout with `.catch(() => {})` and
    // scraped regardless, so an unrendered list produced `posts: []` and was
    // reported as a SUCCESSFUL read of an account with no videos. Observed
    // live: a first call returned 0 posts for an account that already had a
    // video with 96 views; the same account returned 2 posts minutes later.
    // That is silent data corruption — an agent polling on a schedule records
    // fabricated "engagement collapsed" history and pays for every sample.
    const listState = await waitForHydrated(page, HYDRATION_PROBES.studioContent, { timeoutMs: 30000 });
    if (!listState) {
      const diag = await captureUiState(page, "analytics-list-not-hydrated");
      return {
        success: false,
        error: "The content manager never finished rendering, so no post data was read. Reporting this as an empty account would corrupt the account's history.",
        error_code: "NOT_READY",
        data: diag as any,
      };
    }
    // Rows are up (or the list is confirmed genuinely empty); let the last of
    // them settle before reading.
    if (listState === "rows") await page.waitForTimeout(1500);

    // The content manager lazy-loads: only the first screen of rows is in the
    // DOM until you scroll. Reading straight away truncates the account to its
    // newest handful of posts and reports that as the whole history — which,
    // for a time series, silently deletes every older video from the record.
    //
    // Scroll until the row count holds steady twice (one flat round can just be
    // a slow fetch), capped so a pathological list cannot spin forever.
    const MAX_SCROLLS = 40;
    let scrolls = 0;
    let truncated = false;
    if (listState === "rows") {
      let lastCount = -1;
      let stable = 0;
      while (scrolls < MAX_SCROLLS && stable < 2) {
        const count: number = Number(
          await page.evaluate(`document.querySelectorAll('a[href*="/video/"]').length`).catch(() => 0),
        );
        if (count === lastCount) stable++;
        else { stable = 0; lastCount = count; }
        if (stable >= 2) break;
        await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
        await page.waitForTimeout(1200);
        scrolls++;
      }
      // Hitting the cap means there was still more to load. Say so — a caller
      // reading a partial history as complete would compute wrong totals.
      truncated = scrolls >= MAX_SCROLLS && stable < 2;
      if (truncated) console.log("[tiktok] analytics hit the scroll cap; post list may be incomplete");
    }

    const scraped: any = await page.evaluate(`(()=>{
      const parseNum = (t) => {
        if (t == null) return null;
        const m = String(t).trim().replace(/,/g, '').match(/^([\\d.]+)\\s*([KMB])?$/i);
        if (!m) return null;
        let n = parseFloat(m[1]); const u = (m[2] || '').toUpperCase();
        if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9;
        return Math.round(n);
      };
      const links = [...document.querySelectorAll('a[href*="/video/"]')];
      const seen = new Set();
      const rows = [];
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const m = /\\/video\\/(\\d+)/.exec(href); if (!m) continue;
        const id = m[1]; if (seen.has(id)) continue; seen.add(id);
        let row = a;
        for (let i = 0; i < 8 && row; i++) { if (row.querySelector && row.querySelector('button.TUXButton')) break; row = row.parentElement; }
        const caption = (a.textContent || '').trim();
        const nums = [];
        if (row) {
          for (const el of row.querySelectorAll('*')) {
            if (el.children.length === 0) { const t = (el.textContent || '').trim(); if (/^[\\d.,]+\\s*[KMB]?$/i.test(t) && t.length <= 8) nums.push(t); }
          }
        }
        const privacy = row ? ([...row.querySelectorAll('button.TUXButton')].map(b => (b.textContent || '').trim()).find(t => /only me|everyone|friends|public/i.test(t)) || null) : null;
        rows.push({
          id, caption,
          video_url: href.startsWith('http') ? href : ('https://www.tiktok.com' + href),
          views: parseNum(nums[0]), likes: parseNum(nums[1]), comments: parseNum(nums[2]),
          privacy,
        });
      }
      return { posts: rows, count: rows.length, first: rows[0] || null };
    })()`).catch((e: any) => ({ error: String(e?.message || e) }));

    console.log("[tiktok] analytics scraped " + (scraped?.count ?? 0) + " posts; first=" + JSON.stringify(scraped?.first));
    if (!scraped || scraped.error || !Array.isArray(scraped.posts)) {
      const diag = await captureUiState(page, "analytics-scrape-failed");
      return { success: false, error: "Could not scrape the content manager (selector may have rotated).", error_code: "UI_TIMEOUT", data: diag as any };
    }
    // Recover each post's date from its id (Snowflake-style: high 32 bits are
    // the creation time). Arithmetic beats scraping the date out of the row —
    // no selector to rotate, no locale-specific format to misparse, and it
    // works for posts made long before Palmyr ever saw the account.
    const scraped_at = new Date().toISOString();
    const posts = (scraped.posts as any[]).map((p) => ({ ...p, posted_at: postedAtFromVideoId(String(p.id)) }));

    // Persist the sample so the account accrues a history. Without this the
    // caller pays for a snapshot and, unless they store it themselves, the
    // question they actually have — "is this still growing?" — stays
    // unanswerable. Never let a bookkeeping failure lose a scrape the caller
    // already paid for.
    let series: { recorded: number; unchanged: number } | undefined;
    try {
      series = recordSample(req.account_id, posts, scraped_at);
    } catch (e: any) {
      console.error("[tiktok] analytics scraped but failed to persist:", e?.message || e);
    }

    return {
      success: true,
      data: {
        posts,
        scraped_at,
        ...(series ? { recorded: series.recorded, unchanged: series.unchanged } : {}),
        ...(truncated ? { truncated: true } : {}),
      },
    };
  } catch (e: any) {
    const diag = await captureUiState(page, "analytics-error").catch(() => ({}));
    return { success: false, error: e.message || String(e), error_code: "UNKNOWN", data: diag as any };
  } finally {
    await close();
  }
}
