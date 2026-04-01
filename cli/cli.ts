#!/usr/bin/env node

import { AgentOS } from './sdk.js'

// ─── Colors ───
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
  orange: '\x1b[38;5;208m',
}

const VERSION = '0.1.1'

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

function header(title: string) { console.log(`\n  ${c.orange}${c.bold}${title}${c.reset}\n`) }
function row(label: string, value: string, color = c.white) { console.log(`  ${c.dim}${label}:${c.reset} ${color}${value}${c.reset}`) }
function ok(msg: string) { console.log(`  ${c.green}✓${c.reset} ${msg}`) }
function err(msg: string) { console.error(`  ${c.red}✗${c.reset} ${msg}`); process.exit(1) }
function print(obj: any) { console.log(JSON.stringify(obj, null, 2)) }

// ─── Help ───
function help() {
  console.log(`
${c.orange}${c.bold}agentos${c.reset} ${c.dim}v${VERSION}${c.reset}
Everything your AI agent needs — one CLI.

${c.bold}Commands${c.reset}
  ${c.cyan}phone${c.reset}
    ${c.dim}search${c.reset}     Search available numbers    ${c.dim}--country US${c.reset}
    ${c.dim}buy${c.reset}        Buy a phone number          ${c.dim}--country US${c.reset}
    ${c.dim}sms${c.reset}        Send SMS                    ${c.dim}--id ID --to +1... --body "hi"${c.reset}
    ${c.dim}call${c.reset}       Place a voice call          ${c.dim}--id ID --to +1... --tts "hello"${c.reset}

  ${c.cyan}email${c.reset}
    ${c.dim}create${c.reset}     Create an inbox             ${c.dim}--name agent --wallet SOL_PUBKEY${c.reset}
    ${c.dim}read${c.reset}       Read inbox messages          ${c.dim}--id INBOX_ID${c.reset}
    ${c.dim}send${c.reset}       Send an email               ${c.dim}--id INBOX_ID --to x@y.com --subject "Hi" --body "..."${c.reset}
    ${c.dim}threads${c.reset}    List threads                ${c.dim}--id INBOX_ID${c.reset}

  ${c.cyan}compute${c.reset}
    ${c.dim}plans${c.reset}      List VPS plans
    ${c.dim}deploy${c.reset}     Deploy a VPS                ${c.dim}--name my-server --type cx23${c.reset}
    ${c.dim}list${c.reset}       List servers
    ${c.dim}delete${c.reset}     Delete a server             ${c.dim}--id SERVER_ID${c.reset}

  ${c.cyan}domain${c.reset}
    ${c.dim}check${c.reset}      Check availability          ${c.dim}--name example.com${c.reset}
    ${c.dim}pricing${c.reset}    Get TLD pricing             ${c.dim}--name example${c.reset}
    ${c.dim}buy${c.reset}        Register a domain           ${c.dim}--name example.dev${c.reset}
    ${c.dim}dns${c.reset}        Get DNS records             ${c.dim}--name example.dev${c.reset}

  ${c.cyan}wallet${c.reset}
    ${c.dim}create${c.reset}     Create a wallet             ${c.dim}--agent 0xADDR --chain base${c.reset}
    ${c.dim}status${c.reset}     Check wallet status         ${c.dim}WALLET_ADDRESS${c.reset}
    ${c.dim}keygen${c.reset}     Generate keypair            ${c.dim}--chain both${c.reset}

  ${c.cyan}pricing${c.reset}     Show all service prices
  ${c.cyan}health${c.reset}      Check API status

${c.bold}Options${c.reset}
  ${c.yellow}--url${c.reset} ${c.dim}<url>${c.reset}     API base URL (default: https://agntos.dev)
  ${c.yellow}--json${c.reset}          Output raw JSON
  ${c.yellow}--version${c.reset}       Show version
  ${c.yellow}--help${c.reset}          Show this help

${c.bold}Examples${c.reset}
  ${c.green}$${c.reset} agentos phone search --country US
  ${c.green}$${c.reset} agentos phone buy --country US
  ${c.green}$${c.reset} agentos email create --name my-agent --wallet SOL_PUBKEY
  ${c.green}$${c.reset} agentos compute deploy --name my-vps --type cx23
  ${c.green}$${c.reset} agentos domain buy --name myagent.dev
  ${c.green}$${c.reset} agentos wallet keygen

${c.dim}Docs: https://agntos.dev/skill.md${c.reset}
`)
}

// ─── Commands ───
async function main() {
  const { command, subcommand, positional, flags } = parse(process.argv)

  if (flags.version) { console.log(VERSION); return }
  if (!command || flags.help) { help(); return }

  const url = flags.url as string | undefined
  const ao = new AgentOS(url)
  const json = !!flags.json

  try {
    switch (command) {
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
      console.error(`\n  ${c.yellow}Payment required.${c.reset} This endpoint costs USDC via x402.`)
      console.error(`  ${c.dim}Your wallet is your identity — pay to provision.${c.reset}\n`)
    } else {
      console.error(`\n  ${c.red}Error:${c.reset} ${e.message}\n`)
    }
    process.exit(1)
  }
}

main()
