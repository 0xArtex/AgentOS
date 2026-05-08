/**
 * Local JSON queue for scheduled social posts and drafts.
 *
 * Stored at ~/.agentos/social/queue.json (override with AGENTOS_SOCIAL_PATH).
 * Local media files referenced by scheduled items are copied to
 * ~/.agentos/social/queue-media/<id>/ so the schedule survives the user
 * deleting the original; URL-based media is stored as-is and fetched
 * server-side at fire time.
 *
 * This file does ONLY data management — no scheduling, no dispatch, no
 * server calls. The worker (a separate concern) reads the queue, fires
 * due items via the existing CLI flow, then writes the result back.
 */
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, renameSync } from 'fs'
import { join, basename, isAbsolute, resolve } from 'path'
import { homedir } from 'os'

export type SocialAction = 'post' | 'post_thread' | 'post_media'

export interface MediaRef {
  /** Local file path (absolute, lives under queue-media/<id>/). */
  local_path?: string
  /** Original kind, derived from filename or media-json. */
  kind?: 'image' | 'video'
  /** HTTPS URL — server fetches at fire time. */
  image_url?: string
  video_url?: string
}

interface CommonItem {
  id: string
  platform: 'x'
  account_username: string
  action: SocialAction
  text?: string
  texts?: string[]
  media?: MediaRef[]
  community_id?: string
  created_at: string
}

export interface ScheduledItem extends CommonItem {
  post_at: string                                     // ISO 8601
  status: 'pending' | 'in_progress' | 'cancelled'
  attempted_at?: string
  retry_count: number
}

export interface DraftItem extends CommonItem {
  name?: string                                       // optional human label
  updated_at: string
}

export interface PublishedItem {
  id: string
  platform: 'x'
  account_username: string
  action: SocialAction
  result: any                                         // tweet IDs / URLs from the server
  posted_at: string
}

export interface FailedItem {
  id: string
  platform: 'x'
  account_username: string
  action: SocialAction
  error: string
  failed_at: string
  retry_count: number
}

export interface SocialQueue {
  version: 1
  scheduled: ScheduledItem[]
  drafts: DraftItem[]
  published: PublishedItem[]                          // capped to MAX_HISTORY
  failed: FailedItem[]                                // capped to MAX_HISTORY
}

const MAX_HISTORY = 200

function getSocialDir(): string {
  return process.env.AGENTOS_SOCIAL_PATH || join(homedir(), '.agentos', 'social')
}

function getQueuePath(): string {
  return join(getSocialDir(), 'queue.json')
}

function getQueueMediaDir(): string {
  return join(getSocialDir(), 'queue-media')
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function emptyQueue(): SocialQueue {
  return { version: 1, scheduled: [], drafts: [], published: [], failed: [] }
}

export function loadQueue(): SocialQueue {
  const path = getQueuePath()
  if (!existsSync(path)) return emptyQueue()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SocialQueue>
    return {
      version: 1,
      scheduled: Array.isArray(raw.scheduled) ? raw.scheduled : [],
      drafts: Array.isArray(raw.drafts) ? raw.drafts : [],
      published: Array.isArray(raw.published) ? raw.published : [],
      failed: Array.isArray(raw.failed) ? raw.failed : [],
    }
  } catch (e: any) {
    throw new Error(`Failed to parse ${path}: ${e.message}. Move it aside and re-run.`)
  }
}

export function saveQueue(q: SocialQueue): void {
  ensureDir(getSocialDir())
  // Keep history bounded so queue.json doesn't grow forever.
  q.published = q.published.slice(-MAX_HISTORY)
  q.failed = q.failed.slice(-MAX_HISTORY)
  // Atomic write: stage to .tmp then rename. Survives a crash mid-write
  // without leaving the queue in a partial-JSON state.
  const path = getQueuePath()
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(q, null, 2))
  renameSync(tmp, path)
}

/**
 * Resolve a local file path provided by the user, copy it into the queue's
 * private media storage, and return the absolute path that survives the user
 * deleting the original. Throws if the source file doesn't exist.
 */
export function ingestLocalMediaFile(
  itemId: string,
  sourcePath: string,
  kind: 'image' | 'video'
): MediaRef {
  const abs = isAbsolute(sourcePath) ? sourcePath : resolve(process.cwd(), sourcePath)
  if (!existsSync(abs)) {
    throw new Error(`Media file not found: ${sourcePath}`)
  }
  const dest = join(getQueueMediaDir(), itemId)
  ensureDir(dest)
  const destFile = join(dest, basename(abs))
  copyFileSync(abs, destFile)
  return { local_path: destFile, kind }
}

/**
 * Remove all queue-media files associated with an item ID. Best-effort —
 * a missing dir is fine; we just want the cleanup to not throw.
 */
export function pruneItemMedia(itemId: string): void {
  const dir = join(getQueueMediaDir(), itemId)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
}

/**
 * Convert a MediaRef to the wire shape the server expects (base64 for local
 * files, pass-through for URL-based media). Reads the file from disk only
 * when called — keeps the queue file small.
 */
export function materializeMediaRefForWire(
  ref: MediaRef
): { image_base64?: string; image_url?: string; video_base64?: string; video_url?: string } {
  if (ref.image_url) return { image_url: ref.image_url }
  if (ref.video_url) return { video_url: ref.video_url }
  if (!ref.local_path) {
    throw new Error('MediaRef has no local_path or *_url — invalid queue entry')
  }
  const buf = readFileSync(ref.local_path)
  const ext = ref.local_path.split('.').pop()?.toLowerCase() || (ref.kind === 'video' ? 'mp4' : 'png')
  if (ref.kind === 'video') {
    return { video_base64: `data:video/${ext};base64,${buf.toString('base64')}` }
  }
  return { image_base64: `data:image/${ext};base64,${buf.toString('base64')}` }
}

/* ─── Scheduled items ────────────────────────────────────────────────── */

export interface AddScheduledInput {
  account_username: string
  action: SocialAction
  text?: string
  texts?: string[]
  media?: MediaRef[]
  community_id?: string
  post_at: string                                     // ISO 8601
}

export function addScheduled(input: AddScheduledInput): ScheduledItem {
  const id = randomUUID()
  const now = new Date().toISOString()
  const item: ScheduledItem = {
    id,
    platform: 'x',
    account_username: input.account_username,
    action: input.action,
    text: input.text,
    texts: input.texts,
    media: input.media,
    community_id: input.community_id,
    post_at: input.post_at,
    status: 'pending',
    created_at: now,
    retry_count: 0,
  }
  const q = loadQueue()
  q.scheduled.push(item)
  saveQueue(q)
  return item
}

export function cancelScheduled(id: string): { cancelled: boolean; item?: ScheduledItem } {
  const q = loadQueue()
  const idx = q.scheduled.findIndex(s => s.id === id)
  if (idx === -1) return { cancelled: false }
  const item = q.scheduled[idx]
  if (item.status === 'in_progress') {
    return { cancelled: false, item }                 // can't cancel mid-flight
  }
  q.scheduled.splice(idx, 1)
  pruneItemMedia(id)
  saveQueue(q)
  return { cancelled: true, item }
}

export interface ListScheduledFilter {
  account?: string
  from?: string                                       // ISO 8601
  to?: string                                         // ISO 8601
}

export function listScheduled(filter?: ListScheduledFilter): ScheduledItem[] {
  const q = loadQueue()
  return q.scheduled.filter(s => {
    if (filter?.account && s.account_username !== filter.account) return false
    if (filter?.from && s.post_at < filter.from) return false
    if (filter?.to && s.post_at > filter.to) return false
    return true
  }).sort((a, b) => a.post_at.localeCompare(b.post_at))
}

/* ─── Drafts ─────────────────────────────────────────────────────────── */

export interface AddDraftInput {
  account_username: string
  action: SocialAction
  text?: string
  texts?: string[]
  media?: MediaRef[]
  community_id?: string
  name?: string
}

export function addDraft(input: AddDraftInput): DraftItem {
  const id = randomUUID()
  const now = new Date().toISOString()
  const item: DraftItem = {
    id,
    platform: 'x',
    account_username: input.account_username,
    action: input.action,
    text: input.text,
    texts: input.texts,
    media: input.media,
    community_id: input.community_id,
    name: input.name,
    created_at: now,
    updated_at: now,
  }
  const q = loadQueue()
  q.drafts.push(item)
  saveQueue(q)
  return item
}

export function deleteDraft(id: string): boolean {
  const q = loadQueue()
  const idx = q.drafts.findIndex(d => d.id === id)
  if (idx === -1) return false
  q.drafts.splice(idx, 1)
  pruneItemMedia(id)
  saveQueue(q)
  return true
}

export function listDrafts(account?: string): DraftItem[] {
  const q = loadQueue()
  return q.drafts
    .filter(d => !account || d.account_username === account)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

/**
 * Move a draft to scheduled with a fire time. The draft entry is removed;
 * the new scheduled entry gets a fresh ID (so cancellation by ID works
 * cleanly without ambiguity). Media stays under the draft's old ID dir —
 * we move the dir to the new ID atomically.
 */
export function promoteDraft(draftId: string, postAt: string): ScheduledItem | null {
  const q = loadQueue()
  const idx = q.drafts.findIndex(d => d.id === draftId)
  if (idx === -1) return null
  const draft = q.drafts[idx]

  const newId = randomUUID()
  const now = new Date().toISOString()

  // Move media dir from old draft id → new scheduled id
  let movedMedia: MediaRef[] | undefined = undefined
  if (draft.media && draft.media.length > 0) {
    const oldDir = join(getQueueMediaDir(), draftId)
    const newDir = join(getQueueMediaDir(), newId)
    if (existsSync(oldDir)) {
      ensureDir(getQueueMediaDir())
      // Use rename if possible; fallback to copy+delete on cross-device renames.
      try {
        const fs = require('fs')
        fs.renameSync(oldDir, newDir)
      } catch {
        ensureDir(newDir)
        for (const m of draft.media) {
          if (m.local_path) {
            const newPath = join(newDir, basename(m.local_path))
            copyFileSync(m.local_path, newPath)
          }
        }
        try { rmSync(oldDir, { recursive: true, force: true }) } catch { /* noop */ }
      }
    }
    // Rewrite local_paths to point at the new dir.
    movedMedia = draft.media.map(m => {
      if (m.local_path) {
        return { ...m, local_path: join(newDir, basename(m.local_path)) }
      }
      return m
    })
  }

  const scheduled: ScheduledItem = {
    id: newId,
    platform: 'x',
    account_username: draft.account_username,
    action: draft.action,
    text: draft.text,
    texts: draft.texts,
    media: movedMedia,
    community_id: draft.community_id,
    post_at: postAt,
    status: 'pending',
    created_at: now,
    retry_count: 0,
  }

  q.drafts.splice(idx, 1)
  q.scheduled.push(scheduled)
  saveQueue(q)
  return scheduled
}

/* ─── Worker-facing helpers (used by Day 4 worker process) ──────────── */

export function getDueScheduled(now: Date = new Date()): ScheduledItem[] {
  const q = loadQueue()
  const nowIso = now.toISOString()
  return q.scheduled.filter(s => s.status === 'pending' && s.post_at <= nowIso)
}

export function markScheduledInProgress(id: string): boolean {
  const q = loadQueue()
  const item = q.scheduled.find(s => s.id === id)
  if (!item || item.status !== 'pending') return false
  item.status = 'in_progress'
  item.attempted_at = new Date().toISOString()
  saveQueue(q)
  return true
}

export function markScheduledPublished(id: string, result: any): void {
  const q = loadQueue()
  const idx = q.scheduled.findIndex(s => s.id === id)
  if (idx === -1) return
  const item = q.scheduled[idx]
  q.scheduled.splice(idx, 1)
  q.published.push({
    id: item.id,
    platform: item.platform,
    account_username: item.account_username,
    action: item.action,
    result,
    posted_at: new Date().toISOString(),
  })
  pruneItemMedia(id)
  saveQueue(q)
}

export function markScheduledFailed(id: string, error: string, retryable: boolean): void {
  const q = loadQueue()
  const idx = q.scheduled.findIndex(s => s.id === id)
  if (idx === -1) return
  const item = q.scheduled[idx]
  if (retryable && item.retry_count < 3) {
    // Bump retry counter, return to pending, push post_at out by exponential backoff.
    item.retry_count += 1
    item.status = 'pending'
    const backoffMin = Math.pow(2, item.retry_count) * 5    // 10, 20, 40 min
    item.post_at = new Date(Date.now() + backoffMin * 60_000).toISOString()
    saveQueue(q)
    return
  }
  // Terminal failure — move to failed[].
  q.scheduled.splice(idx, 1)
  q.failed.push({
    id: item.id,
    platform: item.platform,
    account_username: item.account_username,
    action: item.action,
    error,
    failed_at: new Date().toISOString(),
    retry_count: item.retry_count,
  })
  pruneItemMedia(id)
  saveQueue(q)
}

/* ─── Read-only history accessors ────────────────────────────────────── */

export function listPublished(account?: string): PublishedItem[] {
  const q = loadQueue()
  return q.published
    .filter(p => !account || p.account_username === account)
    .sort((a, b) => b.posted_at.localeCompare(a.posted_at))
}

export function listFailed(account?: string): FailedItem[] {
  const q = loadQueue()
  return q.failed
    .filter(f => !account || f.account_username === account)
    .sort((a, b) => b.failed_at.localeCompare(a.failed_at))
}
