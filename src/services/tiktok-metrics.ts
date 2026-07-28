/**
 * Per-post engagement over time.
 *
 * Analytics was a one-shot scrape: pay, receive a snapshot, and unless the
 * caller stored it themselves the history was gone. So the question people
 * actually ask — "is this video still growing, or did it stall?" — could not be
 * answered by the server at all. The CLI kept a local JSONL of account-level
 * summaries, but that lives on one operator's laptop, is per-machine, and an
 * agent calling the API directly never had it.
 *
 * This stores the series server-side, per video, so history survives the
 * machine that collected it.
 */
import { db } from "../db";

export interface ScrapedPost {
  id: string;
  caption?: string | null;
  video_url?: string | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  privacy?: string | null;
  posted_at?: string | null;
}

export interface MetricSample {
  video_id: string;
  caption: string | null;
  video_url: string | null;
  posted_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  privacy: string | null;
  sampled_at: string;
}

/** TikTok launched in 2016; anything decoding earlier is not a real post time. */
const TIKTOK_EPOCH_FLOOR_MS = Date.UTC(2016, 0, 1);

/**
 * Recover when a video was posted from its id.
 *
 * TikTok video ids are Snowflake-style: the high 32 bits are the creation time
 * in Unix seconds. Deriving the date arithmetically beats scraping it out of
 * the content manager — there is no selector to rotate, no locale-specific date
 * format to misparse, and it works for posts made before Palmyr ever saw the
 * account (where no post-log row exists to join against).
 *
 * Returns null rather than a wrong answer for anything that fails to decode
 * into a plausible instant, so a caller can tell "unknown" from "1970".
 */
export function postedAtFromVideoId(videoId: string): string | null {
  if (!/^\d{15,25}$/.test(videoId)) return null;
  let seconds: number;
  try {
    seconds = Number(BigInt(videoId) >> 32n);
  } catch {
    return null;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds * 1000;
  // A post cannot predate the platform, and cannot be from the future. Either
  // means the id was not a real video id (or the scheme changed) — say so.
  if (ms < TIKTOK_EPOCH_FLOOR_MS || ms > Date.now() + 86_400_000) return null;
  return new Date(ms).toISOString();
}

function latestSample(accountId: string, videoId: string): MetricSample | undefined {
  return db
    .prepare(
      `SELECT video_id, caption, video_url, posted_at, views, likes, comments, privacy, sampled_at
         FROM tiktok_post_metrics
        WHERE account_id = ? AND video_id = ?
        ORDER BY sampled_at DESC, id DESC
        LIMIT 1`,
    )
    .get(accountId, videoId) as MetricSample | undefined;
}

/**
 * Record one analytics run.
 *
 * A sample whose numbers are identical to the previous one is skipped. A video
 * that nobody watches for a month would otherwise write an unbounded run of
 * identical rows, and "no row between two equal samples" is the normal sparse
 * encoding for a metrics series — the value simply did not change. The counts
 * are returned so a caller can see the difference between "nothing moved" and
 * "nothing was collected", which otherwise look the same from outside.
 */
export function recordSample(
  accountId: string,
  posts: ScrapedPost[],
  sampledAt: string = new Date().toISOString(),
): { recorded: number; unchanged: number } {
  let recorded = 0;
  let unchanged = 0;

  const insert = db.prepare(
    `INSERT INTO tiktok_post_metrics
       (account_id, video_id, caption, video_url, posted_at, views, likes, comments, privacy, sampled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction((rows: ScrapedPost[]) => {
    for (const p of rows) {
      if (!p || typeof p.id !== "string" || !p.id) continue;
      const prev = latestSample(accountId, p.id);
      const views = p.views ?? null;
      const likes = p.likes ?? null;
      const comments = p.comments ?? null;
      if (prev && prev.views === views && prev.likes === likes && prev.comments === comments) {
        unchanged++;
        continue;
      }
      insert.run(
        accountId,
        p.id,
        p.caption ?? null,
        p.video_url ?? null,
        p.posted_at ?? postedAtFromVideoId(p.id),
        views,
        likes,
        comments,
        p.privacy ?? null,
        sampledAt,
      );
      recorded++;
    }
  });
  tx(posts);
  return { recorded, unchanged };
}

/** Every stored sample for one video, oldest first. */
export function seriesFor(accountId: string, videoId: string, limit: number = 500): MetricSample[] {
  return db
    .prepare(
      `SELECT video_id, caption, video_url, posted_at, views, likes, comments, privacy, sampled_at
         FROM tiktok_post_metrics
        WHERE account_id = ? AND video_id = ?
        ORDER BY sampled_at ASC, id ASC
        LIMIT ?`,
    )
    .all(accountId, videoId, limit) as MetricSample[];
}

/** The most recent sample for each video on an account, newest post first. */
export function latestForAccount(accountId: string): MetricSample[] {
  return db
    .prepare(
      `SELECT m.video_id, m.caption, m.video_url, m.posted_at, m.views, m.likes, m.comments, m.privacy, m.sampled_at
         FROM tiktok_post_metrics m
         JOIN (
           SELECT video_id, MAX(id) AS max_id
             FROM tiktok_post_metrics
            WHERE account_id = ?
            GROUP BY video_id
         ) newest ON newest.max_id = m.id
        ORDER BY COALESCE(m.posted_at, '') DESC, m.video_id DESC`,
    )
    .all(accountId) as MetricSample[];
}

export interface Growth {
  video_id: string;
  caption: string | null;
  video_url: string | null;
  posted_at: string | null;
  views: number | null;
  views_gained: number | null;
  likes_gained: number | null;
  comments_gained: number | null;
  from: string;
  to: string;
  /** False when only one sample exists, so a zero cannot be read as "flat". */
  comparable: boolean;
}

/**
 * How much each video gained over a window.
 *
 * Videos with a single sample report `comparable: false` rather than a gain of
 * zero — "we have not measured it twice yet" and "it did not move" are
 * different facts, and collapsing them invents a flat trend that was never
 * observed.
 */
export function growthSince(accountId: string, sinceIso: string): Growth[] {
  const videos = db
    .prepare(`SELECT DISTINCT video_id FROM tiktok_post_metrics WHERE account_id = ?`)
    .all(accountId) as { video_id: string }[];

  const out: Growth[] = [];
  for (const { video_id } of videos) {
    const rows = db
      .prepare(
        `SELECT views, likes, comments, caption, video_url, posted_at, sampled_at
           FROM tiktok_post_metrics
          WHERE account_id = ? AND video_id = ? AND sampled_at >= ?
          ORDER BY sampled_at ASC, id ASC`,
      )
      .all(accountId, video_id, sinceIso) as MetricSample[];
    if (rows.length === 0) continue;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const diff = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b);
    out.push({
      video_id,
      caption: last.caption,
      video_url: last.video_url,
      posted_at: last.posted_at,
      views: last.views,
      views_gained: rows.length > 1 ? diff(last.views, first.views) : null,
      likes_gained: rows.length > 1 ? diff(last.likes, first.likes) : null,
      comments_gained: rows.length > 1 ? diff(last.comments, first.comments) : null,
      from: first.sampled_at,
      to: last.sampled_at,
      comparable: rows.length > 1,
    });
  }
  out.sort((a, b) => (b.views_gained ?? -1) - (a.views_gained ?? -1));
  return out;
}
