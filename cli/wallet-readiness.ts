/**
 * `palmyr wallet readiness` — the stronger sibling of `doctor` + `smoke-test`.
 *
 * Single command that returns a go/no-go verdict for autonomous trading. It
 * answers the agent's checklist:
 *   - can sign Solana? can sign Base?
 *   - has enough gas / native balance to actually trade?
 *   - can fetch a Solana quote? a Base quote?
 *   - is the daemon running for this wallet?
 *   - how many open positions does it already hold?
 *   - safeForAutonomousTrading: boolean (the headline)
 *
 * Output is stable JSON so agents can branch on individual fields without
 * grepping the dump.
 */
import type { Connection } from '@solana/web3.js'

export interface ReadinessCheck {
  name: string
  status: 'pass' | 'warn' | 'fail' | 'skip'
  value?: string | number | boolean
  message?: string
}

export interface ReadinessReport {
  wallet: string
  solanaAddress: string | null
  evmAddress: string | null
  /** Aggregate verdict — true only when every required check is `pass`. */
  safeForAutonomousTrading: boolean
  checks: ReadinessCheck[]
  /** Open position count by chain, plus total. */
  openPositions: {
    solana: number
    base: number
    total: number
  }
  /** Native-asset balances on each chain (display + raw). */
  balances: {
    solana: { lamports: number; sol: number } | null
    base: { wei: string; eth: number } | null
  }
  /** Daemon process state — running flag + pid if any. */
  daemon: {
    running: boolean
    pid: number | null
    lastTick: string | null
    autoExecute: boolean | null
    walletRef: string | null
  }
}

export interface ReadinessOpts {
  walletRef: string
  passphrase?: string
  /**
   * Minimum native balance (lamports / wei) required to count as "has gas".
   * Defaults are intentionally low — the goal is "can sign + send", not "well
   * funded". Callers tuning for big trades should pass explicit thresholds.
   */
  minSolLamports?: number
  minEthWei?: bigint
}

const DEFAULT_MIN_SOL_LAMPORTS = 1_000_000   // 0.001 SOL — covers fees + a few tx
const DEFAULT_MIN_ETH_WEI = 100_000_000_000_000n // 0.0001 ETH

export async function runWalletReadiness(opts: ReadinessOpts): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = []
  const minSol = opts.minSolLamports ?? DEFAULT_MIN_SOL_LAMPORTS
  const minEth = opts.minEthWei ?? DEFAULT_MIN_ETH_WEI

  // Resolve addresses for both chains.
  let solanaAddress: string | null = null
  let evmAddress: string | null = null
  try {
    const { resolveWalletAddresses } = await import('./wallet-trading.js')
    const addrs = await resolveWalletAddresses(opts.walletRef, opts.passphrase)
    solanaAddress = addrs.solanaAddress
    evmAddress = addrs.evmAddress
  } catch (e: any) {
    checks.push({ name: 'walletResolution', status: 'fail', message: e?.message ?? 'failed' })
  }
  checks.push({ name: 'canSignSolana', status: solanaAddress ? 'pass' : 'fail', value: solanaAddress ?? false })
  checks.push({ name: 'canSignBase', status: evmAddress ? 'pass' : 'fail', value: evmAddress ?? false })

  // Native balance checks — done in parallel with quote checks below.
  const balanceTasks: Array<Promise<void>> = []
  let solBalance: { lamports: number; sol: number } | null = null
  let baseBalance: { wei: string; eth: number } | null = null

  if (solanaAddress) {
    balanceTasks.push((async () => {
      try {
        const { PublicKey } = await import('@solana/web3.js')
        const { makeConnection } = await import('./solana/index.js')
        const conn: Connection = makeConnection()
        const lamports = await conn.getBalance(new PublicKey(solanaAddress!))
        solBalance = { lamports, sol: lamports / 1e9 }
        const hasGas = lamports >= minSol
        checks.push({
          name: 'solanaHasGas',
          status: hasGas ? 'pass' : 'fail',
          value: `${(lamports / 1e9).toFixed(6)} SOL`,
          message: hasGas ? undefined : `< ${(minSol / 1e9).toFixed(6)} SOL min for tx fees`,
        })
      } catch (e: any) {
        checks.push({ name: 'solanaHasGas', status: 'fail', message: e?.message ?? 'balance check failed' })
      }
    })())
  } else {
    checks.push({ name: 'solanaHasGas', status: 'skip', message: 'no Solana address' })
  }

  if (evmAddress) {
    balanceTasks.push((async () => {
      try {
        const { getErc20Balance, makeEvmProvider, NATIVE_ETH } = await import('./evm-trading.js')
        const wei = await getErc20Balance(makeEvmProvider(), NATIVE_ETH, evmAddress!)
        const ethValue = Number(wei) / 1e18
        baseBalance = { wei: wei.toString(), eth: ethValue }
        const hasGas = wei >= minEth
        checks.push({
          name: 'baseHasGas',
          status: hasGas ? 'pass' : 'fail',
          value: `${ethValue.toFixed(8)} ETH`,
          message: hasGas ? undefined : `< ${(Number(minEth) / 1e18).toFixed(8)} ETH min for gas`,
        })
      } catch (e: any) {
        checks.push({ name: 'baseHasGas', status: 'fail', message: e?.message ?? 'balance check failed' })
      }
    })())
  } else {
    checks.push({ name: 'baseHasGas', status: 'skip', message: 'no EVM address' })
  }

  // Quote checks in parallel — trivial amounts, no signing.
  const quoteTasks: Array<Promise<void>> = []
  quoteTasks.push((async () => {
    if (!solanaAddress) {
      checks.push({ name: 'canQuoteSolana', status: 'skip', message: 'no Solana address' })
      return
    }
    try {
      const { fetchQuote, SOL_MINT } = await import('./solana/index.js')
      const { USDC_MINT_SOLANA } = await import('./wallet-trading.js')
      await fetchQuote({
        inputMint: SOL_MINT.toBase58(),
        outputMint: USDC_MINT_SOLANA,
        amount: 1_000_000,
        slippageBps: 50,
      })
      checks.push({ name: 'canQuoteSolana', status: 'pass' })
    } catch (e: any) {
      checks.push({ name: 'canQuoteSolana', status: 'fail', message: e?.message ?? 'quote failed' })
    }
  })())
  quoteTasks.push((async () => {
    if (!evmAddress) {
      checks.push({ name: 'canQuoteBase', status: 'skip', message: 'no EVM address' })
      return
    }
    try {
      const { fetchParaswapPrice, NATIVE_ETH, BASE_USDC, BASE_CHAIN_ID } = await import('./evm-trading.js')
      await fetchParaswapPrice({
        srcToken: NATIVE_ETH,
        destToken: BASE_USDC,
        amount: '100000000000000',
        srcDecimals: 18,
        destDecimals: 6,
        network: BASE_CHAIN_ID,
      })
      checks.push({ name: 'canQuoteBase', status: 'pass' })
    } catch (e: any) {
      checks.push({ name: 'canQuoteBase', status: 'fail', message: e?.message ?? 'quote failed' })
    }
  })())

  await Promise.all([...balanceTasks, ...quoteTasks])

  // Daemon status.
  let daemonRunning = false
  let daemonPid: number | null = null
  let daemonLastTick: string | null = null
  let daemonAuto: boolean | null = null
  let daemonWalletRef: string | null = null
  try {
    const { getDaemonStatus } = await import('./wallet-daemon.js')
    const status = getDaemonStatus()
    daemonRunning = status.running
    daemonPid = status.pid
    daemonLastTick = status.lastTick
    daemonAuto = status.opts?.autoExecute ?? null
    daemonWalletRef = status.opts?.walletRef ?? null
  } catch {}
  checks.push({
    name: 'daemonRunning',
    status: daemonRunning ? 'pass' : 'warn',
    value: daemonRunning,
    message: daemonRunning ? undefined : 'daemon not running — run `palmyr wallet daemon start --auto --wallet <ref>` for autonomous monitoring',
  })

  // Open position counts. Cross-chain by default.
  let openSolana = 0
  let openBase = 0
  try {
    const { listPositions } = await import('./wallet-trading.js')
    const addrs = [solanaAddress, evmAddress].filter((x): x is string => !!x)
    if (addrs.length > 0) {
      const positions = listPositions({ walletAddress: addrs, includeClosed: false })
      openSolana = positions.filter((p) => p.chain === 'solana').length
      openBase = positions.filter((p) => p.chain === 'base').length
    }
  } catch {}
  checks.push({
    name: 'openPositions',
    status: 'pass',
    value: openSolana + openBase,
    message: `solana=${openSolana} base=${openBase}`,
  })

  const requiredChecks = ['canSignSolana', 'canSignBase', 'solanaHasGas', 'baseHasGas', 'canQuoteSolana', 'canQuoteBase']
  const safeForAutonomousTrading = !checks.some(
    (c) => requiredChecks.includes(c.name) && c.status === 'fail',
  )

  return {
    wallet: opts.walletRef,
    solanaAddress,
    evmAddress,
    safeForAutonomousTrading,
    checks,
    openPositions: {
      solana: openSolana,
      base: openBase,
      total: openSolana + openBase,
    },
    balances: {
      solana: solBalance,
      base: baseBalance,
    },
    daemon: {
      running: daemonRunning,
      pid: daemonPid,
      lastTick: daemonLastTick,
      autoExecute: daemonAuto,
      walletRef: daemonWalletRef,
    },
  }
}
