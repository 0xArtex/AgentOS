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
 * tx-balance parsing in @palmyr/solana-trading/jupiter.ts.
 */
import { ethers } from 'ethers'

const PARASWAP_API = 'https://api.paraswap.io'

/** ParaSwap's placeholder for native ETH (lowercase eee). Must match exactly. */
export const NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

/** Base mainnet chain ID. */
export const BASE_CHAIN_ID = 8453

/** Common Base mainnet token addresses. */
export const BASE_WETH = '0x4200000000000000000000000000000000000006'
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** Default Base RPC. Caller can override via cfg or env. */
export const DEFAULT_BASE_RPC = 'https://mainnet.base.org'

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

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
    throw new Error(`ParaSwap price failed: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { priceRoute?: ParaswapPriceRoute; error?: string }
  if (data.error || !data.priceRoute) {
    throw new Error(`ParaSwap price: ${data.error ?? 'no priceRoute in response'}`)
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
  const body = {
    priceRoute,
    userAddress,
    srcToken: priceRoute.srcToken,
    destToken: priceRoute.destToken,
    srcAmount: priceRoute.srcAmount,
    destAmount: priceRoute.destAmount,
    srcDecimals: priceRoute.srcDecimals,
    destDecimals: priceRoute.destDecimals,
    slippage: slippageBps,
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

  // 10% buffer on gas to avoid out-of-gas reverts under load.
  const gasLimit = (BigInt(txBlob.gas) * 110n) / 100n

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
      // Native ETH output: balance change + gas fee = swap proceeds.
      const nativeBalancePost = await params.provider.getBalance(userAddr)
      const gasFee = receipt.gasUsed * (receipt.gasPrice ?? 0n)
      const change = nativeBalancePost - nativeBalancePre + gasFee
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
