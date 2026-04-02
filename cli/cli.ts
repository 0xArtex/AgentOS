#!/usr/bin/env node

import { AgentOS } from './sdk.js'
import { loadConfig, saveConfig, ensureDirs, getKeyfile, log, addPhone, addInbox, addServer, addDomain, addWallet, addNote } from './config.js'
import { theme as t, icon, Spinner, header, row, ok, fail, warn, info, subtle, divider, blank, table, box, initReport, banner, kv, section, listItem, statusLine } from './ui.js'
import { existsSync } from 'fs'
import { homedir } from 'os'

// Alias for backwards compat in help text
const c = { ...t, cyan: t.info, green: t.success, red: t.error, yellow: t.warn, white: t.text, gray: t.muted, orange: t.accent }

const VERSION = '0.2.0'

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

function err(msg: string) { fail(msg); process.exit(1) }
function print(obj: any) { console.log(JSON.stringify(obj, null, 2)) }

// ─── Help ───
function help() {
  console.log()
  console.log(`  ${t.accent}${t.bold}▲ AgentOS${t.reset} ${t.muted}v${VERSION}${t.reset}`)
  console.log(`  ${t.dim}Everything your AI agent needs — one CLI.${t.reset}`)
  console.log()
  console.log(`  ${t.bold}Getting Started${t.reset}`)
  console.log(`  ${t.muted}$ ${t.text}agentos setup --keyfile ~/.config/solana/id.json --chain solana${t.reset}`)
  console.log(`  ${t.muted}$ ${t.text}agentos status${t.reset}`)
  console.log()
  console.log(`  ${t.bold}Services${t.reset}`)
  console.log()
  console.log(`  ${t.info}phone${t.reset}     ${t.muted}search · buy · sms · call${t.reset}`)
  console.log(`  ${t.info}email${t.reset}     ${t.muted}create · read · send · threads${t.reset}`)
  console.log(`  ${t.info}compute${t.reset}   ${t.muted}plans · deploy · list · delete${t.reset}`)
  console.log(`  ${t.info}domain${t.reset}    ${t.muted}check · pricing · buy · dns${t.reset}`)
  console.log(`  ${t.info}wallet${t.reset}    ${t.muted}create · status · keygen${t.reset}`)
  console.log()
  console.log(`  ${t.bold}Tools${t.reset}`)
  console.log()
  console.log(`  ${t.info}setup${t.reset}     ${t.muted}Configure wallets + chain preference${t.reset}`)
  console.log(`  ${t.info}status${t.reset}    ${t.muted}Show config, wallets, and API health${t.reset}`)
  console.log(`  ${t.info}note${t.reset}      ${t.muted}Save a note to ~/.agentos/memory/${t.reset}`)
  console.log(`  ${t.info}pricing${t.reset}   ${t.muted}Show all service prices${t.reset}`)
  console.log(`  ${t.info}health${t.reset}    ${t.muted}Check API status${t.reset}`)
  console.log()
  console.log(`  ${t.bold}Options${t.reset}`)
  console.log()
  console.log(`  ${t.warn}--url${t.reset} ${t.dim}<url>${t.reset}     ${t.muted}API base URL${t.reset}`)
  console.log(`  ${t.warn}--json${t.reset}          ${t.muted}Output raw JSON${t.reset}`)
  console.log(`  ${t.warn}--version${t.reset}       ${t.muted}Show version${t.reset}`)
  console.log(`  ${t.warn}--help${t.reset}          ${t.muted}Show this help${t.reset}`)
  console.log()
  console.log(`  ${t.bold}Examples${t.reset}`)
  console.log()
  console.log(`  ${t.muted}$ ${t.text}agentos phone search --country US${t.reset}`)
  console.log(`  ${t.muted}$ ${t.text}agentos email create --name my-agent --wallet SOL_PUBKEY${t.reset}`)
  console.log(`  ${t.muted}$ ${t.text}agentos compute deploy --name my-vps --type cx23${t.reset}`)
  console.log(`  ${t.muted}$ ${t.text}agentos domain buy --name myagent.dev${t.reset}`)
  console.log(`  ${t.muted}$ ${t.text}agentos wallet keygen${t.reset}`)
  console.log()
  console.log(`  ${t.dim}Docs  ${t.reset}${t.muted}https://agntos.dev/skill.md${t.reset}`)
  console.log(`  ${t.dim}API   ${t.reset}${t.muted}https://agntos.dev${t.reset}`)
  console.log(`  ${t.dim}Code  ${t.reset}${t.muted}https://github.com/0xArtex/AgentOS${t.reset}`)
  console.log()
}


// ─── Commands ───
async function main() {
  const { command, subcommand, positional, flags } = parse(process.argv)

  if (flags.version) { console.log(VERSION); return }
  if (!command || flags.help) { help(); return }

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

        initReport('Setup', [
          { name: '~/.agentos/', status: 'created' },
          { name: `${chain} wallet`, status: 'created' },
          ...(chains.length > 1 ? [{ name: `${chains.filter(c => c !== chain)[0]} wallet`, status: 'exists' as const }] : []),
          { name: 'config.json', status: 'updated' },
        ])

        kv('API', url)
        kv('Chain', chains.join(', '))
        kv('Keyfile', keyfile)
        blank()
        subtle(`Run ${t.info}agentos status${t.muted} to verify.`)
        if (chains.length === 1) {
          subtle(`Add ${chain === 'solana' ? 'Base' : 'Solana'}: ${t.info}agentos setup --keyfile <path> --chain ${chain === 'solana' ? 'base' : 'solana'}${t.muted}`)
        }
        blank()
        log(`setup: keyfile=${keyfile} chain=${chain}`)
        break
      }

      case 'status': {
        banner()
        const wallets = config.wallets || {}
        const hasSolana = !!wallets.solana
        const hasBase = !!wallets.base
        let apiOk = false
        try { const h = await ao.health(); apiOk = h.status === 'healthy' } catch {}
        
        statusLine('API', config.api, apiOk)
        statusLine('Solana', hasSolana ? wallets.solana!.keyfile : 'not configured', hasSolana)
        statusLine('Base', hasBase ? wallets.base!.keyfile : 'not configured', hasBase)
        statusLine('Default', config.defaultChain || 'solana', true)
        blank()
        if (!hasSolana && !hasBase) {
          warn('No wallets configured. Run: agentos setup --keyfile <path> --chain solana')
        }
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
        switch (subcommand) {
          case 'search': {
            const country = flags.country as string || 'US'
            const data = await ao.phoneSearch(country, flags.limit ? parseInt(flags.limit as string) : undefined)
            if (json) return print(data)
            header('Available Numbers')
            for (const n of (data.numbers || [])) {
              console.log(`  ${c.green}${n.phoneNumber}${c.reset}  ${c.dim}${n.region || ''} · ${n.type || ''}${c.reset}`)
            }
            break
          }
          case 'buy': {
            const country = flags.country as string
            if (!country) err('--country required')
            const data = await ao.phoneBuy(country, flags.area as string)
            if (json) return print(data)
            header('Phone Number Provisioned')
            ok(data.phoneNumber || data.phone_number || 'provisioned')
            row('ID', data.id || '')
            row('Country', country)
            addPhone({ id: data.id, number: data.phoneNumber || data.phone_number, country, createdAt: new Date().toISOString() })
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
        switch (subcommand) {
          case 'create': {
            const name = flags.name as string; const wallet = flags.wallet as string
            if (!name || !wallet) err('--name, --wallet required')
            const data = await ao.emailCreate(name, wallet)
            if (json) return print(data)
            header('Email Inbox Created')
            ok(data.address || `${name}@agntos.dev`)
            row('ID', data.id || '')
            row('E2E', data.e2eEnabled ? 'enabled' : 'disabled')
            addInbox({ id: data.id, address: data.address || `${name}@agntos.dev`, createdAt: new Date().toISOString() })
            log(`email create: ${data.address || name}`)
            break
          }
          case 'read': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id INBOX_ID required')
            const data = await ao.emailRead(id)
            if (json) return print(data)
            header(`Inbox: ${data.inbox || id}`)
            for (const m of (data.messages || [])) {
              console.log(`  ${m.direction === 'inbound' ? c.cyan + '←' : c.green + '→'} ${c.reset}${m.from} ${c.dim}${m.timestamp}${c.reset}`)
              console.log(`    ${c.white}${m.subject}${c.reset}`)
            }
            console.log(`\n  ${c.dim}${(data.messages || []).length} messages${c.reset}`)
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
            header('Threads')
            for (const t of (data.threads || [])) {
              console.log(`  ${c.cyan}${t.subject}${c.reset} ${c.dim}(${t.message_count} msgs)${c.reset}`)
            }
            break
          }
          default: err(`Unknown email command: ${subcommand}. Try: create, read, send, threads`)
        }
        break
      }

      case 'compute': {
        switch (subcommand) {
          case 'plans': {
            const data = await ao.computePlans()
            if (json) return print(data)
            header('VPS Plans')
            for (const p of (data.plans || data || [])) {
              console.log(`  ${c.cyan}${p.type || p.id || p.name}${c.reset}  ${c.dim}${p.vcpu || p.cpu || p.vcpus} vCPU · ${p.ramGb || p.ram || p.memory}GB RAM · $${p.priceUsdcMonthly || p.priceUsdc || p.price || p.monthly_cost}/mo${c.reset}`)
            }
            break
          }
          case 'deploy': {
            const name = flags.name as string || 'agent-' + Date.now()
            const type = flags.type as string || 'cx23'
            const data = await ao.computeDeploy(name, type)
            if (json) return print(data)
            header('VPS Deployed')
            ok(data.ipv4 || data.ip || 'deploying...')
            row('ID', data.id || '')
            row('Type', type)
            row('SSH', `root@${data.ipv4 || data.ip}`)
            addServer({ id: data.id, ip: data.ipv4 || data.ip, type, name, createdAt: new Date().toISOString() })
            log(`compute deploy: ${data.ipv4 || data.ip} (${type})`)
            break
          }
          case 'list': {
            const data = await ao.computeList()
            if (json) return print(data)
            header('Servers')
            for (const s of (data.servers || [])) {
              console.log(`  ${c.green}●${c.reset} ${s.ipv4 || s.ip} ${c.dim}${s.serverType || s.type} · ${s.status}${c.reset}`)
            }
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
        switch (subcommand) {
          case 'check': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.com required')
            const data = await ao.domainCheck(name)
            if (json) return print(data)
            header('Domain Check')
            console.log(`  ${data.available ? c.green + '✓ Available' : c.red + '✗ Taken'}${c.reset}  ${c.white}${name}${c.reset}`)
            break
          }
          case 'pricing': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain required')
            const data = await ao.domainPricing(name)
            if (json) return print(data)
            header('Domain Pricing')
            for (const [tld, price] of Object.entries(data.tlds || data.pricing || data)) {
              console.log(`  ${c.cyan}.${tld}${c.reset}  ${c.white}$${price}${c.reset}`)
            }
            break
          }
          case 'buy': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.dev required')
            const data = await ao.domainBuy(name)
            if (json) return print(data)
            header('Domain Registered')
            ok(data.domain || name)
            addDomain({ domain: data.domain || name, createdAt: new Date().toISOString() })
            log(`domain buy: ${data.domain || name}`)
            break
          }
          case 'dns': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.dev required')
            const data = await ao.domainDns(name)
            if (json) return print(data)
            header(`DNS: ${name}`)
            for (const r of (data.records || [])) {
              console.log(`  ${c.cyan}${r.type}${c.reset}  ${r.name || '@'}  →  ${c.white}${r.value}${c.reset}`)
            }
            break
          }
          default: err(`Unknown domain command: ${subcommand}. Try: check, pricing, buy, dns`)
        }
        break
      }

      case 'wallet': {
        switch (subcommand) {
          case 'create': {
            const agent = flags.agent as string
            if (!agent) err('--agent ADDRESS required')
            const chain = flags.chain as string || 'base'
            const data = await ao.walletCreate(agent, chain)
            if (json) return print(data)
            header('Wallet Created')
            ok(data.wallet?.address || 'created')
            row('Chain', chain)
            if (data.setupUrl) row('Setup', data.setupUrl)
            addWallet({ address: data.wallet?.address, chain, createdAt: new Date().toISOString() })
            log(`wallet create: ${data.wallet?.address || 'unknown'} (${chain})`)
            break
          }
          case 'status': {
            const addr = positional[0] || flags.address as string
            if (!addr) err('Wallet address required')
            const data = await ao.walletStatus(addr)
            if (json) return print(data)
            header('Wallet Status')
            const w = data.wallet || data
            row('Address', w.address || addr)
            row('Owner', w.owner || 'unknown')
            if (w.policy) {
              row('Daily limit', `$${(parseInt(w.policy.dailyLimit || 0) / 1e6).toFixed(0)}`)
              row('Per-tx limit', `$${(parseInt(w.policy.perTxLimit || 0) / 1e6).toFixed(0)}`)
            }
            break
          }
          case 'keygen': {
            const chain = flags.chain as string || 'both'
            const data = await ao.walletKeygen(chain)
            if (json) return print(data)
            header('Keypair Generated')
            row('Address', data.address || '')
            row('Private Key', data.privateKey || '')
            row('Chain', data.chain || chain)
            console.log(`\n  ${c.yellow}Save the private key securely.${c.reset}`)
            break
          }
          default: err(`Unknown wallet command: ${subcommand}. Try: create, status, keygen`)
        }
        break
      }

      case 'pricing': {
        const data = await ao.pricing()
        if (json) return print(data)
        header('Pricing')
        for (const [svc, prices] of Object.entries(data.services || {})) {
          console.log(`\n  ${c.cyan}${c.bold}${svc}${c.reset}`)
          if (typeof prices === 'object') {
            for (const [k, v] of Object.entries(prices as Record<string, string>)) {
              console.log(`    ${c.dim}${k}:${c.reset} ${c.white}$${v}${c.reset}`)
            }
          }
        }
        break
      }

      case 'health': {
        const data = await ao.health()
        if (json) return print(data)
        header('API Status')
        ok(`${data.status} — v${data.version?.version || '?'}`)
        row('Uptime', data.uptime?.human || '?')
        break
      }

      default:
        console.error(`${c.red}Unknown command: ${command}${c.reset}`)
        console.error(`${c.dim}Run 'agentos --help' for usage${c.reset}`)
        process.exit(1)
    }
  } catch (e: any) {
    if (e.message === 'Payment Required') {
      blank()
      warn('Payment required — this endpoint costs USDC via x402.')
      subtle('Your wallet is your identity — pay to provision.')
      if (!config.setupDone) {
        subtle(`Setup first: ${t.info}agentos setup --keyfile <path> --chain solana${t.muted}`)
      }
      blank()
    } else {
      blank()
      fail(e.message)
      // Suggest fixes for common errors
      if (e.message?.includes('keyfile') || e.message?.includes('key')) {
        subtle(`Configure wallet: ${t.info}agentos setup --keyfile <path> --chain solana${t.muted}`)
      }
      if (e.message?.includes('fetch') || e.message?.includes('ECONNREFUSED')) {
        subtle('Is the API running? Check: agentos health')
      }
      blank()
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
