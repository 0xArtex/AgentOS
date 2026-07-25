/**
 * Pure helpers behind two CLI guards (wired up in cli.ts):
 *
 *   1. Strict unknown-flag check — a typo like `--dubject` fails fast with
 *      `Unknown flag: --dubject` + the command's valid flags, instead of
 *      falling through the parser and resurfacing as a confusing
 *      "missing required flag" error.
 *
 *   2. `chat run` USDC balance preflight — the balance-vs-required comparison
 *      and the abort message shown when a wallet can't cover a plan.
 *
 * Extracted from cli.ts so they can be unit-tested from src/tests/ — the CLI
 * itself is ESM + Ink and only testable end-to-end by spawning the built
 * binary. Keep this module dependency-free: no imports, no I/O.
 */

export interface HelpEntry {
  flag: string
  desc: string
  hint?: string
}

/**
 * Flags accepted on every command: agent-mode toggles, help/version, and the
 * auth/passphrase plumbing read before dispatch in main(). `color` covers the
 * parser's `--no-color` → `flags.color = false` normalization. `max-usdc` is
 * documented in cli.ts's global-flag catalog as honored across commands.
 * `verbose` is currently inert but advertised by the chat-run error truncator
 * ("rerun with --verbose") — accept it so following that hint never errors.
 */
export const GLOBAL_FLAGS: readonly string[] = [
  'help', 'version', 'json', 'no-color', 'color', 'quiet', 'token', 'passphrase', 'max-usdc', 'verbose',
]

/**
 * Derive the set of flag names documented in a help table by scanning every
 * entry's flag/desc/hint strings for `--flag-name` tokens. Deliberately
 * lenient: a flag mentioned anywhere in the table (aliases in descriptions,
 * shared "(other flags)" entries, examples) counts as valid. The guard exists
 * to catch typos, not to be a schema validator.
 */
export function flagNamesFromTable(table: Record<string, HelpEntry[]> | undefined): Set<string> {
  const out = new Set<string>()
  if (!table) return out
  for (const entries of Object.values(table)) {
    for (const e of entries) {
      for (const s of [e.flag, e.desc, e.hint ?? '']) {
        for (const m of s.matchAll(/--([a-z0-9][\w-]*)/gi)) out.add(m[1].toLowerCase())
      }
    }
  }
  return out
}

/**
 * Return the raw `--` flag keys (as typed, without the dashes) that are not in
 * `allowed`. Case-insensitive, order-preserving, de-duplicated. Handles the
 * parser's `--no-<x>` boolean-false convention in both directions: `--no-usd`
 * is valid when the command documents either `--no-usd` or `--usd`, and a bare
 * `--wait` is valid when only `--no-wait` is documented.
 */
export function findUnknownFlags(rawKeys: readonly string[], allowed: ReadonlySet<string>): string[] {
  const unknown: string[] = []
  for (const raw of rawKeys) {
    const k = raw.toLowerCase()
    const ok =
      allowed.has(k) ||
      allowed.has(`no-${k}`) ||
      (k.startsWith('no-') && allowed.has(k.slice(3)))
    if (!ok && !unknown.includes(raw)) unknown.push(raw)
  }
  return unknown
}

/**
 * USDC the wallet is short by (rounded up to 6dp — USDC's atomic unit), or
 * null when the balance covers the requirement. A null/unknown balance also
 * returns null: an RPC hiccup must never block a run, only a positively-known
 * shortfall may.
 */
export function usdcShortfall(balanceUsdc: number | null | undefined, requiredUsdc: number): number | null {
  if (balanceUsdc === null || balanceUsdc === undefined || !isFinite(balanceUsdc)) return null
  if (!isFinite(requiredUsdc) || requiredUsdc <= 0) return null
  const EPS = 1e-9 // absorb float noise so balance === required passes
  if (balanceUsdc + EPS >= requiredUsdc) return null
  return Math.ceil((requiredUsdc - balanceUsdc) * 1e6) / 1e6
}

/** "$1.25", falling back to 6dp for sub-cent amounts ("$0.005000"). */
export function formatUsdc(n: number): string {
  return n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(6)}`
}

/**
 * Abort message for the chat-run balance preflight. Always shows balance vs
 * required, how to fund, and the --skip-balance-check escape hatch (plan
 * totals are estimates — dynamically-priced steps can settle differently).
 */
export function insufficientBalanceMessage(args: {
  balanceUsdc: number
  requiredUsdc: number
  chain: string
  walletAddress?: string | null
  /** What the money is for, e.g. "this plan" or "the $0.10 i402 orchestration fee". */
  context: string
}): string {
  const short = usdcShortfall(args.balanceUsdc, args.requiredUsdc) ?? 0
  const wallet = args.walletAddress || 'your pay wallet'
  return (
    `Insufficient USDC for ${args.context}: balance ${formatUsdc(args.balanceUsdc)} on ${args.chain} < ` +
    `required ~${formatUsdc(args.requiredUsdc)} (estimate). ` +
    `Fund ${wallet} with at least ${formatUsdc(short)} more USDC on ${args.chain}, ` +
    `or pass --skip-balance-check to proceed anyway (plan totals are estimates — dynamically-priced steps can settle for less).`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// `domain dns set` / `domain dns add` record parsing
// ─────────────────────────────────────────────────────────────────────────────

/** A DNS row as the registrar accepts it — `name` is the host, `@` for the apex. */
export interface DnsRecordDraft {
  type: string
  name: string
  value: string
  ttl?: number
}

export const DNS_RECORD_TYPES: readonly string[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'URL', 'URL301']

/**
 * Build the DNS rows for `domain dns set|add` from either `--records '<json>'`
 * or a single `--type/--host/--value[/--ttl]`.
 *
 * Validation lives here so it runs BEFORE the x402 payment: a typo'd record
 * type should cost nothing, rather than $0.01 and a 400 from the registrar.
 * Pure (no I/O, no exit) so the CLI maps a failure to its own error renderer.
 */
export function parseDnsRecords(flags: {
  records?: unknown
  type?: unknown
  host?: unknown
  value?: unknown
  ttl?: unknown
}): { ok: true; records: DnsRecordDraft[] } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error })
  let rows: unknown[]

  if (flags.records !== undefined) {
    let parsed: unknown
    if (typeof flags.records === 'string') {
      try {
        parsed = JSON.parse(flags.records)
      } catch {
        return fail(`--records must be valid JSON, e.g. --records '[{"type":"A","name":"@","value":"1.2.3.4"}]'`)
      }
    } else {
      parsed = flags.records
    }
    rows = Array.isArray(parsed) ? parsed : [parsed]
    if (rows.length === 0) return fail('--records is empty — pass at least one {type,name,value} record')
  } else {
    if (!flags.type || !flags.value) {
      return fail(
        `Nothing to write. Pass --type A --host @ --value 1.2.3.4 for one record, ` +
        `or --records '[{"type":"A","name":"@","value":"1.2.3.4"}]' for several.`,
      )
    }
    const single: Record<string, unknown> = {
      type: flags.type,
      name: flags.host || '@',
      value: flags.value,
    }
    if (flags.ttl !== undefined) single.ttl = flags.ttl
    rows = [single]
  }

  const out: DnsRecordDraft[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>
    const where = rows.length > 1 ? ` (record ${i + 1})` : ''
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return fail(`Each record must be an object {type,name,value}${where}`)
    }
    const type = String(r.type ?? '').toUpperCase()
    if (!DNS_RECORD_TYPES.includes(type)) {
      return fail(`Invalid record type '${String(r.type ?? '')}'${where}. Use one of: ${DNS_RECORD_TYPES.join(', ')}`)
    }
    const value = r.value ?? r.address
    if (value === undefined || value === null || String(value).trim() === '') {
      return fail(`Record ${type}${where} needs a value (the address or target it points at)`)
    }
    let ttl: number | undefined
    if (r.ttl !== undefined) {
      ttl = Number(r.ttl)
      if (!Number.isFinite(ttl) || ttl <= 0) return fail(`Invalid ttl '${String(r.ttl)}'${where} — pass seconds, e.g. 1800`)
    }
    const name = String(r.name ?? r.host ?? '@').trim() || '@'
    out.push({ type, name, value: String(value).trim(), ...(ttl !== undefined ? { ttl } : {}) })
  }
  return { ok: true, records: out }
}
