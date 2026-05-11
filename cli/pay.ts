/**
 * x402 payment handler for Palmyr CLI
 * Supports both Solana (SPL USDC transfer) and Base/EVM (EIP-3009 TransferWithAuthorization).
 * Both flows are gasless: the server/facilitator absorbs chain fees.
 */

import { createRequire } from 'module'
import { loadKeypair, loadConfig, log } from './config.js'
import { getVaultSolanaKeypair, getVaultEvmWallet, hasVaultWallets, listVaultWallets } from './vault.js'
import type { Keypair as SolanaKeypair } from '@solana/web3.js'

const require = createRequire(import.meta.url)

// Solana constants
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

// Base constants
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_CHAIN_ID = 8453

/**
 * A single PaymentRequirements entry from the 402 response (one per chain).
 * Keeps the full server-supplied object so it can be echoed back verbatim
 * in the PaymentPayload's `accepted` field — the canonical x402 v2 client
 * (`@x402/core/client/createPaymentPayload`) and the CDP facilitator's zod
 * validators both reject a stubbed `{ scheme, network }`.
 */
interface PaymentOption {
  amount: bigint
  payTo: string
  feePayer: string
  asset: string
  network: string
  /** Full PaymentRequirements object — echo this into `paymentPayload.accepted`. */
  requirements: Record<string, any>
}

/**
 * Parse a 402 response. Returns available payment options by chain plus the
 * top-level `resource` block so callers can echo it into the PaymentPayload.
 */
export function parsePaymentRequired(data: any): {
  solana: PaymentOption | null
  base: PaymentOption | null
  resource: any
  extensions: any
} {
  const accepts = data.accepts || []
  const sol = accepts.find((a: any) => a.network?.startsWith('solana:'))
  const evm = accepts.find((a: any) => a.network?.startsWith('eip155:'))
  return {
    solana: sol ? {
      amount: BigInt(sol.amount),
      payTo: sol.payTo,
      feePayer: sol.extra?.feePayer || '',
      asset: sol.asset || USDC_MINT,
      network: sol.network,
      requirements: sol,
    } : null,
    base: evm ? {
      amount: BigInt(evm.amount),
      payTo: evm.payTo,
      feePayer: '', // facilitator handles gas
      asset: evm.asset || BASE_USDC,
      network: evm.network,
      requirements: evm,
    } : null,
    resource: data.resource,
    extensions: data.extensions,
  }
}

/**
 * Resolve the Solana payer keypair. Prefers a vault wallet (Palmyr native,
 * BIP-39 encrypted, requires passphrase) and falls back to a legacy keyfile.
 *
 * Vault wallet selection order:
 *   1. walletId argument (explicit)
 *   2. config.defaultPayWalletId
 *   3. PALMYR_PAY_WALLET env var
 *   4. First vault wallet with a Solana address
 *
 * Passphrase resolution:
 *   1. passphrase argument (explicit)
 *   2. PALMYR_WALLET_PASSPHRASE env var
 */
function resolvePayerKeypair(walletId?: string, passphrase?: string): SolanaKeypair | null {
  const cfg = loadConfig()
  const pass = passphrase || process.env.PALMYR_WALLET_PASSPHRASE

  // Try the vault first (session secret from OS cred store, falls back to passphrase)
  if (hasVaultWallets()) {
    const targetId = walletId || (cfg as any).defaultPayWalletId || process.env.PALMYR_PAY_WALLET
    try {
      if (targetId) return getVaultSolanaKeypair(targetId, pass)
      const wallets = listVaultWallets()
      const first = wallets.find(w => w.solanaAddress)
      if (first) return getVaultSolanaKeypair(first.id, pass)
    } catch (err: any) {
      console.error(`  Vault wallet load failed: ${err.message}`)
      // Fall through to keyfile
    }
  }

  // Fall back to the legacy keyfile flow
  const keypairBytes = loadKeypair()
  if (!keypairBytes) return null
  const { Keypair } = require('@solana/web3.js')
  return Keypair.fromSecretKey(keypairBytes) as SolanaKeypair
}

/**
 * Build and partially sign a USDC transfer transaction for x402 payment.
 * Uses raw keypair for transaction building (needed for multi-instruction Solana txs).
 */
export async function buildPaymentTransaction(
  payTo: string,
  amount: bigint,
  feePayer: string,
  walletId?: string,
  passphrase?: string,
): Promise<{ transaction: string; payer: string } | null> {
  const payer = resolvePayerKeypair(walletId, passphrase)
  if (!payer) {
    console.error('  No wallet configured. Create one with: palmyr wallet create')
    console.error('  Or configure a keyfile: palmyr setup --keyfile /path/to/keypair.json')
    return null
  }

  // Dynamic import to keep CLI fast when payment isn't needed
  const { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import('@solana/web3.js')
  const { getAssociatedTokenAddress, createTransferCheckedInstruction, getMint } = await import('@solana/spl-token')

  const connection = new Connection(SOLANA_RPC, 'confirmed')
  const payerPub = payer.publicKey
  const feePayerPub = new PublicKey(feePayer)
  const recipientPub = new PublicKey(payTo)
  const mintPub = new PublicKey(USDC_MINT)

  // Get token accounts
  const sourceAta = await getAssociatedTokenAddress(mintPub, payerPub)
  const destAta = await getAssociatedTokenAddress(mintPub, recipientPub)

  // Get mint info for decimals
  const mintInfo = await getMint(connection, mintPub)

  // Build transfer instruction
  const transferIx = createTransferCheckedInstruction(
    sourceAta, mintPub, destAta, payerPub, amount, mintInfo.decimals
  )

  // Compute budget
  const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 20000 })
  const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })

  // Memo for uniqueness
  const memoIx = {
    keys: [],
    programId: new PublicKey(MEMO_PROGRAM),
    data: Buffer.from(crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''))
  }

  // Get blockhash
  const { blockhash } = await connection.getLatestBlockhash()

  // Build message with feePayer paying gas
  const message = new TransactionMessage({
    payerKey: feePayerPub,
    recentBlockhash: blockhash,
    instructions: [computeLimitIx, computePriceIx, transferIx, memoIx],
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)

  // Partially sign with our key (feePayer signs on the server)
  tx.sign([payer])

  // Serialize to base64
  const serialized = Buffer.from(tx.serialize()).toString('base64')

  return {
    transaction: serialized,
    payer: payerPub.toBase58(),
  }
}

/**
 * Make a paid request: call endpoint → if 402 → build payment → retry with payment
 *
 * Passphrase resolution: explicit arg → PALMYR_WALLET_PASSPHRASE env var → fail
 */
/**
 * Build and sign an EIP-3009 TransferWithAuthorization for Base USDC.
 * The user signs a typed data message; the facilitator submits the on-chain call.
 * Gasless for the user — no ETH required.
 */
async function buildEvmPaymentAuthorization(
  payTo: string,
  amount: bigint,
  walletId?: string,
  passphrase?: string,
): Promise<{ signature: string; authorization: any; payer: string } | null> {
  const cfg = loadConfig()
  const targetId = walletId || (cfg as any).defaultPayWalletId || process.env.PALMYR_PAY_WALLET
  if (!targetId) return null

  let evmWallet: any
  try {
    evmWallet = getVaultEvmWallet(targetId, passphrase)
  } catch (err: any) {
    console.error(`  Vault wallet load failed: ${err.message}`)
    return null
  }

  const { ethers } = require('ethers')

  // Random 32-byte nonce
  const nonce = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')
  const validAfter = 0
  const validBefore = Math.floor(Date.now() / 1000) + 3600 // 1 hour

  // EIP-3009 TransferWithAuthorization for Base USDC (Circle USDC v2)
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: BASE_CHAIN_ID,
    verifyingContract: BASE_USDC,
  }

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  }

  const message = {
    from: evmWallet.address,
    to: ethers.getAddress(payTo),
    value: amount.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  }

  const signature = await evmWallet.signTypedData(domain, types, message)

  return {
    signature,
    authorization: {
      from: evmWallet.address,
      to: ethers.getAddress(payTo),
      value: amount.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
    payer: evmWallet.address,
  }
}

/**
 * Construct a spec-compliant x402 v2 PaymentPayload.
 *
 * The canonical shape (from `@x402/core` types — `PaymentPayload`) is:
 *
 *   { x402Version, resource, accepted: <full PaymentRequirements>, payload, extensions? }
 *
 * Echoing the FULL `accepted` object (asset, amount, payTo, maxTimeoutSeconds,
 * extra) and the top-level `resource` block is non-negotiable on the EVM/CDP
 * facilitator path: Coinbase's API runs zod validation on `paymentPayload` and
 * rejects stubbed `{ scheme, network }` inputs with `cdp_verify_failed`. Our
 * own SVM verifier reads only `payload.transaction` and ignores `accepted`,
 * which is why the bug only manifested on Base.
 *
 * `extensions` is preserved opportunistically — the spec marks it optional and
 * some facilitators read flags out of it, so passing it through is harmless.
 */
function buildSpecCompliantPayload(opts: {
  payload: Record<string, unknown>
  requirements: Record<string, any>
  resource?: any
  extensions?: any
}): Record<string, any> {
  const out: Record<string, any> = {
    x402Version: 2,
    accepted: opts.requirements,
    payload: opts.payload,
  }
  if (opts.resource !== undefined) out.resource = opts.resource
  if (opts.extensions !== undefined) out.extensions = opts.extensions
  return out
}

/**
 * Like paidRequest, but returns the raw Response from the final paid call
 * so the caller can consume a streaming body (e.g. text/event-stream for i402).
 *
 * The probe request is always issued without a payment header to elicit the
 * server's 402 with proper payment-required metadata — this lets the server
 * advertise the exact amount due (critical for i402 /chat/:id/execute which
 * charges plan.total_cost_usdc rather than a fixed fee).
 */
export async function paidStreamRequest(
  api: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  passphrase?: string,
): Promise<{ response: Response; paid: boolean; amountUsdc: number; payer?: string }> {
  const probeOpts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  }
  if (body) probeOpts.body = JSON.stringify(body)

  const probeRes = await fetch(api + path, probeOpts)
  if (probeRes.status !== 402) {
    return { response: probeRes, paid: false, amountUsdc: 0 }
  }

  const probeData: any = await probeRes.json().catch(() => ({}))
  const options = parsePaymentRequired(probeData)
  const cfg = loadConfig()
  const preferredChain = ((cfg as any).defaultPayChain || 'solana') as 'solana' | 'base'
  const selected = preferredChain === 'base' ? options.base : options.solana
  if (!selected) {
    throw new Error(
      `Server did not offer ${preferredChain} payment for streaming endpoint. ` +
        `Received: ${JSON.stringify(probeData).slice(0, 200)}`,
    )
  }

  const amountUsdc = Number(selected.amount) / 1e6
  let paymentPayload: any
  let payer: string

  if (preferredChain === 'base') {
    const auth = await buildEvmPaymentAuthorization(selected.payTo, selected.amount, undefined, passphrase)
    if (!auth) throw new Error('Failed to build EVM payment authorization')
    paymentPayload = buildSpecCompliantPayload({
      payload: { signature: auth.signature, authorization: auth.authorization },
      requirements: selected.requirements,
      resource: options.resource,
      extensions: options.extensions,
    })
    payer = auth.payer
  } else {
    const tx = await buildPaymentTransaction(selected.payTo, selected.amount, selected.feePayer, undefined, passphrase)
    if (!tx) throw new Error('Failed to build Solana payment transaction')
    paymentPayload = buildSpecCompliantPayload({
      payload: { transaction: tx.transaction },
      requirements: selected.requirements,
      resource: options.resource,
      extensions: options.extensions,
    })
    payer = tx.payer
  }

  const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString('base64')
  const paidOpts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      // Spec header is `X-PAYMENT`; legacy `Payment-Signature` is sent for
      // backward compat with our older server build (drops a release after
      // both ends are confirmed on X-PAYMENT only).
      'X-PAYMENT': encoded,
      'Payment-Signature': encoded,
    },
  }
  if (body) paidOpts.body = JSON.stringify(body)

  const paidRes = await fetch(api + path, paidOpts)
  log(`stream payment: ${amountUsdc} USDC → ${path} on ${preferredChain} (payer: ${payer})`)
  return { response: paidRes, paid: true, amountUsdc, payer }
}

/**
 * Detect transient Solana errors that warrant rebuilding the tx with a fresh
 * blockhash and retrying. Most common: "Blockhash not found" (the blockhash
 * we signed against expired in flight, ~60s window).
 */
function isTransientSolanaError(message: string): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return (
    m.includes('blockhash not found') ||
    m.includes('block height exceeded') ||
    m.includes('blockhashnotfound')
  )
}

export async function paidRequest(
  api: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  passphrase?: string,
  attempt: number = 1,
): Promise<{ data: any; paid: boolean; txHash?: string }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  const allowsBody = method !== 'GET' && method !== 'HEAD'
  if (body && allowsBody) opts.body = JSON.stringify(body)

  // First attempt
  const res = await fetch(api + path, opts)
  const data = await res.json() as any

  // Not a 402 — return as-is
  if (res.status !== 402) {
    if (data.error) throw new Error(data.error)
    return { data, paid: false }
  }

  // 402 — need to pay. Chain is decided by config — no silent fallback.
  const options = parsePaymentRequired(data)
  const cfg = loadConfig()
  const preferredChain = ((cfg as any).defaultPayChain || 'solana') as 'solana' | 'base'

  const selected = preferredChain === 'base' ? options.base : options.solana
  if (!selected) {
    throw new Error(
      `Server did not offer ${preferredChain} as a payment option. ` +
      `Either the endpoint doesn't support ${preferredChain} yet, or use: palmyr wallet use <ID> --chain ${preferredChain === 'base' ? 'solana' : 'base'}`,
    )
  }

  const amountUsdc = Number(selected.amount) / 1e6
  let paymentPayload: any
  let payer: string

  // Only show the spinner when attached to an interactive terminal. Piped
  // output (agents running in cron / Docker / pipelines) stays clean JSON.
  const interactive = process.stdout.isTTY
  let spinner: any = null
  const chainLabel = preferredChain === 'base' ? 'Base (gasless)' : 'Solana'
  if (interactive) {
    const { Spinner } = await import('./ui.js')
    spinner = new Spinner()
    spinner.start(`Paying ${amountUsdc} USDC on ${chainLabel}`)
  }

  try {
    if (preferredChain === 'base') {
      const auth = await buildEvmPaymentAuthorization(selected.payTo, selected.amount, undefined, passphrase)
      if (!auth) throw new Error('Failed to build EVM payment authorization — no wallet configured')

      paymentPayload = buildSpecCompliantPayload({
        payload: {
          signature: auth.signature,
          authorization: auth.authorization,
        },
        requirements: selected.requirements,
        resource: options.resource,
        extensions: options.extensions,
      })
      payer = auth.payer
    } else {
      const tx = await buildPaymentTransaction(selected.payTo, selected.amount, selected.feePayer, undefined, passphrase)
      if (!tx) throw new Error('Failed to build Solana payment transaction — no wallet configured')

      paymentPayload = buildSpecCompliantPayload({
        payload: { transaction: tx.transaction },
        requirements: selected.requirements,
        resource: options.resource,
        extensions: options.extensions,
      })
      payer = tx.payer
    }

    if (spinner) spinner.update(`Waiting for server...`)

    const chosenChain = preferredChain

    const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString('base64')
    const paidOpts: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Spec header is `X-PAYMENT`; legacy `Payment-Signature` kept for
        // back-compat with older Palmyr server builds (drop a release after
        // both ends are confirmed on X-PAYMENT only).
        'X-PAYMENT': encoded,
        'Payment-Signature': encoded,
      },
    }
    if (body && allowsBody) paidOpts.body = JSON.stringify(body)

    const paidRes = await fetch(api + path, paidOpts)

    // Some edge layers (Cloudflare, nginx) serve HTML error pages for
    // upstream timeouts/5xx. Detect that before JSON.parse so the user sees
    // "Server returned 504" instead of "Unexpected token '<'". Payment has
    // likely already settled on-chain at this point — flag for manual review.
    const paidContentType = paidRes.headers.get('content-type') || ''
    let paidData: any
    if (paidContentType.includes('application/json')) {
      paidData = await paidRes.json() as any
    } else {
      const text = await paidRes.text().catch(() => '')
      throw new Error(
        `Payment was submitted but server returned ${paidRes.status} ${paidRes.statusText} ` +
        `with non-JSON body (${paidContentType || 'no content-type'}). ` +
        `Your payment may have settled on-chain — check your wallet and contact support with this domain before retrying. ` +
        `First 200 chars: ${text.slice(0, 200)}`
      )
    }

    if (paidData.error) {
      const detail = paidData.message && paidData.message !== paidData.error
        ? `${paidData.error}: ${paidData.message}`
        : paidData.error

      // Transient Solana errors (blockhash expired etc.) self-heal with a
      // rebuilt tx that picks up a fresh blockhash. Retry once before
      // surfacing the failure to the user.
      if (attempt < 2 && isTransientSolanaError(String(detail))) {
        if (spinner) spinner.update(`Retrying with fresh blockhash...`)
        await new Promise(r => setTimeout(r, 500))
        if (spinner) spinner.cancel()
        return paidRequest(api, method, path, body, passphrase, attempt + 1)
      }

      if (spinner) spinner.cancel()
      throw new Error(summarizeUpstreamError(detail))
    }

    if (spinner) spinner.stop(`Paid ${amountUsdc} USDC on ${chainLabel}`, true)
    log(`payment: ${amountUsdc} USDC → ${path} on ${chosenChain} (payer: ${payer})`)

    return { data: paidData, paid: true, txHash: paidData.txHash }
  } catch (e: any) {
    if (spinner) spinner.cancel()
    // Also retry on transient errors that surface as exceptions (network
    // hiccups, RPC errors thrown before paidData parsing).
    if (attempt < 2 && isTransientSolanaError(String(e?.message ?? e))) {
      await new Promise(r => setTimeout(r, 500))
      return paidRequest(api, method, path, body, passphrase, attempt + 1)
    }
    throw e
  }
}

// Trim noisy upstream error bodies (HTML pages, multi-line stack-traces) into
// a single human-readable line. The full body is still available in logs.
function summarizeUpstreamError(raw: string | undefined): string {
  if (!raw) return 'unknown error'
  const s = String(raw)
  // HTML page (e.g. nginx 401 / Cloudflare 502): extract <title> if present,
  // otherwise strip tags and collapse whitespace.
  if (/<html|<body/i.test(s)) {
    const title = s.match(/<title>([^<]+)<\/title>/i)
    if (title) return title[1].trim()
    const stripped = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    return stripped.length > 200 ? stripped.slice(0, 197) + '...' : stripped
  }
  // Plain-text but excessively long: truncate.
  if (s.length > 300) return s.slice(0, 297) + '...'
  return s
}
