/**
 * `palmyr wallet live-test` — executes tiny real round trips to validate
 * end-to-end trading. Unlike `smoke-test` (quote-only), this command actually
 * signs and sends transactions, then verifies the positions closed cleanly
 * with no leftover state.
 *
 * Bounds: `--budget Nusdc` caps the per-leg trade amount. Slippage + gas
 * realized losses are typically pennies for a 0.25 USDC round trip. Anything
 * larger than the budget will refuse to run.
 *
 * Output: stable JSON report with per-leg results, total realized PnL, and
 * `safeForAutonomousTrading` boolean for agent gating.
 */
import type { AssetAmount, AssetPnl } from './wallet-trading.js'

export interface LiveTestLeg {
  name: string
  chain: 'solana' | 'base'
  step: 'buy' | 'sell' | 'verify'
  status: 'pass' | 'fail' | 'skip'
  txHash?: string
  amountIn?: string
  output?: AssetAmount
  realized?: AssetPnl
  message?: string
  durationMs?: number
}

export interface LiveTestReport {
  wallet: string
  startedAt: string
  finishedAt: string
  budgetUsdc: number
  perLegUsdc: number
  legs: LiveTestLeg[]
  /** Total realized PnL in USDC across all legs that ran (negative = loss). */
  totalRealizedUsdc: number
  /** True only when every required leg passed AND no positions remain open. */
  safeForAutonomousTrading: boolean
  /** Open position count for this wallet after the test ran — should be 0. */
  openPositionsAfter: number
}

export interface LiveTestOpts {
  walletRef: string
  passphrase?: string
  /** USDC budget in human units (e.g. 1 = $1). Per-leg = budget / 2. */
  budgetUsdc: number
  /** Default: both chains. */
  chain?: 'solana' | 'base' | 'all'
}

/** Liquid test tokens with tight spreads — minimises slippage on tiny trades. */
const TEST_MINT_SOLANA = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const TEST_MINT_BASE = '0x4200000000000000000000000000000000000006' // WETH

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; durationMs: number } | { ok: false; message: string; durationMs: number }> {
  const t0 = Date.now()
  try {
    const value = await fn()
    return { ok: true, value, durationMs: Date.now() - t0 }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), durationMs: Date.now() - t0 }
  }
}

export async function runWalletLiveTest(opts: LiveTestOpts): Promise<LiveTestReport> {
  const startedAt = new Date().toISOString()
  if (!(opts.budgetUsdc > 0)) {
    throw new Error('--budget required, e.g. --budget 1usdc')
  }
  if (opts.budgetUsdc > 10) {
    throw new Error(`--budget ${opts.budgetUsdc}usdc exceeds the live-test ceiling ($10). Trade manually for larger sizes.`)
  }
  const perLegUsdc = opts.budgetUsdc / 2
  const perLegAmountStr = `${perLegUsdc.toFixed(6)}usdc`
  const wantSolana = !opts.chain || opts.chain === 'solana' || opts.chain === 'all'
  const wantBase = !opts.chain || opts.chain === 'base' || opts.chain === 'all'

  const legs: LiveTestLeg[] = []
  let totalRealizedUsdc = 0

  const { resolveWalletAddresses, buy, sell, buyBase, sellBase, listPositions } = await import('./wallet-trading.js')
  const addrs = await resolveWalletAddresses(opts.walletRef, opts.passphrase)

  // Solana round trip
  if (wantSolana && addrs.solanaAddress) {
    const solBuy = await timed(() => buy({
      ca: TEST_MINT_SOLANA,
      amount: perLegAmountStr,
      thesis: 'live-test round trip',
      walletRef: opts.walletRef,
      passphrase: opts.passphrase,
    }))
    if (!solBuy.ok) {
      legs.push({ name: 'solana-buy', chain: 'solana', step: 'buy', status: 'fail', message: solBuy.message, durationMs: solBuy.durationMs })
    } else {
      legs.push({
        name: 'solana-buy',
        chain: 'solana',
        step: 'buy',
        status: 'pass',
        txHash: solBuy.value.txSignature,
        amountIn: solBuy.value.amountIn,
        durationMs: solBuy.durationMs,
      })
      const solSell = await timed(() => sell({
        ca: TEST_MINT_SOLANA,
        percent: 100,
        reason: 'live-test close',
        walletRef: opts.walletRef,
        passphrase: opts.passphrase,
      }))
      if (!solSell.ok) {
        legs.push({ name: 'solana-sell', chain: 'solana', step: 'sell', status: 'fail', message: solSell.message, durationMs: solSell.durationMs })
      } else {
        legs.push({
          name: 'solana-sell',
          chain: 'solana',
          step: 'sell',
          status: 'pass',
          txHash: solSell.value.txSignature,
          output: solSell.value.output,
          realized: solSell.value.realized,
          durationMs: solSell.durationMs,
        })
        if (solSell.value.realized.asset === 'USDC') {
          totalRealizedUsdc += solSell.value.realized.amount
        }
      }
    }
  } else if (wantSolana) {
    legs.push({ name: 'solana-buy', chain: 'solana', step: 'buy', status: 'skip', message: 'no Solana address' })
  }

  // Base round trip
  if (wantBase && addrs.evmAddress) {
    const baseBuy = await timed(() => buyBase({
      ca: TEST_MINT_BASE,
      amount: perLegAmountStr,
      thesis: 'live-test round trip',
      walletRef: opts.walletRef,
      passphrase: opts.passphrase,
    }))
    if (!baseBuy.ok) {
      legs.push({ name: 'base-buy', chain: 'base', step: 'buy', status: 'fail', message: baseBuy.message, durationMs: baseBuy.durationMs })
    } else {
      legs.push({
        name: 'base-buy',
        chain: 'base',
        step: 'buy',
        status: 'pass',
        txHash: baseBuy.value.txHash,
        amountIn: baseBuy.value.amountIn,
        durationMs: baseBuy.durationMs,
      })
      const baseSell = await timed(() => sellBase({
        ca: TEST_MINT_BASE,
        percent: 100,
        reason: 'live-test close',
        walletRef: opts.walletRef,
        passphrase: opts.passphrase,
      }))
      if (!baseSell.ok) {
        legs.push({ name: 'base-sell', chain: 'base', step: 'sell', status: 'fail', message: baseSell.message, durationMs: baseSell.durationMs })
      } else {
        legs.push({
          name: 'base-sell',
          chain: 'base',
          step: 'sell',
          status: 'pass',
          txHash: baseSell.value.txHash,
          output: baseSell.value.output,
          realized: baseSell.value.realized,
          durationMs: baseSell.durationMs,
        })
        if (baseSell.value.realized.asset === 'USDC') {
          totalRealizedUsdc += baseSell.value.realized.amount
        }
      }
    }
  } else if (wantBase) {
    legs.push({ name: 'base-buy', chain: 'base', step: 'buy', status: 'skip', message: 'no EVM address' })
  }

  // Verify no positions left open *for this test*. The previous behaviour was
  // to fail the test whenever ANY position remained open on the wallet, even
  // unrelated ones the user opened before live-test ran. The 2026-05-25
  // dogfood hit exactly that — both Base and Solana legs succeeded but the
  // final verify fail-flagged a wallet that already had legitimate live
  // positions from real trading.
  //
  // Scope the check to the two test mints (JUP on Solana, WETH on Base): if
  // those are open at the end, this test leaked. Anything else open is
  // pre-existing user state, reported separately so the agent gating signal
  // doesn't lose that info.
  const walletAddrs = [addrs.solanaAddress, addrs.evmAddress].filter((x): x is string => !!x)
  const allOpen = walletAddrs.length > 0
    ? listPositions({ walletAddress: walletAddrs, includeClosed: false })
    : []
  const TEST_MINTS_LOWER = new Set([TEST_MINT_SOLANA.toLowerCase(), TEST_MINT_BASE.toLowerCase()])
  const leaked = allOpen.filter((p) => TEST_MINTS_LOWER.has(String(p.mint).toLowerCase()))
  const preExisting = allOpen.filter((p) => !TEST_MINTS_LOWER.has(String(p.mint).toLowerCase()))
  legs.push({
    name: 'verify-no-open-positions',
    chain: leaked[0]?.chain ?? preExisting[0]?.chain ?? 'solana',
    step: 'verify',
    status: leaked.length === 0 ? 'pass' : 'fail',
    message: leaked.length === 0
      ? (preExisting.length > 0
          ? `Test roundtrip cleanly closed. ${preExisting.length} unrelated pre-existing position(s) remain (not from live-test): ${preExisting.map((p) => `${p.chain}:${p.mint}`).join(', ')}`
          : undefined)
      : `${leaked.length} live-test position(s) still open: ${leaked.map((p) => `${p.chain}:${p.mint}`).join(', ')}`,
  })

  const anyFail = legs.some((l) => l.status === 'fail')
  const safeForAutonomousTrading = !anyFail && Math.abs(totalRealizedUsdc) <= opts.budgetUsdc

  return {
    wallet: opts.walletRef,
    startedAt,
    finishedAt: new Date().toISOString(),
    budgetUsdc: opts.budgetUsdc,
    perLegUsdc,
    legs,
    totalRealizedUsdc,
    safeForAutonomousTrading,
    openPositionsAfter: leaked.length,
  }
}
