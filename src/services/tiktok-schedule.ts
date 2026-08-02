/**
 * Scheduled posts — Palmyr's own record of what it asked TikTok to publish.
 *
 * TikTok's native scheduler does the publishing (the video is uploaded and
 * encoded ahead of time, so nothing has to work at the moment it goes out).
 * What TikTok does NOT do is tell anyone what is scheduled: measured directly,
 * a held post's row in the content manager is byte-for-byte identical to a
 * published one — no badge, no status field, no filter, and its URL returns 200
 * either way. So "what have I got scheduled" cannot be read back, and this
 * record is the only place the answer can live.
 *
 * That makes the record authoritative about our INTENT and merely a belief
 * about TikTok's state. Anyone editing, rescheduling or deleting a post inside
 * TikTok Studio changes reality without changing this table, so every read says
 * so rather than presenting a guess as fact.
 *
 * Nothing is duplicated to achieve it: a scheduled post is already a row in
 * tiktok_post_jobs with schedule_at set. This is a view over that plus the one
 * thing the job table could not know — whether we later cancelled it.
 */
import { db } from "../db";
// Side-effect import: tiktok-post-jobs owns the table this reads, and creates
// (and migrates) it at module load. Importing it here makes that dependency
// explicit instead of quietly relying on some other module having been loaded
// first — which works in the server, where the route imports both, and fails
// anywhere that reaches this service on its own.
import "./tiktok-post-jobs";

export type ScheduleState = "scheduled" | "due" | "published" | "cancelled";

export interface ScheduledPost {
  operation_id: string;
  account_id: string;
  caption: string;
  video_id: string | null;
  video_url: string | null;
  scheduled_at: string;
  created_at: string;
  cancelled_at: string | null;
  state: ScheduleState;
  /** Minutes until publication; negative once the time has passed. */
  minutes_until: number;
  /** Views seen after the scheduled time — the only evidence of publication. */
  observed_views: number | null;
}

interface JobRow {
  id: string;
  account_id: string;
  owner: string;
  caption: string;
  schedule_at: string;
  video_id: string | null;
  video_url: string | null;
  created_at: string;
  cancelled_at: string | null;
}

/**
 * Did this video accrue views after it was meant to go out?
 *
 * The only honest publication signal available. A held post cannot gather
 * views, so views observed after `scheduled_at` mean it published. The absence
 * of views proves nothing — a published post can genuinely have none — which is
 * exactly why the state for that case is "due" rather than "failed".
 */
function viewsAfter(accountId: string, videoId: string | null, scheduledAt: string): number | null {
  if (!videoId) return null;
  const row = db
    .prepare(
      `SELECT MAX(views) AS v FROM tiktok_post_metrics
        WHERE account_id = ? AND video_id = ? AND sampled_at >= ?`,
    )
    .get(accountId, videoId, scheduledAt) as { v: number | null };
  return row?.v ?? null;
}

function deriveState(row: JobRow, now: number): { state: ScheduleState; observed_views: number | null } {
  if (row.cancelled_at) return { state: "cancelled", observed_views: null };
  const due = Date.parse(row.schedule_at) <= now;
  if (!due) return { state: "scheduled", observed_views: null };

  const views = viewsAfter(row.account_id, row.video_id, row.schedule_at);
  // Views can only accrue once it is live. No views is NOT evidence it failed,
  // so it stays "due" — publication expected, not confirmed.
  if (views !== null && views > 0) return { state: "published", observed_views: views };
  return { state: "due", observed_views: views };
}

export interface ListOptions {
  accountId?: string;
  /** Include cancelled and already-published rows. Default: only live ones. */
  includeDone?: boolean;
  now?: number;
}

/** Everything this wallet has scheduled, soonest first. */
export function listScheduled(owner: string, opts: ListOptions = {}): ScheduledPost[] {
  const now = opts.now ?? Date.now();
  const rows = (
    opts.accountId
      ? db.prepare(
          `SELECT id, account_id, owner, caption, schedule_at, video_id, video_url, created_at, cancelled_at
             FROM tiktok_post_jobs
            WHERE owner = ? AND account_id = ? AND schedule_at IS NOT NULL AND status = 'posted'
            ORDER BY schedule_at ASC`,
        ).all(owner, opts.accountId)
      : db.prepare(
          `SELECT id, account_id, owner, caption, schedule_at, video_id, video_url, created_at, cancelled_at
             FROM tiktok_post_jobs
            WHERE owner = ? AND schedule_at IS NOT NULL AND status = 'posted'
            ORDER BY schedule_at ASC`,
        ).all(owner)
  ) as JobRow[];

  const out = rows.map((r) => {
    const { state, observed_views } = deriveState(r, now);
    return {
      operation_id: r.id,
      account_id: r.account_id,
      caption: r.caption,
      video_id: r.video_id,
      video_url: r.video_url,
      scheduled_at: r.schedule_at,
      created_at: r.created_at,
      cancelled_at: r.cancelled_at,
      state,
      minutes_until: Math.round((Date.parse(r.schedule_at) - now) / 60_000),
      observed_views,
    };
  });

  return opts.includeDone ? out : out.filter((p) => p.state === "scheduled" || p.state === "due");
}

/** One scheduled post, owner-scoped so an id alone is not access. */
export function getScheduled(owner: string, operationId: string, now: number = Date.now()): ScheduledPost | null {
  const row = db
    .prepare(
      `SELECT id, account_id, owner, caption, schedule_at, video_id, video_url, created_at, cancelled_at
         FROM tiktok_post_jobs
        WHERE id = ? AND owner = ? AND schedule_at IS NOT NULL`,
    )
    .get(operationId, owner) as JobRow | undefined;
  if (!row) return null;
  const { state, observed_views } = deriveState(row, now);
  return {
    operation_id: row.id,
    account_id: row.account_id,
    caption: row.caption,
    video_id: row.video_id,
    video_url: row.video_url,
    scheduled_at: row.schedule_at,
    created_at: row.created_at,
    cancelled_at: row.cancelled_at,
    state,
    minutes_until: Math.round((Date.parse(row.schedule_at) - now) / 60_000),
    observed_views,
  };
}

/** Record that we deleted the video behind a scheduled post. */
export function markCancelled(operationId: string, at: string = new Date().toISOString()): void {
  db.prepare("UPDATE tiktok_post_jobs SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL").run(at, operationId);
}

/**
 * The caveat that has to travel with every schedule answer.
 *
 * Exported as one constant so the wording cannot drift between the post
 * response, the list and the docs — an agent reading two different hedges for
 * the same limitation learns to trust neither.
 */
export const SCHEDULE_RECORD_CAVEAT =
  "This is Palmyr's own record of what it scheduled. TikTok does not expose which posts are pending — " +
  "a held post is indistinguishable from a published one in Studio — so if you edit, reschedule or delete " +
  "a post directly in TikTok Studio, this record will not know. Cancel through Palmyr to keep the two in step.";
