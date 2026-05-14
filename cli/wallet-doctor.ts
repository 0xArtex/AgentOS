/**
 * `palmyr wallet doctor` — health check for the wallet-trading subsystem.
 *
 * Verifies the things QA found were silent killers in the field: ws version
 * incompatibility with ethers v6 ESM, the bundled @palmyr/solana-trading
 * disappearing after a stray `npm install`, RPC/aggregator reachability,
 * wallet address resolution. Each check is independent — one failing doesn't
 * abort the rest.
 *
 * Output is `{status, wallet, solanaAddress, evmAddress, checks[]}` —
 * agents read `status` for the overall verdict and `checks` for granular
 * remediation.
 */
import { existsSync, readFileSync, statSync, accessSync, constants as FS_CONSTANTS, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface DoctorCheck {
  name: string
  status: CheckStatus
  value?: string
  message?: string
}

export interface DoctorReport {
  status: 'ok' | 'warning' | 'fail'
  wallet: string | null
  solanaAddress: string | null
  evmAddress: string | null
  cliVersion: string
  nodeVersion: string
  platform: NodeJS.Platform
  checks: DoctorCheck[]
}

/**
 * Resolve the version of a dependency the CLI imports. Reads
 * `node_modules/<pkg>/package.json` relative to where this module was loaded.
 * Returns null if the dep can't be found — caller treats that as a fail.
 */
function readDepVersion(pkgName: string): string | null {
  try {
    // Walk up from the loaded module's dir looking for node_modules/<pkg>/package.json.
    const here = dirname(fileURLToPath(import.meta.url))
    let cur = here
    for (let i = 0; i < 8; i++) {
      const candidate = join(cur, 'node_modules', pkgName, 'package.json')
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, 'utf8')).version as string
      }
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    return null
  } catch {
    return null
  }
}

function checkWsVersion(): DoctorCheck {
  const v = readDepVersion('ws')
  if (!v) return { name: 'wsVersion', status: 'fail', message: 'ws package not found' }
  // ethers v6 ESM requires ws@8 — anything less than 8 breaks Base trading.
  const major = Number(v.split('.')[0])
  if (!Number.isFinite(major) || major < 8) {
    return {
      name: 'wsVersion',
      status: 'fail',
      value: v,
      message: 'ws@<8 breaks ethers v6 ESM (Named export `WebSocket` not found). Reinstall @palmyr/cli to pick up the pinned ws@^8.17.1.',
    }
  }
  return { name: 'wsVersion', status: 'pass', value: v }
}

function checkEthersVersion(): DoctorCheck {
  const v = readDepVersion('ethers')
  if (!v) return { name: 'ethersVersion', status: 'fail', message: 'ethers package not found' }
  const major = Number(v.split('.')[0])
  if (major < 6) {
    return { name: 'ethersVersion', status: 'warn', value: v, message: 'ethers <6 not tested with current CLI' }
  }
  return { name: 'ethersVersion', status: 'pass', value: v }
}

function checkBundledSolanaTrading(): DoctorCheck {
  const v = readDepVersion('@palmyr/solana-trading')
  if (!v) {
    return {
      name: 'bundledSolanaTrading',
      status: 'fail',
      message: '@palmyr/solana-trading missing — likely removed by a stray `npm install` inside the CLI dir. Reinstall the CLI from npm.',
    }
  }
  return { name: 'bundledSolanaTrading', status: 'pass', value: v }
}

async function checkSolanaRpc(rpcUrl?: string): Promise<DoctorCheck> {
  const url = rpcUrl ?? 'https://api.mainnet-beta.solana.com'
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
    })
    if (!res.ok) return { name: 'solanaRpc', status: 'fail', value: url, message: `HTTP ${res.status}` }
    const data = (await res.json()) as { result?: string }
    if (data.result === 'ok') return { name: 'solanaRpc', status: 'pass', value: url }
    return { name: 'solanaRpc', status: 'warn', value: url, message: `unexpected getHealth response: ${JSON.stringify(data).slice(0, 120)}` }
  } catch (e: any) {
    return { name: 'solanaRpc', status: 'fail', value: url, message: e?.message ?? 'unreachable' }
  }
}

async function checkBaseRpc(rpcUrl?: string): Promise<DoctorCheck> {
  const url = rpcUrl ?? 'https://mainnet.base.org'
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    })
    if (!res.ok) return { name: 'baseRpc', status: 'fail', value: url, message: `HTTP ${res.status}` }
    const data = (await res.json()) as { result?: string }
    if (typeof data.result === 'string' && data.result.startsWith('0x')) {
      return { name: 'baseRpc', status: 'pass', value: url, message: `block ${parseInt(data.result, 16)}` }
    }
    return { name: 'baseRpc', status: 'warn', value: url, message: 'no result in response' }
  } catch (e: any) {
    return { name: 'baseRpc', status: 'fail', value: url, message: e?.message ?? 'unreachable' }
  }
}

async function checkJupiterReachable(): Promise<DoctorCheck> {
  try {
    const res = await fetch('https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50')
    if (res.ok) return { name: 'jupiter', status: 'pass' }
    if (res.status === 429) return { name: 'jupiter', status: 'warn', message: 'rate-limited (recovery is automatic during trades)' }
    return { name: 'jupiter', status: 'fail', message: `HTTP ${res.status}` }
  } catch (e: any) {
    return { name: 'jupiter', status: 'fail', message: e?.message ?? 'unreachable' }
  }
}

async function checkParaswapReachable(): Promise<DoctorCheck> {
  try {
    // Trivial WETH→USDC quote on Base (smallest unit) — a 200 confirms the API is reachable.
    const res = await fetch('https://api.paraswap.io/prices?srcToken=0x4200000000000000000000000000000000000006&destToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amount=10000000000000000&srcDecimals=18&destDecimals=6&network=8453&side=SELL')
    if (res.ok) return { name: 'paraswap', status: 'pass' }
    if (res.status === 429) return { name: 'paraswap', status: 'warn', message: 'rate-limited' }
    return { name: 'paraswap', status: 'fail', message: `HTTP ${res.status}` }
  } catch (e: any) {
    return { name: 'paraswap', status: 'fail', message: e?.message ?? 'unreachable' }
  }
}

async function checkTradingDirWritable(): Promise<DoctorCheck> {
  try {
    // Dynamic import so this module stays useful even if the wallet-trading
    // module is what's being diagnosed (e.g. a corrupt position file).
    const { TRADING_DIR } = await import('./wallet-trading.js')
    if (!existsSync(TRADING_DIR)) {
      try { mkdirSync(TRADING_DIR, { recursive: true }) } catch {}
    }
    accessSync(TRADING_DIR, FS_CONSTANTS.W_OK)
    // Round-trip a probe file to catch read-only mounts that pass W_OK.
    const probe = join(TRADING_DIR, `.doctor-probe-${process.pid}`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return { name: 'tradingDir', status: 'pass', value: TRADING_DIR }
  } catch (e: any) {
    return { name: 'tradingDir', status: 'fail', message: e?.message ?? 'not writable' }
  }
}

export interface DoctorOpts {
  walletRef?: string
  passphrase?: string
  cliVersion: string
}

export async function runWalletDoctor(opts: DoctorOpts): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  checks.push(checkWsVersion())
  checks.push(checkEthersVersion())
  checks.push(checkBundledSolanaTrading())
  checks.push(await checkTradingDirWritable())

  let solanaAddress: string | null = null
  let evmAddress: string | null = null
  if (opts.walletRef) {
    try {
      const { resolveWalletAddresses } = await import('./wallet-trading.js')
      const resolved = await resolveWalletAddresses(opts.walletRef, opts.passphrase)
      solanaAddress = resolved.solanaAddress
      evmAddress = resolved.evmAddress
      checks.push({
        name: 'walletResolution',
        status: (solanaAddress || evmAddress) ? 'pass' : 'fail',
        value: [solanaAddress, evmAddress].filter(Boolean).join(' / '),
        message: !solanaAddress && !evmAddress ? 'could not derive any chain address from this wallet' : undefined,
      })
    } catch (e: any) {
      checks.push({ name: 'walletResolution', status: 'fail', message: e?.message ?? 'failed' })
    }
  } else {
    checks.push({ name: 'walletResolution', status: 'skip', message: 'pass --wallet <ref> to check derivation' })
  }

  // Parallelise the network probes — they take 100–500ms each.
  const [sol, base, jup, para] = await Promise.all([
    checkSolanaRpc(),
    checkBaseRpc(),
    checkJupiterReachable(),
    checkParaswapReachable(),
  ])
  checks.push(sol, base, jup, para)

  const anyFail = checks.some((c) => c.status === 'fail')
  const anyWarn = checks.some((c) => c.status === 'warn')
  const status: DoctorReport['status'] = anyFail ? 'fail' : anyWarn ? 'warning' : 'ok'

  return {
    status,
    wallet: opts.walletRef ?? null,
    solanaAddress,
    evmAddress,
    cliVersion: opts.cliVersion,
    nodeVersion: process.version,
    platform: process.platform,
    checks,
  }
}
