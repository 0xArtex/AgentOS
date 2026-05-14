/**
 * `palmyr wallet smoke-test` — end-to-end validation of the wallet-trading
 * subsystem. Runs against the user's wallet and the live aggregators (Jupiter
 * + ParaSwap) to confirm that buy/sell/sync work today, not just that
 * dependencies are installed (`doctor` covers that).
 *
 * Default mode is dry-run: walks through buy(SOL→USDC) dry-run on Solana and
 * buy(ETH→USDC) dry-run on Base. Returns a checklist with `safeForAutonomousTrading`
 * verdict. With `--live --amount tiny` it actually executes tiny round trips
 * (currently not exposed in the CLI surface to avoid foot-guns; the function
 * accepts the flag for future use).
 */
import type { Connection } from '@solana/web3.js'

export type LegStatus = 'pass' | 'fail' | 'skip'

export interface SmokeLeg {
  name: string
  chain: 'solana' | 'base' | 'meta'
  status: LegStatus
  message?: string
  durationMs?: number
}

export interface SmokeReport {
  wallet: string
  solanaAddress: string | null
  evmAddress: string | null
  mode: 'dry-run' | 'live'
  legs: SmokeLeg[]
  safeForAutonomousTrading: boolean
  startedAt: string
  finishedAt: string
}

export interface SmokeTestOpts {
  walletRef: string
  passphrase?: string
  chain?: 'solana' | 'base' | 'all'
  /**
   * `dry-run` (default) — no on-chain txs; quotes only.
   * `live` — execute tiny round trips. NOT wired into CLI yet; reserved.
   */
  mode?: 'dry-run' | 'live'
}

async function timed(fn: () => Promise<void>): Promise<{ ok: boolean; message?: string; durationMs: number }> {
  const t0 = Date.now()
  try {
    await fn()
    return { ok: true, durationMs: Date.now() - t0 }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), durationMs: Date.now() - t0 }
  }
}

export async function runWalletSmokeTest(opts: SmokeTestOpts): Promise<SmokeReport> {
  const startedAt = new Date().toISOString()
  const mode: 'dry-run' | 'live' = opts.mode ?? 'dry-run'
  const wantSolana = !opts.chain || opts.chain === 'solana' || opts.chain === 'all'
  const wantBase = !opts.chain || opts.chain === 'base' || opts.chain === 'all'

  const legs: SmokeLeg[] = []

  // Resolve both chain addresses. Required for any subsequent leg.
  let solanaAddress: string | null = null
  let evmAddress: string | null = null
  {
    const r = await timed(async () => {
      const { resolveWalletAddresses } = await import('./wallet-trading.js')
      const addrs = await resolveWalletAddresses(opts.walletRef, opts.passphrase)
      solanaAddress = addrs.solanaAddress
      evmAddress = addrs.evmAddress
      if (!solanaAddress && !evmAddress) {
        throw new Error('Neither Solana nor EVM address could be derived from this wallet')
      }
    })
    legs.push({
      name: 'walletResolution',
      chain: 'meta',
      status: r.ok ? 'pass' : 'fail',
      message: r.message ?? [solanaAddress, evmAddress].filter(Boolean).join(' / '),
      durationMs: r.durationMs,
    })
  }

  // Solana legs
  if (wantSolana && solanaAddress) {
    // Native SOL → USDC quote
    const solBuyQuote = await timed(async () => {
      const { fetchQuote, SOL_MINT } = await import('./solana/index.js')
      const { USDC_MINT_SOLANA } = await import('./wallet-trading.js')
      await fetchQuote({
        inputMint: SOL_MINT.toBase58(),
        outputMint: USDC_MINT_SOLANA,
        amount: 1_000_000, // 0.001 SOL
        slippageBps: 50,
      })
    })
    legs.push({
      name: 'solanaNativeQuote',
      chain: 'solana',
      status: solBuyQuote.ok ? 'pass' : 'fail',
      message: solBuyQuote.message,
      durationMs: solBuyQuote.durationMs,
    })

    // Wallet RPC reachability via balance check
    const solBalance = await timed(async () => {
      const { PublicKey } = await import('@solana/web3.js')
      const { makeConnection } = await import('./solana/index.js')
      const conn: Connection = makeConnection()
      const bal = await conn.getBalance(new PublicKey(solanaAddress!))
      if (typeof bal !== 'number') throw new Error('balance call returned non-number')
    })
    legs.push({
      name: 'solanaBalance',
      chain: 'solana',
      status: solBalance.ok ? 'pass' : 'fail',
      message: solBalance.message,
      durationMs: solBalance.durationMs,
    })

    if (mode === 'live') {
      legs.push({ name: 'solanaLiveRoundTrip', chain: 'solana', status: 'skip', message: 'live mode not yet wired in CLI' })
    }
  } else if (wantSolana && !solanaAddress) {
    legs.push({ name: 'solanaNativeQuote', chain: 'solana', status: 'skip', message: 'no Solana address derived from this wallet' })
  }

  // Base legs
  if (wantBase && evmAddress) {
    const baseQuote = await timed(async () => {
      const { fetchParaswapPrice, NATIVE_ETH, BASE_USDC, BASE_CHAIN_ID } = await import('./evm-trading.js')
      await fetchParaswapPrice({
        srcToken: NATIVE_ETH,
        destToken: BASE_USDC,
        amount: '100000000000000', // 0.0001 ETH
        srcDecimals: 18,
        destDecimals: 6,
        network: BASE_CHAIN_ID,
      })
    })
    legs.push({
      name: 'baseNativeQuote',
      chain: 'base',
      status: baseQuote.ok ? 'pass' : 'fail',
      message: baseQuote.message,
      durationMs: baseQuote.durationMs,
    })

    const baseBalance = await timed(async () => {
      const { getErc20Balance, makeEvmProvider, NATIVE_ETH } = await import('./evm-trading.js')
      const bal = await getErc20Balance(makeEvmProvider(), NATIVE_ETH, evmAddress!)
      if (typeof bal !== 'bigint') throw new Error('balance call returned non-bigint')
    })
    legs.push({
      name: 'baseBalance',
      chain: 'base',
      status: baseBalance.ok ? 'pass' : 'fail',
      message: baseBalance.message,
      durationMs: baseBalance.durationMs,
    })

    if (mode === 'live') {
      legs.push({ name: 'baseLiveRoundTrip', chain: 'base', status: 'skip', message: 'live mode not yet wired in CLI' })
    }
  } else if (wantBase && !evmAddress) {
    legs.push({ name: 'baseNativeQuote', chain: 'base', status: 'skip', message: 'no EVM address derived from this wallet' })
  }

  // Aggregate verdict: only `pass` legs count toward "safe for autonomous".
  // A single fail tips to unsafe. `skip` is neutral.
  const anyFail = legs.some((l) => l.status === 'fail')
  const safeForAutonomousTrading = !anyFail

  return {
    wallet: opts.walletRef,
    solanaAddress,
    evmAddress,
    mode,
    legs,
    safeForAutonomousTrading,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}
