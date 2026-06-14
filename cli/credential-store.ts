/**
 * OS credential store — CLI-side module for protecting wallet session secrets.
 *
 * Windows: DPAPI via PowerShell (encrypted blob at ~/.palmyr/secrets/<id>.dpapi)
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

const SECRETS_DIR = join(homedir(), '.palmyr', 'secrets')
const SERVICE = 'palmyr-wallet'
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
  // The secret is read from the child's STDIN — never placed on argv (visible
  // via Win32_Process / Process Explorer) nor written to a temp file (which can
  // outlive a killed process). Only the non-secret script + output path travel
  // on the command line. `ReadToEnd()` returns the stdin bytes verbatim; we feed
  // exactly `secret` (no trailing newline) so the DPAPI plaintext matches.
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$s = [Console]::In.ReadToEnd()',
    '$bytes = [System.Text.Encoding]::UTF8.GetBytes($s)',
    '$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    `[System.IO.File]::WriteAllBytes('${outPath.replace(/\\/g, '\\\\').replace(/'/g, "''")}', $enc)`,
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    input: secret,
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 10000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`DPAPI protect failed with exit code ${result.status}`)
  }
}

function retrieveWindows(account: string): string | null {
  const fpath = dpapiPath(account)
  if (!existsSync(fpath)) return null
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$enc = [System.IO.File]::ReadAllBytes('${fpath.replace(/\\/g, '\\\\').replace(/'/g, "''")}')`,
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

// ─── Batched storage ───
//
// One PowerShell process startup is ~300-500ms on Windows. Sealing 100
// session secrets one at a time stretches `wallet create --count 100` to
// nearly a minute purely from process overhead. `storeSecretsBatch` seals
// every secret inside a single powershell.exe invocation by piping a generated
// script over STDIN (`-Command -`). STDIN keeps the secrets off both argv and
// disk, while also dodging the ~8191-char `-Command` arg cap that would
// otherwise blow once you hit ~30 wallets. On mac/Linux the per-call cost is
// small enough that we just loop.

function storeSecretsBatchWindows(items: Array<{ account: string; secret: string }>): void {
  ensureSecretsDir()
  const scriptLines: string[] = ['Add-Type -AssemblyName System.Security']
  for (const item of items) {
    const escapedPath = dpapiPath(item.account).replace(/\\/g, '\\\\').replace(/'/g, "''")
    // assertHex already ran on every input, so embedding the secret as a
    // single-quoted PS literal is injection-safe (hex has no quotes/backticks).
    scriptLines.push(
      `$b = [System.Text.Encoding]::UTF8.GetBytes('${item.secret}'); ` +
      `$e = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
      `[System.IO.File]::WriteAllBytes('${escapedPath}', $e)`
    )
  }
  // The script (which inlines every plaintext secret) is fed to PowerShell over
  // STDIN via `-Command -`, NOT written to a `.ps1` temp file and NOT placed on
  // argv. This keeps secrets off the process command line (Win32_Process) and
  // off disk entirely — there is no temp file to survive a killed process.
  // `-Command -` also sidesteps Windows' ~8191-char argv cap that originally
  // forced the file path, so batches of any size go through one process.
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', '-'],
    {
      input: scriptLines.join('\n'),
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 180_000,
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`DPAPI batch protect failed with exit code ${result.status}`)
  }
}

export function storeSecretsBatch(items: Array<{ account: string; secret: string }>): void {
  if (!items || items.length === 0) return
  for (const item of items) {
    assertHex(item.account, 'account')
    assertHex(item.secret, 'secret')
  }
  const p = platform()
  try {
    if (p === 'win32') return storeSecretsBatchWindows(items)
    for (const item of items) {
      if (p === 'darwin') storeMac(item.account, item.secret)
      else storeLinux(item.account, item.secret)
    }
  } catch (err: any) {
    throw new Error(
      `Failed to store secrets in OS credential store (${p}): ${err.message}. ` +
      `On Windows, ensure PowerShell and DPAPI are available.`,
    )
  }
}
