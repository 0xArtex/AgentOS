#!/usr/bin/env node

import React from 'react'
import { render as inkRender } from 'ink'
import { ComputeDeployScreen, ComputeListScreen, ComputePlansScreen, Dashboard, DomainCheckScreen, DomainPricingScreen, ErrorScreen, HealthScreen, MenuScreen, PricingScreen, RecordsScreen, SetupScreen, StatusScreen, SuccessScreen, WalletCreateScreen, WalletStatusScreen, WalletListScreen } from './app.js'
import { AgentOS } from './sdk.js'
import { loadConfig, saveConfig, ensureDirs, getKeyfile, log, addPhone, addInbox, addServer, addDomain, addWallet, addNote } from './config.js'
import { theme as t, icon, Spinner, header, row, ok, fail, warn, info, subtle, divider, blank, table, box, initReport, banner, kv, section, listItem, statusLine, welcomeScreen, statusBar, panel } from './ui.js'
import { existsSync } from 'fs'
import { homedir } from 'os'

// Alias for backwards compat in help text
const c = { ...t, cyan: t.info, green: t.success, red: t.error, yellow: t.warn, white: t.text, gray: t.muted, orange: t.accent }

const VERSION = '0.5.0'

function render(node: React.ReactElement) {
  return inkRender(node)
}

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
      { name: 'wallet', description: 'create · import · list · info · sign · api-key' },
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
  const fromHome = process.env.AGENTOS_FROM_HOME === '1'

  if (flags.version) { console.log(VERSION); return }
  if (flags.help) { help(); return }

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

  // First-time welcome
  if (!config.setupDone && command !== 'setup' && !['help','--help'].includes(command) && !flags.help && !flags.version) {
    render(React.createElement(MenuScreen, {
      version: VERSION,
      title: 'setup needed',
      subtitle: 'First time?',
      footerLeft: 'Run setup to get started',
      commands: [{ name: 'setup', description: 'agentos setup --keyfile ~/.config/solana/id.json --chain solana' }],
    }))
  }
  const url = flags.url as string || config.api
  const token = (flags.token as string) || config.apiKey || process.env.AGENTOS_TOKEN || process.env.AGENTOS_API_KEY
  const ao = new AgentOS(url, true, token)
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
            render(React.createElement(SuccessScreen, { version: VERSION, title: 'SMS sent', subtitle: to, details: [{ label: 'To', value: to }], footerLeft: 'Message delivered' }))
            break
          }
          case 'call': {
            const id = flags.id as string; const to = flags.to as string
            if (!id || !to) err('--id, --to required')
            const data = await ao.phoneCall(id, to, flags.tts as string)
            if (json) return print(data)
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
            if (json) return print(data)
            render(React.createElement(SuccessScreen, { version: VERSION, title: 'email sent', subtitle: to, details: [{ label: 'To', value: to }], footerLeft: 'Email delivered' }))
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
            if (json) return print(data)
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
            if (json) return print(data)
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
            if (json) return print(data)
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
            subtitle: 'Encrypted BIP-39 vault',
            footerLeft: 'Vault-backed wallet operations',
            commands: [
              { name: 'create', description: 'Create a new wallet', hint: '--chains solana,evm' },
              { name: 'import', description: 'Import from mnemonic', hint: '--mnemonic "..."' },
              { name: 'list', description: 'List all wallets' },
              { name: 'info', description: 'Wallet details', hint: 'WALLET_ID' },
              { name: 'addresses', description: 'Show all chain addresses', hint: 'WALLET_ID' },
              { name: 'sign-message', description: 'Sign a message', hint: 'WALLET_ID --chain evm --msg "hello"' },
              { name: 'api-key', description: 'Create agent API key', hint: 'WALLET_ID --name my-agent' },
              { name: 'config', description: 'Get agent config', hint: 'WALLET_ID' },
              { name: 'use', description: 'Set default pay wallet', hint: 'WALLET_ID' },
            ],
          }))
          break
        }
        switch (subcommand) {
          case 'create': {
            const label = flags.label as string || undefined
            const chainsStr = flags.chains as string || 'solana,evm'
            const chains = chainsStr.split(',').map((c: string) => c.trim())
            const data = await ao.walletCreate(label, chains)
            if (json) return print(data)
            const w = data.wallet
            render(React.createElement(WalletCreateScreen, {
              version: VERSION,
              id: w.id,
              solana: w.solana?.address,
              base: w.base?.address,
              chains: w.supportedChains || chains,
            }))
            addWallet({ id: w.id, solana: w.solana?.address, base: w.base?.address, createdAt: new Date().toISOString() })
            log(`wallet create: ${w.id}`)
            break
          }
          case 'import': {
            const mnemonic = flags.mnemonic as string
            if (!mnemonic) err('--mnemonic "your twelve words..." required')
            const label = flags.label as string || undefined
            const data = await ao.walletImport(mnemonic, label)
            if (json) return print(data)
            const w = data.wallet
            render(React.createElement(WalletCreateScreen, {
              version: VERSION,
              id: w.id,
              solana: w.solana?.address,
              base: w.base?.address,
              chains: w.supportedChains || ['solana', 'evm'],
            }))
            log(`wallet import: ${w.id}`)
            break
          }
          case 'list': {
            const data = await ao.walletList()
            if (json) return print(data)
            render(React.createElement(WalletListScreen, {
              version: VERSION,
              wallets: (data.wallets || []).map((w: any) => ({
                id: w.id,
                label: w.label,
                solana: w.solana?.address,
                base: w.base?.address,
                chains: w.accounts?.length || w.supportedChains?.length || 2,
              })),
            }))
            break
          }
          case 'info': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const data = await ao.walletGet(walletId)
            if (json) return print(data)
            const w = data.wallet
            render(React.createElement(WalletStatusScreen, {
              version: VERSION,
              id: w.id,
              label: w.label,
              accounts: w.accounts || [],
            }))
            break
          }
          case 'addresses': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const data = await ao.walletAddresses(walletId)
            if (json) return print(data)
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
            const data = await ao.walletSignMessage(walletId, chain, msg)
            if (json) return print(data)
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
            const data = await ao.walletApiKey(walletId, name)
            if (json) return print(data)
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
            const data = await ao.walletConfig(walletId)
            if (json) return print(data)
            print(data.config || data)
            break
          }
          case 'use': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const cfg = loadConfig()
            cfg.defaultPayWalletId = walletId
            saveConfig(cfg)
            if (json) return print({ success: true, defaultPayWalletId: walletId })
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Default pay wallet set',
              subtitle: walletId,
              footerLeft: 'x402 payments will use this wallet',
              details: [
                { label: 'Wallet ID', value: walletId },
                { label: 'Config', value: '~/.agentos/config.json' },
              ],
            }))
            break
          }
          default: err(`Unknown wallet command: ${subcommand}. Try: create, import, list, info, addresses, sign-message, api-key, config, use`)
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
        if (json) return print(data)
        render(React.createElement(HealthScreen, {
          version: VERSION,
          status: data.status || 'unknown',
          uptime: data.uptime?.human || '?',
          apiVersion: data.version?.version || '?',
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
    console.log(`  \x1b[90mDone in ${(elapsed / 1000).toFixed(1)}s\x1b[0m`)
  }
}

main()
