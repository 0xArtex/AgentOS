/**
 * SSH-key helpers for the `compute` command group.
 *
 * Three responsibilities:
 *   1. Local keypair generation (`generateKeypair`) — shells out to `ssh-keygen`
 *      so we don't have to ship our own OpenSSH-format encoder. Saved under
 *      `~/.agentos/ssh/<server-id>/id_ed25519{,.pub}` with chmod 600.
 *   2. Local server cache (`saveDeployedServer` / `findCachedServer`) — lets
 *      `agentos compute ssh <name>` resolve a friendly name → IP without a
 *      paid `GET /compute/servers` round-trip.
 *   3. Wait-for-running (`waitForRunning`) — polls the server's status with
 *      backoff until Hetzner reports `running` or the deadline trips.
 */

import { execSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

const AGENTOS_DIR = join(homedir(), '.agentos')
const SSH_DIR = join(AGENTOS_DIR, 'ssh')
const SERVER_CACHE = join(AGENTOS_DIR, 'data', 'servers.json')

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

/**
 * Confirm `ssh-keygen` is on PATH before we promise a keypair to the caller.
 * On Windows it's bundled with Git for Windows / OpenSSH client; on macOS and
 * most Linux distros it's installed by default. We prefer this over rolling
 * our own ed25519 OpenSSH-format encoder because the file format
 * (`-----BEGIN OPENSSH PRIVATE KEY-----`, base64-wrapped, encrypted by KDF)
 * is finicky to produce correctly without bugs.
 */
export function hasSshKeygen(): boolean {
  try {
    const r = spawnSync('ssh-keygen', ['-V'], { stdio: 'pipe' })
    // ssh-keygen prints help to stderr and exits non-zero on -V, but the
    // command is found if spawn didn't ENOENT.
    return r.error == null
  } catch {
    return false
  }
}

export interface GeneratedKeypair {
  privateKeyPath: string
  publicKeyPath: string
  publicKey: string
  /** Comment field embedded in the .pub file ("agentos-<serverId>"). */
  comment: string
}

/**
 * Generate a fresh ed25519 keypair in `~/.agentos/ssh/<serverId>/`. The label
 * (typically the Hetzner server id, but any safe slug works) namespaces the
 * key so multiple deploys don't trample each other. Caller is responsible for
 * passing the resulting `publicKey` string to the deploy endpoint.
 *
 * Throws if `ssh-keygen` isn't on PATH or if the key already exists at the
 * destination — refusing to overwrite is intentional, the user should delete
 * the old key explicitly if they want a clean slate.
 */
export function generateKeypair(label: string): GeneratedKeypair {
  if (!hasSshKeygen()) {
    throw new Error(
      "ssh-keygen not on PATH. Install OpenSSH client (Windows: 'Add Optional Feature → OpenSSH Client', macOS: bundled, Linux: 'apt install openssh-client') or pass --pubkey-file to deploy with an existing key.",
    )
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(label)) {
    throw new Error('keypair label must be 1–64 chars of [A-Za-z0-9._-]')
  }
  const dir = join(SSH_DIR, label)
  ensureDir(dir)
  const privateKeyPath = join(dir, 'id_ed25519')
  const publicKeyPath = privateKeyPath + '.pub'
  if (existsSync(privateKeyPath)) {
    throw new Error(
      `Key already exists at ${privateKeyPath}. Delete it first or pass --pubkey-file ${publicKeyPath} to reuse it.`,
    )
  }
  const comment = `agentos-${label}`
  // -N "" is empty passphrase. -q suppresses ssh-keygen's banner.
  // We pass the path with no shell metachars (label already validated).
  const r = spawnSync(
    'ssh-keygen',
    ['-t', 'ed25519', '-N', '', '-q', '-f', privateKeyPath, '-C', comment],
    { stdio: 'pipe' },
  )
  if (r.status !== 0) {
    const errText = (r.stderr?.toString() || r.stdout?.toString() || 'ssh-keygen failed').trim()
    throw new Error(`ssh-keygen failed: ${errText}`)
  }
  // ssh-keygen sets 600 on Unix already, but Windows NTFS doesn't honor that.
  // chmod is a no-op on Windows but harmless.
  try { chmodSync(privateKeyPath, 0o600) } catch {}
  const publicKey = readFileSync(publicKeyPath, 'utf8').trim()
  return { privateKeyPath, publicKeyPath, publicKey, comment }
}

/**
 * The shape we cache locally for `compute ssh <name>` lookup. Mirrors the
 * subset of Hetzner's server fields we actually need (name → IP plus a hint
 * about which key to use). Anything else can be re-fetched via `compute list`.
 */
export interface CachedServer {
  id: string
  name: string
  ipv4: string | null
  serverType?: string
  /** Path to the private key matching the deployed pubkey, if we generated one. */
  sshPrivateKeyPath?: string
  /** Hetzner SSH key IDs attached at deploy. */
  sshKeyIds?: number[]
  /** ISO timestamp of when we deployed. Used for cache freshness, not auth. */
  deployedAt: string
}

function readCache(): CachedServer[] {
  if (!existsSync(SERVER_CACHE)) return []
  try {
    const data = JSON.parse(readFileSync(SERVER_CACHE, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function writeCache(entries: CachedServer[]): void {
  ensureDir(dirname(SERVER_CACHE))
  writeFileSync(SERVER_CACHE, JSON.stringify(entries, null, 2))
}

export function saveDeployedServer(s: CachedServer): void {
  const all = readCache().filter(e => e.id !== s.id && e.name !== s.name)
  all.push(s)
  writeCache(all)
}

export function removeCachedServer(idOrName: string): void {
  const filtered = readCache().filter(e => e.id !== idOrName && e.name !== idOrName)
  writeCache(filtered)
}

/**
 * Resolve a user-supplied identifier (name or id) against the local cache.
 * Returns the first matching entry, or null if nothing matches. Caller can
 * fall back to a server-side `GET /compute/servers` lookup on null.
 */
export function findCachedServer(idOrName: string): CachedServer | null {
  const norm = idOrName.trim()
  if (!norm) return null
  const all = readCache()
  // Exact id match wins over name match — ids are globally unique, names aren't.
  return all.find(e => e.id === norm) || all.find(e => e.name === norm) || null
}

export function listCachedServers(): CachedServer[] {
  return readCache()
}

/**
 * Spawn `ssh root@<ip>` with stdio inherited so the user's interactive
 * session takes over the parent terminal. The optional `keyPath` is appended
 * as `-i <path>` only if the file actually exists — saves a confusing "no
 * such identity" error when the cached path is stale.
 *
 * Returns the ssh exit code (or non-zero on spawn failure). Caller is
 * expected to `process.exit(returnCode)` so shell pipelines see the right
 * status. Non-TTY callers shouldn't reach here — they should print the
 * command instead via `buildSshCommand`.
 */
export function spawnInteractiveSsh(ip: string, keyPath?: string): number {
  const args: string[] = []
  if (keyPath && existsSync(keyPath)) args.push('-i', keyPath)
  args.push(
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=' + join(AGENTOS_DIR, 'ssh', 'known_hosts'),
    `root@${ip}`,
  )
  ensureDir(join(AGENTOS_DIR, 'ssh'))
  const r = spawnSync('ssh', args, { stdio: 'inherit' })
  if (r.error) {
    process.stderr.write(`ssh spawn failed: ${(r.error as any).message}\n`)
    return 127
  }
  return r.status ?? 1
}

/**
 * Build the equivalent shell command without running it. Used in agent mode
 * so the caller (an automated runner) can shell out to ssh themselves.
 */
export function buildSshCommand(ip: string, keyPath?: string): string {
  const parts = ['ssh']
  if (keyPath && existsSync(keyPath)) parts.push('-i', shellQuote(keyPath))
  parts.push(`root@${ip}`)
  return parts.join(' ')
}

function shellQuote(s: string): string {
  // Simple POSIX quoting — wrap in single quotes, escape any embedded ones.
  // Good enough for path-like inputs we control; not for arbitrary user data.
  if (/^[A-Za-z0-9._/:\\-]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Poll `getStatus()` until it returns `running` or the deadline trips. Backs
 * off from 1s → 5s so we don't hammer the API while a fresh box is doing its
 * first-boot work (Hetzner servers usually go `initializing` → `running` in
 * 30–60s). Returns the final status object or throws on timeout.
 */
export async function waitForRunning(
  getStatus: () => Promise<{ status: string; ipv4: string | null }>,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: string; ipv4: string | null }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
  let delay = 1_000
  while (Date.now() < deadline) {
    const s = await getStatus().catch(() => null)
    if (s && s.status === 'running' && s.ipv4) return s
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 1.4, 5_000)
  }
  throw new Error(`Server did not reach 'running' state within ${opts.timeoutMs ?? 120_000}ms`)
}
