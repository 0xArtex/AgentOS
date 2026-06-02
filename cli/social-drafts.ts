/**
 * Local draft queue + post-log for the human-in-the-loop posting flow:
 *
 *   draft  → (awaiting approval) → approve → post → post-log
 *                                → reject  → discarded
 *
 * Everything is local to ~/.palmyr/social (no server, no cookies leave the
 * machine) — the CLI holds the session and publishes on approval. Drafts are
 * one JSON file each; the post-log is append-only JSONL so it's a durable audit
 * trail of everything that actually went out (drafts AND direct posts).
 */
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Platform = 'tiktok' | 'twitter'

export interface SocialDraft {
  id: string
  platform: Platform
  account: string                 // local username/alias the draft posts from
  caption: string
  file?: string                   // local video path (resolved at approve time)
  url?: string                    // remote video URL (server-fetched at approve)
  privacy?: 0 | 1 | 2
  tag?: string
  schedule_at?: string            // ISO; if set, approve schedules instead of posting now
  created_at: string
  status: 'awaiting_approval'
}

export interface PostLogEntry {
  ts: string
  platform: Platform
  account: string
  caption: string
  source: 'draft' | 'direct'      // approved-from-draft vs posted directly
  status: 'posted' | 'scheduled'
  url?: string                    // public video URL, if the post op resolved one
  tag?: string
  draft_id?: string
  result?: any                    // whatever the post op returned (url/id/etc.)
}

function socialDir(): string {
  return process.env.PALMYR_SOCIAL_PATH || join(homedir(), '.palmyr', 'social')
}
function draftsDir(): string { return join(socialDir(), 'drafts') }
function postLogPath(): string { return join(socialDir(), 'post-log.jsonl') }
function ensure(dir: string): void { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }

export function createDraft(d: Omit<SocialDraft, 'id' | 'created_at' | 'status'>): SocialDraft {
  ensure(draftsDir())
  const draft: SocialDraft = {
    id: 'd_' + randomBytes(5).toString('hex'),
    created_at: new Date().toISOString(),
    status: 'awaiting_approval',
    ...d,
  }
  writeFileSync(join(draftsDir(), `${draft.id}.json`), JSON.stringify(draft, null, 2), { mode: 0o600 })
  return draft
}

export function listDrafts(opts: { platform?: Platform; account?: string; tag?: string } = {}): SocialDraft[] {
  ensure(draftsDir())
  return readdirSync(draftsDir())
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(draftsDir(), f), 'utf8')) as SocialDraft } catch { return null } })
    .filter((x): x is SocialDraft => !!x)
    .filter(d => !opts.platform || d.platform === opts.platform)
    .filter(d => !opts.account || d.account === opts.account)
    .filter(d => !opts.tag || d.tag === opts.tag)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
}

export function getDraft(id: string): SocialDraft | undefined {
  const p = join(draftsDir(), `${id}.json`)
  if (!existsSync(p)) return undefined
  try { return JSON.parse(readFileSync(p, 'utf8')) as SocialDraft } catch { return undefined }
}

export function deleteDraft(id: string): boolean {
  const p = join(draftsDir(), `${id}.json`)
  if (!existsSync(p)) return false
  unlinkSync(p)
  return true
}

export function appendPostLog(e: Omit<PostLogEntry, 'ts'> & { ts?: string }): PostLogEntry {
  ensure(socialDir())
  const entry: PostLogEntry = { ...e, ts: e.ts || new Date().toISOString() } as PostLogEntry
  appendFileSync(postLogPath(), JSON.stringify(entry) + '\n', { mode: 0o600 })
  return entry
}

export function readPostLog(opts: { platform?: Platform; account?: string; tag?: string; limit?: number } = {}): PostLogEntry[] {
  if (!existsSync(postLogPath())) return []
  const entries = readFileSync(postLogPath(), 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as PostLogEntry } catch { return null } })
    .filter((x): x is PostLogEntry => !!x)
    .filter(e => !opts.platform || e.platform === opts.platform)
    .filter(e => !opts.account || e.account === opts.account)
    .filter(e => !opts.tag || e.tag === opts.tag)
    .reverse() // most recent first
  return opts.limit ? entries.slice(0, opts.limit) : entries
}
