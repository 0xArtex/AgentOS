#!/usr/bin/env node

// Load .env from CWD if present so users only maintain one config file for both
// the server and the CLI. Process env (set in shell) still wins over .env.
import 'dotenv/config'

// Silence the noisy `bigint: Failed to load bindings, pure JS will be used`
// warning from bigint-buffer (transitive dep of @solana/web3.js). The pure JS
// fallback is fine for CLI one-shot use — the warning is cosmetic noise.
const __origWarn = console.warn
console.warn = (...args: any[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : ''
  if (msg.startsWith('bigint: Failed to load bindings')) return
  __origWarn.apply(console, args)
}

import React from 'react'
import { render as inkRender } from 'ink'
import { ComputeDeployScreen, ComputeListScreen, ComputePlansScreen, ConfigScreen, Dashboard, DoctorScreen, DomainCheckScreen, DomainPricingScreen, ErrorScreen, HealthScreen, MenuScreen, PricingScreen, RecordsScreen, SetupScreen, StatusScreen, SuccessScreen, WalletCreateScreen, WalletStatusScreen, WalletListScreen } from './app.js'
import { AgentOS } from './sdk.js'
import { loadConfig, saveConfig, ensureDirs, getKeyfile, log, addPhone, addInbox, addServer, addDomain, addNote } from './config.js'
import { theme as t, icon, Spinner, header, row, ok, fail, warn, info, subtle, divider, blank, table, box, initReport, banner, kv, section, listItem, statusLine, welcomeScreen, statusBar, panel, setAgentMode as setUiAgentMode } from './ui.js'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Alias for backwards compat in help text
const c = { ...t, cyan: t.info, green: t.success, red: t.error, yellow: t.warn, white: t.text, gray: t.muted, orange: t.accent }

// Read version from package.json so the binary and the published version
// can never drift. dist/cli.js sits next to ../package.json after build.
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version as string
  } catch {
    return '0.0.0'
  }
})()

// ─── Exit codes ───
//
// These are part of the agent-facing CLI contract — agents branch on $? to
// distinguish "wrong flag" from "no funds" from "API unreachable". Treat
// them as semver-stable. New error categories get new codes; never repurpose
// an existing one.
const EXIT = {
  OK: 0,
  GENERAL: 1,
  BAD_INPUT: 2,
  AUTH_FAIL: 3,
  NOT_FOUND: 4,
  NETWORK: 5,
  PAYMENT: 6,
  SECURITY: 7,
} as const

const EXIT_CODE_DOCS = [
  { code: 0, name: 'OK', description: 'Success' },
  { code: 1, name: 'GENERAL', description: 'Unspecified failure' },
  { code: 2, name: 'BAD_INPUT', description: 'Missing or invalid flag/argument' },
  { code: 3, name: 'AUTH_FAIL', description: 'Authentication failed (bad token/session)' },
  { code: 4, name: 'NOT_FOUND', description: 'Wallet/resource not found' },
  { code: 5, name: 'NETWORK', description: 'API unreachable or transient network error' },
  { code: 6, name: 'PAYMENT', description: 'x402 payment verification or settlement failed' },
  { code: 7, name: 'SECURITY', description: 'Vault tamper / security check failed — do not retry' },
]

function render(node: React.ReactElement) {
  return inkRender(node)
}

// ─── Parse args ───
// Boolean flags that never take a value (prevents flag <next> from eating the next positional)
// `json` and `no-color` are agent-mode toggles; the rest are command-specific.
// Boolean flags never consume the next argv token — important so `agentos
// wallet list --json` doesn't try to swallow whatever comes after.
const BOOLEAN_FLAGS = new Set([
  'help', 'version', 'managed', 'quiet', 'confirm', 'json', 'no-color',
  // compute deploy/ssh flags
  'wait', 'generate-ssh-key', 'generate', 'progress',
])

function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  let command = ''
  let subcommand = ''
  // After we hit a bare `--`, every remaining argv element is a positional —
  // even if it starts with a dash. Lets `agentos compute exec my-vps --
  // systemctl status --no-pager openclaw` pass `--no-pager` through to the
  // remote shell instead of being swallowed as a CLI flag.
  let inPositionalRun = false

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (inPositionalRun) { positional.push(arg); continue }
    if (arg === '--') { inPositionalRun = true; continue }
    if (!command && !arg.startsWith('-')) { command = arg; continue }
    if (command && !subcommand && !arg.startsWith('-')) { subcommand = arg; continue }

    if (arg.startsWith('--')) {
      // Handle --key=value syntax
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
        continue
      }

      // Handle --no-prefix as boolean false
      const key = arg.slice(2)
      if (key.startsWith('no-')) {
        flags[key.slice(3)] = false
        continue
      }

      // Known boolean flags — never consume the next arg
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
        continue
      }

      // Otherwise: next arg is the value (if it exists and isn't a flag)
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) { flags[key] = next; i++ }
      else flags[key] = true
    } else {
      positional.push(arg)
    }
  }
  return { command, subcommand, positional, flags }
}

// Global agent-mode flag — set early in main() based on TTY detection + the
// --json flag. When true, every output path emits structured JSON (stdout for
// data, stderr for errors) and skips Ink rendering and ANSI decoration. This
// is the contract agents rely on: pipe stdout into jq, check $? against the
// EXIT table, parse stderr for the {error, exitCode} object on failure.
let AGENT_MODE = !process.stdout.isTTY

function err(msg: string, code: number = EXIT.BAD_INPUT): never {
  if (AGENT_MODE) {
    process.stderr.write(JSON.stringify({ error: msg, exitCode: code }) + '\n')
    process.exit(code)
  }
  render(React.createElement(ErrorScreen, {
    version: VERSION,
    title: 'Command error',
    message: msg,
    footerLeft: 'Fix the command and retry',
  }))
  process.exit(code)
}

/** Show per-subcommand help with flag descriptions */
function subcommandHelp(command: string, subcommand: string, options: Array<{ flag: string; desc: string; hint?: string }>) {
  if (AGENT_MODE) {
    print({ command, subcommand, options })
    return
  }
  console.log(`\n  ${t.accent}agentos ${command} ${subcommand}${t.reset}\n`)
  for (const opt of options) {
    const flagStr = `  ${t.info}${opt.flag.padEnd(24)}${t.reset}`
    const hintStr = opt.hint ? ` ${t.muted}${opt.hint}${t.reset}` : ''
    console.log(`${flagStr}${opt.desc}${hintStr}`)
  }
  console.log()
}

// ─── Subcommand help definitions ───
const WALLET_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  create: [
    { flag: '--name <name>', desc: 'Wallet name', hint: 'default: "My Wallet"' },
    { flag: '--managed', desc: 'Create managed wallet with human oversight via passkey' },
    { flag: '--chains <list>', desc: 'Supported chains (comma-separated)', hint: 'default: solana,evm' },
  ],
  import: [
    { flag: '--mnemonic <words>', desc: 'BIP-39 mnemonic phrase (required)' },
    { flag: '--name <name>', desc: 'Wallet name', hint: 'default: "Imported Wallet"' },
    { flag: '--managed', desc: 'Import as managed wallet' },
  ],
  'sign-message': [
    { flag: '<WALLET_ID>', desc: 'Wallet ID (positional or --id)' },
    { flag: '--chain <chain>', desc: 'Chain to sign on (required)', hint: 'solana | evm' },
    { flag: '--msg <message>', desc: 'Message to sign (required)' },
  ],
  'api-key': [
    { flag: '<WALLET_ID>', desc: 'Wallet ID (positional or --id)' },
    { flag: '--name <name>', desc: 'API key name', hint: 'default: "cli-agent"' },
  ],
  'request-approval': [
    { flag: '<WALLET_ID>', desc: 'Wallet ID (positional or --id)' },
    { flag: '--action <type>', desc: 'Approval action', hint: 'default: "limits"' },
    { flag: '--daily <usdc>', desc: 'Requested daily USDC limit' },
    { flag: '--tx <usdc>', desc: 'Requested per-tx USDC limit' },
  ],
  export: [
    { flag: '<WALLET_ID>', desc: 'Wallet ID (positional or --id)' },
    { flag: '--confirm', desc: 'Confirm you understand the risk of exposing the mnemonic' },
  ],
  use: [
    { flag: '<WALLET_ID>', desc: 'Wallet ID to use for x402 payments (positional or --id)' },
    { flag: '--chain <chain>', desc: 'Which chain to pay on', hint: 'solana (default) | base' },
  ],
}
/**
 * Render a per-command menu (no subcommand given). On a TTY → Ink MenuScreen
 * with the AgentOS aesthetic. In agent mode → flat JSON listing the available
 * subcommands so an agent can drive discovery (e.g. `agentos phone --json`
 * → `{"command":"phone","subcommands":[{"name":"search",...}, ...]}`).
 */
function showMenu(opts: {
  command: string
  title: string
  subtitle: string
  footerLeft: string
  commands: Array<{ name: string; description: string; hint?: string }>
  fromHome: boolean
}) {
  if (AGENT_MODE) {
    print({ command: opts.command, subcommands: opts.commands })
    return
  }
  render(React.createElement(MenuScreen, {
    version: VERSION,
    title: opts.title,
    subtitle: opts.subtitle,
    footerLeft: opts.footerLeft,
    commands: opts.commands,
    interactive: opts.fromHome,
    onBack: opts.fromHome ? () => {
      process.env.AGENTOS_FROM_HOME = '0'
      process.argv = [process.argv[0], process.argv[1]]
      void main()
    } : undefined,
  }))
}

function print(obj: any) {
  const json = JSON.stringify(obj, null, 2)
  // Plain JSON in agent mode (stdout is piped, --json is set, or AGENTOS_JSON
  // env is on). On a real TTY without --json, color the keys so humans get a
  // little visual aid — but the structure is still valid JSON either way.
  if (AGENT_MODE) {
    console.log(json)
  } else {
    const colored = json
      .replace(/"([^"]+)":/g, `${t.info}"$1"${t.reset}:`)
      .replace(/: "([^"]+)"/g, `: ${t.success}"$1"${t.reset}`)
      .replace(/: (\d+)/g, `: ${t.warn}$1${t.reset}`)
      .replace(/: (true|false)/g, `: ${t.accent}$1${t.reset}`)
      .replace(/: (null)/g, `: ${t.muted}$1${t.reset}`)
    console.log(colored)
  }
}

/**
 * Compact formatter for chat-run step outputs in the summary line. Picks the
 * most-useful 2-4 fields per step (id, address, status flags) without dumping
 * the entire JSON. Falls back to the full object for unknown shapes.
 */
/**
 * Trim long upstream errors (HTML pages, multi-paragraph stack traces) down
 * to a one-liner the terminal can display without scrolling. Strips HTML
 * tags, collapses whitespace, and clips to ~200 chars with a length hint.
 */
function truncateError(msg: string, max: number = 200): string {
  if (!msg) return '(no error message)'
  const stripped = msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (stripped.length <= max) return stripped
  return `${stripped.slice(0, max)}… [+${stripped.length - max} chars; rerun with --verbose for full body]`
}

function formatStepOutput(output: any): string {
  if (output == null) return '—'
  if (typeof output !== 'object') return String(output)
  // Common shapes we want a clean one-liner for.
  if (output.inbox?.address) {
    const i = output.inbox
    const flags: string[] = []
    if (output.dnsApplied === true) flags.push('dns ✓')
    if (output.mailgunRegistered === true) flags.push(`mailgun=${output.mailgunStatus ?? 'pending'}`)
    if (output.sendingStatus) flags.push(`send: ${output.sendingStatus.split(/ [—-] /)[0]}`)
    return `${i.address} (id ${i.id})${flags.length ? '  ' + flags.join('  ') : ''}`
  }
  if (Array.isArray(output.inboxes)) return `${output.inboxes.length} inbox(es)`
  if (Array.isArray(output.numbers)) return `${output.numbers.length} number(s)`
  if (Array.isArray(output.servers)) return `${output.servers.length} server(s)`
  if (Array.isArray(output.domains)) return `${output.domains.length} domain(s)`
  if (Array.isArray(output.calls)) return `${output.calls.length} call(s)`
  if (Array.isArray(output.sshKeys)) return `${output.sshKeys.length} ssh key(s)`
  // Pull the most-useful keys for unknown single-object shapes.
  const keys = ['id', 'address', 'phoneNumber', 'callControlId', 'serverId', 'ipv4', 'domain', 'status', 'message']
  const parts: string[] = []
  for (const k of keys) {
    const v = output[k]
    if (v !== undefined && v !== null) parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    if (parts.length >= 4) break
  }
  return parts.length ? parts.join('  ') : JSON.stringify(output).slice(0, 200)
}

// Single source of truth for the top-level command catalog. Used by both the
// Ink help screen and the JSON path so agents and humans see the same surface.
const TOP_LEVEL_COMMANDS: Array<{ name: string; description: string }> = [
  { name: 'phone', description: 'search · buy · sms · call' },
  { name: 'email', description: 'create · read · send · threads' },
  { name: 'compute', description: 'plans · deploy · list · delete' },
  { name: 'domain', description: 'check · pricing · buy · dns' },
  { name: 'wallet', description: 'create · import · list · export · sign · api-key' },
  { name: 'setup', description: 'Configure wallets + chain preference' },
  { name: 'status', description: 'Show config, wallets, and API health' },
  { name: 'config', description: 'Show current configuration' },
  { name: 'doctor', description: 'Verify system health (cred store, vault, API)' },
  { name: 'pricing', description: 'All service prices' },
  { name: 'health', description: 'API status + version check' },
]

// ─── Help ───
function help() {
  if (AGENT_MODE) {
    print({
      version: VERSION,
      commands: TOP_LEVEL_COMMANDS,
      flags: {
        global: [
          { flag: '--json', desc: 'Force machine-parseable JSON output (auto-on when stdout isn\'t a TTY)' },
          { flag: '--quiet', desc: 'Suppress decorative log lines' },
          { flag: '--token <api-key>', desc: 'Bearer token for authenticated calls' },
          { flag: '--passphrase <pass>', desc: 'Wallet passphrase (or AGENTOS_WALLET_PASSPHRASE env)' },
        ],
      },
      exitCodes: EXIT_CODE_DOCS,
    })
    return
  }
  render(React.createElement(MenuScreen, {
    version: VERSION,
    title: 'help',
    subtitle: 'Command surface',
    footerLeft: 'Structured JSON output for all commands',
    commands: TOP_LEVEL_COMMANDS,
  }))
}

// ─── Commands ───
async function main() {
  const { command, subcommand, positional, flags } = parse(process.argv)
  const fromHome = process.env.AGENTOS_FROM_HOME === '1'

  // Agent-mode detection: piped stdout (no TTY) or explicit --json. Once set,
  // it drives everything — Ink screens flip to JSON output, Spinner/decorators
  // self-suppress (see ui.ts:setAgentMode), and err() stringifies to stderr.
  // Honor AGENTOS_JSON=1 too so agents can opt in via env var when their
  // runtime allocates a TTY they can't easily suppress.
  AGENT_MODE = !process.stdout.isTTY || !!flags.json || process.env.AGENTOS_JSON === '1'
  setUiAgentMode(AGENT_MODE)

  if (flags.version) {
    if (AGENT_MODE) print({ version: VERSION })
    else console.log(VERSION)
    return
  }
  if (flags.help && !command) { help(); return }

  // No command — show welcome dashboard (agents get a JSON listing of the
  // top-level command surface so they can drive discovery programmatically).
  if (!command) {
    const cfg = loadConfig()
    let apiOk = false
    try { const h = await new AgentOS(cfg.api).health(); apiOk = h.status === 'healthy' } catch {}
    if (AGENT_MODE) {
      print({
        version: VERSION,
        chain: cfg.defaultChain,
        wallets: cfg.wallets || {},
        apiOk,
        commands: TOP_LEVEL_COMMANDS,
      })
      return
    }
    render(React.createElement(Dashboard, {
      version: VERSION,
      chain: cfg.defaultChain,
      wallets: cfg.wallets,
      apiOk,
    }))
    return
  }

  // Always ensure ~/.agentos/ exists on any command
  ensureDirs()

  const config = loadConfig()
  const startTime = Date.now()

  // No first-time banner — agent-first CLI should never pollute output.
  const url = process.env.AGENTOS_API || config.api
  const token = (flags.token as string) || config.apiKey || process.env.AGENTOS_TOKEN || process.env.AGENTOS_API_KEY
  const passphrase = (flags.passphrase as string) || process.env.AGENTOS_WALLET_PASSPHRASE
  const ao = new AgentOS(url, true, token, passphrase)

  try {
    switch (command) {
      case 'setup': {
        ensureDirs()

        const keyfile = flags.keyfile as string
          || process.env.AGENTOS_KEYFILE
          || (() => {
            const defaultPath = homedir() + '/.config/solana/id.json'
            if (existsSync(defaultPath)) return defaultPath
            return ''
          })()

        const chain = (flags.chain as string || 'solana') as 'solana' | 'base'

        if (!keyfile) {
          err('No keyfile. Pass --keyfile /path/to/keypair.json --chain solana', EXIT.BAD_INPUT)
        }

        if (!existsSync(keyfile.replace('~', homedir()))) {
          err(`Keyfile not found: ${keyfile}`, EXIT.NOT_FOUND)
        }

        const { addWalletToConfig, getConfiguredChains } = await import('./config.js')
        addWalletToConfig(chain, keyfile)
        const chains = getConfiguredChains()

        if (AGENT_MODE) {
          print({ ok: true, api: url, keyfile, chains, addedChain: chain })
        } else {
          render(React.createElement(SetupScreen, {
            version: VERSION,
            api: url,
            keyfile,
            chains,
            addedChain: chain,
          }))
        }
        log(`setup: keyfile=${keyfile} chain=${chain}`)
        break
      }

      case 'status': {
        const wallets = config.wallets || {}
        let apiOk = false
        try { const h = await ao.health(); apiOk = h.status === 'healthy' } catch {}

        if (AGENT_MODE) {
          print({
            api: config.api,
            apiOk,
            wallets,
            defaultChain: config.defaultChain || 'solana',
          })
        } else {
          render(React.createElement(StatusScreen, {
            version: VERSION,
            api: config.api,
            apiOk,
            wallets,
            defaultChain: config.defaultChain || 'solana',
            interactive: fromHome,
            onBack: fromHome ? () => {
              process.env.AGENTOS_FROM_HOME = '0'
              process.argv = [process.argv[0], process.argv[1]]
              void main()
            } : undefined,
          }))
        }
        break
      }

      case 'note': {
        const text = positional.join(' ') || subcommand || ''
        if (!text) err('Usage: agentos note "your note here"')
        addNote(text)
        if (AGENT_MODE) {
          print({ ok: true, note: text, path: '~/.agentos/memory/notes.md' })
        } else {
          render(React.createElement(SuccessScreen, { version: VERSION, title: 'note saved', subtitle: text, details: [{ label: 'Path', value: '~/.agentos/memory/notes.md' }], footerLeft: 'Note saved' }))
        }
        break
      }

      case 'phone': {
        if (!subcommand || flags.help) {
          showMenu({
            command: 'phone',
            title: 'phone',
            subtitle: 'Voice and messaging',
            footerLeft: 'Phone operations',
            commands: [
              { name: 'search', description: 'Search available numbers', hint: '--country US' },
              { name: 'buy', description: 'Buy a phone number', hint: '--country US' },
              { name: 'sms', description: 'Send an SMS', hint: '--id ID --to +1... --body "hi"' },
              { name: 'call', description: 'Place a voice call', hint: '--id ID --to +1... --tts "hello"' },
            ],
            fromHome,
          })
          break
        }
        switch (subcommand) {
          case 'search': {
            const country = flags.country as string || 'US'
            const data = await ao.phoneSearch(country, flags.limit ? parseInt(flags.limit as string) : undefined)
            return print(data)
            render(React.createElement(RecordsScreen, {
              version: VERSION,
              title: 'phone search',
              subtitle: `Available numbers · ${country}`,
              footerLeft: `${(data.numbers || []).length} result(s)`,
              records: (data.numbers || []).map((n: any) => ({
                primary: String(n.phoneNumber || 'unknown'),
                secondary: [n.region, n.type].filter(Boolean).join(' · '),
              })),
              interactive: fromHome,
              onBack: fromHome ? () => {
                process.env.AGENTOS_FROM_HOME = '0'
                process.argv = [process.argv[0], process.argv[1]]
                void main()
              } : undefined,
            }))
            break
          }
          case 'buy': {
            const country = flags.country as string
            if (!country) err('--country required')
            const spin = new Spinner()
            spin.start('Provisioning phone number...')
            const data = await ao.phoneBuy(country, flags.area as string)
            spin.stop('Phone number provisioned', true)
            return print(data)
            const number = data.phoneNumber || data.phone_number || 'provisioned'
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Phone provisioned',
              subtitle: number,
              footerLeft: 'Number ready to use',
              details: [
                { label: 'ID', value: String(data.id || '') },
                { label: 'Country', value: country },
              ],
            }))
            addPhone({ id: data.id, number, country, createdAt: new Date().toISOString() })
            log(`phone buy: ${data.phoneNumber || data.phone_number || 'unknown'} (${country})`)
            break
          }
          case 'sms': {
            const id = flags.id as string; const to = flags.to as string; const body = flags.body as string
            if (!id || !to || !body) err('--id, --to, --body required')
            const data = await ao.phoneSms(id, to, body)
            return print(data)
            render(React.createElement(SuccessScreen, { version: VERSION, title: 'SMS sent', subtitle: to, details: [{ label: 'To', value: to }], footerLeft: 'Message delivered' }))
            break
          }
          case 'call': {
            const id = flags.id as string; const to = flags.to as string
            if (!id || !to) err('--id, --to required')
            const data = await ao.phoneCall(id, to, flags.tts as string)
            return print(data)
            render(React.createElement(SuccessScreen, { version: VERSION, title: 'calling', subtitle: to, details: [{ label: 'To', value: to }, { label: 'Call ID', value: data.callControlId || data.id || '' }], footerLeft: 'Call initiated' }))
            break
          }
          default: err(`Unknown phone command: ${subcommand}. Try: search, buy, sms, call`)
        }
        break
      }

      case 'email': {
        if (!subcommand || flags.help) {
          showMenu({
            command: 'email',
            title: 'email',
            subtitle: 'Inbox operations',
            footerLeft: 'Email operations',
            commands: [
              { name: 'create', description: 'Create an inbox', hint: '--name agent [--domain example.com]' },
              { name: 'list', description: 'List inboxes owned by your wallet' },
              { name: 'status', description: 'Domain verification status (Mailgun)', hint: '<domain>' },
              { name: 'register', description: 'Register / re-register a wallet-owned domain with Mailgun', hint: '<domain>' },
              { name: 'read', description: 'Read inbox messages', hint: '--id INBOX_ID' },
              { name: 'send', description: 'Send an email', hint: '--id ID --to x@y.com --subject ... --body ...' },
              { name: 'threads', description: 'List threads', hint: '--id INBOX_ID' },
            ],
            fromHome,
          })
          break
        }
        switch (subcommand) {
          case 'create': {
            const name = flags.name as string || positional[0]
            const wallet = flags.wallet as string | undefined
            const domain = flags.domain as string | undefined
            if (!name) err('--name required (e.g. agentos email create --name hello [--domain example.com])')
            const spin = new Spinner()
            spin.start('Creating inbox...')
            const data = await ao.emailCreate(name, wallet, domain)
            spin.stop('Inbox created', true)
            return print(data)
          }
          case 'list': {
            const data = await ao.emailListInboxes()
            return print(data)
          }
          case 'status': {
            const domain = (flags.domain as string) || positional[0]
            if (!domain) err('domain required: agentos email status <domain>')
            const data = await ao.emailDomainStatus(domain)
            return print(data)
          }
          case 'register': {
            const domain = (flags.domain as string) || positional[0]
            if (!domain) err('domain required: agentos email register <domain>')
            const data = await ao.emailRegisterDomain(domain)
            return print(data)
          }
          case 'read': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id INBOX_ID required')
            const data = await ao.emailRead(id)
            return print(data)
            render(React.createElement(RecordsScreen, {
              version: VERSION,
              title: 'email read',
              subtitle: `Inbox ${data.inbox || id}`,
              footerLeft: `${(data.messages || []).length} message(s)`,
              records: (data.messages || []).map((m: any) => ({
                primary: String(m.subject || '(no subject)'),
                secondary: `${m.direction === 'inbound' ? '←' : '→'} ${m.from || ''}`.trim(),
                status: String(m.timestamp || ''),
              })),
              interactive: fromHome,
              onBack: fromHome ? () => {
                process.env.AGENTOS_FROM_HOME = '0'
                process.argv = [process.argv[0], process.argv[1]]
                void main()
              } : undefined,
            }))
            break
          }
          case 'send': {
            const id = flags.id as string; const to = flags.to as string
            const subject = flags.subject as string; const body = flags.body as string
            if (!id || !to || !subject || !body) err('--id, --to, --subject, --body required')
            const data = await ao.emailSend(id, to, subject, body)
            return print(data)
            render(React.createElement(SuccessScreen, { version: VERSION, title: 'email sent', subtitle: to, details: [{ label: 'To', value: to }], footerLeft: 'Email delivered' }))
            break
          }
          case 'threads': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id INBOX_ID required')
            const data = await ao.emailThreads(id)
            return print(data)
            render(React.createElement(RecordsScreen, {
              version: VERSION,
              title: 'email threads',
              subtitle: 'Conversation threads',
              footerLeft: `${(data.threads || []).length} thread(s)`,
              records: (data.threads || []).map((t: any) => ({
                primary: String(t.subject || '(no subject)'),
                secondary: `${t.message_count || 0} msg(s)`,
              })),
            }))
            break
          }
          default: err(`Unknown email command: ${subcommand}. Try: create, read, send, threads`)
        }
        break
      }

      case 'compute': {
        if (!subcommand || flags.help) {
          showMenu({
            command: 'compute',
            title: 'compute',
            subtitle: 'Server operations',
            footerLeft: 'Compute operations',
            commands: [
              { name: 'plans', description: 'List VPS plans (live from Hetzner)', hint: '[--location fsn1]' },
              { name: 'locations', description: 'List Hetzner datacenters + per-location server-type availability' },
              { name: 'install-recipes', description: 'List available agent install recipes (hermes, openclaw, ...)' },
              { name: 'ssh-key', description: 'Manage Hetzner SSH keys', hint: 'add <pubkey-file> | list | delete <id>' },
              { name: 'deploy', description: 'Deploy a VPS (golden path: auto-key, wait, verified SSH)', hint: '--type cx23 [--install hermes] [--location fsn1] [--no-wait]' },
              { name: 'wait', description: 'Block until status=running, port 22 open, SSH verified, installs done', hint: '<name|id> [--install hermes] [--key <path>] [--wait-timeout <sec>]' },
              { name: 'ssh', description: 'SSH into a deployed VPS by name or id', hint: '<name|id>' },
              { name: 'exec', description: 'Run a single command on a freshly-deployed VPS (pre-handoff)', hint: '<name|id> -- <command> [args...]' },
              { name: 'rename', description: 'Rename a deployed VPS (metadata-only, no reboot)', hint: '<name|id> <new-name>' },
              { name: 'reset-password', description: 'Rotate the root password (Hetzner-side)', hint: '<name|id>' },
              { name: 'console', description: 'Get a noVNC console URL (break-glass)', hint: '<name|id>' },
              { name: 'reboot', description: 'Reboot a server', hint: '<name|id>' },
              { name: 'setup-ssh', description: 'Inject your SSH key into a deployed VPS post-hoc', hint: '<id> --pubkey-file ~/.ssh/id_ed25519.pub' },
              { name: 'list', description: 'List servers' },
              { name: 'delete', description: 'Delete a server', hint: '--id SERVER_ID' },
            ],
            fromHome,
          })
          break
        }
        switch (subcommand) {
          case 'plans': {
            // --location filters to types deployable in that location. Each
            // plan's response also carries `availableLocations[]` so callers
            // without a preference can see where each type runs.
            const location = flags.location as string | undefined
            const data = await ao.computePlans(location ? { location } : {})
            return print(data)
          }
          case 'locations': {
            // Free discovery — list Hetzner locations + per-location server
            // type availability. Useful when the default location is
            // capacity-constrained or doesn't carry the type you want.
            const data = await ao.computeLocations()
            return print(data)
          }
          case 'ssh-key': {
            // Subcommand layout: `compute ssh-key add <pubkey-file>` | `list` | `delete <id>`
            // We piggy-back on the parser's `positional` array — `add` consumes
            // positional[0] as the file path, `delete` consumes it as the ID.
            const op = positional[0]
            const arg = positional[1]
            if (!op || op === 'list') {
              const data = await ao.computeSshKeyList()
              return print(data)
            }
            if (op === 'add') {
              const pubkeyFile = arg || (flags.file as string) || (flags['pubkey-file'] as string)
              if (!pubkeyFile) err('Usage: agentos compute ssh-key add <pubkey-file> [--name "label"]', EXIT.BAD_INPUT)
              const fullPath = pubkeyFile.replace('~', homedir())
              if (!existsSync(fullPath)) err(`Public key file not found: ${pubkeyFile}`, EXIT.NOT_FOUND)
              const publicKey = readFileSync(fullPath, 'utf8').trim()
              const name = (flags.name as string) || (flags.label as string) ||
                (publicKey.split(/\s+/)[2] || `key-${Date.now()}`)
              const data = await ao.computeSshKeyAdd(name, publicKey)
              return print(data)
            }
            if (op === 'delete' || op === 'remove' || op === 'rm') {
              const id = arg || (flags.id as string)
              if (!id) err('Usage: agentos compute ssh-key delete <id>', EXIT.BAD_INPUT)
              const data = await ao.computeSshKeyDelete(id)
              return print(data)
            }
            err(`Unknown ssh-key subcommand: ${op}. Try: add, list, delete`, EXIT.BAD_INPUT)
            break
          }
          case 'deploy': {
            const csshMod = await import('./compute-ssh.js')
            const name = flags.name as string || 'agent-' + Date.now()
            const type = flags.type as string || 'cx23'

            // SSH-key resolution priority (most explicit wins):
            //   1. --generate-ssh-key      → fresh keypair, saved locally, pubkey inline
            //   2. --pubkey-file <path>    → read file, send pubkey inline
            //   3. --pubkey "ssh-..."      → send pubkey inline as-is
            //   4. --ssh-key <id>          → numeric Hetzner ID, sent as sshKeyIds[]
            // 1–3 all use cloud-init inline; 4 uses Hetzner's pre-uploaded key
            // mechanism. They're mutually exclusive — the user who passes
            // multiple gets a clear error rather than silent precedence games.
            //
            // GOLDEN PATH: with no key flag at all, we auto-generate one. The
            // alternative ("deploy returns and you can't SSH") was the agent's
            // top complaint. `--no-generate-ssh-key` opts out (e.g. user wants
            // to attach a key after the fact via setup-ssh).
            let wantGenerate = flags['generate-ssh-key'] === true || flags.generate === true
            const pubkeyInline = (flags.pubkey as string) || (flags.publicKey as string)
            const pubkeyFile = (flags['pubkey-file'] as string) || (flags['ssh-key-file'] as string)
            const sshKeyIdRaw = flags['ssh-key'] as string | undefined
            const explicitNoGenerate = flags['generate-ssh-key'] === false || flags.generate === false

            const keySources = [wantGenerate, !!pubkeyInline, !!pubkeyFile, !!sshKeyIdRaw].filter(Boolean).length
            if (keySources > 1) {
              err('Pass only one of: --generate-ssh-key, --pubkey, --pubkey-file, --ssh-key <id>', EXIT.BAD_INPUT)
            }
            if (keySources === 0 && !explicitNoGenerate) {
              wantGenerate = true
            }

            let sshPublicKey: string | undefined
            let sshKeyIds: number[] | undefined
            let generatedKeyMeta: { privateKeyPath: string; publicKeyPath: string } | undefined

            if (sshKeyIdRaw) {
              const n = Number(sshKeyIdRaw)
              if (!Number.isFinite(n) || n <= 0) err(`--ssh-key must be a numeric Hetzner key ID (got "${sshKeyIdRaw}"). Run \`agentos compute ssh-key list\` to find it, or \`compute ssh-key add <pubkey-file>\` to upload one.`, EXIT.BAD_INPUT)
              sshKeyIds = [n]
            } else if (pubkeyFile) {
              const fullPath = pubkeyFile.replace('~', homedir())
              if (!existsSync(fullPath)) err(`Public key file not found: ${pubkeyFile}`, EXIT.NOT_FOUND)
              sshPublicKey = readFileSync(fullPath, 'utf8').trim()
            } else if (pubkeyInline) {
              sshPublicKey = pubkeyInline.trim()
            } else if (wantGenerate) {
              // Generated keys are namespaced by server NAME (we don't have an
              // ID yet at this point). The directory gets renamed to use the
              // ID once the deploy returns, so cached lookups by either work.
              try {
                const kp = csshMod.generateKeypair(name)
                sshPublicKey = kp.publicKey
                generatedKeyMeta = { privateKeyPath: kp.privateKeyPath, publicKeyPath: kp.publicKeyPath }
              } catch (e: any) {
                err(`--generate-ssh-key failed: ${e.message}`, EXIT.GENERAL)
              }
            }

            // Resolve the install list. `--install hermes` or `--install hermes,openclaw`
            // overrides the default. `--no-install` (or `--install ""`) skips
            // cloud-init entirely (vanilla Ubuntu, password auth on). With no
            // flag at all, the server defaults to OpenClaw — same behavior the
            // CLI has shipped since v0.5.
            const installRaw = flags.install
            let installRequested: string[] | undefined
            if (installRaw === false) {
              // `--no-install` → empty array (vanilla Ubuntu).
              installRequested = []
            } else if (typeof installRaw === 'string') {
              installRequested = installRaw.split(',').map(s => s.trim()).filter(Boolean)
            } // else: leave undefined → server keeps the legacy default.

            // --location overrides the server's default datacenter. Server
            // pre-validates type+location compatibility BEFORE x402 settles,
            // so a typo or mismatch fails as 400 with a clear hint instead
            // of burning $6 on Hetzner's 422.
            const location = flags.location as string | undefined

            const spin = new Spinner()
            spin.start('Deploying VPS...')
            let data: any
            try {
              data = await ao.computeDeploy(name, type, {
                ...(sshPublicKey ? { sshPublicKey } : {}),
                ...(sshKeyIds ? { sshKeyIds } : {}),
                ...(installRequested !== undefined ? { install: installRequested } : {}),
                ...(location ? { location } : {}),
              })
            } catch (e: any) {
              spin.stop('VPS deploy failed', false)
              // Specific server-side validation errors map to BAD_INPUT (2)
              // so shell scripts can branch — they're user-fixable, not
              // transient or payment-related.
              const msg = String(e?.message || '')
              if (/install recipe/i.test(msg)) {
                err(`${e.message} Run \`agentos compute install-recipes --json\` to list available recipes.`, EXIT.BAD_INPUT)
              }
              if (/Type not available in location|Invalid location/i.test(msg)) {
                err(`${e.message} Run \`agentos compute locations --json\` to see what's deployable where.`, EXIT.BAD_INPUT)
              }
              if (/Invalid server name/i.test(msg)) {
                err(`${e.message}`, EXIT.BAD_INPUT)
              }
              throw e
            }
            spin.stop('VPS deployed', true)

            // Golden-path default: --wait is ON unless the user explicitly opts
            // out (`--no-wait`). The deploy contract is "return when SSH
            // works", and a plain `compute deploy` without --wait was a frequent
            // foot-gun (looks successful, isn't yet usable). Users who want
            // fire-and-forget deploys should pass --no-wait explicitly.
            const wantWait = flags.wait !== false
            // The marker file gate (gate 4) only runs when the deploy actually
            // requested an install. Use whatever the SERVER echoed back —
            // `data.installs` reflects the resolved list (including any legacy
            // default), independent of what the CLI inferred.
            const expectedInstalls: string[] = Array.isArray(data?.installs) ? data.installs : []
            // Bigger default budget when an install is in flight. Hermes pulls
            // Python 3.11 + a couple hundred MB of pip packages on a fresh box;
            // 240s is too tight, 600s is comfortable.
            const defaultTimeout = expectedInstalls.length > 0 ? 600 : 240
            const waitTimeoutSec = flags['wait-timeout']
              ? Math.max(30, Math.min(900, parseInt(String(flags['wait-timeout']), 10)))
              : defaultTimeout
            // Resolve the local key path for the SSH credential probe. Only
            // available when the user supplied a key on disk (--pubkey-file or
            // --generate-ssh-key) OR explicitly told us where the matching
            // private key lives (--key-path) when using --ssh-key <id>.
            const explicitKeyPath = (flags['key-path'] as string) || (flags['private-key'] as string)
            const localKeyPath = generatedKeyMeta?.privateKeyPath
              || (pubkeyFile ? pubkeyFile.replace(/\.pub$/, '').replace('~', homedir()) : undefined)
              || (explicitKeyPath ? explicitKeyPath.replace('~', homedir()) : undefined)

            // Progress events to stderr — default ON in agent mode so a
            // long deploy isn't a 10-minute silence. Pass --no-progress to
            // opt out. Stdout still gets one final JSON object, so jq
            // pipelines on stdout aren't disturbed either way.
            //
            // We only emit when --wait is in effect; without --wait the
            // deploy returns immediately and stdout already has everything,
            // so stderr noise would be redundant.
            const wantProgress = flags.progress !== false
            const emitProgress = (event: { stage: string; message: string }) => {
              if (AGENT_MODE && wantProgress) {
                process.stderr.write(JSON.stringify({ event: 'progress', ...event }) + '\n')
              }
            }
            // Emit a `created` ack right after the deploy returns from the
            // API, before the readiness chain starts. Agents watching
            // stderr now know the server got provisioned within seconds —
            // any subsequent silence is the install running, not us hung.
            if (AGENT_MODE && wantProgress && data?.ipv4) {
              process.stderr.write(JSON.stringify({
                event: 'created',
                id: data.id,
                name: data.name,
                ipv4: data.ipv4,
                installs: expectedInstalls,
                waitTimeoutSec,
              }) + '\n')
            }

            // Persist a local cache entry IMMEDIATELY — before the readiness
            // chain. Issue #85: if --wait hangs/times out, a follow-up
            // `compute wait <id>` or `compute ssh <id>` would otherwise find
            // nothing in cache and silently skip the SSH + install gates.
            // Saving here means the cache always has the server's IP, name,
            // and key path, even when the wait portion of the deploy fails.
            try {
              csshMod.saveDeployedServer({
                id: String(data.id || ''),
                name: String(data.name || name),
                ipv4: data.ipv4 ?? null,
                serverType: String(data.serverType || type),
                sshPrivateKeyPath: localKeyPath && existsSync(localKeyPath) ? localKeyPath : undefined,
                sshKeyIds,
                deployedAt: new Date().toISOString(),
              })
            } catch {}

            let finalData: any = data
            let readiness: any = undefined
            if (wantWait && data?.id) {
              const spin2 = new Spinner()
              spin2.start('Waiting: status=running…')
              const result = await csshMod.waitForReady({
                getStatus: async () => {
                  const s = await ao.computeGet(String(data.id))
                  return { status: s.status || 'unknown', ipv4: s.ipv4 ?? null }
                },
                keyPath: localKeyPath && existsSync(localKeyPath) ? localKeyPath : undefined,
                timeoutMs: waitTimeoutSec * 1000,
                expectedInstalls,
                onProgress: ev => {
                  spin2.update(`Waiting: ${ev.message}`)
                  emitProgress(ev)
                },
              })
              readiness = {
                ready: result.ready,
                checks: result.checks,
                elapsedMs: result.elapsedMs,
                ...(result.skipReasons ? { skipReasons: result.skipReasons } : {}),
                ...(result.reason ? { reason: result.reason } : {}),
                ...(result.installStatus ? { installStatus: result.installStatus } : {}),
                ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
              }
              if (result.ready) {
                const passed = ['status=running', 'port22=open']
                if (result.checks.ssh === 'pass') passed.push('ssh=verified')
                if (result.checks.installs === 'pass') passed.push(`installs=${expectedInstalls.join('+')}`)
                spin2.stop(`Server ready in ${(result.elapsedMs / 1000).toFixed(1)}s (${passed.join(', ')})`, true)
              } else {
                spin2.stop(`Wait incomplete: ${result.reason}`, false)
              }
              finalData = {
                ...data,
                status: result.status ?? data.status,
                ipv4: result.ip ?? data.ipv4,
              }
            }

            // Refresh the cache entry if --wait found a different IP than
            // the create call returned (Hetzner sometimes assigns the v4
            // post-provisioning). Only fires when wait actually ran;
            // otherwise the pre-wait save above is already authoritative.
            if (wantWait && finalData.ipv4 !== data.ipv4) {
              try {
                csshMod.saveDeployedServer({
                  id: String(finalData.id || data.id || ''),
                  name: String(finalData.name || data.name || name),
                  ipv4: (finalData.ipv4 || data.ipv4) ?? null,
                  serverType: String(finalData.serverType || data.serverType || type),
                  sshPrivateKeyPath: localKeyPath && existsSync(localKeyPath) ? localKeyPath : undefined,
                  sshKeyIds,
                  deployedAt: new Date().toISOString(),
                })
              } catch {}
            }

            // Surface where the generated key landed in the response so users
            // (especially agents in non-TTY runs) know what to ssh -i. When we
            // know a working key, also include a top-level `sshCommand` —
            // that's the literal "usable SSH command" the deploy contract
            // promises when --wait succeeds.
            const ip = finalData.ipv4 || data.ipv4
            if (generatedKeyMeta) {
              finalData = {
                ...finalData,
                generatedKey: {
                  privateKeyPath: generatedKeyMeta.privateKeyPath,
                  publicKeyPath: generatedKeyMeta.publicKeyPath,
                  hint: `ssh -i "${generatedKeyMeta.privateKeyPath}" root@${ip || '<ip>'}`,
                },
              }
            }
            if (localKeyPath && ip) {
              finalData.sshCommand = csshMod.buildSshCommand(ip, localKeyPath)
            }
            if (readiness) finalData.readiness = readiness
            return print(finalData)
          }
          case 'wait': {
            // `compute wait <name|id> [--key <path>] [--wait-timeout <sec>] [--install <name>]`
            // — run the readiness chain against an existing server. Useful when
            // the user deployed without --wait, or the deploy --wait timed out
            // and they want to retry without redeploying. Pass --install to
            // also gate on the install marker file (gate 4).
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: agentos compute wait <name|id> [--key <path>] [--wait-timeout <sec>] [--install hermes,...]', EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            // Resolve the server id — cache first (to skip a paid round-trip
            // when possible), but accept a numeric arg as the id directly.
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache. Pass the numeric id as the first arg, or run 'agentos compute list' to refresh.`, EXIT.NOT_FOUND)
            const explicitKeyPath = (flags.key as string) || (flags['key-path'] as string) || (flags['private-key'] as string)
            const keyPath = (explicitKeyPath ? explicitKeyPath.replace('~', homedir()) : cached?.sshPrivateKeyPath)
            const installRaw = flags.install
            const expectedInstalls: string[] = typeof installRaw === 'string'
              ? installRaw.split(',').map(s => s.trim()).filter(Boolean)
              : []
            const defaultTimeout = expectedInstalls.length > 0 ? 600 : 240
            const waitTimeoutSec = flags['wait-timeout']
              ? Math.max(30, Math.min(900, parseInt(String(flags['wait-timeout']), 10)))
              : defaultTimeout
            const wantProgressWait = flags.progress !== false
            const spin = new Spinner()
            spin.start('Probing readiness…')
            const result = await csshMod.waitForReady({
              getStatus: async () => {
                const s = await ao.computeGet(serverId)
                return { status: s.status || 'unknown', ipv4: s.ipv4 ?? null }
              },
              keyPath: keyPath && existsSync(keyPath) ? keyPath : undefined,
              timeoutMs: waitTimeoutSec * 1000,
              expectedInstalls,
              onProgress: ev => {
                spin.update(`Probing: ${ev.message}`)
                if (AGENT_MODE && wantProgressWait) {
                  process.stderr.write(JSON.stringify({ event: 'progress', ...ev }) + '\n')
                }
              },
            })
            spin.stop(result.ready ? `Ready in ${(result.elapsedMs / 1000).toFixed(1)}s` : `Not ready: ${result.reason}`, result.ready)
            const out: any = {
              id: serverId,
              ready: result.ready,
              status: result.status,
              ipv4: result.ip,
              checks: result.checks,
              elapsedMs: result.elapsedMs,
              ...(result.skipReasons ? { skipReasons: result.skipReasons } : {}),
              ...(result.reason ? { reason: result.reason } : {}),
              ...(result.installStatus ? { installStatus: result.installStatus } : {}),
              ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
            }
            if (keyPath && result.ip) out.sshCommand = csshMod.buildSshCommand(result.ip, keyPath)
            // Exit with NOT_FOUND if any gate failed so shell scripts can
            // branch on $?. Stdout still gets the full report so callers
            // capturing JSON can inspect which check tripped.
            if (!result.ready) {
              print(out)
              process.exit(EXIT.NOT_FOUND)
            }
            return print(out)
          }
          case 'install-recipes':
          case 'recipes': {
            // Free discovery endpoint — list available agent install recipes.
            // Agents call this to know what they can pass to --install.
            const data = await ao.computeInstallRecipes()
            return print(data)
          }
          case 'ssh': {
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: agentos compute ssh <name|id>', EXIT.BAD_INPUT)
            // Local cache first — free, instant. Server-side fallback is
            // available but not auto-triggered: it would cost 0.01 USDC and
            // we'd rather make the user opt in than charge them silently.
            const cached = csshMod.findCachedServer(target)
            if (!cached?.ipv4) {
              err(
                `Server "${target}" not in local cache. ` +
                `Either run 'agentos compute list --json' first, ` +
                `or use the explicit IP: ssh root@<ip>.`,
                EXIT.NOT_FOUND,
              )
            }
            const keyPath = cached.sshPrivateKeyPath || (flags.key as string) || (flags.identity as string)
            if (AGENT_MODE) {
              return print({
                id: cached.id,
                name: cached.name,
                ipv4: cached.ipv4,
                command: csshMod.buildSshCommand(cached.ipv4!, keyPath),
                privateKeyPath: keyPath,
              })
            }
            // TTY mode: hand the terminal over to ssh and exit with its code.
            const code = csshMod.spawnInteractiveSsh(cached.ipv4!, keyPath)
            process.exit(code)
          }
          case 'setup-ssh': {
            const id = (flags.id as string) || positional[0]
            if (!id) err('--id SERVER_ID required (or pass it as the first positional arg)', EXIT.BAD_INPUT)
            let pubkey = (flags.pubkey as string) || (flags.publicKey as string)
            const pubkeyFile = (flags['pubkey-file'] as string) || (flags['ssh-key-file'] as string)
            if (!pubkey && pubkeyFile) {
              try {
                pubkey = readFileSync(pubkeyFile.replace('~', homedir()), 'utf8').trim()
              } catch (e: any) {
                err(`Could not read --pubkey-file ${pubkeyFile}: ${e.message}`, EXIT.NOT_FOUND)
              }
            }
            if (!pubkey) err('--pubkey "ssh-ed25519 AAAA..." (or --pubkey-file ~/.ssh/id_ed25519.pub) required', EXIT.BAD_INPUT)
            const data = await ao.computeSetupSsh(id, pubkey)
            return print(data)
          }
          case 'list': {
            const data = await ao.computeList()
            return print(data)
          }
          case 'delete': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id SERVER_ID required')
            const data = await ao.computeDelete(id)
            try {
              const csshMod = await import('./compute-ssh.js')
              csshMod.removeCachedServer(id)
            } catch {}
            return print(data)
          }
          case 'rename': {
            // `compute rename <name|id> <new-name>` — wraps PUT /servers/:id.
            // We resolve the source from the local cache (so the user can
            // refer to a friendly name) but if it's a numeric Hetzner id we
            // accept that directly. The server validates the new name
            // pre-payment so an invalid one bounces as 400 without charging.
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            const newName = positional[1] || (flags.to as string) || (flags['new-name'] as string)
            if (!target || !newName) {
              err('Usage: agentos compute rename <name|id> <new-name>', EXIT.BAD_INPUT)
            }
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache. Pass numeric Hetzner id or run 'agentos compute list' first.`, EXIT.NOT_FOUND)
            let data: any
            try {
              data = await ao.computeRename(serverId, newName)
            } catch (e: any) {
              const msg = String(e?.message || '')
              if (/Invalid server name/i.test(msg)) {
                err(msg, EXIT.BAD_INPUT)
              }
              throw e
            }
            // Preserve the rest of the cache entry (ipv4, key path, sshKeyIds,
            // deployedAt) — only the name changes. Use the OLD cached entry
            // as the base, drop both the old name and the old id-keyed entry,
            // then write the renamed one.
            try {
              if (cached) {
                csshMod.removeCachedServer(cached.id)
                csshMod.saveDeployedServer({ ...cached, name: data.name || newName })
              }
            } catch {}
            return print(data)
          }
          case 'exec': {
            // Usage: agentos compute exec <name|id> -- <command> [args...]
            // Or:    agentos compute exec <name|id> --command "..." --arg "..." --arg "..."
            // The double-dash form is the natural one for shells that already
            // know how to split argv; the explicit form lets agents that build
            // arrays JSON-encode args without shell-splitting.
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: agentos compute exec <name|id> -- <command> [args...]', EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache. Pass numeric id, or run 'agentos compute list' first.`, EXIT.NOT_FOUND)

            // Pull command + args from the remaining argv after the target.
            // Bare `--` is a conventional separator; argv after it is treated
            // as remote-shell argv.
            let command: string | undefined
            let args: string[] = []
            const rest = positional.slice(1)
            if (rest.length > 0) {
              command = rest[0]
              args = rest.slice(1)
            } else if (flags.command) {
              command = String(flags.command)
              const argFlag = flags.arg
              args = Array.isArray(argFlag) ? argFlag.map(String) : argFlag ? [String(argFlag)] : []
            }
            if (!command) err('No command. Try: agentos compute exec my-vps -- systemctl status openclaw', EXIT.BAD_INPUT)
            const timeoutSec = flags.timeout ? Math.max(1, Math.min(120, parseInt(String(flags.timeout), 10))) : undefined
            const data = await ao.computeExec(serverId, command, args, timeoutSec ? { timeoutSec } : {})
            return print(data)
          }
          case 'reset-password':
          case 'reset_password': {
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: agentos compute reset-password <name|id>', EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache.`, EXIT.NOT_FOUND)
            const data = await ao.computeAction(serverId, 'reset_password')
            return print(data)
          }
          case 'console':
          case 'request-console': {
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: agentos compute console <name|id>', EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache.`, EXIT.NOT_FOUND)
            const data = await ao.computeAction(serverId, 'request_console')
            return print(data)
          }
          case 'reboot':
          case 'poweroff':
          case 'poweron':
          case 'reset':
          case 'rebuild': {
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err(`Usage: agentos compute ${subcommand} <name|id>`, EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache.`, EXIT.NOT_FOUND)
            const opts = subcommand === 'rebuild' && flags.image ? { image: String(flags.image) } : {}
            const data = await ao.computeAction(serverId, subcommand, opts)
            return print(data)
          }
          default: err(`Unknown compute command: ${subcommand}. Try: plans, locations, install-recipes, ssh-key, deploy, wait, ssh, exec, rename, reset-password, console, reboot, poweroff, poweron, reset, rebuild, setup-ssh, list, delete`)
        }
        break
      }

      case 'domain': {
        if (!subcommand || flags.help) {
          showMenu({
            command: 'domain',
            title: 'domain',
            subtitle: 'Naming and DNS',
            footerLeft: 'Domain operations',
            commands: [
              { name: 'check', description: 'Check availability', hint: '--name example.dev' },
              { name: 'pricing', description: 'Get TLD pricing', hint: '--name example' },
              { name: 'buy', description: 'Register a domain', hint: '--name example.dev' },
              { name: 'list', description: 'List domains owned by your wallet', hint: '' },
              { name: 'dns', description: 'Get DNS records', hint: '--name example.dev' },
              { name: 'transfer-ownership', description: 'Transfer domain to another wallet', hint: '--name example.dev --to <wallet>' },
            ],
            fromHome,
          })
          break
        }
        switch (subcommand) {
          case 'check': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.com required')
            const data = await ao.domainCheck(name)
            // Multi-TLD response: render a table when interactive, JSON otherwise.
            if (Array.isArray(data?.results)) {
              if (AGENT_MODE) return print(data)
              console.log(`\n  ${t.accent}domain check${t.reset} — ${t.info}${data.query}${t.reset}\n`)
              const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length))
              const dLen = Math.max(...data.results.map((r: any) => r.domain.length), 6)
              for (const r of data.results) {
                const mark = r.available ? `${t.success}✓${t.reset}` : `${t.error}✗${t.reset}`
                const status = r.available ? `${t.success}available${t.reset}` : `${t.muted}taken${t.reset}    `
                const price = r.available ? `${t.warn}$${r.price}${t.reset}` : `${t.muted}—${t.reset}`
                console.log(`  ${mark}  ${pad(r.domain, dLen + 2)} ${status}   ${price}`)
              }
              console.log('')
              return
            }
            return print(data)
            render(React.createElement(DomainCheckScreen, {
              version: VERSION,
              domain: name,
              available: !!data.available,
              interactive: fromHome,
              onBack: fromHome ? () => {
                process.env.AGENTOS_FROM_HOME = '0'
                process.argv = [process.argv[0], process.argv[1]]
                void main()
              } : undefined,
            }))
            break
          }
          case 'pricing': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain required')
            const data = await ao.domainPricing(name)
            return print(data)
            const items = Object.entries(data.tlds || data.pricing || data).map(([tld, price]) => ({
              tld,
              price: String(price),
            }))
            render(React.createElement(DomainPricingScreen, {
              version: VERSION,
              query: name,
              items,
              interactive: fromHome,
              onBack: fromHome ? () => {
                process.env.AGENTOS_FROM_HOME = '0'
                process.argv = [process.argv[0], process.argv[1]]
                void main()
              } : undefined,
            }))
            break
          }
          case 'buy': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.dev required')
            const spin = new Spinner()
            spin.start('Registering domain...')
            const data = await ao.domainBuy(name)
            spin.stop('Domain registered', true)
            return print(data)
            const domain = data.domain || name
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Domain registered',
              subtitle: domain,
              footerLeft: 'Domain secured',
              details: [
                { label: 'Domain', value: domain },
              ],
            }))
            addDomain({ domain, createdAt: new Date().toISOString() })
            log(`domain buy: ${data.domain || name}`)
            break
          }
          case 'list': {
            const data = await ao.domainList()
            if (AGENT_MODE) return print(data)
            const domains = data?.domains || []
            console.log(`\n  ${t.accent}your domains${t.reset} — ${t.muted}${data.owner}${t.reset}\n`)
            if (domains.length === 0) {
              console.log(`  ${t.muted}No domains yet. Try: agentos domain buy --name example.xyz${t.reset}\n`)
              return
            }
            const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length))
            const dLen = Math.max(...domains.map((r: any) => r.domain.length), 6)
            for (const r of domains) {
              const exp = (r.expires_at || '').slice(0, 10)
              const statusColor = r.status === 'active' ? t.success : r.status === 'pending' ? t.warn : t.error
              console.log(`  ${pad(r.domain, dLen + 2)} ${statusColor}${pad(r.status, 8)}${t.reset} ${t.muted}expires ${exp}${t.reset}`)
            }
            console.log(`\n  ${t.muted}${domains.length} domain(s)${t.reset}\n`)
            return
          }
          case 'transfer-ownership': {
            const name = flags.name as string || positional[0]
            const to = flags.to as string || positional[1]
            if (!name) err('--name domain.dev required')
            if (!to) err('--to <wallet> required')
            const data = await ao.domainTransferOwnership(name, to)
            return print(data)
          }
          case 'dns': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.dev required')
            const data = await ao.domainDns(name)
            return print(data)
            render(React.createElement(RecordsScreen, {
              version: VERSION,
              title: 'domain dns',
              subtitle: name,
              footerLeft: `${(data.records || []).length} record(s)`,
              records: (data.records || []).map((r: any) => ({
                primary: String(r.type || 'record'),
                secondary: `${r.name || '@'} → ${r.value || ''}`,
              })),
            }))
            break
          }
          default: err(`Unknown domain command: ${subcommand}. Try: check, pricing, buy, list, dns, transfer-ownership`)
        }
        break
      }

      case 'wallet': {
        if (!subcommand || (flags.help && !WALLET_HELP[subcommand])) {
          showMenu({
            command: 'wallet',
            title: 'wallet',
            subtitle: 'Non-custodial HD wallet',
            footerLeft: 'Solana + Base wallet operations',
            commands: [
              { name: 'create', description: 'Create a new wallet', hint: '[--managed]' },
              { name: 'import', description: 'Import from mnemonic', hint: '--mnemonic "..."' },
              { name: 'list', description: 'List all wallets' },
              { name: 'info', description: 'Wallet details', hint: 'WALLET_ID' },
              { name: 'addresses', description: 'Show all chain addresses', hint: 'WALLET_ID' },
              { name: 'sign-message', description: 'Sign a message', hint: 'WALLET_ID --chain evm --msg "hello"' },
              { name: 'export', description: 'Export mnemonic for backup', hint: 'WALLET_ID --confirm' },
              { name: 'api-key', description: 'Create agent API key', hint: 'WALLET_ID --name my-agent' },
              { name: 'config', description: 'Get agent config', hint: 'WALLET_ID' },
              { name: 'use', description: 'Set default pay wallet', hint: 'WALLET_ID' },
              { name: 'request-approval', description: 'Request human approval (managed)', hint: 'WALLET_ID --action limits --daily 100' },
            ],
            fromHome,
          })
          break
        }

        // Per-subcommand --help
        if (flags.help && subcommand && WALLET_HELP[subcommand]) {
          subcommandHelp('wallet', subcommand, WALLET_HELP[subcommand])
          break
        }

        switch (subcommand) {
          case 'create': {
            const isManaged = !!flags.managed
            // Accept --name (primary) or --label (alias)
            const name = (flags.name as string) || (flags.label as string) || 'My Wallet'
            const mode = isManaged ? 'managed' as const : 'unmanaged' as const

            // Create locally — no server needed for the key material
            const { createLocalWallet } = await import('./vault.js')
            const w = createLocalWallet(name, mode)

            // Store session secret in OS credential store
            const { storeSecret } = await import('./credential-store.js')
            storeSecret(w.id, w.sessionSecret)

            log(`wallet create: ${w.id} (${mode})`)

            // For managed wallets, register metadata with the server to get a setup link
            let setupLink: string | undefined
            if (isManaged) {
              try {
                const headers: Record<string, string> = { 'Content-Type': 'application/json' }
                const res = await fetch(ao.api + '/wallet/register-managed', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    walletId: w.id,
                    name: w.name,
                    solanaAddress: w.solanaAddress,
                    evmAddress: w.evmAddress,
                  }),
                })
                const data = await res.json() as any
                if (!res.ok || data.error) {
                  throw new Error(data.error || `HTTP ${res.status}`)
                }
                setupLink = ao.api + data.setupLink
              } catch (e: any) {
                err(`Failed to register managed wallet with server: ${e.message}`, EXIT.NETWORK)
              }
            }

            // TTY → nice TUI. Piped → JSON with setupLink included.
            if (!AGENT_MODE) {
              render(React.createElement(WalletCreateScreen, {
                version: VERSION,
                id: w.id,
                name: w.name,
                mode: w.mode,
                solana: w.solanaAddress,
                base: w.evmAddress,
              }))
              if (setupLink) {
                console.log(`\n  ${t.accent}Setup link${t.reset} — send to the human who will manage this wallet:`)
                console.log(`  ${t.info}${setupLink}${t.reset}\n`)
                console.log(`  ${t.muted}They'll register a passkey and set spending limits. Takes 30 seconds.${t.reset}\n`)
              }
            } else {
              print({ ...w, setupLink })
            }
            break
          }
          case 'import': {
            const mnemonic = flags.mnemonic as string
            if (!mnemonic) err('--mnemonic "your twelve words..." required')
            const name = (flags.name as string) || (flags.label as string) || 'Imported Wallet'
            const mode = flags.managed ? 'managed' as const : 'unmanaged' as const

            const { importLocalWallet } = await import('./vault.js')
            const w = importLocalWallet(name, mnemonic, mode)

            // Store session secret
            const { storeSecret } = await import('./credential-store.js')
            storeSecret(w.id, w.sessionSecret)

            log(`wallet import: ${w.id}`)

            if (!AGENT_MODE) {
              render(React.createElement(WalletCreateScreen, {
                version: VERSION,
                id: w.id,
                name: w.name,
                mode: w.mode,
                solana: w.solanaAddress,
                base: w.evmAddress,
              }))
            } else {
              print(w)
            }
            break
          }
          case 'list': {
            // List from local vault — no server needed
            const { listVaultWallets } = await import('./vault.js')
            const wallets = listVaultWallets()
            if (!AGENT_MODE) {
              render(React.createElement(WalletListScreen, {
                version: VERSION,
                wallets: wallets.map((w: any) => ({
                  id: w.id,
                  name: w.name,
                  mode: w.mode,
                  solana: w.solanaAddress,
                  base: w.evmAddress,
                })),
              }))
            } else {
              print({ wallets })
            }
            break
          }
          case 'info': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            // Read from local vault directly
            const { listVaultWallets } = await import('./vault.js')
            const wallets = listVaultWallets()
            const w = wallets.find(x => x.id === walletId || x.name === walletId)
            if (!w) err(`Wallet "${walletId}" not found`, EXIT.NOT_FOUND)
            if (!AGENT_MODE) {
              render(React.createElement(WalletStatusScreen, {
                version: VERSION,
                id: w!.id,
                name: w!.name,
                mode: w!.mode,
                solana: w!.solanaAddress,
                base: w!.evmAddress,
              }))
            } else {
              print(w)
            }
            break
          }
          case 'addresses': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            // Read from local vault — same source as `wallet list` / `wallet info`.
            // The previous server-call path 401'd for unauthenticated users
            // even though all the data is already on the local disk.
            const { listVaultWallets } = await import('./vault.js')
            const wallets = listVaultWallets()
            const w = wallets.find(x => x.id === walletId || x.name === walletId)
            if (!w) err(`Wallet "${walletId}" not found`, EXIT.NOT_FOUND)
            const addresses = [
              ...(w!.solanaAddress ? [{ chainId: 'solana', address: w!.solanaAddress }] : []),
              ...(w!.evmAddress ? [{ chainId: 'base', address: w!.evmAddress }] : []),
            ]
            if (!AGENT_MODE) {
              render(React.createElement(SuccessScreen, {
                version: VERSION,
                title: 'Wallet addresses',
                subtitle: walletId,
                footerLeft: `${addresses.length} chain(s)`,
                details: addresses.map(a => ({ label: a.chainId + ':', value: a.address })),
              }))
            } else {
              print({ id: w!.id, name: w!.name, addresses })
            }
            break
          }
          case 'sign-message': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const chain = flags.chain as string
            const msg = flags.msg as string || flags.message as string
            if (!chain || !msg) err('--chain and --msg required')
            // Sign locally — no server needed
            const { signMessageLocal } = await import('./vault.js')
            const data = signMessageLocal(walletId, chain, msg)
            return print({ success: true, ...data })
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Message signed',
              subtitle: chain,
              footerLeft: 'Signature ready',
              details: [
                { label: 'Signature', value: String(data.signature || '') },
                ...(data.recoveryId !== undefined ? [{ label: 'Recovery ID', value: String(data.recoveryId) }] : []),
              ],
            }))
            break
          }
          case 'api-key': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const name = flags.name as string || 'cli-agent'
            // Retrieve session secret from OS credential store
            const { retrieveSecret } = await import('./credential-store.js')
            const sessionSecret = retrieveSecret(walletId)
            if (!sessionSecret) err('No session secret found. Was this wallet created on this machine?')
            const data = await ao.walletApiKey(walletId, name, sessionSecret!)
            return print(data)
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'API key created',
              subtitle: 'Save this token — it will not be shown again',
              footerLeft: 'Agent API key',
              details: [
                { label: 'Token', value: String(data.apiKey?.token || '') },
                { label: 'Key ID', value: String(data.apiKey?.id || '') },
                { label: 'Name', value: String(data.apiKey?.name || name) },
              ],
            }))
            break
          }
          case 'config': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const { retrieveSecret } = await import('./credential-store.js')
            const sessionSecret = retrieveSecret(walletId)
            if (!sessionSecret) err('No session secret found. Was this wallet created on this machine?')
            const data = await ao.walletConfig(walletId, sessionSecret!)
            return print(data)
            print(data.config || data)
            break
          }
          case 'use': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const chain = (flags.chain as string)?.toLowerCase()
            if (chain && chain !== 'solana' && chain !== 'base') {
              err(`--chain must be 'solana' or 'base', got: ${chain}`)
            }
            const cfg = loadConfig()
            cfg.defaultPayWalletId = walletId
            if (chain) (cfg as any).defaultPayChain = chain as 'solana' | 'base'
            saveConfig(cfg)
            print({ success: true, defaultPayWalletId: walletId, defaultPayChain: (cfg as any).defaultPayChain || 'solana' })
            break
          }
          case 'request-approval': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const action = flags.action as string || 'limits'
            const params: Record<string, any> = {}
            if (flags.daily) params.daily_usdc = Number(flags.daily)
            if (flags['per-tx'] || flags.tx) params.per_tx_usdc = Number(flags['per-tx'] || flags.tx)
            const data = await ao.walletRequestApproval(walletId, action, params)
            return print(data)
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Approval requested',
              subtitle: action,
              footerLeft: 'Send link to human for approval',
              details: [
                { label: 'Approval URL', value: `${ao.api}${data.approvalPath}` },
                { label: 'Action', value: action },
              ],
            }))
            break
          }
          case 'export': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            if (!flags.confirm) {
              err(
                'This will display your mnemonic in plaintext. ' +
                'Anyone who sees it can steal your funds.\n\n' +
                '  Re-run with --confirm to proceed:\n' +
                `  agentos wallet export ${walletId} --confirm`
              )
            }
            // Decrypt via vault's single decryption path (session secret from OS cred store)
            const { exportMnemonic } = await import('./vault.js')
            let mnemonic: string
            try {
              mnemonic = exportMnemonic(walletId)
            } catch (e: any) {
              // Preserve SECURITY exit code for integrity failures
              const code = e.message?.includes('SECURITY') ? EXIT.SECURITY : EXIT.GENERAL
              err(e.message, code)
            }

            const warning = 'Keep this phrase secret. Anyone with these 12 words can take your funds. Write it down offline; never share, screenshot, or paste it.'
            if (!AGENT_MODE) {
              console.log(`\n  ${t.warn}⚠  MNEMONIC — KEEP SECRET${t.reset}\n`)
              console.log(`  ${mnemonic!}\n`)
              console.log(`  ${t.muted}${warning}${t.reset}\n`)
            } else {
              print({ mnemonic: mnemonic!, walletId, warning })
            }
            break
          }
          default: err(`Unknown wallet command: ${subcommand}. Try: create, import, list, info, export, addresses, sign-message, api-key, config, use, request-approval`)
        }
        break
      }

      case 'chat': {
        if (!subcommand || flags.help) {
          showMenu({
            command: 'chat',
            title: 'chat',
            subtitle: 'i402 (intent layer for x402): tell AgentOS what you want, pay USDC, get the outcome',
            footerLeft: 'Powered by the i402 protocol — see spec/i402.md',
            commands: [
              { name: 'run',         description: 'Generate a plan (and optionally execute it)', hint: '"launch a sneaker brand" --budget 50' },
              { name: 'resume',      description: 'Continue an existing session with a follow-up intent', hint: '<session_id> "now post 3 videos"' },
              { name: 'status',      description: 'Inspect a session: history, current status', hint: '<session_id>' },
              { name: 'cancel',      description: 'Halt execution and refund remaining escrow', hint: '<session_id>' },
              { name: 'sessions',    description: 'List your active sessions' },
              { name: 'capabilities', description: 'List the canonical capability classes' },
              { name: 'providers',   description: 'List registered providers, optionally filtered', hint: '[--capability web_search]' },
            ],
            fromHome,
          })
          break
        }

        switch (subcommand) {
          case 'run': {
            const intent = (positional.join(' ') || flags.intent as string || '').trim()
            if (!intent) err('pass the intent as a positional arg or --intent "..."')
            const budget = flags.budget ? parseFloat(flags.budget as string) : NaN
            if (!isFinite(budget) || budget <= 0) err('--budget <USDC> is required and must be positive')
            const quality = (flags.quality as string) || 'best'
            if (!['fast', 'cheap', 'best'].includes(quality)) err('--quality must be fast | cheap | best')
            const autoExecute = flags.execute === true || flags['auto-execute'] === true
            const autoApprove = flags['auto-approve-under'] ? parseFloat(flags['auto-approve-under'] as string) : undefined

            const spin = new Spinner()
            spin.start('Generating i402 plan...')
            const plan = await ao.chat(intent, {
              budgetUsdc: budget,
              quality: quality as 'fast' | 'cheap' | 'best',
              autoApproveUnderUsdc: autoApprove,
              approve: autoExecute,
            })
            spin.stop('Plan generated', true)

            if (plan.status === 'clarification_needed') {
              if (AGENT_MODE) {
                print({
                  status: 'clarification_needed',
                  sessionId: plan.session_id,
                  questions: plan.questions || [],
                })
              } else {
                render(React.createElement(RecordsScreen, {
                  version: VERSION,
                  title: 'i402 — clarification needed',
                  subtitle: `session ${plan.session_id}`,
                  records: (plan.questions || []).map((q: any) => ({
                    primary: q.text,
                    secondary: `id: ${q.id}`,
                  })),
                  footerLeft: 'Re-run `agentos chat resume <session_id> "<your answer>"`',
                }))
              }
              break
            }

            // Agent mode: emit the plan as a single JSON object, then NDJSON
            // events during execution so an agent can `for await` over stdout.
            // TTY mode: keep the colored progress output below.
            if (AGENT_MODE) {
              print({
                event: 'plan',
                planId: plan.plan_id,
                sessionId: plan.session_id,
                intent: plan.intent,
                steps: plan.steps,
                totals: plan.totals,
                status: plan.status,
              })
            } else {
              console.log(`\n${c.cyan}Plan${c.white}: ${plan.intent?.interpreted ?? plan.intent?.original}`)
              console.log(`  ${plan.steps?.length ?? 0} steps · $${plan.totals?.total_cost_usdc?.toFixed(2) ?? '?'} · ~${plan.totals?.eta_seconds ?? '?'}s · session ${plan.session_id}`)
              for (const s of plan.steps || []) {
                console.log(`  ${s.step_id}  ${s.capability} → ${s.provider}  $${s.cost_usdc?.toFixed(2)}  ${s.description ?? ''}`)
              }
              console.log('')
            }

            if (!autoExecute && plan.status !== 'approved') {
              if (AGENT_MODE) {
                print({
                  event: 'awaiting_approval',
                  sessionId: plan.session_id,
                  planId: plan.plan_id,
                  resumeCommand: `agentos chat resume ${plan.session_id} --approve --plan-id ${plan.plan_id}`,
                })
              } else {
                console.log(`${c.yellow}Plan not auto-approved.${c.white} To execute:`)
                console.log(`  ${c.cyan}agentos chat resume ${plan.session_id} --approve --plan-id ${plan.plan_id}${c.white}`)
              }
              break
            }

            if (autoExecute || plan.status === 'approved') {
              if (!AGENT_MODE) console.log(`${c.cyan}Executing plan${c.white} (streaming)...\n`)
              let spent = 0
              const stepOutputs: Record<string, any> = {}
              for await (const event of ao.chatExecute(plan)) {
                if (AGENT_MODE) {
                  // NDJSON: one event per line. Agents can stream-parse.
                  process.stdout.write(JSON.stringify(event) + '\n')
                  if (event.type === 'step_result' || event.type === 'session_refresh_done') {
                    spent += Number((event as any).costChargedUsdc ?? 0)
                  }
                  if (event.type === 'step_result' && event.output && typeof event.output === 'object') {
                    stepOutputs[event.stepId] = event.output
                  }
                  continue
                }
                switch (event.type) {
                  case 'session':
                  case 'plan':
                    // Already displayed
                    break
                  case 'step_start':
                    // Price is shown cumulatively on step_result — no need to
                    // print it twice per step.
                    console.log(`  ${c.gray}→${c.white} ${event.stepId} ${event.capability} via ${event.provider}`)
                    break
                  case 'session_refresh_started':
                    process.stdout.write(`    ${c.gray}↻ refreshing ${event.platform} session for @${event.handle}…${c.white}`)
                    break
                  case 'session_refresh_done':
                    spent += Number(event.costChargedUsdc ?? 0)
                    console.log(` ${c.green}done${c.white} ${c.gray}(+$${event.costChargedUsdc?.toFixed(3)})${c.white}`)
                    break
                  case 'step_result':
                    spent += Number(event.costChargedUsdc ?? 0)
                    if (event.output && typeof event.output === 'object') stepOutputs[event.stepId] = event.output
                    console.log(`  ${c.green}✓${c.white} ${event.stepId} done in ${event.latencyMs}ms  ${c.gray}spent: $${spent.toFixed(2)}${c.white}`)
                    break
                  case 'step_error': {
                    // Long upstream errors (HTML pages, JSON dumps) are noise
                    // in the terminal — truncate and point at --verbose.
                    const errMsg = truncateError(String(event.error ?? ''))
                    const tag = event.fatal ? '(FATAL)' : `retry → ${event.retryWith ?? 'none'}`
                    console.log(`  ${c.red}✗${c.white} ${event.stepId} ${tag}: ${errMsg}`)
                    break
                  }
                  case 'clarification_needed':
                    console.log(`  ${c.yellow}?${c.white} clarification: ${JSON.stringify(event.questions)}`)
                    break
                  case 'summary':
                    console.log(`\n${c.cyan}Summary${c.white}: status=${event.status}  spent=$${event.spentUsdc?.toFixed(2)}  ${c.gray}session=${plan.session_id}${c.white}`)
                    if (Object.keys(stepOutputs).length > 0) {
                      console.log(`\n${c.cyan}Outputs:${c.white}`)
                      for (const [stepId, out] of Object.entries(stepOutputs)) {
                        console.log(`  ${c.gray}${stepId}${c.white} ${formatStepOutput(out)}`)
                      }
                    }
                    for (const a of event.artifacts || []) {
                      console.log(`  ${c.gray}artifact:${c.white} ${a.type} — ${a.name ?? a.resourceRef}`)
                    }
                    break
                }
              }
            }
            break
          }

          case 'resume': {
            const sessionId = positional[0]
            const intentParts = positional.slice(1)
            const intent = intentParts.join(' ').trim() || (flags.intent as string | undefined) || ''
            const planId = flags['plan-id'] as string | undefined
            if (!sessionId) err('session_id required: agentos chat resume <session_id> "follow-up intent"')

            // If intent is provided, generate a new plan in this session
            if (intent) {
              const budget = flags.budget ? parseFloat(flags.budget as string) : 20
              const autoExecute = flags.execute === true || flags['auto-execute'] === true
              const plan = await ao.chat(intent, {
                sessionId,
                budgetUsdc: budget,
                quality: (flags.quality as any) || 'best',
                approve: autoExecute,
              })
              if (AGENT_MODE) {
                print({
                  event: 'plan',
                  sessionId,
                  planId: plan.plan_id,
                  totalCostUsdc: plan.totals?.total_cost_usdc,
                  steps: plan.steps,
                })
              } else {
                console.log(`${c.cyan}New plan in session${c.white} ${sessionId}`)
                console.log(`  plan_id: ${plan.plan_id}  cost: $${plan.totals?.total_cost_usdc?.toFixed(2) ?? '?'}`)
              }
              if (!autoExecute) break
              for await (const event of ao.chatExecute(plan)) {
                if (AGENT_MODE) {
                  process.stdout.write(JSON.stringify(event) + '\n')
                  continue
                }
                if (event.type === 'step_result') console.log(`  ${c.green}✓${c.white} ${event.stepId} $${event.costChargedUsdc?.toFixed(2)}`)
                if (event.type === 'step_error') console.log(`  ${c.red}✗${c.white} ${event.stepId} ${event.error}`)
                if (event.type === 'summary') console.log(`${c.cyan}done${c.white}: ${event.status}  spent=$${event.spentUsdc?.toFixed(2)}`)
              }
              break
            }

            // No intent → we'd need to re-fetch the plan from the server.
            // Not wired in this minimal CLI: generate a new plan with `chat run`
            // or pass a follow-up intent to `chat resume <session> "..."`.
            err('pass a follow-up intent to continue the session; direct re-execution of a stored plan by id is not yet wired')
            break
          }

          case 'status': {
            const sessionId = positional[0]
            if (!sessionId) err('session_id required')
            const data = await ao.chatGetSession(sessionId)
            return print(data)
          }

          case 'cancel': {
            const sessionId = positional[0]
            if (!sessionId) err('session_id required')
            const data = await ao.chatCancel(sessionId)
            return print(data)
          }

          case 'sessions': {
            const data = await ao.chatListSessions()
            return print(data)
          }

          case 'capabilities': {
            const data = await ao.chatListCapabilities()
            return print(data)
          }

          case 'providers': {
            const capability = flags.capability as string | undefined
            const data = await ao.chatListProviders(capability)
            return print(data)
          }

          default: err(`Unknown chat command: ${subcommand}. Try: run, resume, status, cancel, sessions, capabilities, providers`)
        }
        break
      }

      case 'twitter': {
        const sv = await import('./social-vault.js')
        const platform = 'twitter' as const

        if (!subcommand) {
          showMenu({
            command: 'twitter',
            title: 'twitter',
            subtitle: 'Automated X account management',
            footerLeft: 'Phase 1: local vault + BYO import works today. Server-dependent commands stub out.',
            commands: [
              { name: 'import',  description: 'Save a BYO account to the local vault', hint: '--username --password --totp-seed' },
              { name: 'list',    description: 'List all local X accounts' },
              { name: 'info',    description: 'Show one account', hint: '<username>' },
              { name: 'rename',  description: 'Update the local record when the handle changes', hint: '<old> --to <new>' },
              { name: 'remove',  description: 'Delete an account from the local vault', hint: '<username> --confirm' },
              { name: 'totp',    description: 'Print the current TOTP code for an account', hint: '<username>' },
              { name: 'buy',     description: 'Purchase an aged account (requires server supplier config)', hint: '--age 1y --country US' },
              { name: 'login',   description: 'Force a fresh server-side session (requires browser runtime)', hint: '<username>' },
              { name: 'post',    description: 'Post a tweet (requires server browser runtime)', hint: '<username> --body "..."' },
              { name: 'status',  description: 'Check if the account is alive / shadow-banned', hint: '<username>' },
            ],
            fromHome,
          })
          return
        }

        switch (subcommand) {
          case 'import': {
            // Option 1: --credentials-line "login:password:email:email_pw:2fa:ct0:auth_token"
            // Option 2: individual --username --password --email etc flags
            const line = flags['credentials-line'] as string
            let login: string | undefined
            let password: string | undefined
            let email: string | undefined
            let emailPassword: string | undefined
            let totpSeed: string | undefined
            let ct0: string | undefined
            let authToken: string | undefined
            let username = (flags.username as string) || positional[0]

            if (line) {
              // AccsMarket common formats:
              //   login:password:email:email_pw                    (4 fields)
              //   login:password:email:email_pw:2fa                (5 fields)
              //   login:password:email:email_pw:2fa:ct0:auth_token (7 fields)
              const parts = line.split(':')
              if (parts.length < 4) err(`--credentials-line must have at least 4 colon-separated fields, got ${parts.length}`)
              login = parts[0]
              password = parts[1]
              email = parts[2]
              emailPassword = parts[3]
              if (parts[4]) totpSeed = parts[4]
              if (parts[5]) ct0 = parts[5]
              if (parts[6]) authToken = parts[6]
              // If no explicit --username, use the login field as the account handle.
              if (!username) username = login
            } else {
              password = flags.password as string
              login = flags.login as string
              email = flags.email as string
              emailPassword = (flags['email-password'] as string) || (flags.emailpw as string)
              totpSeed = (flags['totp-seed'] as string) || (flags.totp as string)
              ct0 = flags.ct0 as string
              authToken = (flags['auth-token'] as string) || (flags.authtoken as string)
            }

            if (!username) err('--username (or --credentials-line) required')
            if (!password) err('--password (or --credentials-line) required')

            const recovery = flags['recovery-codes'] as string
            const profileUrl = flags['profile-url'] as string

            const creds: import('./social-vault.js').SocialCredentials = {
              login: login || email || undefined,
              password: password!,
              email: email || login || undefined,
              email_password: emailPassword,
              totp_seed: totpSeed,
              recovery_codes: recovery ? recovery.split(',').map(s => s.trim()) : undefined,
              profile_url: profileUrl,
              auth_token: authToken,
              ct0,
            }
            const summary = sv.importAccount(platform, username, creds, { source: line ? 'accsmarket-line' : 'import' })
            log(`twitter import: ${summary.username} (${summary.id})${authToken ? ' [cookies included — cookie login path]' : ' [form login path]'}`)
            return print({ ...summary, has_cookies: !!authToken })
          }

          case 'list': {
            const accounts = sv.listAccounts(platform)
            return print({ accounts, count: accounts.length })
          }

          case 'info': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)
            return print(acc!)
          }

          case 'rename': {
            const oldUsername = positional[0] || (flags.username as string)
            const newUsername = flags.to as string
            if (!oldUsername) err('<old-username> required')
            if (!newUsername) err('--to <new-username> required')
            const summary = sv.renameAccount(platform, oldUsername, newUsername)
            log(`twitter rename: ${oldUsername} → ${newUsername}`)
            return print(summary)
          }

          case 'remove': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            if (!flags.confirm) {
              err(
                `This deletes the local copy of "${username}". The X account itself is NOT deleted.\n\n` +
                `  Re-run with --confirm to proceed:\n` +
                `  agentos twitter remove ${username} --confirm`
              )
            }
            sv.removeAccount(platform, username)
            log(`twitter remove: ${username}`)
            return print({ success: true, platform, username })
          }

          case 'totp': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const creds = sv.unlockCredentials(platform, username)
            if (!creds.totp_seed) err(`twitter account "${username}" has no TOTP seed configured`, EXIT.NOT_FOUND)
            const { code, secondsUntilNextCode } = await import('./totp.js')
            return print({
              platform,
              username,
              code: code(creds.totp_seed!),
              expires_in_seconds: secondsUntilNextCode(),
            })
          }

          case 'login': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)

            // Decrypt credentials locally — they transit the network only over TLS
            // during this one request, and are never persisted server-side.
            const creds = sv.unlockCredentials(platform, username)
            if (!creds.login) err('Account has no login field. Re-import with --login <email-or-handle>.', EXIT.BAD_INPUT)

            const cookiePath = !!(creds.auth_token && creds.ct0)
            const psid = sv.getProxySessionId(platform, username)
            let data: any
            try {
              // Uses the SDK so x402 payment is auto-signed from the configured wallet
              data = await ao.socialTwitterLogin(
                acc!.id,
                creds.login!,
                creds.password,
                creds.totp_seed,
                cookiePath ? { auth_token: creds.auth_token, ct0: creds.ct0 } : undefined,
                psid
              )
            } catch (e: any) {
              err(`Login failed: ${e.message}`, EXIT.GENERAL)
            }

            if (!data || !data.success) {
              err(
                `Login failed: ${data?.error || 'unknown error'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }

            sv.saveSession(acc!.id, platform, data.cookies || [])
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })

            return print({
              success: true,
              platform,
              username,
              cookies_captured: (data.cookies || []).length,
              captured_at: data.captured_at,
            })
          }

          case 'session': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)
            const sess = sv.loadSession(acc!.id)
            if (!sess) {
              return print({
                platform,
                username,
                cached: false,
                hint: `No cached session. Run: node cli/dist/cli.js twitter login ${username}`,
              })
            }
            const ageHours = sv.sessionAgeHours(acc!.id)
            return print({
              platform,
              username,
              cached: true,
              cookies: sess.cookies.length,
              captured_at: sess.captured_at,
              age_hours: Number((ageHours || 0).toFixed(2)),
              stale: (ageHours || 0) > 12,
            })
          }

          case 'list-tweets': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const rawLimit = flags.limit
            let limit: number | undefined
            if (rawLimit !== undefined) {
              const n = Number(rawLimit)
              if (!Number.isFinite(n) || n <= 0) err('--limit must be a positive integer', EXIT.BAD_INPUT)
              limit = Math.floor(n)
            }
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)
            const sess = sv.loadSession(acc!.id)
            if (!sess || !sess.cookies || sess.cookies.length === 0) {
              err(
                `No cached session for ${username}. Run 'twitter login ${username}' first.`,
                EXIT.NOT_FOUND
              )
            }
            const psid = sv.getProxySessionId(platform, username)
            let data: any
            try {
              data = await ao.socialTwitterListMyTweets(acc!.id, sess!.cookies, limit, psid)
            } catch (e: any) {
              err(`list-tweets failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(
                `list-tweets failed: ${data?.error || 'unknown'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })
            return print({ success: true, platform, username, ...(data?.data || {}) })
          }

          case 'register': {
            // Register an X account with the AgentOS server. Server tests the
            // login, encrypts credentials at rest, and from then on can refresh
            // cookies on this wallet's behalf — foundation for server-side
            // scheduling. If the account already exists in the local vault,
            // we pull its credentials by default so the user doesn't have to
            // re-type. Explicit flags override.
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')

            let login: string | undefined = (flags.login as string) || undefined
            let password: string | undefined = (flags.password as string) || undefined
            let totpSeed: string | undefined = (flags['totp-seed'] as string) || undefined
            let email: string | undefined = (flags.email as string) || undefined
            let emailPassword: string | undefined = (flags['email-password'] as string) || undefined
            let authToken: string | undefined = (flags['auth-token'] as string) || undefined
            let ct0: string | undefined = (flags.ct0 as string) || undefined
            const country: string | undefined = (flags.country as string) || undefined

            const localAcc = sv.getAccount(platform, username!)
            if (localAcc && !password) {
              const localCreds = sv.unlockCredentials(platform, username!)
              login = login || localCreds.login
              password = password || localCreds.password
              totpSeed = totpSeed || localCreds.totp_seed
              email = email || localCreds.email
              emailPassword = emailPassword || localCreds.email_password
              authToken = authToken || localCreds.auth_token
              ct0 = ct0 || localCreds.ct0
            }

            if (!password) {
              err('--password required (or import the account locally first via `agentos twitter import`)')
            }

            let data: any
            try {
              data = await ao.socialTwitterRegister(username!, password!, {
                login, email, email_password: emailPassword,
                totp_seed: totpSeed, auth_token: authToken, ct0, country,
              })
            } catch (e: any) {
              err(`Register failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(
                `Register failed: ${data?.error || 'unknown'}` +
                (data?.login_error_code ? ` [${data.login_error_code}]` : ''),
                EXIT.GENERAL
              )
            }
            return print({
              success: true,
              platform, username,
              account_id: data.id,
              cookies_captured: data.cookies_captured,
              hint: 'Server holds encrypted credentials. Use `agentos twitter schedule` (next PR) to schedule fire-and-forget posts.',
            })
          }

          case 'unregister': {
            const usernameOrId = positional[0] || (flags.username as string) || (flags.id as string)
            if (!usernameOrId) err('<username-or-id> required')
            // 32-char hex == account_id. Otherwise treat as username and look up.
            let accountId: string | undefined
            if (/^[a-f0-9]{32}$/i.test(usernameOrId!)) {
              accountId = usernameOrId
            } else {
              let registered: any
              try {
                registered = await ao.socialTwitterListRegistered()
              } catch (e: any) {
                err(`Failed to list registered accounts: ${e.message}`, EXIT.GENERAL)
              }
              const match = (registered?.accounts || []).find((a: any) => a.username === usernameOrId)
              if (!match) {
                err(`No registered account with username "${usernameOrId}". Run \`agentos twitter registered\` to list.`, EXIT.NOT_FOUND)
              }
              accountId = match!.id
            }
            let data: any
            try {
              data = await ao.socialTwitterUnregister(accountId!)
            } catch (e: any) {
              err(`Unregister failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(`Unregister failed: ${data?.error || 'unknown'}`, EXIT.GENERAL)
            }
            return print({ success: true, platform, account_id: accountId, hint: 'Server-side credentials wiped. Account no longer schedulable until re-registered.' })
          }

          case 'registered': {
            let data: any
            try {
              data = await ao.socialTwitterListRegistered()
            } catch (e: any) {
              err(`List registered failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(`List registered failed: ${data?.error || 'unknown'}`, EXIT.GENERAL)
            }
            return print({ success: true, platform, accounts: data.accounts || [] })
          }

          case 'schedule':
          case 'draft': {
            // Both share the same content-parsing + media-ingestion logic.
            // Action shape (post / post_thread / post_media) is inferred from
            // which content flags the user passed.
            const sq = await import('./social-queue.js')
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const text = (flags.body as string) || (flags.text as string)
            const textsRaw = flags.texts as string
            const fileTextsPath = (flags.file as string) || (flags.path as string)
            let texts: string[] | undefined
            if (fileTextsPath) {
              const fs = require('fs')
              try { texts = JSON.parse(fs.readFileSync(fileTextsPath, 'utf8')) }
              catch (e: any) { err(`--file ${fileTextsPath}: ${e.message}`) }
            } else if (textsRaw) {
              try { texts = JSON.parse(textsRaw) }
              catch (e: any) { err(`--texts must be a JSON array of strings: ${e.message}`) }
            }
            if (!text && (!Array.isArray(texts) || texts.length === 0)) {
              err('Either --body "..." or --texts \'["..."]\' required')
            }

            // Determine action based on flags + future media handling.
            const hasMediaFlags = !!(flags.image || flags.video || flags['media-json'])
            let action: 'post' | 'post_thread' | 'post_media' = 'post'
            if (Array.isArray(texts) && texts.length > 0) action = 'post_thread'
            else if (hasMediaFlags) action = 'post_media'

            // Schedule needs --at; draft is timeless.
            let postAt: string | undefined
            if (subcommand === 'schedule') {
              postAt = flags.at as string
              if (!postAt) err('--at "ISO 8601" required (e.g. --at "2026-05-15T14:00:00Z")')
              const t = Date.parse(postAt!)
              if (Number.isNaN(t)) err(`--at "${postAt}" is not a valid ISO 8601 date`)
            }

            // Generate ID upfront so we can pre-ingest media files into its dir.
            const id = require('crypto').randomUUID()

            // Build MediaRef[] from flags. Local files get copied into queue
            // storage; URL-based media is stored as-is for server fetch later.
            const media: any[] = []
            if (flags.image) {
              const path = require('path')
              for (const fp of (flags.image as string).split(',').map((p: string) => p.trim()).filter(Boolean)) {
                try {
                  const ref = sq.ingestLocalMediaFile(id, fp, 'image')
                  media.push(ref)
                } catch (e: any) { err(`--image ${fp}: ${e.message}`) }
              }
            }
            if (flags.video) {
              const fp = flags.video as string
              try {
                const ref = sq.ingestLocalMediaFile(id, fp, 'video')
                media.push(ref)
              } catch (e: any) { err(`--video ${fp}: ${e.message}`) }
            }
            if (flags['media-json']) {
              let parsed: any
              try { parsed = JSON.parse(flags['media-json'] as string) }
              catch (e: any) { err(`--media-json: ${e.message}`) }
              if (!Array.isArray(parsed)) err('--media-json must be a JSON array')
              for (const m of parsed) {
                if (m.image_url || m.video_url) {
                  media.push({
                    image_url: m.image_url,
                    video_url: m.video_url,
                    kind: m.video_url ? 'video' : 'image',
                  })
                } else {
                  err('--media-json entries must have image_url or video_url (local files: use --image / --video)')
                }
              }
            }
            if (media.length > 0) action = action === 'post_thread' ? 'post_thread' : 'post_media'

            const communityId = (flags.community as string) || (flags['community-id'] as string) || undefined

            // Schedule path: write a ScheduledItem; cli.social-queue assigns
            // a NEW id internally, but we already used `id` to ingest media —
            // pass it explicitly so the dirs match. (Helper accepts the id.)
            if (subcommand === 'schedule') {
              // For correct id-to-media binding, we sidestep addScheduled and
              // construct the entry directly via loadQueue/saveQueue so the
              // pre-ingested media dir lines up with the entry's id.
              const q = sq.loadQueue()
              const item = {
                id,
                platform: 'x' as const,
                account_username: username!,
                action,
                text: text || undefined,
                texts,
                media: media.length > 0 ? media : undefined,
                community_id: communityId,
                post_at: postAt!,
                status: 'pending' as const,
                created_at: new Date().toISOString(),
                retry_count: 0,
              }
              q.scheduled.push(item)
              sq.saveQueue(q)
              return print({ success: true, scheduled: item })
            } else {
              const q = sq.loadQueue()
              const item = {
                id,
                platform: 'x' as const,
                account_username: username!,
                action,
                text: text || undefined,
                texts,
                media: media.length > 0 ? media : undefined,
                community_id: communityId,
                name: (flags.name as string) || undefined,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }
              q.drafts.push(item)
              sq.saveQueue(q)
              return print({ success: true, draft: item })
            }
          }

          case 'queue': {
            const sq = await import('./social-queue.js')
            const acct = (flags.account as string) || undefined
            const fromIso = (flags.from as string) || undefined
            const toIso = (flags.to as string) || undefined
            // Default = show everything; flags narrow.
            const onlyScheduled = flags.scheduled === true
            const onlyDrafts = flags.drafts === true
            const onlyPublished = flags.published === true
            const onlyFailed = flags.failed === true
            const showAll = !onlyScheduled && !onlyDrafts && !onlyPublished && !onlyFailed
            const out: any = {}
            if (showAll || onlyScheduled) {
              out.scheduled = sq.listScheduled({ account: acct, from: fromIso, to: toIso })
            }
            if (showAll || onlyDrafts) {
              out.drafts = sq.listDrafts(acct)
            }
            if (showAll || onlyPublished) {
              out.published = sq.listPublished(acct)
            }
            if (showAll || onlyFailed) {
              out.failed = sq.listFailed(acct)
            }
            return print(out)
          }

          case 'cancel': {
            const sq = await import('./social-queue.js')
            const id = positional[0] || (flags.id as string)
            if (!id) err('<id> required (from `agentos twitter queue`)')
            // Try scheduled first, then drafts.
            const cancelled = sq.cancelScheduled(id!)
            if (cancelled.cancelled) {
              return print({ success: true, cancelled: 'scheduled', id, item: cancelled.item })
            }
            if (cancelled.item && cancelled.item.status === 'in_progress') {
              err(`Scheduled item ${id} is in_progress and cannot be cancelled.`, EXIT.GENERAL)
            }
            const deletedDraft = sq.deleteDraft(id!)
            if (deletedDraft) {
              return print({ success: true, cancelled: 'draft', id })
            }
            err(`No scheduled item or draft found with id "${id}"`, EXIT.NOT_FOUND)
          }

          case 'promote-draft': {
            const sq = await import('./social-queue.js')
            const id = positional[0] || (flags.id as string)
            if (!id) err('<draft-id> required (from `agentos twitter queue --drafts`)')
            const postAt = flags.at as string
            if (!postAt) err('--at "ISO 8601" required (e.g. --at "2026-05-15T14:00:00Z")')
            const t = Date.parse(postAt)
            if (Number.isNaN(t)) err(`--at "${postAt}" is not a valid ISO 8601 date`)
            const promoted = sq.promoteDraft(id!, postAt)
            if (!promoted) err(`No draft found with id "${id}"`, EXIT.NOT_FOUND)
            return print({ success: true, promoted })
          }

          case 'username': {
            const username = positional[0] || (flags.username as string)
            const rawNewUsername = flags.to as string
            if (!username) err('<username> required')
            if (!rawNewUsername) err('--to <new-handle> required')
            // Pre-flight validate so we don't pay for preventable input errors.
            const newUsername = rawNewUsername.replace(/^@/, '').trim()
            if (!/^[A-Za-z0-9_]{4,15}$/.test(newUsername)) {
              err(
                `Invalid username "${rawNewUsername}". X requires 4-15 chars, letters/numbers/underscores only. ` +
                `You have NOT been charged.`,
                EXIT.BAD_INPUT
              )
            }
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)
            const sess = sv.loadSession(acc!.id)
            if (!sess || !sess.cookies || sess.cookies.length === 0) {
              err(`No cached session. Run 'twitter login ${username}' first.`, EXIT.NOT_FOUND)
            }
            // Unlock password locally — transits to server only in this call.
            const creds = sv.unlockCredentials(platform, username)
            if (!creds.password) err('Account has no password in vault — cannot authenticate username change.')

            const psid = sv.getProxySessionId(platform, username)
            let data: any
            try {
              data = await ao.socialTwitterUsername(acc!.id, sess!.cookies, newUsername, creds.password, psid)
            } catch (e: any) {
              err(`Username change failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(
                `Username change failed: ${data?.error || 'unknown'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }

            // Sync local record to the new handle.
            const renamed = sv.renameAccount(platform, username, newUsername.replace(/^@/, ''))
            sv.updateMeta(platform, renamed.username, { last_action_at: new Date().toISOString() })
            return print({ success: true, platform, old_username: username, new_username: renamed.username })
          }

          case 'post':
          case 'thread':
          case 'reply':
          case 'like':
          case 'retweet':
          case 'follow':
          case 'unfollow':
          case 'delete':
          case 'bio':
          case 'name':
          case 'location':
          case 'website':
          case 'pfp':
          case 'banner': {
            const username = positional[0] || (flags.username as string)
            if (!username) err(`<username> required`)
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)
            const sess = sv.loadSession(acc!.id)
            if (!sess || !sess.cookies || sess.cookies.length === 0) {
              err(
                `No cached session for ${username}. Run 'twitter login ${username}' first.`,
                EXIT.NOT_FOUND
              )
            }
            const psid = sv.getProxySessionId(platform, username)

            let data: any
            try {
              if (subcommand === 'post') {
                const text = (flags.body as string) || (flags.text as string)
                if (!text) err('--body "..." required')
                const communityId = (flags.community as string) || (flags['community-id'] as string) || undefined
                // Build optional media array. CLI supports the common cases:
                // --image path[,path,path,path] for 1-4 local image files,
                // --video path for a single local video file,
                // --media-json '[{...}]' as the full-power escape hatch
                // (mix image_url / image_base64 / video_url / video_base64).
                const media: Array<{ image_base64?: string; image_url?: string; video_base64?: string; video_url?: string }> = []
                if (flags.image) {
                  const fs = require('fs')
                  const path = require('path')
                  for (const fp of (flags.image as string).split(',').map((p: string) => p.trim()).filter(Boolean)) {
                    let buf: Buffer
                    try { buf = fs.readFileSync(fp) } catch (e: any) { err(`--image ${fp}: ${e.message}`); continue }
                    const ext = path.extname(fp).slice(1).toLowerCase() || 'png'
                    media.push({ image_base64: `data:image/${ext};base64,${buf.toString('base64')}` })
                  }
                }
                if (flags.video) {
                  const fs = require('fs')
                  const path = require('path')
                  const fp = flags.video as string
                  let buf: Buffer
                  try { buf = fs.readFileSync(fp) } catch (e: any) { err(`--video ${fp}: ${e.message}`) }
                  const ext = path.extname(fp).slice(1).toLowerCase() || 'mp4'
                  media.push({ video_base64: `data:video/${ext};base64,${buf!.toString('base64')}` })
                }
                if (flags['media-json']) {
                  let parsed: any
                  try { parsed = JSON.parse(flags['media-json'] as string) }
                  catch (e: any) { err(`--media-json: ${e.message}`) }
                  if (!Array.isArray(parsed)) err('--media-json must be a JSON array of media objects')
                  media.push(...parsed)
                }
                if (media.length > 0) {
                  data = await ao.socialTwitterPostWithMedia(acc!.id, sess!.cookies, text, media, psid, communityId)
                } else {
                  data = await ao.socialTwitterPost(acc!.id, sess!.cookies, text, psid, communityId)
                }
              } else if (subcommand === 'thread') {
                // --texts accepts a JSON-encoded array of strings, OR --file points
                // to a JSON file with the same shape. Each tweet ≤280 chars; 1-25
                // tweets per thread. Single-tweet "threads" delegate to a normal post.
                const textsRaw = (flags.texts as string) || (flags.body as string)
                const filePath = (flags.file as string) || (flags.path as string)
                let texts: string[] | undefined
                if (filePath) {
                  const fs = require('fs')
                  try { texts = JSON.parse(fs.readFileSync(filePath, 'utf8')) }
                  catch (e: any) { err(`--file ${filePath}: ${e.message}`) }
                } else if (textsRaw) {
                  try { texts = JSON.parse(textsRaw) }
                  catch (e: any) { err(`--texts must be a JSON array of strings: ${e.message}`) }
                }
                if (!Array.isArray(texts) || texts.length === 0) {
                  err('--texts \'["tweet 1","tweet 2",...]\' or --file <path> required')
                }
                const communityIdT = (flags.community as string) || (flags['community-id'] as string) || undefined
                data = await ao.socialTwitterPostThread(acc!.id, sess!.cookies, texts!, psid, communityIdT)
              } else if (subcommand === 'reply') {
                const tweetUrl = (flags.to as string) || (flags.tweet as string)
                const text = (flags.body as string) || (flags.text as string)
                if (!tweetUrl) err('--to <tweet-url> required')
                if (!text) err('--body "..." required')
                data = await ao.socialTwitterReply(acc!.id, sess!.cookies, tweetUrl, text, psid)
              } else if (subcommand === 'like') {
                const tweetUrl = (flags.tweet as string) || (flags.url as string)
                if (!tweetUrl) err('--tweet <tweet-url> required')
                data = await ao.socialTwitterLike(acc!.id, sess!.cookies, tweetUrl, psid)
              } else if (subcommand === 'retweet') {
                const tweetUrl = (flags.tweet as string) || (flags.url as string)
                if (!tweetUrl) err('--tweet <tweet-url> required')
                data = await ao.socialTwitterRetweet(acc!.id, sess!.cookies, tweetUrl, psid)
              } else if (subcommand === 'follow') {
                const target = (flags.user as string) || (flags.target as string)
                if (!target) err('--user <@handle> required')
                data = await ao.socialTwitterFollow(acc!.id, sess!.cookies, target, psid)
              } else if (subcommand === 'unfollow') {
                const target = (flags.user as string) || (flags.target as string)
                if (!target) err('--user <@handle> required')
                data = await ao.socialTwitterUnfollow(acc!.id, sess!.cookies, target, psid)
              } else if (subcommand === 'delete') {
                const tweetUrl = (flags.tweet as string) || (flags.url as string)
                if (!tweetUrl) err('--tweet <tweet-url> required')
                data = await ao.socialTwitterDelete(acc!.id, sess!.cookies, tweetUrl, psid)
              } else if (subcommand === 'bio') {
                const text = (flags.text as string) || (flags.body as string)
                if (text === undefined) err('--text "..." required (pass "" to clear)')
                data = await ao.socialTwitterProfile(acc!.id, sess!.cookies, { bio: text }, psid)
              } else if (subcommand === 'name') {
                const text = (flags.display as string) || (flags.text as string) || (flags.name as string)
                if (!text) err('--display "Display Name" required')
                data = await ao.socialTwitterProfile(acc!.id, sess!.cookies, { display_name: text }, psid)
              } else if (subcommand === 'location') {
                const text = (flags.text as string) || ''
                data = await ao.socialTwitterProfile(acc!.id, sess!.cookies, { location: text }, psid)
              } else if (subcommand === 'website') {
                const url = (flags.url as string) || (flags.text as string) || ''
                data = await ao.socialTwitterProfile(acc!.id, sess!.cookies, { website: url }, psid)
              } else {
                // pfp / banner: accept --file (local path, base64-encoded here)
                // OR --url (hosted image, server fetches).
                const filePath = (flags.file as string) || (flags.path as string)
                const imageUrl = flags.url as string
                if (!filePath && !imageUrl) err('--file <local-path> or --url <https-url> required')
                let image: { image_base64?: string; image_url?: string } = {}
                if (filePath) {
                  const { readFileSync, existsSync } = await import('fs')
                  if (!existsSync(filePath)) err(`File not found: ${filePath}`, EXIT.NOT_FOUND)
                  const buf = readFileSync(filePath)
                  const ext = filePath.toLowerCase().match(/\.(png|jpg|jpeg|webp|gif)$/)?.[1] || 'png'
                  image.image_base64 = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`
                } else {
                  image.image_url = imageUrl
                }
                if (subcommand === 'pfp') {
                  data = await ao.socialTwitterAvatar(acc!.id, sess!.cookies, image, psid)
                } else {
                  data = await ao.socialTwitterBanner(acc!.id, sess!.cookies, image, psid)
                }
              }
            } catch (e: any) {
              err(`${subcommand} failed: ${e.message}`, EXIT.GENERAL)
            }

            if (!data?.success) {
              err(
                `${subcommand} failed: ${data?.error || 'unknown'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }

            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })
            return print({ success: true, platform, username, op: subcommand, ...(data?.data || {}) })
          }

          case 'buy': {
            // Agents just say "buy." Server picks the oldest ready account.
            let data: any
            try {
              data = await ao.socialTwitterBuy()
            } catch (e: any) {
              err(`Buy failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success || !data.account) {
              err(`Buy failed: ${data?.error || 'no account returned'}`, EXIT.GENERAL)
            }
            const { account } = data
            // Auto-import into the local vault + prime the session cache so
            // the buyer can post immediately with the cookies the admin
            // pre-seasoned at pool-add time.
            const summary = sv.importAccount(platform, account.username, account.credentials, {
              source: 'pool',
              proxy_session_id: account.proxy_session_id,
              notes: 'Bought from pool',
            })
            sv.saveSession(summary.id, platform, account.cookies || [])
            sv.updateMeta(platform, summary.username, { last_action_at: new Date().toISOString() })
            return print({
              success: true,
              platform,
              username: summary.username,
              hint: `Ready to post — try: node cli/dist/cli.js twitter post ${summary.username} --body "gm"`,
            })
          }

          case 'pool-add': {
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const file = (flags.file as string) || (flags.batch as string)
            const line = flags['credentials-line'] as string
            const country = (flags.country as string) || undefined
            const ageCategory = (flags.age as string) || (flags['age-category'] as string) || undefined
            const price = flags.price !== undefined ? Number(flags.price) : undefined
            if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
              err('--price <USDC> required (e.g. --price 5)')
            }
            if (!file && !line) {
              err('Either --credentials-line "..." or --file path/to/accounts.txt required')
            }

            // Collect credentials lines from flag or file.
            let lines: string[] = []
            if (line) {
              lines = [line]
            } else {
              const { readFileSync, existsSync } = await import('fs')
              if (!existsSync(file!)) err(`File not found: ${file}`, EXIT.NOT_FOUND)
              lines = readFileSync(file!, 'utf8')
                .split(/\r?\n/)
                .map(s => s.trim())
                .filter(s => s.length > 0 && !s.startsWith('#')) // # = comment
            }

            const results: any[] = []
            const isInteractive = !AGENT_MODE
            let spin: any = null
            if (isInteractive && lines.length > 1) {
              spin = new Spinner()
              spin.start(`Seeding pool (0/${lines.length})`)
            }

            for (let i = 0; i < lines.length; i++) {
              const credsLine = lines[i]
              if (spin) spin.update(`Seeding pool (${i + 1}/${lines.length})`)
              try {
                const headers = buildAdminHeaders('POST', '/social/twitter/pool-add')
                const res = await fetch(ao.api + '/social/twitter/pool-add', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...headers },
                  body: JSON.stringify({
                    credentials_line: credsLine,
                    country,
                    age_category: ageCategory,
                    sale_price_usdc: price,
                  }),
                })
                const data = await res.json() as any
                if (!res.ok || !data.success) {
                  results.push({ index: i, success: false, error: data.error || `HTTP ${res.status}`, username: credsLine.split(':')[0] })
                } else {
                  results.push({ index: i, success: true, id: data.id, username: credsLine.split(':')[0], cookies_captured: data.cookies_captured })
                }
              } catch (e: any) {
                results.push({ index: i, success: false, error: e.message, username: credsLine.split(':')[0] })
              }
            }
            if (spin) {
              const ok = results.filter(r => r.success).length
              spin.stop(`Seeded ${ok}/${lines.length} accounts`, ok === lines.length)
            }
            return print({
              total: lines.length,
              seeded: results.filter(r => r.success).length,
              failed: results.filter(r => !r.success).length,
              results,
            })
          }

          case 'pool-status': {
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const headers = buildAdminHeaders('GET', '/social/twitter/pool-status')
            const res = await fetch(ao.api + '/social/twitter/pool-status', { headers })
            const data = await res.json() as any
            if (!res.ok) err(`Pool status failed: ${data.error || `HTTP ${res.status}`}`, EXIT.GENERAL)
            return print(data)
          }

          case 'status': {
            err(
              `twitter status: not wired yet. Phase 3 will add it.`,
              EXIT.GENERAL
            )
          }

          default:
            err(`Unknown twitter command: ${subcommand}. Try: import, list, info, rename, remove, totp, login, session, post, reply, like, retweet, follow, unfollow, delete, list-tweets, bio, name, location, website, pfp, banner, username, buy`)
        }
        break
      }

      case 'tiktok': {
        const sv = await import('./social-vault.js')
        const platform = 'tiktok' as const

        if (!subcommand) {
          showMenu({
            command: 'tiktok',
            title: 'tiktok',
            subtitle: 'Automated TikTok account management',
            footerLeft: 'BYO: export sessionid from a logged-in TikTok browser, import, then post / follow / like.',
            commands: [
              { name: 'import',  description: 'Save a BYO TikTok account. Pass --credentials-line "login:pw:email:email_pw" from a marketplace, or extract cookies from DevTools → Application → Cookies → .tiktok.com and pass --sessionid.', hint: '--credentials-line "..." OR <username> --sessionid ... --csrf ... --webid ...' },
              { name: 'list',    description: 'List all local TikTok accounts' },
              { name: 'info',    description: 'Show one account', hint: '<username>' },
              { name: 'rename',  description: 'Update the local handle', hint: '<old> --to <new>' },
              { name: 'remove',  description: 'Delete an account from the local vault', hint: '<username> --confirm' },
              { name: 'totp',    description: 'Print the current TOTP code', hint: '<username>' },
              { name: 'login',   description: 'Validate cookies and cache the session', hint: '<username>' },
              { name: 'session', description: 'Check cached session status', hint: '<username>' },
              { name: 'post',    description: 'Post a video', hint: '<username> --file video.mp4 --caption "..."' },
              { name: 'follow',  description: 'Follow a TikTok user', hint: '<username> --user @handle' },
              { name: 'like',    description: 'Like a video', hint: '<username> --video https://...' },
              { name: 'delete',  description: 'Delete a video', hint: '<username> --video https://...' },
              { name: 'bio',     description: 'Update bio (<=80 chars)', hint: '<username> --text "..."' },
              { name: 'name',    description: 'Update display name (<=30 chars)', hint: '<username> --display "..."' },
              { name: 'pfp',     description: 'Update avatar', hint: '<username> --file pic.png' },
            ],
            fromHome,
          })
          return
        }

        switch (subcommand) {
          case 'import': {
            // Two formats:
            //   --credentials-line "login:password:email:email_password"  (from AccsMarket etc.)
            //   OR explicit flags --login / --password / --email / --sessionid / --csrf / --webid
            const line = flags['credentials-line'] as string
            let login: string | undefined
            let password: string | undefined
            let email: string | undefined
            let emailPassword: string | undefined
            let username = (flags.username as string) || positional[0]

            if (line) {
              const parts = line.split(':')
              if (parts.length < 4) err(`--credentials-line must have at least 4 colon-separated fields, got ${parts.length}`)
              login = parts[0]
              password = parts[1]
              email = parts[2]
              emailPassword = parts[3]
              if (!username) username = login
            } else {
              login = flags.login as string
              password = flags.password as string
              email = flags.email as string
              emailPassword = (flags['email-password'] as string) || (flags.emailpw as string)
            }

            const sessionid = flags.sessionid as string
            const csrf = (flags.csrf as string) || (flags['tt-csrf'] as string)
            const webid = (flags.webid as string) || (flags['tt-webid'] as string)
            const totpSeed = (flags['totp-seed'] as string) || (flags.totp as string)
            const profileUrl = flags['profile-url'] as string
            const country = (flags.country as string)?.toLowerCase()

            if (!username) err('<username> (or --username / --credentials-line) required')
            if (!password && !sessionid) {
              err('Provide either --sessionid <hex> for cookie-injection, or --password (via --credentials-line or --password flag) for password login.')
            }
            if (!country) {
              err('--country <iso-2> required (e.g. --country de). Drives proxy exit + browser locale; without it TikTok flags geography mismatch.')
            }

            // Pre-flight: check whether the email provider will actually work
            // with our (password-based) IMAP reader. Blocks unsupported
            // providers up front so you don't pay for marketplace accounts
            // that can't be automated.
            if (email && !sessionid && !flags['force-email']) {
              const emailDomain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
              const microsoftDomains = /^(hotmail|outlook|live|msn)\.com$/
              const gmailDomains = /^(gmail|googlemail)\.com$/
              const yahooDomains = /^(yahoo|ymail)\./
              const protonDomains = /^(proton|protonmail)\./

              if (microsoftDomains.test(emailDomain)) {
                err(
                  `This account's email is ${emailDomain}. Microsoft disabled password IMAP for consumer accounts in late 2022, and our OAuth2 integration isn't wired yet.\n\n` +
                  `  Recommendation: buy a TikTok account with a rambler.ru, mail.ru, or yandex.ru email — those work out of the box.\n` +
                  `  Override (not recommended): --force-email`,
                  EXIT.BAD_INPUT,
                )
              }
              if (gmailDomains.test(emailDomain)) {
                const looksLikeAppPassword = typeof emailPassword === 'string' && /^[a-z]{16}$/.test(emailPassword)
                if (!looksLikeAppPassword) {
                  err(
                    `This account's email is ${emailDomain}. Gmail needs a 16-char app-password (lowercase letters) for IMAP, not the regular account password.\n\n` +
                    `  Your email_password looks like a regular password. It will fail at IMAP auth.\n` +
                    `  Recommendation: buy accounts with rambler.ru or mail.ru email instead.\n` +
                    `  Override: --force-email`,
                    EXIT.BAD_INPUT,
                  )
                }
              }
              if (yahooDomains.test(emailDomain)) {
                err(
                  `This account's email is ${emailDomain}. Yahoo needs an app-password for IMAP and marketplace accounts rarely ship with one.\n\n` +
                  `  Recommendation: buy accounts with rambler.ru or mail.ru email instead.\n` +
                  `  Override: --force-email`,
                  EXIT.BAD_INPUT,
                )
              }
              if (protonDomains.test(emailDomain)) {
                err(
                  `This account's email is ${emailDomain}. ProtonMail IMAP requires a local Bridge app — not usable server-side.\n\n` +
                  `  Recommendation: buy accounts with rambler.ru or mail.ru email instead.`,
                  EXIT.BAD_INPUT,
                )
              }
            }

            const creds: import('./social-vault.js').SocialCredentials = {
              login: login || username,
              password: password || 'unknown',
              email: email || login,
              email_password: emailPassword,
              totp_seed: totpSeed,
              profile_url: profileUrl,
              tiktok_sessionid: sessionid,
              tiktok_csrf: csrf,
              tiktok_webid: webid,
            }
            const summary = sv.importAccount(platform, username, creds, {
              source: line ? 'marketplace-line' : 'import',
              country,
            })
            const loginPath = sessionid ? 'cookie-injection' : 'form-login (requires CAPSOLVER_API_KEY server-side)'
            log(`tiktok import: ${summary.username} (${summary.id}) [login: ${loginPath}, country: ${country}]`)
            return print({ ...summary, has_sessionid: !!sessionid, has_password: !!password, login_path: loginPath })
          }

          case 'list': {
            const accounts = sv.listAccounts(platform)
            return print({ accounts, count: accounts.length })
          }

          case 'info': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`tiktok account "${username}" not found locally`, EXIT.NOT_FOUND)
            return print(acc!)
          }

          case 'rename': {
            const oldUsername = positional[0] || (flags.username as string)
            const newUsername = flags.to as string
            if (!oldUsername) err('<old-username> required')
            if (!newUsername) err('--to <new-username> required')
            const summary = sv.renameAccount(platform, oldUsername, newUsername)
            log(`tiktok rename: ${oldUsername} → ${newUsername}`)
            return print(summary)
          }

          case 'remove': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            if (!flags.confirm) {
              err(
                `This deletes the local copy of "${username}". The TikTok account itself is NOT deleted.\n\n` +
                `  Re-run with --confirm to proceed:\n` +
                `  agentos tiktok remove ${username} --confirm`
              )
            }
            sv.removeAccount(platform, username)
            log(`tiktok remove: ${username}`)
            return print({ success: true, platform, username })
          }

          case 'totp': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const creds = sv.unlockCredentials(platform, username)
            if (!creds.totp_seed) err(`tiktok account "${username}" has no TOTP seed configured`, EXIT.NOT_FOUND)
            const { code, secondsUntilNextCode } = await import('./totp.js')
            return print({
              platform,
              username,
              code: code(creds.totp_seed!),
              expires_in_seconds: secondsUntilNextCode(),
            })
          }

          case 'login': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`tiktok account "${username}" not found locally`, EXIT.NOT_FOUND)

            const creds = sv.unlockCredentials(platform, username)
            const hasCookies = !!creds.tiktok_sessionid
            const hasPassword = !!(creds.login && creds.password && creds.password !== 'unknown')
            if (!hasCookies && !hasPassword) {
              err('Account has no cookies and no password. Re-import with either --sessionid or --credentials-line.', EXIT.BAD_INPUT)
            }
            const psid = sv.getProxySessionId(platform, username)
            const country = sv.getCountry(platform, username)

            let data: any
            try {
              data = await ao.socialTiktokLogin(acc!.id, {
                sessionid: creds.tiktok_sessionid,
                ttCsrfToken: creds.tiktok_csrf,
                ttWebidV2: creds.tiktok_webid,
                login: hasCookies ? undefined : creds.login,
                password: hasCookies ? undefined : creds.password,
                // Email creds enable server-side auto-solve of TikTok's
                // "Verify it's really you" device-verification challenge.
                email: creds.email,
                emailPassword: creds.email_password,
                proxySessionId: psid,
                country,
              })
            } catch (e: any) {
              err(`Login failed: ${e.message}`, EXIT.GENERAL)
            }

            if (!data?.success) {
              err(
                `Login failed: ${data?.error || 'unknown error'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }

            sv.saveSession(acc!.id, platform, data.cookies || [])
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })

            return print({
              success: true,
              platform,
              username,
              observed_username: data.observed_username,
              cookies_captured: (data.cookies || []).length,
              captured_at: data.captured_at,
            })
          }

          case 'session': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`tiktok account "${username}" not found locally`, EXIT.NOT_FOUND)
            const sess = sv.loadSession(acc!.id)
            if (!sess) {
              return print({
                platform,
                username,
                cached: false,
                hint: `No cached session. Run: agentos tiktok login ${username}`,
              })
            }
            const ageHours = sv.sessionAgeHours(acc!.id)
            return print({
              platform,
              username,
              cached: true,
              cookies: sess.cookies.length,
              captured_at: sess.captured_at,
              age_hours: Number((ageHours || 0).toFixed(2)),
              stale: (ageHours || 0) > 12,
            })
          }

          case 'post':
          case 'follow':
          case 'like':
          case 'delete':
          case 'bio':
          case 'name':
          case 'pfp': {
            const username = positional[0] || (flags.username as string)
            if (!username) err(`<username> required`)
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`tiktok account "${username}" not found locally`, EXIT.NOT_FOUND)
            const sess = sv.loadSession(acc!.id)
            if (!sess || !sess.cookies || sess.cookies.length === 0) {
              err(`No cached session for ${username}. Run 'tiktok login ${username}' first.`, EXIT.NOT_FOUND)
            }
            const psid = sv.getProxySessionId(platform, username)
            const country = sv.getCountry(platform, username)

            let data: any
            try {
              if (subcommand === 'post') {
                const caption = (flags.caption as string) || (flags.body as string) || (flags.text as string)
                if (!caption) err('--caption "..." required')
                const filePath = (flags.file as string) || (flags.path as string)
                const videoUrl = flags.url as string
                if (!filePath && !videoUrl) err('--file <local-path> or --url <https-url> required')
                let media: { video_base64?: string; video_url?: string } = {}
                if (filePath) {
                  const { readFileSync, existsSync, statSync } = await import('fs')
                  if (!existsSync(filePath)) err(`File not found: ${filePath}`, EXIT.NOT_FOUND)
                  const size = statSync(filePath).size
                  if (size > 100 * 1024 * 1024) err(`Video too large (${size} bytes, max 100 MB)`, EXIT.BAD_INPUT)
                  const buf = readFileSync(filePath)
                  media.video_base64 = `data:video/mp4;base64,${buf.toString('base64')}`
                } else {
                  media.video_url = videoUrl
                }
                const privacy = flags.privacy !== undefined ? Number(flags.privacy) as 0 | 1 | 2 : undefined
                data = await ao.socialTiktokPost(acc!.id, sess!.cookies, caption, media, { privacy }, psid, country)
              } else if (subcommand === 'follow') {
                const target = (flags.user as string) || (flags.target as string)
                if (!target) err('--user <@handle> required')
                data = await ao.socialTiktokFollow(acc!.id, sess!.cookies, target, psid, country)
              } else if (subcommand === 'like') {
                const videoUrl = (flags.video as string) || (flags.url as string)
                if (!videoUrl) err('--video <tiktok-url> required')
                data = await ao.socialTiktokLike(acc!.id, sess!.cookies, videoUrl, psid, country)
              } else if (subcommand === 'delete') {
                const videoUrl = (flags.video as string) || (flags.url as string)
                if (!videoUrl) err('--video <tiktok-url> required')
                data = await ao.socialTiktokDelete(acc!.id, sess!.cookies, videoUrl, psid, country)
              } else if (subcommand === 'bio') {
                const text = (flags.text as string) || (flags.body as string)
                if (text === undefined) err('--text "..." required (pass "" to clear)')
                data = await ao.socialTiktokProfile(acc!.id, sess!.cookies, { bio: text }, psid, country)
              } else if (subcommand === 'name') {
                const text = (flags.display as string) || (flags.text as string) || (flags.name as string)
                if (!text) err('--display "Display Name" required')
                data = await ao.socialTiktokProfile(acc!.id, sess!.cookies, { display_name: text }, psid, country)
              } else {
                // pfp
                const filePath = (flags.file as string) || (flags.path as string)
                const imageUrl = flags.url as string
                if (!filePath && !imageUrl) err('--file <local-path> or --url <https-url> required')
                let image: { image_base64?: string; image_url?: string } = {}
                if (filePath) {
                  const { readFileSync, existsSync } = await import('fs')
                  if (!existsSync(filePath)) err(`File not found: ${filePath}`, EXIT.NOT_FOUND)
                  const buf = readFileSync(filePath)
                  const ext = filePath.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/)?.[1] || 'png'
                  image.image_base64 = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`
                } else {
                  image.image_url = imageUrl
                }
                data = await ao.socialTiktokAvatar(acc!.id, sess!.cookies, image, psid, country)
              }
            } catch (e: any) {
              err(`${subcommand} failed: ${e.message}`, EXIT.GENERAL)
            }

            if (!data?.success) {
              err(
                `${subcommand} failed: ${data?.error || 'unknown'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }

            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })
            return print({ success: true, platform, username, op: subcommand, ...(data?.data || {}) })
          }

          default:
            err(`Unknown tiktok command: ${subcommand}. Try: import, list, info, rename, remove, totp, login, session, post, follow, like, delete, bio, name, pfp`)
        }
        break
      }

      case 'worker': {
        // Long-running consumer of cli/social-queue.ts. Polls every --interval
        // seconds (default 60), claims due scheduled items, dispatches via the
        // existing paid X routes through the SDK. Stops on SIGINT/SIGTERM.
        // --once runs a single tick and exits — useful for cron-style invocation.
        const worker = await import('./social-worker.js')
        const intervalSec = flags.interval !== undefined
          ? Math.max(10, Math.floor(Number(flags.interval) || 60))
          : 60
        const accountFilter = (flags.account as string) || undefined

        if (flags.once === true) {
          const summary = await worker.runWorkerOnce(ao, accountFilter)
          return print(summary)
        }

        await worker.runWorkerLoop(ao, {
          intervalSec,
          accountFilter,
          onLog: (msg) => {
            if (AGENT_MODE) {
              print({ event: 'worker_log', msg, ts: new Date().toISOString() })
            } else {
              const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
              process.stderr.write(`[${ts}] ${msg}\n`)
            }
          },
          onTick: AGENT_MODE
            ? (summary) => { if (summary.processed > 0) print({ event: 'worker_tick', ...summary }) }
            : undefined,
        })
        break
      }

      case 'config': {
        const cfg = loadConfig()
        const { homedir } = await import('os')
        const { join } = await import('path')
        const vaultDir = process.env.AGENTOS_WALLET_PATH || join(homedir(), '.agentos', 'wallet')
        const { isCredentialStoreAvailable } = await import('./credential-store.js')

        const configData = {
          api: cfg.api,
          defaultChain: cfg.defaultChain,
          setupDone: cfg.setupDone,
          defaultPayWalletId: (cfg as any).defaultPayWalletId || null,
          defaultPayChain: (cfg as any).defaultPayChain || 'solana',
          vaultPath: vaultDir,
          credentialStore: isCredentialStoreAvailable() ? 'available' : 'unavailable',
          configPath: join(homedir(), '.agentos', 'config.json'),
          cliVersion: VERSION,
        }

        if (!AGENT_MODE) {
          render(React.createElement(ConfigScreen, { version: VERSION, config: configData }))
        } else {
          print(configData)
        }
        break
      }

      case 'doctor': {
        const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; detail: string }> = []
        const { homedir } = await import('os')
        const { join } = await import('path')
        const { existsSync } = await import('fs')

        // 1. Vault directory
        const vaultDir = process.env.AGENTOS_WALLET_PATH || join(homedir(), '.agentos', 'wallet')
        const vaultExists = existsSync(join(vaultDir, 'wallets'))
        checks.push({ name: 'Vault directory', status: vaultExists ? 'pass' : 'fail', detail: vaultExists ? vaultDir : 'Not found — run: agentos wallet create' })

        // 2. Credential store
        const { isCredentialStoreAvailable } = await import('./credential-store.js')
        const credAvail = isCredentialStoreAvailable()
        checks.push({ name: 'OS credential store', status: credAvail ? 'pass' : 'fail', detail: credAvail ? `${process.platform} store available` : 'Not available — wallet keys cannot be stored securely' })

        // 3. Local wallets
        const { listVaultWallets } = await import('./vault.js')
        const wallets = listVaultWallets()
        checks.push({ name: 'Local wallets', status: wallets.length > 0 ? 'pass' : 'warn', detail: `${wallets.length} wallet(s) found` })

        // 4. Session secrets present for wallets
        const { retrieveSecret } = await import('./credential-store.js')
        let secretsOk = 0, secretsMissing = 0
        for (const w of wallets) {
          if (retrieveSecret(w.id)) secretsOk++
          else secretsMissing++
        }
        if (wallets.length > 0) {
          checks.push({
            name: 'Session secrets',
            status: secretsMissing === 0 ? 'pass' : 'fail',
            detail: secretsMissing === 0 ? `All ${secretsOk} wallet(s) have secrets stored` : `${secretsMissing} wallet(s) missing session secret`,
          })
        }

        // 5. API connectivity
        try {
          const health = await ao.health()
          checks.push({ name: 'API connectivity', status: health.status === 'healthy' ? 'pass' : 'warn', detail: `${ao.api} — ${health.status}` })
          if (health.version?.version && health.version.version !== VERSION) {
            checks.push({ name: 'Version match', status: 'warn', detail: `CLI ${VERSION} vs server ${health.version.version}` })
          } else {
            checks.push({ name: 'Version match', status: 'pass', detail: `CLI ${VERSION}` })
          }
        } catch {
          checks.push({ name: 'API connectivity', status: 'warn', detail: `${ao.api} — unreachable (local-only mode works fine)` })
        }

        const failCount = checks.filter(c => c.status === 'fail').length
        if (!AGENT_MODE) {
          render(React.createElement(DoctorScreen, { version: VERSION, checks }))
        } else {
          print({ checks })
        }
        if (failCount > 0) process.exit(EXIT.GENERAL)
        break
      }

      case 'pricing': {
        const data = await ao.pricing()
        return print(data)
        const services = Object.entries(data.services || {}).map(([name, prices]) => ({
          name,
          items: typeof prices === 'object'
            ? Object.entries(prices as Record<string, string>).map(([label, value]) => ({ label, value: String(value) }))
            : [],
        }))
        render(React.createElement(PricingScreen, {
          version: VERSION,
          services,
          interactive: fromHome,
          onBack: fromHome ? () => {
            process.env.AGENTOS_FROM_HOME = '0'
            process.argv = [process.argv[0], process.argv[1]]
            void main()
          } : undefined,
        }))
        break
      }

      case 'health': {
        const data = await ao.health()
        return print(data)

        // Version check — warn if CLI is behind the server
        const serverVersion = data.version?.version
        if (serverVersion && serverVersion !== VERSION) {
          console.log(`  ${t.warn}Update available:${t.reset} CLI ${VERSION} → server ${serverVersion}`)
          console.log(`  ${t.muted}Run: npm install -g @agntos/agentos${t.reset}\n`)
        }

        render(React.createElement(HealthScreen, {
          version: VERSION,
          status: data.status || 'unknown',
          uptime: data.uptime?.human || '?',
          apiVersion: serverVersion || '?',
          interactive: fromHome,
          onBack: fromHome ? () => {
            process.env.AGENTOS_FROM_HOME = '0'
            process.argv = [process.argv[0], process.argv[1]]
            void main()
          } : undefined,
        }))
        break
      }

      default:
        if (AGENT_MODE) {
          process.stderr.write(JSON.stringify({
            error: `Unknown command: ${command}`,
            hint: 'Run agentos --help for usage',
            exitCode: EXIT.BAD_INPUT,
          }) + '\n')
        } else {
          render(React.createElement(ErrorScreen, {
            version: VERSION,
            title: 'Unknown command',
            message: `Unknown command: ${command}`,
            hint: 'Run agentos --help for usage',
            footerLeft: 'Command not found',
          }))
        }
        process.exit(EXIT.BAD_INPUT)
    }
  } catch (e: any) {
    // Sanitize error output — never expose stack traces or internal paths.
    // The same sanitized message goes to both the Ink ErrorScreen and the
    // JSON-mode stderr line, so behaviour matches across modes.
    const rawMsg: string = e.message || String(e)
    const safeMsg = rawMsg
      .replace(/\s*at\s+.+/g, '')              // strip stack frames
      .replace(/[A-Z]:\\[^\s:]+/gi, '[path]')  // strip Windows paths
      .replace(/\/[^\s:]+\.(ts|js)/g, '[path]') // strip Unix paths
      .trim()

    // Map the raw error to a stable exit code + a one-line agent-friendly hint.
    let exitCode: number = EXIT.GENERAL
    let title = 'Command failed'
    let hint: string | undefined
    let footerLeft = 'See agentos --help'

    if (rawMsg.startsWith('Payment Required:') || rawMsg.includes('settlement failed') || rawMsg.includes('verification failed')) {
      exitCode = EXIT.PAYMENT
      title = 'Payment rejected'
      hint = rawMsg.includes('settlement failed')
        ? 'On-chain tx reverted. Check wallet balance (USDC only — chain fees are paid by the server). View tx on explorer if settled partially.'
        : 'The server rejected the payment signature. Check your default pay wallet: agentos config'
      footerLeft = 'x402 payment failed'
    } else if (rawMsg === 'Payment Required' || rawMsg.includes('402')) {
      exitCode = EXIT.PAYMENT
      title = 'Payment required'
      hint = 'Set a default pay wallet: agentos wallet use <ID>'
      footerLeft = 'Provisioning blocked until payment'
    } else if (rawMsg.includes('SECURITY')) {
      exitCode = EXIT.SECURITY
      title = 'Security violation'
      hint = 'A wallet file may have been tampered with. Do not use it.'
      footerLeft = 'Operation blocked'
    } else if (rawMsg.includes('ECONNREFUSED') || rawMsg.includes('fetch failed')) {
      exitCode = EXIT.NETWORK
      hint = 'Is the API running? Check: agentos health'
    } else if (rawMsg.includes('Authentication') || rawMsg.includes('401') || rawMsg.includes('Unauthorized')) {
      exitCode = EXIT.AUTH_FAIL
      hint = 'Check your API token or session'
    } else if (rawMsg.includes('session secret') || rawMsg.includes('credential store')) {
      exitCode = EXIT.NOT_FOUND
      hint = 'Create a wallet first: agentos wallet create'
    } else if (rawMsg.includes('not found')) {
      exitCode = EXIT.NOT_FOUND
      const scope = rawMsg.includes('twitter account') ? 'twitter'
                  : rawMsg.includes('tiktok account') ? 'tiktok'
                  : 'wallet'
      hint = `Check the name with: agentos ${scope} list`
    }

    if (AGENT_MODE) {
      const payload: Record<string, any> = {
        error: safeMsg || 'An unexpected error occurred',
        exitCode,
      }
      if (hint) payload.hint = hint
      process.stderr.write(JSON.stringify(payload) + '\n')
    } else {
      render(React.createElement(ErrorScreen, {
        version: VERSION,
        title,
        message: safeMsg || 'An unexpected error occurred',
        hint,
        footerLeft,
      }))
    }
    process.exit(exitCode)
  }

}

main()
