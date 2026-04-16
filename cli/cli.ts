#!/usr/bin/env node

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
import { theme as t, icon, Spinner, header, row, ok, fail, warn, info, subtle, divider, blank, table, box, initReport, banner, kv, section, listItem, statusLine, welcomeScreen, statusBar, panel } from './ui.js'
import { existsSync } from 'fs'
import { homedir } from 'os'

// Alias for backwards compat in help text
const c = { ...t, cyan: t.info, green: t.success, red: t.error, yellow: t.warn, white: t.text, gray: t.muted, orange: t.accent }

const VERSION = '0.5.2'

// ─── Exit codes ───
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

function render(node: React.ReactElement) {
  return inkRender(node)
}

// ─── Parse args ───
// Boolean flags that never take a value (prevents flag <next> from eating the next positional)
const BOOLEAN_FLAGS = new Set(['help', 'version', 'managed', 'quiet', 'confirm'])

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

// Global JSON mode — set early in main() based on TTY + flags.
// When true, errors emit as JSON to stderr instead of Ink render.
let JSON_MODE = false

function err(msg: string, code: number = EXIT.BAD_INPUT): never {
  if (JSON_MODE) {
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
function print(obj: any) {
  const json = JSON.stringify(obj, null, 2)
  // Color only when output is a TTY. When piped/captured by an agent, emit parseable JSON.
  if (process.stdout.isTTY) {
    const colored = json
      .replace(/"([^"]+)":/g, `${t.info}"$1"${t.reset}:`)
      .replace(/: "([^"]+)"/g, `: ${t.success}"$1"${t.reset}`)
      .replace(/: (\d+)/g, `: ${t.warn}$1${t.reset}`)
      .replace(/: (true|false)/g, `: ${t.accent}$1${t.reset}`)
      .replace(/: (null)/g, `: ${t.muted}$1${t.reset}`)
    console.log(colored)
  } else {
    console.log(json)
  }
}

// ─── Help ───
function help() {
  render(React.createElement(MenuScreen, {
    version: VERSION,
    title: 'help',
    subtitle: 'Command surface',
    footerLeft: 'Structured JSON output for all commands',
    commands: [
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
    ],
  }))
}

// ─── Commands ───
async function main() {
  const { command, subcommand, positional, flags } = parse(process.argv)
  const fromHome = process.env.AGENTOS_FROM_HOME === '1'

  if (flags.version) { console.log(VERSION); return }
  if (flags.help && !command) { help(); return }

  // No command — show welcome dashboard
  if (!command) {
    const cfg = loadConfig()
    let apiOk = false
    try { const h = await new AgentOS(cfg.api).health(); apiOk = h.status === 'healthy' } catch {}
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
  const url = flags.url as string || config.api
  const token = (flags.token as string) || config.apiKey || process.env.AGENTOS_TOKEN || process.env.AGENTOS_API_KEY
  const passphrase = (flags.passphrase as string) || process.env.AGENTOS_WALLET_PASSPHRASE
  const ao = new AgentOS(url, true, token, passphrase)
  // All data commands emit JSON. One format, agent-first.
  // Interactive screens (Dashboard, help menus, setup wizards) use Ink rendering.
  JSON_MODE = true

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
          render(React.createElement(ErrorScreen, {
            version: VERSION,
            title: 'No keyfile',
            message: 'No keyfile found.',
            hint: 'agentos setup --keyfile /path/to/keypair.json --chain solana',
            footerLeft: 'Provide a keyfile to continue',
          }))
          process.exit(1)
        }

        if (!existsSync(keyfile.replace('~', homedir()))) {
          err(`Keyfile not found: ${keyfile}`)
        }

        const { addWalletToConfig, getConfiguredChains } = await import('./config.js')
        addWalletToConfig(chain, keyfile)
        const chains = getConfiguredChains()

        render(React.createElement(SetupScreen, {
          version: VERSION,
          api: url,
          keyfile,
          chains,
          addedChain: chain,
        }))
        log(`setup: keyfile=${keyfile} chain=${chain}`)
        break
      }

      case 'status': {
        const wallets = config.wallets || {}
        let apiOk = false
        try { const h = await ao.health(); apiOk = h.status === 'healthy' } catch {}

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
        break
      }

      case 'note': {
        const text = positional.join(' ') || subcommand || ''
        if (!text) err('Usage: agentos note "your note here"')
        addNote(text)
        render(React.createElement(SuccessScreen, { version: VERSION, title: 'note saved', subtitle: text, details: [{ label: 'Path', value: '~/.agentos/memory/notes.md' }], footerLeft: 'Note saved' }))
        break
      }

      case 'phone': {
        if (!subcommand || flags.help) {
          render(React.createElement(MenuScreen, {
            version: VERSION,
            title: 'phone',
            subtitle: 'Voice and messaging',
            footerLeft: 'Phone operations',
            commands: [
              { name: 'search', description: 'Search available numbers', hint: '--country US' },
              { name: 'buy', description: 'Buy a phone number', hint: '--country US' },
              { name: 'sms', description: 'Send an SMS', hint: '--id ID --to +1... --body "hi"' },
              { name: 'call', description: 'Place a voice call', hint: '--id ID --to +1... --tts "hello"' },
            ],
            interactive: fromHome,
            onBack: fromHome ? () => {
              process.env.AGENTOS_FROM_HOME = '0'
              process.argv = [process.argv[0], process.argv[1]]
              void main()
            } : undefined,
          }))
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
          render(React.createElement(MenuScreen, {
            version: VERSION,
            title: 'email',
            subtitle: 'Inbox operations',
            footerLeft: 'Email operations',
            commands: [
              { name: 'create', description: 'Create an inbox', hint: '--name agent --wallet SOL_PUB' },
              { name: 'read', description: 'Read inbox messages', hint: '--id INBOX_ID' },
              { name: 'send', description: 'Send an email', hint: '--id ID --to x@y.com --subject ... --body ...' },
              { name: 'threads', description: 'List threads', hint: '--id INBOX_ID' },
            ],
          }))
          break
        }
        switch (subcommand) {
          case 'create': {
            const name = flags.name as string; const wallet = flags.wallet as string
            if (!name || !wallet) err('--name, --wallet required')
            const spin = new Spinner()
            spin.start('Creating inbox...')
            const data = await ao.emailCreate(name, wallet)
            spin.stop('Inbox created', true)
            return print(data)
            const address = data.address || `${name}@agntos.dev`
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Inbox created',
              subtitle: address,
              footerLeft: 'Inbox ready',
              details: [
                { label: 'ID', value: String(data.id || '') },
                { label: 'E2E', value: data.e2eEnabled ? 'enabled' : 'disabled' },
              ],
            }))
            addInbox({ id: data.id, address, createdAt: new Date().toISOString() })
            log(`email create: ${data.address || name}`)
            break
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
          render(React.createElement(MenuScreen, {
            version: VERSION,
            title: 'compute',
            subtitle: 'Server operations',
            footerLeft: 'Compute operations',
            commands: [
              { name: 'plans', description: 'List VPS plans' },
              { name: 'deploy', description: 'Deploy a VPS', hint: '--name my-vps --type cx23' },
              { name: 'list', description: 'List servers' },
              { name: 'delete', description: 'Delete a server', hint: '--id SERVER_ID' },
            ],
            interactive: fromHome,
            onBack: fromHome ? () => {
              process.env.AGENTOS_FROM_HOME = '0'
              process.argv = [process.argv[0], process.argv[1]]
              void main()
            } : undefined,
          }))
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
          render(React.createElement(MenuScreen, {
            version: VERSION,
            title: 'domain',
            subtitle: 'Naming and DNS',
            footerLeft: 'Domain operations',
            commands: [
              { name: 'check', description: 'Check availability', hint: '--name example.dev' },
              { name: 'pricing', description: 'Get TLD pricing', hint: '--name example' },
              { name: 'buy', description: 'Register a domain', hint: '--name example.dev' },
              { name: 'dns', description: 'Get DNS records', hint: '--name example.dev' },
            ],
            interactive: fromHome,
            onBack: fromHome ? () => {
              process.env.AGENTOS_FROM_HOME = '0'
              process.argv = [process.argv[0], process.argv[1]]
              void main()
            } : undefined,
          }))
          break
        }
        switch (subcommand) {
          case 'check': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.com required')
            const data = await ao.domainCheck(name)
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
          default: err(`Unknown domain command: ${subcommand}. Try: check, pricing, buy, dns`)
        }
        break
      }

      case 'wallet': {
        if (!subcommand || (flags.help && !WALLET_HELP[subcommand])) {
          render(React.createElement(MenuScreen, {
            version: VERSION,
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
          }))
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
            if (process.stdout.isTTY) {
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

            if (process.stdout.isTTY) {
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
            if (process.stdout.isTTY) {
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
            if (process.stdout.isTTY) {
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
            const data = await ao.walletAddresses(walletId)
            return print(data)
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Wallet addresses',
              subtitle: walletId,
              footerLeft: `${(data.addresses || []).length} chains`,
              details: (data.addresses || []).map((a: any) => ({
                label: a.chainId,
                value: a.address,
              })),
            }))
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
            if (process.stdout.isTTY) {
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

      case 'twitter': {
        const sv = await import('./social-vault.js')
        const platform = 'twitter' as const

        if (!subcommand) {
          render(React.createElement(MenuScreen, {
            version: VERSION,
            title: 'twitter',
            subtitle: 'Automated X account management',
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
            footerLeft: 'Phase 1: local vault + BYO import works today. Server-dependent commands stub out.',
          }))
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
            log(`twitter login: ${username} → ${cookiePath ? 'cookie injection path' : 'form login path'} via residential proxy`)

            let data: any
            try {
              // Uses the SDK so x402 payment is auto-signed from the configured wallet
              data = await ao.socialTwitterLogin(
                acc!.id,
                creds.login!,
                creds.password,
                creds.totp_seed,
                cookiePath ? { auth_token: creds.auth_token, ct0: creds.ct0 } : undefined
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

          case 'buy':
          case 'post':
          case 'status': {
            err(
              `twitter ${subcommand}: not wired yet. ` +
              `Phase 2 currently supports: login, session. Phase 3 will add buy/post/status.`,
              EXIT.GENERAL
            )
          }

          default:
            err(`Unknown twitter command: ${subcommand}. Try: import, list, info, rename, remove, totp, login, session`)
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

        if (process.stdout.isTTY) {
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
        if (process.stdout.isTTY) {
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
        render(React.createElement(ErrorScreen, {
          version: VERSION,
          title: 'Unknown command',
          message: `Unknown command: ${command}`,
          hint: 'Run agentos --help for usage',
          footerLeft: 'Command not found',
        }))
        process.exit(1)
    }
  } catch (e: any) {
    // Sanitize error output — never expose stack traces or internal paths
    const rawMsg: string = e.message || String(e)
    // Strip file paths, stack frames, and Node internals
    const safeMsg = rawMsg
      .replace(/\s*at\s+.+/g, '')              // strip stack frames
      .replace(/[A-Z]:\\[^\s:]+/gi, '[path]')  // strip Windows paths
      .replace(/\/[^\s:]+\.(ts|js)/g, '[path]') // strip Unix paths
      .trim()

    let exitCode: number = EXIT.GENERAL
    // Show real server error on 402, not generic "Payment required" boilerplate
    if (rawMsg.startsWith('Payment Required:') || rawMsg.includes('settlement failed') || rawMsg.includes('verification failed')) {
      render(React.createElement(ErrorScreen, {
        version: VERSION,
        title: 'Payment rejected',
        message: safeMsg,
        hint: rawMsg.includes('settlement failed')
          ? 'On-chain tx reverted. Check wallet balance (USDC only — chain fees are paid by the server). View tx on explorer if settled partially.'
          : 'The server rejected the payment signature. Check your default pay wallet: agentos config',
        footerLeft: 'x402 payment failed',
      }))
      exitCode = EXIT.PAYMENT
    } else if (rawMsg === 'Payment Required' || rawMsg.includes('402')) {
      render(React.createElement(ErrorScreen, {
        version: VERSION,
        title: 'Payment required',
        message: 'This endpoint costs USDC via x402.',
        hint: 'Set a default pay wallet: agentos wallet use <ID>',
        footerLeft: 'Provisioning blocked until payment',
      }))
      exitCode = EXIT.PAYMENT
    } else if (rawMsg.includes('SECURITY')) {
      render(React.createElement(ErrorScreen, {
        version: VERSION,
        title: 'Security violation',
        message: safeMsg,
        hint: 'A wallet file may have been tampered with. Do not use it.',
        footerLeft: 'Operation blocked',
      }))
      exitCode = EXIT.SECURITY
    } else {
      let hint: string | undefined
      if (rawMsg.includes('ECONNREFUSED') || rawMsg.includes('fetch failed')) {
        hint = 'Is the API running? Check: agentos health'
        exitCode = EXIT.NETWORK
      } else if (rawMsg.includes('Authentication') || rawMsg.includes('401') || rawMsg.includes('Unauthorized')) {
        hint = 'Check your API token or session'
        exitCode = EXIT.AUTH_FAIL
      } else if (rawMsg.includes('session secret') || rawMsg.includes('credential store')) {
        hint = 'Create a wallet first: agentos wallet create'
        exitCode = EXIT.NOT_FOUND
      } else if (rawMsg.includes('not found')) {
        const scope = rawMsg.includes('twitter account') ? 'twitter'
                    : rawMsg.includes('tiktok account') ? 'tiktok'
                    : 'wallet'
        hint = `Check the name with: agentos ${scope} list`
        exitCode = EXIT.NOT_FOUND
      }
      render(React.createElement(ErrorScreen, {
        version: VERSION,
        title: 'Command failed',
        message: safeMsg || 'An unexpected error occurred',
        hint,
        footerLeft: 'See agentos --help',
      }))
    }
    process.exit(exitCode)
  }

}

main()
