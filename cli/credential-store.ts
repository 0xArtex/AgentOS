/**
 * OS credential store — CLI-side module for protecting wallet session secrets.
 *
 * Windows: DPAPI via PowerShell (encrypted blob at ~/.agentos/secrets/<id>.dpapi)
 * macOS:   Keychain via `security` CLI
 * Linux:   Secret Service via `secret-tool` CLI
 *
 * Security: All inputs are validated as hex-only before use. All OS commands
 * use execFileSync/spawnSync with argument arrays — never shell interpolation.
 */
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SECRETS_DIR = join(homedir(), '.agentos', 'secrets')
const SERVICE = 'agentos-wallet'
const HEX_RE = /^[0-9a-f]+$/i

function ensureSecretsDir(): void {
  if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true })
}

function dpapiPath(account: string): string {
  return join(SECRETS_DIR, `${account}.dpapi`)
}

function assertHex(value: string, label: string): void {
  if (!value || !HEX_RE.test(value)) {
    throw new Error(`${label} must be a non-empty hex string, got: ${typeof value === 'string' ? value.slice(0, 20) : typeof value}`)
  }
}

function platform(): 'win32' | 'darwin' | 'linux' {
  const p = process.platform
  if (p === 'win32' || p === 'darwin') return p
  return 'linux'
}

// ─── Windows (DPAPI) ───

function storeWindows(account: string, secret: string): void {
  ensureSecretsDir()
  const outPath = dpapiPath(account)
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$bytes = [System.Text.Encoding]::UTF8.GetBytes('${secret}')`,
    '$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    `[System.IO.File]::WriteAllBytes('${outPath.replace(/\\/g, '\\\\')}', $enc)`,
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore', timeout: 10000 })
}

function retrieveWindows(account: string): string | null {
  const fpath = dpapiPath(account)
  if (!existsSync(fpath)) return null
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$enc = [System.IO.File]::ReadAllBytes('${fpath.replace(/\\/g, '\\\\')}')`,
    '$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[System.Text.Encoding]::UTF8.GetString($dec)',
  ].join('; ')
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 10000 }).trim()
  } catch {
    return null
  }
}

function deleteWindows(account: string): void {
  const fpath = dpapiPath(account)
  if (existsSync(fpath)) unlinkSync(fpath)
}

// ─── macOS (Keychain) ───

function storeMac(account: string, secret: string): void {
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { stdio: 'ignore' })
  } catch {}
  execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', account, '-w', secret], { stdio: 'ignore', timeout: 5000 })
}

function retrieveMac(account: string): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return null
  }
}

function deleteMac(account: string): void {
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { stdio: 'ignore' })
  } catch {}
}

// ─── Linux (secret-tool) ───

function storeLinux(account: string, secret: string): void {
  const result = spawnSync('secret-tool', ['store', `--label=${SERVICE}`, 'service', SERVICE, 'account', account], {
    input: secret,
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 5000,
  })
  if (result.status !== 0) {
    throw new Error(`secret-tool store failed with exit code ${result.status}`)
  }
}

function retrieveLinux(account: string): string | null {
  try {
    return execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account], { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return null
  }
}

function deleteLinux(account: string): void {
  try {
    execFileSync('secret-tool', ['clear', 'service', SERVICE, 'account', account], { stdio: 'ignore' })
  } catch {}
}

// ─── Public API ───

export function isCredentialStoreAvailable(): boolean {
  const p = platform()
  try {
    if (p === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Security'], { stdio: 'ignore', timeout: 5000 })
      return true
    }
    if (p === 'darwin') {
      execFileSync('which', ['security'], { stdio: 'ignore', timeout: 2000 })
      return true
    }
    execFileSync('which', ['secret-tool'], { stdio: 'ignore', timeout: 2000 })
    return true
  } catch {
    return false
  }
}

export function storeSecret(account: string, secret: string): void {
  assertHex(account, 'account')
  assertHex(secret, 'secret')
  const p = platform()
  try {
    if (p === 'win32') return storeWindows(account, secret)
    if (p === 'darwin') return storeMac(account, secret)
    return storeLinux(account, secret)
  } catch (err: any) {
    throw new Error(
      `Failed to store secret in OS credential store (${p}): ${err.message}. ` +
      `Your wallet key cannot be stored securely. On Windows, ensure PowerShell and DPAPI are available. ` +
      `On macOS, ensure the 'security' command works. On Linux, install 'secret-tool'.`
    )
  }
}

export function retrieveSecret(account: string): string | null {
  assertHex(account, 'account')
  const p = platform()
  try {
    if (p === 'win32') return retrieveWindows(account)
    if (p === 'darwin') return retrieveMac(account)
    return retrieveLinux(account)
  } catch {
    return null
  }
}

export function deleteSecret(account: string): void {
  assertHex(account, 'account')
  const p = platform()
  try {
    if (p === 'win32') deleteWindows(account)
    else if (p === 'darwin') deleteMac(account)
    else deleteLinux(account)
  } catch {}
}
