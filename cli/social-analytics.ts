/**
 * Local analytics store + categorizer + review aggregation — the "self-learner"
 * layer. The server scrapes per-post metrics; this module categorizes each post
 * relative to the account's OWN distribution, snapshots the result to a local
 * time-series, and rolls it up into a review an agent can act on.
 *
 *   ~/.palmyr/social/analytics.jsonl   — append-only snapshots (one per tick)
 *
 * Everything is local; metrics join to the post-log (#235) by video_id.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface PostMetrics {
  id: string
  caption: string
  video_url?: string
  views: number | null
  likes: number | null
  comments: number | null
  privacy?: string | null
  engagement_rate?: number   // (likes+comments)/views, 0 when no views
  tier?: 'top' | 'solid' | 'underperforming' | 'pending'
}

export interface AnalyticsSnapshot {
  ts: string
  account: string
  posts: PostMetrics[]
  summary: ReturnType<typeof summarize>
}

function socialDir(): string {
  return process.env.PALMYR_SOCIAL_PATH || join(homedir(), '.palmyr', 'social')
}
function snapshotPath(): string { return join(socialDir(), 'analytics.jsonl') }
function ensure(dir: string): void { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }

const n = (x: number | null | undefined): number => (typeof x === 'number' && isFinite(x) ? x : 0)

/**
 * Categorize each post into a tier RELATIVE to the account's own posts, so an
 * agent learns what works for IT (not against arbitrary absolute thresholds).
 * Posts with no views yet are "pending" (no signal). Tiers use the median views
 * of posts that DO have views: top ≥ 1.5× median, underperforming < 0.5× median.
 */
export function categorize(posts: PostMetrics[]): PostMetrics[] {
  const viewed = posts.map(p => n(p.views)).filter(v => v > 0).sort((a, b) => a - b)
  const median = viewed.length ? viewed[Math.floor(viewed.length / 2)] : 0
  return posts.map(p => {
    const views = n(p.views)
    const er = views > 0 ? Number((((n(p.likes) + n(p.comments)) / views)).toFixed(4)) : 0
    let tier: PostMetrics['tier']
    if (views === 0) tier = 'pending'
    else if (median > 0 && views >= median * 1.5) tier = 'top'
    else if (median > 0 && views < Math.max(median * 0.5, 1)) tier = 'underperforming'
    else tier = 'solid'
    return { ...p, engagement_rate: er, tier }
  })
}

export function summarize(posts: PostMetrics[]) {
  const cat = posts.every(p => p.tier) ? posts : categorize(posts)
  const viewed = cat.filter(p => n(p.views) > 0)
  const totalViews = cat.reduce((s, p) => s + n(p.views), 0)
  const sortedByViews = [...cat].sort((a, b) => n(b.views) - n(a.views))
  const tiers = cat.reduce((a: Record<string, number>, p) => { a[p.tier || 'pending'] = (a[p.tier || 'pending'] || 0) + 1; return a }, {})
  const avgEr = viewed.length ? Number((viewed.reduce((s, p) => s + (p.engagement_rate || 0), 0) / viewed.length).toFixed(4)) : 0
  return {
    posts: cat.length,
    total_views: totalViews,
    total_likes: cat.reduce((s, p) => s + n(p.likes), 0),
    total_comments: cat.reduce((s, p) => s + n(p.comments), 0),
    avg_views: cat.length ? Math.round(totalViews / cat.length) : 0,
    avg_engagement_rate: avgEr,
    tiers,
    best: sortedByViews[0] ? { caption: sortedByViews[0].caption, views: n(sortedByViews[0].views), video_url: sortedByViews[0].video_url } : null,
    worst: viewed.length ? (() => { const w = sortedByViews[sortedByViews.length - 1]; return { caption: w.caption, views: n(w.views), video_url: w.video_url } })() : null,
  }
}

export function appendSnapshot(account: string, rawPosts: PostMetrics[], ts?: string): AnalyticsSnapshot {
  ensure(socialDir())
  const posts = categorize(rawPosts)
  const snap: AnalyticsSnapshot = { ts: ts || new Date().toISOString(), account, posts, summary: summarize(posts) }
  appendFileSync(snapshotPath(), JSON.stringify(snap) + '\n', { mode: 0o600 })
  return snap
}

function readSnapshots(account?: string): AnalyticsSnapshot[] {
  if (!existsSync(snapshotPath())) return []
  return readFileSync(snapshotPath(), 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as AnalyticsSnapshot } catch { return null } })
    .filter((x): x is AnalyticsSnapshot => !!x)
    .filter(s => !account || s.account === account)
}

export function latestSnapshot(account: string): AnalyticsSnapshot | undefined {
  const all = readSnapshots(account)
  return all[all.length - 1]
}

/** Roll up the latest snapshot into a review, with a trend vs the prior snapshot. */
export function review(account: string): any {
  const all = readSnapshots(account)
  if (!all.length) return { account, error: 'No analytics snapshots yet. Run `palmyr tiktok analytics ' + account + '` (or `tiktok monitor tick`) first.' }
  const cur = all[all.length - 1]
  const prev = all.length > 1 ? all[all.length - 2] : undefined
  const trend = prev ? {
    since: prev.ts,
    total_views_delta: cur.summary.total_views - prev.summary.total_views,
    posts_delta: cur.summary.posts - prev.summary.posts,
  } : null
  return { account, snapshot_at: cur.ts, summary: cur.summary, trend }
}
