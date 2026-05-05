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
import { createConnection } from 'net'

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

/**
 * TCP-probe `host:port` once with a hard timeout. Resolves true on connect,
 * false on RST/refused/timeout. Used as the second readiness gate after
 * Hetzner reports `running` — Hetzner's status flips before the OS finishes
 * booting and sshd binds, so we need an independent signal that port 22 is
 * actually listening.
 */
export function tcpProbe(host: string, port: number, timeoutMs: number = 3000): Promise<boolean> {
  return new Promise(resolve => {
    const sock = createConnection({ host, port })
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try { sock.destroy() } catch {}
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/**
 * Probe an SSH endpoint with the user's key, asking sshd to run `true` and
 * exit. Confirms three things at once: sshd is up, the key is in
 * authorized_keys, and the user can actually open a session. We pass
 * `BatchMode=yes` so ssh refuses to fall back to password prompts (which
 * would hang in a non-interactive runner).
 *
 * Returns true on exit code 0; false on anything else (connection refused,
 * permission denied, host key mismatch, timeout). The caller can decide
 * whether to retry — most "fresh box" failures resolve in 10–30s as
 * cloud-init finishes touching authorized_keys.
 */
export function sshProbe(ip: string, keyPath: string, timeoutSec: number = 5): boolean {
  if (!existsSync(keyPath)) return false
  // -q (quiet): suppress ssh's own MOTD/banner/warning chatter.
  // -T: refuse to allocate a pseudo-tty. Some sshd configs and login-shell
  //     setups on the remote print "tcsetattr: Inappropriate ioctl for
  //     device" + "logout" through stderr when the remote bash thinks it
  //     should manipulate terminal modes — issue #85. Forcing -T removes
  //     the entire class of failure.
  const r = spawnSync('ssh', [
    '-i', keyPath,
    '-q',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${timeoutSec}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=' + join(AGENTOS_DIR, 'ssh', 'known_hosts'),
    `root@${ip}`,
    'true',
  ], { stdio: 'pipe', timeout: (timeoutSec + 2) * 1000 })
  return r.status === 0
}

export type ReadinessCheck = 'pass' | 'fail' | 'skipped' | 'timeout'

export interface ReadinessResult {
  ready: boolean
  ip: string | null
  status: string | null
  /** Per-gate result so the caller can branch on which one tripped. */
  checks: {
    hetznerStatus: ReadinessCheck
    port22: ReadinessCheck
    ssh: ReadinessCheck
    /** Only populated when the deploy requested an install recipe. */
    installs?: ReadinessCheck
  }
  /**
   * Per-gate explanation when `checks.<gate> === 'skipped'`. Omitted for
   * `pass`/`fail`/`timeout` since those are self-explanatory. Lets agents
   * (and humans) immediately see WHY a gate didn't run instead of having
   * to reason about it from the call shape — issue #85 had a `compute
   * wait --install hermes` return ssh+installs as `skipped` with no
   * indication that the cause was a missing local key path.
   */
  skipReasons?: {
    ssh?: string
    installs?: string
  }
  elapsedMs: number
  /** Diagnostic string when `ready === false`. */
  reason?: string
  /** Parsed contents of /etc/agentos/install-status.json on success. */
  installStatus?: { installs: string[]; completed_at: string; status: string }
  /** Cloud-init logs + recipe logs, fetched on failure when we can SSH. */
  diagnostics?: {
    cloudInitStatus?: string | null
    cloudInitLogTail?: string | null
    agentosLogTail?: string | null
    recipeLogs?: Array<{ name: string; tail: string }>
  }
}

/**
 * Run a single command on the server via SSH using the platform/user key
 * supplied to gate 3 + 4. Returns {stdout, status} so callers can branch on
 * exit code rather than just trim/parse stdout.
 *
 * Used by the install-status probe, the cloud-init status probe, and the
 * diagnostic-fetcher that runs on readiness failure. None of those need
 * structured stderr handling, so we redirect 2>&1 to keep a single buffer.
 */
function sshRun(ip: string, keyPath: string, command: string, timeoutSec: number = 10): { stdout: string; status: number } {
  if (!existsSync(keyPath)) return { stdout: '', status: 127 }
  // -q + -T: see sshProbe for rationale. Same defensive flags everywhere.
  const r = spawnSync('ssh', [
    '-i', keyPath,
    '-q',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.min(15, timeoutSec)}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=' + join(AGENTOS_DIR, 'ssh', 'known_hosts'),
    `root@${ip}`,
    command,
  ], { stdio: 'pipe', timeout: (timeoutSec + 2) * 1000, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
  return {
    stdout: (r.stdout ?? '').toString(),
    status: r.status === null ? 124 : r.status,
  }
}

/**
 * Read /etc/agentos/install-status.json from the server via SSH. Returns the
 * parsed object on success, null if the file doesn't exist yet (cloud-init
 * still running) or can't be parsed. Used as gate 4 of the readiness chain
 * when a deploy requested install recipes.
 */
export function readInstallStatus(ip: string, keyPath: string, timeoutSec: number = 8):
  | { installs: string[]; completed_at: string; status: string }
  | null
{
  // 2>/dev/null suppresses the "no such file" error so the missing-file
  // case is just an empty stdout, not a parse failure with stderr noise.
  const r = sshRun(ip, keyPath, 'cat /etc/agentos/install-status.json 2>/dev/null', timeoutSec)
  if (r.status !== 0) return null
  const out = r.stdout.trim()
  if (!out) return null
  try {
    const parsed = JSON.parse(out)
    if (parsed && typeof parsed === 'object' && parsed.status === 'ok' && Array.isArray(parsed.installs)) {
      return parsed as any
    }
  } catch {}
  return null
}

/**
 * Probe `cloud-init status` so the readiness chain can fail fast when the
 * user_data script has clearly aborted. Returns the parsed status string
 * (`done`, `running`, `error`, `disabled`, etc.) or null when the binary
 * isn't reachable yet.
 *
 * Polled in gate 4 — if it returns 'error' we break out immediately and
 * surface diagnostics, instead of waiting the full 600s install timeout
 * for a marker file that's never going to be written.
 */
export function readCloudInitStatus(ip: string, keyPath: string, timeoutSec: number = 8): string | null {
  const r = sshRun(ip, keyPath, 'cloud-init status 2>/dev/null', timeoutSec)
  if (r.status !== 0) return null
  // cloud-init status output: "status: done" / "status: error" / etc.
  const m = r.stdout.match(/status:\s*(\S+)/)
  return m ? m[1] : null
}

/**
 * On readiness failure, SSH in (best effort) and grab a small bundle of
 * diagnostic data so the JSON response includes a clear cause without the
 * caller needing to ssh in by hand:
 *
 *   - cloud-init status (--long if available)
 *   - tail of /var/log/cloud-init-output.log
 *   - tail of /var/log/agentos/cloud-init.log (the wrapper's own tee)
 *   - tail of any /var/log/agentos/<recipe>-install.log files
 *
 * Tails are capped to keep response bodies sane. If SSH is unreachable
 * (gate 2 or 3 tripped), returns a short note instead of throwing.
 */
export function fetchDeployDiagnostics(ip: string, keyPath: string): {
  cloudInitStatus: string | null
  cloudInitLogTail: string | null
  agentosLogTail: string | null
  recipeLogs: Array<{ name: string; tail: string }>
} {
  const result = {
    cloudInitStatus: null as string | null,
    cloudInitLogTail: null as string | null,
    agentosLogTail: null as string | null,
    recipeLogs: [] as Array<{ name: string; tail: string }>,
  }
  if (!existsSync(keyPath)) return result

  // cloud-init status --long has more detail than plain status (errors[],
  // boot_status_code, etc.) but is also Ubuntu-version-dependent. Fall back
  // to plain status if --long isn't supported.
  const status = sshRun(ip, keyPath, 'cloud-init status --long 2>/dev/null || cloud-init status 2>/dev/null', 10)
  if (status.status === 0 && status.stdout.trim()) {
    result.cloudInitStatus = status.stdout.trim().split('\n').slice(0, 40).join('\n')
  }

  const ciLog = sshRun(ip, keyPath, 'tail -120 /var/log/cloud-init-output.log 2>/dev/null', 15)
  if (ciLog.status === 0 && ciLog.stdout.trim()) {
    result.cloudInitLogTail = ciLog.stdout
  }

  const agentosLog = sshRun(ip, keyPath, 'tail -80 /var/log/agentos/cloud-init.log 2>/dev/null', 15)
  if (agentosLog.status === 0 && agentosLog.stdout.trim()) {
    result.agentosLogTail = agentosLog.stdout
  }

  // List per-recipe install logs and tail the last one each. We use ls + a
  // capped find so we don't accidentally pull megabytes from a runaway log.
  const list = sshRun(ip, keyPath, 'ls /var/log/agentos/*-install.log 2>/dev/null', 10)
  if (list.status === 0) {
    const files = list.stdout.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 8)
    for (const file of files) {
      // Path is from `ls`, not user input, so safe to splice.
      const r = sshRun(ip, keyPath, `tail -80 ${file}`, 15)
      if (r.status === 0) {
        const m = file.match(/\/([^/]+)-install\.log$/)
        result.recipeLogs.push({ name: m ? m[1] : file, tail: r.stdout })
      }
    }
  }

  return result
}

/**
 * Four-gate readiness chain used by `compute deploy --wait` and `compute
 * wait <id>`:
 *
 *   1. Hetzner status flips to `running`.
 *   2. TCP port 22 accepts connections.
 *   3. (Optional) `ssh -i <key> root@<ip> 'true'` exits 0.
 *   4. (Optional) /etc/agentos/install-status.json exists with `status: ok`
 *      and contains every recipe in `expectedInstalls`. Skipped when no
 *      installs were requested at deploy time, OR when we don't have a
 *      private key path to SSH in with.
 *
 * Gate 3 is skipped when `keyPath` is undefined or the file doesn't exist —
 * e.g. user deployed with `--ssh-key <hetzner-id>` and we don't have the
 * private key locally. They get gates 1+2 and a documented "ssh: skipped"
 * marker so they know the credential check wasn't done.
 *
 * The function shares one wall-clock budget across all four gates so a slow
 * Hetzner provisioning step doesn't steal time from the install poll. Default
 * 240s is enough for the SSH gates with no install; bump via `timeoutMs` (the
 * CLI defaults to 600s when an install is requested, since Hermes pulls
 * Python 3.11 + several hundred MB of pip packages).
 */
export async function waitForReady(opts: {
  getStatus: () => Promise<{ status: string; ipv4: string | null }>
  keyPath?: string
  timeoutMs?: number
  /** Recipe names that the deploy requested; the gate-4 marker file must contain all of them with status=ok. */
  expectedInstalls?: string[]
  /** Optional progress callback fired on each gate transition. Invoked once with `{ stage, message }` per stage entry; never called from within the inner polling loops. */
  onProgress?: (event: { stage: 'status' | 'port22' | 'ssh' | 'installs'; message: string }) => void
}): Promise<ReadinessResult> {
  const startedAt = Date.now()
  const deadline = startedAt + (opts.timeoutMs ?? 240_000)
  const checks: ReadinessResult['checks'] = {
    hetznerStatus: 'fail',
    port22: 'skipped',
    ssh: 'skipped',
  }
  let ip: string | null = null
  let status: string | null = null

  // Gate 1: Hetzner status → running
  opts.onProgress?.({ stage: 'status', message: 'Waiting for Hetzner status=running…' })
  let delay = 1_000
  while (Date.now() < deadline) {
    const s = await opts.getStatus().catch(() => null)
    if (s) {
      status = s.status
      ip = s.ipv4
      if (s.status === 'running' && s.ipv4) {
        checks.hetznerStatus = 'pass'
        break
      }
    }
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 1.4, 5_000)
  }
  if (checks.hetznerStatus !== 'pass') {
    checks.hetznerStatus = 'timeout'
    return {
      ready: false,
      ip,
      status,
      checks,
      elapsedMs: Date.now() - startedAt,
      reason: `Hetzner status did not reach 'running' (last seen: ${status ?? 'unknown'})`,
    }
  }

  // Gate 2: TCP port 22
  opts.onProgress?.({ stage: 'port22', message: 'Probing port 22…' })
  checks.port22 = 'fail'
  let port22Open = false
  delay = 1_000
  while (Date.now() < deadline) {
    if (await tcpProbe(ip!, 22, 3_000)) {
      checks.port22 = 'pass'
      port22Open = true
      break
    }
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 1.4, 5_000)
  }
  if (!port22Open) {
    checks.port22 = 'timeout'
    return {
      ready: false,
      ip,
      status,
      checks,
      elapsedMs: Date.now() - startedAt,
      reason: `Server is running but port 22 did not open within the timeout`,
    }
  }

  // Gate 3: SSH credential probe (optional)
  const skipReasons: NonNullable<ReadinessResult['skipReasons']> = {}
  if (opts.keyPath && existsSync(opts.keyPath)) {
    opts.onProgress?.({ stage: 'ssh', message: `Verifying SSH login with ${opts.keyPath}…` })
    checks.ssh = 'fail'
    let sshOk = false
    delay = 2_000
    while (Date.now() < deadline) {
      if (sshProbe(ip!, opts.keyPath, 5)) {
        checks.ssh = 'pass'
        sshOk = true
        break
      }
      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(delay * 1.4, 5_000)
    }
    if (!sshOk) {
      checks.ssh = 'timeout'
      return {
        ready: false,
        ip,
        status,
        checks,
        elapsedMs: Date.now() - startedAt,
        reason: `Port 22 is open but ssh -i ${opts.keyPath} root@${ip} did not authenticate. Check that the public half is in authorized_keys (cloud-init may still be running).`,
      }
    }
  } else {
    checks.ssh = 'skipped'
    skipReasons.ssh = opts.keyPath
      ? `Private key not found at ${opts.keyPath}.`
      : 'No local SSH key path supplied. Pass --key <path> to enable the SSH credential probe, or run from the host where the key was generated.'
  }

  // Gate 4: Install marker (optional). Cloud-init writes
  // /etc/agentos/install-status.json once every requested recipe finishes.
  // We poll it via SSH every 5–8s, AND probe `cloud-init status` so we can
  // fail fast when scripts_user has aborted (no point polling for a marker
  // file that's never going to land).
  let installStatus: ReadinessResult['installStatus']
  if (opts.expectedInstalls && opts.expectedInstalls.length > 0) {
    if (opts.keyPath && existsSync(opts.keyPath)) {
      checks.installs = 'fail'
      opts.onProgress?.({ stage: 'installs', message: `Waiting for installs to finish: ${opts.expectedInstalls.join(', ')}…` })
      let installOk = false
      let cloudInitErrored = false
      delay = 5_000
      let pollIter = 0
      while (Date.now() < deadline) {
        const s = readInstallStatus(ip!, opts.keyPath, 8)
        if (s) {
          // Confirm every requested recipe shows up in the marker. The server
          // writes them in install order, so set-equality is sufficient.
          const have = new Set(s.installs)
          const missing = opts.expectedInstalls.filter(r => !have.has(r))
          if (missing.length === 0) {
            checks.installs = 'pass'
            installStatus = s
            installOk = true
            break
          }
        }

        // Every 3rd iteration, probe cloud-init status. Don't probe every
        // tick — it's an extra SSH roundtrip and cloud-init's status file
        // doesn't update that often anyway. 3 polls × ~6s = ~18s cadence.
        pollIter++
        if (pollIter % 3 === 0) {
          const ciStatus = readCloudInitStatus(ip!, opts.keyPath, 8)
          if (ciStatus === 'error') {
            cloudInitErrored = true
            break
          }
        }

        await new Promise(r => setTimeout(r, delay))
        delay = Math.min(delay * 1.2, 8_000)
      }
      if (!installOk) {
        checks.installs = cloudInitErrored ? 'fail' : 'timeout'
        const diagnostics = fetchDeployDiagnostics(ip!, opts.keyPath)
        return {
          ready: false,
          ip,
          status,
          checks,
          elapsedMs: Date.now() - startedAt,
          reason: cloudInitErrored
            ? `cloud-init aborted (status: error). The user_data script failed before writing the install marker. See diagnostics.cloudInitLogTail for the failure.`
            : `Install did not complete within ${Math.round((opts.timeoutMs ?? 240_000) / 1000)}s. Recipes requested: ${opts.expectedInstalls.join(', ')}. See diagnostics for cloud-init + recipe logs.`,
          installStatus,
          diagnostics,
        }
      }
    } else {
      // Install was requested but we have no local key to SSH in with — can't
      // poll the marker. Mark skipped so the caller knows the gate didn't run.
      checks.installs = 'skipped'
      skipReasons.installs = opts.keyPath
        ? `Private key not found at ${opts.keyPath}; can't read /etc/agentos/install-status.json.`
        : 'No local SSH key path supplied; can\'t read /etc/agentos/install-status.json. Pass --key <path>, or check the marker manually: agentos compute exec <id> -- cat /etc/agentos/install-status.json'
    }
  }

  return {
    ready: true,
    ip,
    status,
    checks,
    ...(Object.keys(skipReasons).length > 0 ? { skipReasons } : {}),
    elapsedMs: Date.now() - startedAt,
    installStatus,
  }
}
