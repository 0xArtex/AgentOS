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
const BOOLEAN_FLAGS = new Set(['help', 'version', 'managed', 'quiet', 'confirm', 'json', 'no-color'])

function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  let command = ''
  let subcommand = ''

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
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
              { name: 'plans', description: 'List VPS plans' },
              { name: 'deploy', description: 'Deploy a VPS', hint: '--name my-vps --type cx23' },
              { name: 'list', description: 'List servers' },
              { name: 'delete', description: 'Delete a server', hint: '--id SERVER_ID' },
            ],
            fromHome,
          })
          break
        }
        switch (subcommand) {
          case 'plans': {
            const data = await ao.computePlans()
            return print(data)
            const plans = (data.plans || data || []).map((p: any) => ({
              name: String(p.type || p.id || p.name || 'unknown'),
              cpu: `${p.vcpu || p.cpu || p.vcpus || '?'} vCPU`,
              ram: `${p.ramGb || p.ram || p.memory || '?'}GB RAM`,
              price: String(p.priceUsdcMonthly || p.priceUsdc || p.price || p.monthly_cost || '?'),
            }))
            render(React.createElement(ComputePlansScreen, {
              version: VERSION,
              plans,
              interactive: fromHome,
              onBack: fromHome ? () => {
                process.env.AGENTOS_FROM_HOME = '0'
                process.argv = [process.argv[0], process.argv[1]]
                void main()
              } : undefined,
            }))
            break
          }
          case 'deploy': {
            const name = flags.name as string || 'agent-' + Date.now()
            const type = flags.type as string || 'cx23'
            const spin = new Spinner()
            spin.start('Deploying VPS...')
            const data = await ao.computeDeploy(name, type)
            spin.stop('VPS deployed', true)
            return print(data)
            const ip = data.ipv4 || data.ip || 'deploying...'
            render(React.createElement(ComputeDeployScreen, {
              version: VERSION,
              ip,
              id: data.id || '',
              type,
              name,
            }))
            addServer({ id: data.id, ip, type, name, createdAt: new Date().toISOString() })
            log(`compute deploy: ${ip} (${type})`)
            break
          }
          case 'list': {
            const data = await ao.computeList()
            return print(data)
            const servers = (data.servers || []).map((s: any) => ({
              ip: String(s.ipv4 || s.ip || 'unknown'),
              type: String(s.serverType || s.type || 'unknown'),
              status: String(s.status || 'unknown'),
            }))
            render(React.createElement(ComputeListScreen, { version: VERSION, servers }))
            break
          }
          case 'delete': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id SERVER_ID required')
            const data = await ao.computeDelete(id)
            return print(data)
            render(React.createElement(SuccessScreen, { version: VERSION, title: 'server deleted', subtitle: id, details: [{ label: 'ID', value: id }], footerLeft: 'Server removed' }))
            break
          }
          default: err(`Unknown compute command: ${subcommand}. Try: plans, deploy, list, delete`)
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
                data = await ao.socialTwitterPost(acc!.id, sess!.cookies, text, psid)
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
