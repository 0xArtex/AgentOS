/**
 * Strategy templates — Phase "templates" (post-4c nice-to-have).
 *
 * A template captures the boring defaults of a trade decision (amounts,
 * exit plan, slippage profile, cohort layout) in a single YAML file you can
 * version, share, and reuse. Templates are NOT decisions themselves:
 *   - `thesis` is always required at trade time (never lives in a template —
 *     "dead simple" rule: the WHY is per-trade, the HOW is reusable).
 *   - The `mint` / contract address is always per-trade.
 *
 * Storage: `~/.palmyr/trading/templates/<name>.yml` (overridable by the
 * existing PALMYR_TRADING_PATH env). Per-template files (not one big config)
 * so users can `cp`, `git diff`, and share single strategies between machines.
 *
 * Merge semantics: template values supply DEFAULTS; CLI flags WIN on conflict.
 * That keeps the CLI authoritative — you can always override a template's
 * choice without editing the file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { TRADING_DIR } from './wallet-trading.js'

export const TEMPLATES_DIR = join(TRADING_DIR, 'templates')

/**
 * One template = one reusable trade-decision shape. Every field is optional;
 * the rest comes from CLI flags or `loadTradingConfig()` fallbacks. We keep
 * the schema flat-ish to stay grep-able + diff-friendly.
 */
export interface StrategyTemplate {
  /** Display name — usually mirrors the filename stem. */
  name: string
  description?: string
  /** Target chain. CLI's positional <chain> arg still overrides. */
  chain?: 'solana' | 'base'
  /** Default --amount (e.g. "0.1sol", "0.01eth"). */
  amount?: string
  exitPlan?: {
    cut?: string
    takeProfit?: string
    holdIf?: string
    trailingStop?: string
    timeLimit?: string
    thesisCheck?: string
  }
  /** Static slippage in bps. Ignored if autoSlippage / protectedExec are on. */
  slippageBps?: number
  autoSlippage?: boolean
  protectedExec?: boolean
  /** Solana: Jito tip lamports. */
  jitoTipLamports?: number
  /** Base: EIP-1559 priority fee in wei (string for YAML safety). */
  priorityFeeWei?: string
  /** Override RPC URL (Base only currently). */
  rpcUrl?: string
  /** Free-form tags surfaced on each position record. */
  riskFlags?: string[]
  /** Cohort-specific defaults; only consumed by `wallet cohort buy`. */
  cohort?: {
    split?: number
    jitterMs?: number
    /** Starting wallet ref, e.g. 'trading:0'. */
    from?: string
  }
}

/**
 * Stricter than just `parseYaml` — we reject unknown keys to catch typos
 * (e.g. `cutt: -25%` would silently no-op without this check).
 */
const TEMPLATE_KEYS = new Set([
  'name', 'description', 'chain', 'amount', 'exitPlan',
  'slippageBps', 'autoSlippage', 'protectedExec', 'jitoTipLamports',
  'priorityFeeWei', 'rpcUrl', 'riskFlags', 'cohort',
])
const EXIT_PLAN_KEYS = new Set([
  'cut', 'takeProfit', 'holdIf', 'trailingStop', 'timeLimit', 'thesisCheck',
])
const COHORT_KEYS = new Set(['split', 'jitterMs', 'from'])

function validateTemplate(raw: unknown, sourceLabel: string): StrategyTemplate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Template ${sourceLabel}: top-level must be a mapping.`)
  }
  const obj = raw as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if (!TEMPLATE_KEYS.has(k)) {
      throw new Error(`Template ${sourceLabel}: unknown top-level key '${k}'. Known: ${[...TEMPLATE_KEYS].join(', ')}`)
    }
  }
  if (obj.chain && obj.chain !== 'solana' && obj.chain !== 'base') {
    throw new Error(`Template ${sourceLabel}: chain must be 'solana' or 'base', got '${obj.chain}'.`)
  }
  if (obj.exitPlan) {
    if (typeof obj.exitPlan !== 'object' || Array.isArray(obj.exitPlan)) {
      throw new Error(`Template ${sourceLabel}: exitPlan must be a mapping.`)
    }
    for (const k of Object.keys(obj.exitPlan as object)) {
      if (!EXIT_PLAN_KEYS.has(k)) {
        throw new Error(`Template ${sourceLabel}: unknown exitPlan key '${k}'. Known: ${[...EXIT_PLAN_KEYS].join(', ')}`)
      }
    }
  }
  if (obj.cohort) {
    if (typeof obj.cohort !== 'object' || Array.isArray(obj.cohort)) {
      throw new Error(`Template ${sourceLabel}: cohort must be a mapping.`)
    }
    for (const k of Object.keys(obj.cohort as object)) {
      if (!COHORT_KEYS.has(k)) {
        throw new Error(`Template ${sourceLabel}: unknown cohort key '${k}'. Known: ${[...COHORT_KEYS].join(', ')}`)
      }
    }
  }
  if (obj.riskFlags !== undefined) {
    if (!Array.isArray(obj.riskFlags) || !(obj.riskFlags as unknown[]).every(x => typeof x === 'string')) {
      throw new Error(`Template ${sourceLabel}: riskFlags must be an array of strings.`)
    }
  }
  if (obj.slippageBps !== undefined && (typeof obj.slippageBps !== 'number' || !Number.isFinite(obj.slippageBps))) {
    throw new Error(`Template ${sourceLabel}: slippageBps must be a number.`)
  }
  if (obj.jitoTipLamports !== undefined && (typeof obj.jitoTipLamports !== 'number' || !Number.isFinite(obj.jitoTipLamports))) {
    throw new Error(`Template ${sourceLabel}: jitoTipLamports must be a number.`)
  }
  return obj as unknown as StrategyTemplate
}

function ensureTemplatesDir() {
  if (!existsSync(TEMPLATES_DIR)) mkdirSync(TEMPLATES_DIR, { recursive: true })
}

export function templatePath(name: string): string {
  if (!/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    throw new Error(`Invalid template name: '${name}'. Use letters, digits, dot, dash, underscore.`)
  }
  return join(TEMPLATES_DIR, `${name}.yml`)
}

export function templateExists(name: string): boolean {
  return existsSync(templatePath(name))
}

export function loadTemplate(name: string): StrategyTemplate {
  const p = templatePath(name)
  if (!existsSync(p)) {
    throw new Error(
      `Template '${name}' not found at ${p}. Available: ${listTemplates().map(t => t.name).join(', ') || '(none)'}.`,
    )
  }
  const raw = readFileSync(p, 'utf8')
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (e: any) {
    throw new Error(`Template '${name}': YAML parse failed: ${e?.message ?? String(e)}`)
  }
  const tpl = validateTemplate(parsed, `'${name}'`)
  if (!tpl.name) tpl.name = name
  return tpl
}

export function saveTemplate(name: string, body: StrategyTemplate | string): string {
  ensureTemplatesDir()
  const yamlText = typeof body === 'string' ? body : stringifyYaml(body)
  // Validate by round-trip (catches malformed YAML strings early).
  validateTemplate(parseYaml(yamlText), `'${name}'`)
  const p = templatePath(name)
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, yamlText)
  return p
}

export interface TemplateListing {
  name: string
  path: string
  description?: string
  chain?: 'solana' | 'base'
}

export function listTemplates(): TemplateListing[] {
  if (!existsSync(TEMPLATES_DIR)) return []
  const out: TemplateListing[] = []
  for (const f of readdirSync(TEMPLATES_DIR)) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue
    const name = f.replace(/\.(ya?ml)$/, '')
    try {
      const tpl = loadTemplate(name)
      out.push({
        name,
        path: templatePath(name),
        description: tpl.description,
        chain: tpl.chain,
      })
    } catch {
      // Broken template — still surface it so the user can fix or delete it.
      out.push({ name, path: join(TEMPLATES_DIR, f) })
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export function deleteTemplate(name: string): boolean {
  const p = templatePath(name)
  if (!existsSync(p)) return false
  unlinkSync(p)
  return true
}

/**
 * Bundled examples auto-installed on first access. Idempotent: only writes
 * files that don't already exist, so users can edit them without fear of an
 * upgrade overwriting their work.
 */
const EXAMPLE_TEMPLATES: Record<string, string> = {
  'sol-pumpfun-quick': `# Quick pump.fun launch on Solana. -25% stop, +60% take-profit,
# trailing 25% from peak, kill after 4h regardless, LLM thesis check every 90m.
name: sol-pumpfun-quick
description: Quick pump.fun launch with aggressive exits + protected execution
chain: solana
amount: 0.05sol
exitPlan:
  cut: "-25%"
  takeProfit: "+60%"
  trailingStop: "25%"
  timeLimit: "4h"
  thesisCheck: "90m"
protectedExec: true
autoSlippage: true
riskFlags:
  - new-launch
  - meme
`,
  'sol-scout-cohort': `# Solana cohort scout: split 0.3 SOL across 3 derived wallets with up to
# 10s of jitter. Tight stops, modest TP, intentional non-coupled exits.
name: sol-scout-cohort
description: Solana cohort scout — 3-way split with jitter for new launches
chain: solana
amount: 0.3sol
exitPlan:
  cut: "-20%"
  takeProfit: "+40%"
  trailingStop: "15%"
  timeLimit: "6h"
protectedExec: true
autoSlippage: true
riskFlags:
  - cohort
  - scout
cohort:
  split: 3
  jitterMs: 10000
  from: "trading:0"
`,
  'base-eth-swing': `# Base ETH swing: lean cohort sizing, longer hold, USDC as the typical CA.
# protectedExec sends through PALMYR_BASE_PROTECTED_RPC if set, otherwise
# bumps EIP-1559 priority fee on the public Base RPC.
name: base-eth-swing
description: Base swing trade — wider stops, longer hold, protected execution
chain: base
amount: 0.02eth
exitPlan:
  cut: "-30%"
  takeProfit: "+80%"
  trailingStop: "30%"
  timeLimit: "48h"
  thesisCheck: "6h"
protectedExec: true
riskFlags:
  - swing
`,
}

/**
 * Install bundled example templates that aren't already present locally.
 * Called from `wallet template list` and `wallet template show <name>` so
 * first-time users discover the examples without an explicit init step.
 */
export function installExamplesIfMissing(): { installed: string[]; skipped: string[] } {
  ensureTemplatesDir()
  const installed: string[] = []
  const skipped: string[] = []
  for (const [name, body] of Object.entries(EXAMPLE_TEMPLATES)) {
    const p = templatePath(name)
    if (existsSync(p)) {
      skipped.push(name)
      continue
    }
    writeFileSync(p, body)
    installed.push(name)
  }
  return { installed, skipped }
}

/**
 * Merge a template into a per-command opts bag. CLI-provided values WIN over
 * template values (CLI is authoritative). Returns a new opts object.
 *
 * `cliPresent` tells us which CLI flags the user explicitly set vs which are
 * just falsy/undefined defaults. We treat the absence of a value (undefined)
 * as "use the template's value if any"; truthy CLI values always override.
 */
export interface BuyOptsLike {
  amount?: string
  cut?: string
  takeProfit?: string
  holdIf?: string
  trailingStop?: string
  timeLimit?: string
  thesisCheck?: string
  slippageBps?: number
  autoSlippage?: boolean
  protectedExec?: boolean
  jitoTipLamports?: number
  priorityFeeWei?: bigint
  rpcUrl?: string
  riskFlags?: string[]
}

export interface CohortOptsLike extends BuyOptsLike {
  walletRefs?: string[]
  jitterMs?: number
}

export function applyTemplateToBuyOpts<T extends BuyOptsLike>(
  template: StrategyTemplate,
  opts: T,
): T {
  const merged: T = { ...opts }
  if (merged.amount === undefined && template.amount !== undefined) merged.amount = template.amount
  if (template.exitPlan) {
    if (merged.cut === undefined) merged.cut = template.exitPlan.cut
    if (merged.takeProfit === undefined) merged.takeProfit = template.exitPlan.takeProfit
    if (merged.holdIf === undefined) merged.holdIf = template.exitPlan.holdIf
    if (merged.trailingStop === undefined) merged.trailingStop = template.exitPlan.trailingStop
    if (merged.timeLimit === undefined) merged.timeLimit = template.exitPlan.timeLimit
    if (merged.thesisCheck === undefined) merged.thesisCheck = template.exitPlan.thesisCheck
  }
  if (merged.slippageBps === undefined && template.slippageBps !== undefined) merged.slippageBps = template.slippageBps
  if (merged.autoSlippage === undefined && template.autoSlippage !== undefined) merged.autoSlippage = template.autoSlippage
  if (merged.protectedExec === undefined && template.protectedExec !== undefined) merged.protectedExec = template.protectedExec
  if (merged.jitoTipLamports === undefined && template.jitoTipLamports !== undefined) merged.jitoTipLamports = template.jitoTipLamports
  if (merged.priorityFeeWei === undefined && template.priorityFeeWei !== undefined) {
    merged.priorityFeeWei = BigInt(template.priorityFeeWei)
  }
  if (merged.rpcUrl === undefined && template.rpcUrl !== undefined) merged.rpcUrl = template.rpcUrl
  if ((!merged.riskFlags || merged.riskFlags.length === 0) && template.riskFlags) {
    merged.riskFlags = [...template.riskFlags]
  }
  return merged
}

/**
 * Cohort-specific merge. Returns a fully-populated opts bag for cohortBuy,
 * including the wallet list derived from template.cohort if --wallets / --from
 * + --split weren't passed.
 */
export function resolveCohortFromTemplate(
  template: StrategyTemplate,
  cliWalletRefs: string[] | undefined,
  cliFrom: string | undefined,
  cliSplit: number | undefined,
  cliJitterMs: number | undefined,
): { walletRefs: string[]; jitterMs: number } {
  let walletRefs: string[] | undefined = cliWalletRefs
  if (!walletRefs || walletRefs.length === 0) {
    // Allow CLI --from / --split to use template cohort.from as default start.
    const split = cliSplit ?? template.cohort?.split
    const fromRef = cliFrom ?? template.cohort?.from ?? 'trading:0'
    if (split && Number.isInteger(split) && split > 0) {
      if (!fromRef.startsWith('trading:')) {
        throw new Error(`Cohort --from must be a 'trading:' reference (got '${fromRef}')`)
      }
      const startIdx = Number(fromRef.slice('trading:'.length))
      if (!Number.isInteger(startIdx) || startIdx < 0) {
        throw new Error(`Invalid --from index: '${fromRef}'`)
      }
      walletRefs = []
      for (let i = 0; i < split; i++) walletRefs.push(`trading:${startIdx + i}`)
    }
  }
  if (!walletRefs || walletRefs.length === 0) {
    throw new Error(
      "Cohort needs wallets — pass --wallets, --split, or include `cohort: { split: N }` in the template.",
    )
  }
  const jitterMs = cliJitterMs ?? template.cohort?.jitterMs ?? 0
  return { walletRefs, jitterMs }
}
