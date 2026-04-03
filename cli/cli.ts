#!/usr/bin/env node

import React from 'react'
import { render } from 'ink'
import { ComputeDeployScreen, ComputeListScreen, ComputePlansScreen, Dashboard, DomainCheckScreen, DomainPricingScreen, ErrorScreen, HealthScreen, MenuScreen, PricingScreen, RecordsScreen, SetupScreen, StatusScreen, SuccessScreen, WalletCreateScreen, WalletStatusScreen } from './app.js'
import { AgentOS } from './sdk.js'
import { loadConfig, saveConfig, ensureDirs, getKeyfile, log, addPhone, addInbox, addServer, addDomain, addWallet, addNote } from './config.js'
import { theme as t, icon, Spinner, header, row, ok, fail, warn, info, subtle, divider, blank, table, box, initReport, banner, kv, section, listItem, statusLine, welcomeScreen, statusBar, panel } from './ui.js'
import { existsSync } from 'fs'
import { homedir } from 'os'

// Alias for backwards compat in help text
const c = { ...t, cyan: t.info, green: t.success, red: t.error, yellow: t.warn, white: t.text, gray: t.muted, orange: t.accent }

const VERSION = '0.4.0'

// ─── Parse args ───
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
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) { flags[key] = next; i++ }
      else flags[key] = true
    } else positional.push(arg)
  }
  return { command, subcommand, positional, flags }
}

function err(msg: string) {
  render(React.createElement(ErrorScreen, {
    version: VERSION,
    title: 'Command error',
    message: msg,
    footerLeft: 'Fix the command and retry',
  }))
  process.exit(1)
}
function print(obj: any) {
  const json = JSON.stringify(obj, null, 2)
  // Syntax highlight JSON
  const colored = json
    .replace(/"([^"]+)":/g, `${t.info}"$1"${t.reset}:`)
    .replace(/: "([^"]+)"/g, `: ${t.success}"$1"${t.reset}`)
    .replace(/: (\d+)/g, `: ${t.warn}$1${t.reset}`)
    .replace(/: (true|false)/g, `: ${t.accent}$1${t.reset}`)
    .replace(/: (null)/g, `: ${t.muted}$1${t.reset}`)
  console.log(colored)
}

// ─── Help ───
function help() {
  render(React.createElement(MenuScreen, {
    version: VERSION,
    title: 'help',
    subtitle: 'Command surface',
    footerLeft: 'Use --json for raw output',
    commands: [
      { name: 'phone', description: 'search · buy · sms · call' },
      { name: 'email', description: 'create · read · send · threads' },
      { name: 'compute', description: 'plans · deploy · list · delete' },
      { name: 'domain', description: 'check · pricing · buy · dns' },
      { name: 'wallet', description: 'create · status · keygen' },
      { name: 'setup', description: 'Configure wallets + chain preference' },
      { name: 'status', description: 'Show config, wallets, and API health' },
      { name: 'pricing', description: 'All service prices' },
      { name: 'health', description: 'API status' },
    ],
  }))
}

// ─── Commands ───
async function main() {
  const { command, subcommand, positional, flags } = parse(process.argv)

  if (flags.version) { console.log(VERSION); return }
  if (flags.help) { help(); return }

  // No command — show welcome dashboard
  if (!command) {
    const cfg = loadConfig()
    let apiOk = false
    try { const h = await new AgentOS(cfg.api).health(); apiOk = h.status === 'healthy' } catch {}
    let selectedCommand: unknown = null
    const app = render(React.createElement(Dashboard, {
      version: VERSION,
      chain: cfg.defaultChain,
      wallets: cfg.wallets,
      apiOk,
      onSelectAction: (cmd: string) => {
        selectedCommand = cmd
        app.unmount()
      },
    }))
    await app.waitUntilExit()
    if (typeof selectedCommand === 'string') {
      const chosen = selectedCommand as string
      const next = chosen.trim().split(/\s+/)
      process.argv = [process.argv[0], process.argv[1], ...next.slice(1)]
      return main()
    }
    return
  }

  // Always ensure ~/.agentos/ exists on any command
  ensureDirs()

  const config = loadConfig()
  const startTime = Date.now()

  // First-time welcome
  if (!config.setupDone && command !== 'setup' && !['help','--help'].includes(command) && !flags.help && !flags.version) {
    banner()
    subtle('First time? Run:')
    console.log(`  ${t.info}agentos setup --keyfile ~/.config/solana/id.json --chain solana${t.reset}`)
    blank()
  }
  const url = flags.url as string || config.api
  const ao = new AgentOS(url)
  const json = !!flags.json

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
          console.log(`  ${c.yellow}No keyfile found.${c.reset}`)
          console.log(`  ${c.dim}Provide one with: agentos setup --keyfile /path/to/keypair.json --chain solana${c.reset}`)
          console.log(`  ${c.dim}Add both chains:  agentos setup --keyfile sol.json --chain solana${c.reset}`)
          console.log(`  ${c.dim}                  agentos setup --keyfile base.json --chain base${c.reset}`)
          console.log(`  ${c.dim}Or generate one:  agentos wallet keygen${c.reset}`)
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
        }))
        break
      }

      case 'note': {
        const text = positional.join(' ') || subcommand || ''
        if (!text) err('Usage: agentos note "your note here"')
        addNote(text)
        ok(`Note saved to ~/.agentos/memory/notes.md`)
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
          }))
          break
        }
        switch (subcommand) {
          case 'search': {
            const country = flags.country as string || 'US'
            const data = await ao.phoneSearch(country, flags.limit ? parseInt(flags.limit as string) : undefined)
            if (json) return print(data)
            render(React.createElement(RecordsScreen, {
              version: VERSION,
              title: 'phone search',
              subtitle: `Available numbers · ${country}`,
              footerLeft: `${(data.numbers || []).length} result(s)`,
              records: (data.numbers || []).map((n: any) => ({
                primary: String(n.phoneNumber || 'unknown'),
                secondary: [n.region, n.type].filter(Boolean).join(' · '),
              })),
            }))
            break
          }
          case 'buy': {
            const country = flags.country as string
            if (!country) err('--country required')
            const spinner = new Spinner()
            spinner.start('Provisioning phone number...')
            const spin = new Spinner(); spin.start('Provisioning phone number...'); const data = await ao.phoneBuy(country, flags.area as string); spin.stop('Phone number provisioned', true)
            spinner.stop('Phone number provisioned', true)
            if (json) return print(data)
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
            if (json) return print(data)
            ok(`SMS sent to ${to}`)
            break
          }
          case 'call': {
            const id = flags.id as string; const to = flags.to as string
            if (!id || !to) err('--id, --to required')
            const data = await ao.phoneCall(id, to, flags.tts as string)
            if (json) return print(data)
            ok(`Calling ${to}`)
            row('Call ID', data.callControlId || data.id || '')
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
            const spin = new Spinner(); spin.start('Creating inbox...'); const data = await ao.emailCreate(name, wallet); spin.stop('Inbox created', true)
            if (json) return print(data)
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
            if (json) return print(data)
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
            }))
            break
          }
          case 'send': {
            const id = flags.id as string; const to = flags.to as string
            const subject = flags.subject as string; const body = flags.body as string
            if (!id || !to || !subject || !body) err('--id, --to, --subject, --body required')
            const data = await ao.emailSend(id, to, subject, body)
            if (json) return print(data)
            ok(`Email sent to ${to}`)
            break
          }
          case 'threads': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id INBOX_ID required')
            const data = await ao.emailThreads(id)
            if (json) return print(data)
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
          }))
          break
        }
        switch (subcommand) {
          case 'plans': {
            const data = await ao.computePlans()
            if (json) return print(data)
            const plans = (data.plans || data || []).map((p: any) => ({
              name: String(p.type || p.id || p.name || 'unknown'),
              cpu: `${p.vcpu || p.cpu || p.vcpus || '?'} vCPU`,
              ram: `${p.ramGb || p.ram || p.memory || '?'}GB RAM`,
              price: String(p.priceUsdcMonthly || p.priceUsdc || p.price || p.monthly_cost || '?'),
            }))
            render(React.createElement(ComputePlansScreen, { version: VERSION, plans }))
            break
          }
          case 'deploy': {
            const name = flags.name as string || 'agent-' + Date.now()
            const type = flags.type as string || 'cx23'
            const spin = new Spinner(); spin.start('Deploying VPS...'); const data = await ao.computeDeploy(name, type); spin.stop('VPS deployed', true)
            if (json) return print(data)
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
            if (json) return print(data)
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
            if (json) return print(data)
            ok('Server deleted')
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
          }))
          break
        }
        switch (subcommand) {
          case 'check': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.com required')
            const data = await ao.domainCheck(name)
            if (json) return print(data)
            render(React.createElement(DomainCheckScreen, {
              version: VERSION,
              domain: name,
              available: !!data.available,
            }))
            break
          }
          case 'pricing': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain required')
            const data = await ao.domainPricing(name)
            if (json) return print(data)
            const items = Object.entries(data.tlds || data.pricing || data).map(([tld, price]) => ({
              tld,
              price: String(price),
            }))
            render(React.createElement(DomainPricingScreen, {
              version: VERSION,
              query: name,
              items,
            }))
            break
          }
          case 'buy': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.dev required')
            const spin = new Spinner(); spin.start('Registering domain...'); const data = await ao.domainBuy(name); spin.stop('Domain registered', true)
            if (json) return print(data)
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
            if (json) return print(data)
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
        if (!subcommand || flags.help) {
          render(React.createElement(MenuScreen, {
            version: VERSION,
            title: 'wallet',
            subtitle: 'Identity and policy',
            footerLeft: 'Wallet operations',
            commands: [
              { name: 'keygen', description: 'Generate a keypair', hint: '--chain both' },
              { name: 'create', description: 'Create a smart wallet', hint: '--agent 0xADDR --chain base' },
              { name: 'status', description: 'Check wallet status', hint: 'WALLET_ADDRESS' },
            ],
          }))
          break
        }
        switch (subcommand) {
          case 'create': {
            const agent = flags.agent as string
            if (!agent) err('--agent ADDRESS required')
            const chain = flags.chain as string || 'base'
            const data = await ao.walletCreate(agent, chain)
            if (json) return print(data)
            const address = data.wallet?.address || 'created'
            render(React.createElement(WalletCreateScreen, {
              version: VERSION,
              address,
              chain,
              setupUrl: data.setupUrl,
            }))
            addWallet({ address: data.wallet?.address, chain, createdAt: new Date().toISOString() })
            log(`wallet create: ${data.wallet?.address || 'unknown'} (${chain})`)
            break
          }
          case 'status': {
            const addr = positional[0] || flags.address as string
            if (!addr) err('Wallet address required')
            const data = await ao.walletStatus(addr)
            if (json) return print(data)
            const w = data.wallet || data
            render(React.createElement(WalletStatusScreen, {
              version: VERSION,
              address: w.address || addr,
              owner: w.owner || 'unknown',
              dailyLimit: w.policy ? `$${(parseInt(w.policy.dailyLimit || 0) / 1e6).toFixed(0)}` : undefined,
              perTxLimit: w.policy ? `$${(parseInt(w.policy.perTxLimit || 0) / 1e6).toFixed(0)}` : undefined,
            }))
            break
          }
          case 'keygen': {
            const chain = flags.chain as string || 'both'
            const data = await ao.walletKeygen(chain)
            if (json) return print(data)
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Keypair generated',
              subtitle: data.address || 'generated',
              footerLeft: 'Save the private key securely',
              details: [
                { label: 'Address', value: String(data.address || '') },
                { label: 'Private Key', value: String(data.privateKey || '') },
                { label: 'Chain', value: String(data.chain || chain) },
              ],
            }))
            break
          }
          default: err(`Unknown wallet command: ${subcommand}. Try: create, status, keygen`)
        }
        break
      }

      case 'pricing': {
        const data = await ao.pricing()
        if (json) return print(data)
        const services = Object.entries(data.services || {}).map(([name, prices]) => ({
          name,
          items: typeof prices === 'object'
            ? Object.entries(prices as Record<string, string>).map(([label, value]) => ({ label, value: String(value) }))
            : [],
        }))
        render(React.createElement(PricingScreen, { version: VERSION, services }))
        break
      }

      case 'health': {
        const data = await ao.health()
        if (json) return print(data)
        render(React.createElement(HealthScreen, {
          version: VERSION,
          status: data.status || 'unknown',
          uptime: data.uptime?.human || '?',
          apiVersion: data.version?.version || '?',
        }))
        break
      }

      default:
        console.error(`${c.red}Unknown command: ${command}${c.reset}`)
        console.error(`${c.dim}Run 'agentos --help' for usage${c.reset}`)
        process.exit(1)
    }
  } catch (e: any) {
    if (e.message === 'Payment Required') {
      render(React.createElement(ErrorScreen, {
        version: VERSION,
        title: 'Payment required',
        message: 'This endpoint costs USDC via x402.',
        hint: !config.setupDone ? 'Setup first: agentos setup --keyfile <path> --chain solana' : 'Your wallet is your identity — pay to provision.',
        footerLeft: 'Provisioning blocked until payment',
      }))
    } else {
      let hint: string | undefined
      if (e.message?.includes('keyfile') || e.message?.includes('key')) {
        hint = 'Configure wallet: agentos setup --keyfile <path> --chain solana'
      } else if (e.message?.includes('fetch') || e.message?.includes('ECONNREFUSED')) {
        hint = 'Is the API running? Check: agentos health'
      }
      render(React.createElement(ErrorScreen, {
        version: VERSION,
        title: 'Request failed',
        message: e.message,
        hint,
        footerLeft: 'Command failed',
      }))
    }
    process.exit(1)
  }

  // Show duration for non-instant commands
  const elapsed = Date.now() - startTime
  if (elapsed > 500 && !['help','--help'].includes(command) && !flags.help) {
    subtle(`Done in ${(elapsed / 1000).toFixed(1)}s`)
    blank()
  }
}

main()
