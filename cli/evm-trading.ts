/**
 * EVM trading primitives — Phase 5a (Base focus, generic over chainId).
 *
 * ParaSwap v6.2 free API is the swap aggregator: no API key, multi-chain,
 * cleaner than 0x v2 (which now requires a paid key). Two-step flow:
 *   1. GET /prices — returns a price route
 *   2. POST /transactions/<network> — returns a ready-to-sign tx blob
 *
 * Signing + sending uses ethers v6 (already a cli dep). For dry-run we skip
 * the build-tx + send entirely and return the quoted output.
 *
 * Output amount comes from parsing the ERC20 `Transfer` event in the receipt
 * (or the balance delta for native ETH output) — same idea as the Solana
 * tx-balance parsing in cli/solana/jupiter.ts.
 */
import { ethers } from 'ethers'

const PARASWAP_API = 'https://api.paraswap.io'

/**
 * Structured route error. Thrown by the route-fetching helpers (Jupiter,
 * ParaSwap) so CLI callers can return stable JSON shape + exit code to agents.
 *
 * `errorCode` is a stable identifier — agents pattern-match on it rather than
 * the raw error message. Known codes:
 *   - TOKEN_NOT_TRADABLE: provider says the token isn't tradable
 *   - NO_ROUTE: provider can't find a route with sufficient liquidity
 *   - RATE_LIMITED: provider returned 429 after the retry loop gave up
 *   - PROVIDER_ERROR: generic upstream failure (5xx, parse failure)
 */
export class RouteError extends Error {
  readonly errorCode: 'TOKEN_NOT_TRADABLE' | 'NO_ROUTE' | 'RATE_LIMITED' | 'PROVIDER_ERROR'
  readonly provider: 'jupiter' | 'paraswap'
  readonly chain: 'solana' | 'base'
  readonly status?: number

  constructor(
    code: RouteError['errorCode'],
    provider: RouteError['provider'],
    chain: RouteError['chain'],
    message: string,
    status?: number,
  ) {
    super(message)
    this.name = 'RouteError'
    this.errorCode = code
    this.provider = provider
    this.chain = chain
    this.status = status
  }
}

/** ParaSwap's placeholder for native ETH (lowercase eee). Must match exactly. */
export const NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

/** Base mainnet chain ID. */
export const BASE_CHAIN_ID = 8453

/** Common Base mainnet token addresses. */
export const BASE_WETH = '0x4200000000000000000000000000000000000006'
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** Default Base RPC. Caller can override via cfg or env. */
export const DEFAULT_BASE_RPC = 'https://mainnet.base.org'

/**
 * Phase 5d — protected Base RPC. There is no canonical free public MEV-protected
 * endpoint for Base in the way Jito is for Solana, so we read from env/config.
 * Resolution order:
 *   1. opts.rpcUrl (--rpc flag)        — explicit override
 *   2. PALMYR_BASE_PROTECTED_RPC env   — user-configured private mempool
 *   3. opts.protected → DEFAULT        — falls back to public Base RPC with
 *                                        a bumped EIP-1559 priority fee so
 *                                        the swap gets included quickly
 * Examples users plug in: Merkle, Blocknative blxr, Flashbots Protect on Base.
 */
export function resolveBaseRpcUrl(opts: {
  rpcUrl?: string
  protectedExec?: boolean
}): string {
  if (opts.rpcUrl) return opts.rpcUrl
  if (opts.protectedExec) {
    const envRpc = process.env.PALMYR_BASE_PROTECTED_RPC?.trim()
    if (envRpc) return envRpc
  }
  return DEFAULT_BASE_RPC
}

/**
 * Phase 5d — default priority fee tip (EIP-1559 maxPriorityFeePerGas) used
 * when --protected is set on Base. 0.001 gwei = 1_000_000 wei. Base typically
 * has near-zero base fee, so even a tiny tip puts you ahead of the queue.
 */
export const DEFAULT_BASE_PROTECTED_TIP_GWEI = 0.001
export const DEFAULT_BASE_PROTECTED_TIP_WEI = 1_000_000n

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// WETH9 Withdrawal(address indexed src, uint wad) — emitted when wrapped ETH is
// unwrapped back to native ETH. We cross-check this against the native balance
// delta when destToken is native ETH to catch under-counting from missing
// `receipt.gasPrice` data.
const WETH_WITHDRAWAL_TOPIC =
  '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'

export interface ParaswapPriceRoute {
  blockNumber: number
  network: number
  srcToken: string
  srcDecimals: number
  srcAmount: string
  destToken: string
  destDecimals: number
  destAmount: string
  bestRoute: unknown[]
  gasCost: string
  side: 'SELL' | 'BUY'
  [k: string]: unknown
}

export interface FetchPriceParams {
  srcToken: string
  destToken: string
  amount: string            // raw integer string (wei / smallest unit)
  srcDecimals: number
  destDecimals: number
  network: number
  side?: 'SELL' | 'BUY'
}

export async function fetchParaswapPrice(p: FetchPriceParams): Promise<ParaswapPriceRoute> {
  const side = p.side ?? 'SELL'
  const url =
    `${PARASWAP_API}/prices?srcToken=${p.srcToken}&destToken=${p.destToken}` +
    `&amount=${p.amount}&srcDecimals=${p.srcDecimals}&destDecimals=${p.destDecimals}` +
    `&network=${p.network}&side=${side}`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text()
    // 404 "No routes found with enough liquidity" is the most common
    // diagnostic — agents should pattern-match on `errorCode`, not the raw text.
    if (res.status === 404 && /no routes? found/i.test(body)) {
      throw new RouteError('NO_ROUTE', 'paraswap', 'base', `ParaSwap: no route for ${p.destToken}`, 404)
    }
    if (res.status === 429) {
      throw new RouteError('RATE_LIMITED', 'paraswap', 'base', `ParaSwap rate limit hit: ${body}`, 429)
    }
    throw new RouteError('PROVIDER_ERROR', 'paraswap', 'base', `ParaSwap price failed: ${res.status} ${body}`, res.status)
  }
  const data = (await res.json()) as { priceRoute?: ParaswapPriceRoute; error?: string }
  if (data.error || !data.priceRoute) {
    if (/no routes? found/i.test(data.error ?? '')) {
      throw new RouteError('NO_ROUTE', 'paraswap', 'base', `ParaSwap: ${data.error}`)
    }
    throw new RouteError('PROVIDER_ERROR', 'paraswap', 'base', `ParaSwap price: ${data.error ?? 'no priceRoute in response'}`)
  }
  return data.priceRoute
}

interface ParaswapTxBlob {
  from: string
  to: string
  data: string
  value: string
  gas: string
  gasPrice?: string
  chainId: number
}

export async function buildParaswapTx(
  priceRoute: ParaswapPriceRoute,
  userAddress: string,
  slippageBps: number,
  network: number,
): Promise<ParaswapTxBlob> {
  const url = `${PARASWAP_API}/transactions/${network}?ignoreChecks=true`
  // ParaSwap v6.2 rejects the build when both `destAmount` and `slippage` are
  // supplied ("Cannot specify both slippage and destAmount"). On SELL routes
  // we send `slippage` and omit `destAmount` so the executor applies the bps
  // tolerance to the route's destAmount internally. On BUY routes (which we
  // don't currently use, but the contract handles), `srcAmount` is the floor
  // and `destAmount` is exact — there `slippage` would be the one to omit.
  const isBuySide = priceRoute.side === 'BUY'
  const body: Record<string, unknown> = {
    priceRoute,
    userAddress,
    srcToken: priceRoute.srcToken,
    destToken: priceRoute.destToken,
    srcAmount: priceRoute.srcAmount,
    srcDecimals: priceRoute.srcDecimals,
    destDecimals: priceRoute.destDecimals,
  }
  if (isBuySide) {
    body.destAmount = priceRoute.destAmount
  } else {
    body.slippage = slippageBps
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`ParaSwap transactions failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as ParaswapTxBlob
}

export interface EvmSwapParams {
  provider: ethers.Provider
  wallet: ethers.Wallet
  srcToken: string
  destToken: string
  srcAmount: string                // raw u256 integer string
  srcDecimals: number
  destDecimals: number
  slippageBps: number
  chainId: number
  dryRun?: boolean
  /**
   * Phase 5c — optional hook that fires AFTER the swap tx has been built
   * (so the caller knows the router/spender address from txBlob.to) but
   * BEFORE the tx is signed and sent. Use this to run ERC20 approvals for
   * token-input swaps.
   *
   * `spender` is the ACTUAL ERC20 spender (ParaSwap's tokenTransferProxy when
   * the route reports one, otherwise the Augustus router at `to`). Approving
   * the wrong one causes the underlying `transferFrom` to revert with
   * "SafeERC20: low-level call failed" on partial sells. Always approve
   * `spender`, not `to`.
   */
  onTxBuilt?: (txBlob: { to: string; spender: string; value: string; data: string; chainId: number }) => Promise<void>
  /**
   * Phase 5d — extra priority fee (EIP-1559 maxPriorityFeePerGas) in wei.
   * When set, overrides ParaSwap's gasPrice with type-2 fields and bumps the
   * tip so the tx jumps the inclusion queue. Used by `--protected` on Base.
   */
  priorityFeeWei?: bigint
}

export interface EvmSwapResult {
  txHash: string
  srcAmount: string                // raw integer string
  destAmount: string               // realized raw out (parsed from logs)
  quotedDestAmount: string         // ParaSwap's promise
  gasUsed: string                  // u256 as string (BigInt-safe)
  effectiveGasPriceWei: string
  feeWei: string                   // gasUsed * effectiveGasPrice
}

/**
 * One-shot EVM swap: price → build tx → sign → send → confirm → parse realized
 * destAmount from receipt logs (Transfer event for ERC20 output, balance delta
 * for native ETH output).
 */
export async function executeEvmSwap(params: EvmSwapParams): Promise<EvmSwapResult> {
  const priceRoute = await fetchParaswapPrice({
    srcToken: params.srcToken,
    destToken: params.destToken,
    amount: params.srcAmount,
    srcDecimals: params.srcDecimals,
    destDecimals: params.destDecimals,
    network: params.chainId,
  })
  const quotedDestAmount = priceRoute.destAmount

  if (params.dryRun) {
    return {
      txHash: `dryrun_${Date.now()}`,
      srcAmount: params.srcAmount,
      destAmount: quotedDestAmount,
      quotedDestAmount,
      gasUsed: '0',
      effectiveGasPriceWei: '0',
      feeWei: '0',
    }
  }

  const userAddr = await params.wallet.getAddress()
  const txBlob = await buildParaswapTx(priceRoute, userAddr, params.slippageBps, params.chainId)

  // ParaSwap v6 splits the call target (Augustus, `txBlob.to`) from the ERC20
  // spender that actually pulls user tokens via transferFrom. The spender lives
  // on `priceRoute.tokenTransferProxy`; for native-ETH input there's no
  // approval needed so we fall back to `to` (the value is unused). Approving
  // the wrong contract was the cause of "SafeERC20: low-level call failed"
  // reverts on partial sells.
  const tokenTransferProxy = typeof (priceRoute as Record<string, unknown>).tokenTransferProxy === 'string'
    ? ((priceRoute as Record<string, unknown>).tokenTransferProxy as string)
    : txBlob.to

  // Phase 5c — hook for ERC20 approval (or anything else that depends on knowing
  // the router address before send). Runs after the swap tx is built.
  if (params.onTxBuilt) {
    await params.onTxBuilt({
      to: txBlob.to,
      spender: tokenTransferProxy,
      value: txBlob.value,
      data: txBlob.data,
      chainId: txBlob.chainId,
    })
  }

  // ParaSwap occasionally returns a tx blob without a `gas` field. Fall back
  // to a local estimate so we don't throw on `BigInt(undefined)`. 10% buffer
  // either way to avoid out-of-gas reverts under load.
  let gasLimit: bigint
  if (txBlob.gas) {
    gasLimit = (BigInt(txBlob.gas) * 110n) / 100n
  } else {
    try {
      const estimated = await params.provider.estimateGas({
        from: userAddr,
        to: txBlob.to,
        data: txBlob.data,
        value: BigInt(txBlob.value),
      })
      gasLimit = (estimated * 110n) / 100n
    } catch (e: any) {
      throw new Error(
        `ParaSwap returned no gas estimate and local estimation reverted: ${e?.message ?? String(e)}`,
      )
    }
  }

  // For native ETH input: include `value`. For ERC20 input: ParaSwap returns
  // value="0" and the contract pulls via transferFrom (assumes prior approval).
  // Phase 5a doesn't auto-approve — Phase 5b adds Permit2.
  const txReq: ethers.TransactionRequest = {
    to: txBlob.to,
    data: txBlob.data,
    value: BigInt(txBlob.value),
    gasLimit,
    chainId: txBlob.chainId,
  }

  // Phase 5d — protected execution: send as EIP-1559 type-2 tx with an
  // explicit maxPriorityFeePerGas tip. We pull the current base fee from the
  // pending block and add the configured tip on top, so the tx is competitive
  // even under spikes. If the provider can't supply fee data we silently
  // fall back to legacy gasPrice (the provider's default).
  if (params.priorityFeeWei && params.priorityFeeWei > 0n) {
    try {
      const feeData = await params.provider.getFeeData()
      const baseFee = feeData.maxFeePerGas != null
        ? feeData.maxFeePerGas - (feeData.maxPriorityFeePerGas ?? 0n)
        : (feeData.gasPrice ?? 0n)
      const maxPriorityFeePerGas = params.priorityFeeWei
      // maxFee = baseFee * 2 (headroom for base-fee bumps mid-block) + tip
      const maxFeePerGas = (baseFee * 2n) + maxPriorityFeePerGas
      txReq.maxPriorityFeePerGas = maxPriorityFeePerGas
      txReq.maxFeePerGas = maxFeePerGas
      txReq.type = 2
    } catch {
      // ignore — fall through to legacy gasPrice from ParaSwap blob
    }
  }

  // Snapshot native balance to compute realized for ETH-output trades.
  const nativeBalancePre = params.destToken.toLowerCase() === NATIVE_ETH
    ? await params.provider.getBalance(userAddr)
    : 0n

  const tx = await params.wallet.sendTransaction(txReq)
  const receipt = await tx.wait(1)
  if (!receipt) throw new Error(`No receipt for ${tx.hash}`)
  if (receipt.status === 0) throw new Error(`Tx reverted: ${tx.hash}`)

  let destAmount = quotedDestAmount
  try {
    const destTokenLower = params.destToken.toLowerCase()
    if (destTokenLower === NATIVE_ETH) {
      // Native ETH output: balance change + gas fee = swap proceeds. Cross-check
      // against any WETH Withdrawal events targeting the user — those are the
      // authoritative source if the receipt's gasPrice is missing/zero, which
      // would otherwise under-count the swap output.
      const nativeBalancePost = await params.provider.getBalance(userAddr)
      const gasFee = receipt.gasUsed * (receipt.gasPrice ?? 0n)
      const balanceDelta = nativeBalancePost - nativeBalancePre + gasFee
      const userLower = userAddr.toLowerCase()
      let withdrawalAmount = 0n
      for (const log of receipt.logs) {
        if (log.topics[0] !== WETH_WITHDRAWAL_TOPIC) continue
        if (log.topics.length < 2) continue
        const srcAddr = ('0x' + log.topics[1].slice(26)).toLowerCase()
        // WETH Withdrawal's indexed `src` is the WETH holder being unwrapped.
        // ParaSwap typically unwraps on Augustus's behalf, so the src is the
        // router, not the user. In that case we accept the largest withdrawal
        // amount as a lower bound on the ETH delivered to the user.
        if (srcAddr === userLower || withdrawalAmount === 0n) {
          const wad = BigInt(log.data)
          if (wad > withdrawalAmount) withdrawalAmount = wad
        }
      }
      const change = balanceDelta > withdrawalAmount ? balanceDelta : withdrawalAmount
      if (change > 0n) destAmount = change.toString()
    } else {
      const userLower = userAddr.toLowerCase()
      for (const log of receipt.logs) {
        if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue
        if (log.address.toLowerCase() !== destTokenLower) continue
        // topics[2] is the padded "to" address. Lower 20 bytes.
        const toAddr = ('0x' + log.topics[2].slice(26)).toLowerCase()
        if (toAddr === userLower) {
          destAmount = BigInt(log.data).toString()
          break
        }
      }
    }
  } catch {
    // Best-effort — fall back to quoted on any parse failure.
  }

  const effectiveGasPrice = receipt.gasPrice ?? 0n
  return {
    txHash: tx.hash,
    srcAmount: params.srcAmount,
    destAmount,
    quotedDestAmount,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceWei: effectiveGasPrice.toString(),
    feeWei: (receipt.gasUsed * effectiveGasPrice).toString(),
  }
}

/** Build a default provider for Base. Caller can pass their own RPC URL. */
export function makeEvmProvider(rpcUrl: string = DEFAULT_BASE_RPC): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrl)
}

/**
 * Read ERC20 decimals on demand. Cheap call — caches per-process via the
 * Map so the same token is queried only once.
 */
const decimalsCache = new Map<string, number>()

export async function getErc20Decimals(
  provider: ethers.Provider,
  tokenAddress: string,
): Promise<number> {
  if (tokenAddress.toLowerCase() === NATIVE_ETH) return 18
  const key = `${tokenAddress.toLowerCase()}:${(await provider.getNetwork()).chainId}`
  const cached = decimalsCache.get(key)
  if (cached !== undefined) return cached
  const erc20 = new ethers.Contract(tokenAddress, ['function decimals() view returns (uint8)'], provider)
  const decimals = Number(await erc20.decimals())
  decimalsCache.set(key, decimals)
  return decimals
}

export async function getErc20Balance(
  provider: ethers.Provider,
  tokenAddress: string,
  owner: string,
): Promise<bigint> {
  if (tokenAddress.toLowerCase() === NATIVE_ETH) {
    return await provider.getBalance(owner)
  }
  const erc20 = new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address) view returns (uint256)'],
    provider,
  )
  return (await erc20.balanceOf(owner)) as bigint
}

/**
 * Phase 5c — ensure the connected wallet has approved `spender` to pull at least
 * `needed` units of `token`. Uses max-approval (2^256-1) when an approve tx
 * is required, which is standard for trading routers: saves gas on every
 * subsequent sell.
 *
 * Caller's responsibility: pass an ethers.Wallet that's `.connect()`ed to a
 * provider, and the ParaSwap router address as `spender` (the `to` field of
 * the price-route's transaction blob).
 */
const ERC20_ALLOWANCE_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]

export async function ensureErc20Approval(
  wallet: ethers.Wallet,
  token: string,
  spender: string,
  needed: bigint,
): Promise<{ approved: boolean; txHash?: string }> {
  if (token.toLowerCase() === NATIVE_ETH) return { approved: false } // native ETH doesn't need approval
  const erc20 = new ethers.Contract(token, ERC20_ALLOWANCE_ABI, wallet)
  const owner = await wallet.getAddress()
  const current = (await erc20.allowance(owner, spender)) as bigint
  if (current >= needed) return { approved: false }
  const max = (2n ** 256n) - 1n
  const tx = await erc20.approve(spender, max)
  const receipt = await tx.wait(1)
  if (!receipt || receipt.status === 0) {
    throw new Error(`ERC20 approval failed: ${tx.hash}`)
  }
  return { approved: true, txHash: tx.hash }
}

/**
 * Phase 5d — fetch USD spot price for SOL or ETH. Best-effort, returns null
 * on failure rather than throwing. Caller decides whether to show USD totals
 * or fall back to native units only.
 *
 * SOL: Jupiter price API (same source we use for entryMcap).
 * ETH: Coinbase public spot API — no key required, sub-second response.
 */
export async function fetchUsdPrice(asset: 'SOL' | 'ETH'): Promise<number | null> {
  try {
    if (asset === 'SOL') {
      // Jupiter price v3 (lite-api) — same family we use for the swap API.
      // v2 was retired by Jupiter in 2025; v3 keeps the {mint: {usdPrice}} shape.
      const SOL_MINT = 'So11111111111111111111111111111111111111112'
      const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`)
      if (!res.ok) return null
      const data = (await res.json()) as Record<string, { usdPrice?: number } | null>
      const price = data[SOL_MINT]?.usdPrice
      return typeof price === 'number' && isFinite(price) && price > 0 ? price : null
    }
    // ETH — Coinbase public spot, no key required.
    const res = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot')
    if (!res.ok) return null
    const data = (await res.json()) as { data?: { amount?: string } }
    const price = data.data?.amount ? Number(data.data.amount) : NaN
    return isFinite(price) && price > 0 ? price : null
  } catch {
    return null
  }
}
