/**
 * The niche hook corpus — what openings are working on TikTok at large.
 *
 * This is the answer for a new account, which is most accounts: `tiktok hooks
 * <username>` needs your own posting history, and on day one there isn't any.
 * The corpus needs none — it reports what is landing in your niche right now,
 * measured from other people's posts.
 *
 * It is kept rigidly separate from your own measured results. A hook that
 * prints five million views for an established creator says nothing about what
 * a new account will do, so the two are never averaged: one is labelled
 * "observed in this niche", the other "measured on your account".
 *
 * Two dates per row, and both are load-bearing. `posted_at` is when the hook
 * worked — hooks decay, so a corpus without it can only say "this worked at
 * some point". `collected_at` is when we looked, which is what lets the same
 * niche be compared across months to show a pattern rising or dying.
 */
import { db } from "../db";
import { extractHook, classifyHook, HOOK_PATTERNS, MIN_CONFIDENT_POSTS, type HookPattern, type PatternStat } from "./tiktok-hooks";
import { getNiche, resolveNiche, type NicheResolution } from "./tiktok-niches";

/** How long a collection stays usable before it should be refreshed. */
export const DEFAULT_STALE_DAYS = 5;

export interface CorpusRow {
  niche: string;
  query: string;
  video_id: string;
  author: string | null;
  caption: string | null;
  hook: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  posted_at: string | null;
  collected_at: string;
}

/** One post as the upstream returns it, already flattened. */
export interface UpstreamPost {
  video_id: string;
  author?: string | null;
  caption?: string | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  posted_at?: string | null;
}

/**
 * Flatten one Scrape Creators `aweme_info` object.
 *
 * Kept as its own exported function because it is the only place the upstream's
 * shape is known, and it is the thing most likely to change underneath us.
 */
export function parseUpstreamPost(aweme: any): UpstreamPost | null {
  if (!aweme || typeof aweme !== "object") return null;
  const id = String(aweme.aweme_id ?? aweme.statistics?.aweme_id ?? "").trim();
  if (!id) return null;
  const st = aweme.statistics || {};
  const created = Number(aweme.create_time);
  return {
    video_id: id,
    author: aweme.author?.unique_id ?? aweme.author?.nickname ?? null,
    caption: typeof aweme.desc === "string" ? aweme.desc : null,
    views: Number.isFinite(st.play_count) ? st.play_count : null,
    likes: Number.isFinite(st.digg_count) ? st.digg_count : null,
    comments: Number.isFinite(st.comment_count) ? st.comment_count : null,
    shares: Number.isFinite(st.share_count) ? st.share_count : null,
    saves: Number.isFinite(st.collect_count) ? st.collect_count : null,
    // create_time is unix seconds. A missing or absurd value becomes null
    // rather than 1970 — "we don't know when" and "it worked in 1970" are
    // different claims, and only one of them is survivable in a decay model.
    posted_at:
      Number.isFinite(created) && created > 1_400_000_000 && created * 1000 < Date.now() + 86_400_000
        ? new Date(created * 1000).toISOString()
        : null,
  };
}

/** Store one collection. Idempotent per (niche, video, collected_at). */
export function storeCollection(
  niche: string,
  query: string,
  posts: UpstreamPost[],
  collectedAt: string,
): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tiktok_niche_corpus
       (niche, query, video_id, author, caption, hook, views, likes, comments, shares, saves, posted_at, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let stored = 0;
  const tx = db.transaction((rows: UpstreamPost[]) => {
    for (const p of rows) {
      if (!p?.video_id) continue;
      const r = insert.run(
        niche, query, p.video_id, p.author ?? null, p.caption ?? null,
        extractHook(p.caption), p.views ?? null, p.likes ?? null, p.comments ?? null,
        p.shares ?? null, p.saves ?? null, p.posted_at ?? null, collectedAt,
      );
      if (r.changes > 0) stored++;
    }
  });
  tx(posts);
  return stored;
}

export function recordCollectionRun(opts: {
  niche: string;
  collectedAt: string;
  queries: number;
  posts: number;
  costUsdc: number;
  error?: string | null;
}): void {
  db.prepare(
    `INSERT INTO tiktok_niche_collections (niche, collected_at, queries, posts, cost_usdc, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.niche, opts.collectedAt, opts.queries, opts.posts, opts.costUsdc, opts.error ?? null);
}

export interface CorpusFreshness {
  niche: string;
  last_collected_at: string | null;
  age_days: number | null;
  posts: number;
  stale: boolean;
}

export function corpusFreshness(niche: string, staleDays: number = DEFAULT_STALE_DAYS, now: number = Date.now()): CorpusFreshness {
  const row = db
    .prepare(`SELECT MAX(collected_at) AS last, COUNT(*) AS n FROM tiktok_niche_corpus WHERE niche = ?`)
    .get(niche) as { last: string | null; n: number };
  const last = row?.last ?? null;
  const ageDays = last ? (now - Date.parse(last)) / 86_400_000 : null;
  return {
    niche,
    last_collected_at: last,
    age_days: ageDays === null ? null : Math.round(ageDays * 10) / 10,
    posts: row?.n ?? 0,
    stale: ageDays === null || ageDays > staleDays,
  };
}

/** The newest collection's rows — one snapshot, not every snapshot pooled. */
function latestRows(niche: string): CorpusRow[] {
  const last = db
    .prepare(`SELECT MAX(collected_at) AS last FROM tiktok_niche_corpus WHERE niche = ?`)
    .get(niche) as { last: string | null };
  if (!last?.last) return [];
  return db
    .prepare(`SELECT * FROM tiktok_niche_corpus WHERE niche = ? AND collected_at = ?`)
    .all(niche, last.last) as CorpusRow[];
}

function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

export interface CorpusExample {
  hook: string;
  views: number;
  posted_at: string | null;
  age_days: number | null;
  author: string | null;
  video_url: string;
}

export interface CorpusPatternStat extends PatternStat {
  examples: CorpusExample[];
}

export interface CorpusReport {
  niche: string;
  niche_label: string;
  requested: string;
  /** True when the caller's word was not itself a niche id — never substitute silently. */
  resolved: boolean;
  freshness: CorpusFreshness;
  window: { posts: number; median_views: number | null; from: string | null; to: string | null };
  patterns: CorpusPatternStat[];
  notes: string[];
}

/**
 * What is working in a niche right now.
 *
 * `recencyDays` bounds which POSTS count, independently of when we collected
 * them: a collection from yesterday can still be full of year-old videos, and
 * those say nothing about what works now.
 */
export function corpusReport(opts: {
  niche: string;
  recencyDays?: number;
  staleDays?: number;
  examplesPerPattern?: number;
  now?: number;
}): CorpusReport | null {
  const resolution: NicheResolution | null = resolveNiche(opts.niche);
  if (!resolution) return null;
  const niche = resolution.niche;
  const now = opts.now ?? Date.now();
  const recencyDays = opts.recencyDays ?? 90;
  const perPattern = opts.examplesPerPattern ?? 3;

  const freshness = corpusFreshness(niche.id, opts.staleDays ?? DEFAULT_STALE_DAYS, now);
  const rows = latestRows(niche.id);

  const inWindow = rows.filter((r) => {
    if (!r.hook) return false;
    if (!r.posted_at) return false;
    const age = (now - Date.parse(r.posted_at)) / 86_400_000;
    return Number.isFinite(age) && age >= 0 && age <= recencyDays;
  });

  const baseline = median(inWindow.map((r) => r.views ?? 0));
  const dates = inWindow.map((r) => Date.parse(r.posted_at!)).filter((n) => !Number.isNaN(n));

  const patterns: CorpusPatternStat[] = HOOK_PATTERNS.map(({ pattern, label }) => {
    const hits = inWindow.filter((r) => classifyHook(r.hook).includes(pattern as HookPattern));
    const med = median(hits.map((r) => r.views ?? 0));
    const lift = med !== null && baseline !== null && baseline > 0 ? Math.round((med / baseline) * 100) / 100 : null;
    const examples: CorpusExample[] = [...hits]
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, perPattern)
      .map((r) => ({
        hook: r.hook!,
        views: r.views ?? 0,
        posted_at: r.posted_at,
        age_days: r.posted_at ? Math.round(((now - Date.parse(r.posted_at)) / 86_400_000) * 10) / 10 : null,
        author: r.author,
        video_url: `https://www.tiktok.com/@${r.author || "i"}/video/${r.video_id}`,
      }));
    return {
      pattern: pattern as HookPattern,
      label,
      posts: hits.length,
      median_views: med,
      lift,
      confident: hits.length >= MIN_CONFIDENT_POSTS && lift !== null,
      examples,
    };
  })
    .filter((p) => p.posts > 0)
    .sort((a, b) => {
      if (a.confident !== b.confident) return a.confident ? -1 : 1;
      return (b.lift ?? -Infinity) - (a.lift ?? -Infinity);
    });

  const notes: string[] = [];
  if (freshness.posts === 0) {
    notes.push(`No corpus collected for "${niche.id}" yet. Run: palmyr tiktok corpus refresh ${niche.id}`);
  } else if (freshness.stale) {
    notes.push(
      `Corpus is ${freshness.age_days} days old — hooks move, so refresh it: palmyr tiktok corpus refresh ${niche.id}`,
    );
  }
  if (rows.length > 0 && inWindow.length < rows.length) {
    notes.push(`${rows.length - inWindow.length} of ${rows.length} collected posts fell outside the ${recencyDays}-day window or had no readable hook.`);
  }
  if (inWindow.length > 0 && inWindow.length < MIN_CONFIDENT_POSTS * 2) {
    notes.push(`Only ${inWindow.length} posts in window — treat this as directional.`);
  }
  notes.push(
    "Observed in this niche, on other people's accounts — NOT measured on yours. " +
    "These creators' reach is not yours, so treat patterns as direction and the examples as phrasing to adapt.",
  );

  return {
    niche: niche.id,
    niche_label: niche.label,
    requested: resolution.requested,
    resolved: resolution.resolved,
    freshness,
    window: {
      posts: inWindow.length,
      median_views: baseline,
      from: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      to: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    },
    patterns,
    notes,
  };
}

/** Every collection we have made for a niche, oldest first — the decay record. */
export function collectionHistory(niche: string): { collected_at: string; posts: number; cost_usdc: number; error: string | null }[] {
  const n = getNiche(niche);
  if (!n) return [];
  return db
    .prepare(`SELECT collected_at, posts, cost_usdc, error FROM tiktok_niche_collections WHERE niche = ? ORDER BY collected_at ASC`)
    .all(niche) as any[];
}
