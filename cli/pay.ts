/**
 * x402 payment handler for AgentOS CLI
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
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com'

// Base constants
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_CHAIN_ID = 8453

interface PaymentOption {
  amount: bigint
  payTo: string
  feePayer: string
  asset: string
  network: string
}

/**
 * Parse a 402 response. Returns available payment options by chain.
 */
export function parsePaymentRequired(data: any): {
  solana: PaymentOption | null
  base: PaymentOption | null
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
    } : null,
    base: evm ? {
      amount: BigInt(evm.amount),
      payTo: evm.payTo,
      feePayer: '', // facilitator handles gas
      asset: evm.asset || BASE_USDC,
      network: evm.network,
    } : null,
  }
}

/**
 * Resolve the Solana payer keypair. Prefers a vault wallet (AgentOS native,
 * BIP-39 encrypted, requires passphrase) and falls back to a legacy keyfile.
 *
 * Vault wallet selection order:
 *   1. walletId argument (explicit)
 *   2. config.defaultPayWalletId
 *   3. AGENTOS_PAY_WALLET env var
 *   4. First vault wallet with a Solana address
 *
 * Passphrase resolution:
 *   1. passphrase argument (explicit)
 *   2. AGENTOS_WALLET_PASSPHRASE env var
 */
function resolvePayerKeypair(walletId?: string, passphrase?: string): SolanaKeypair | null {
  const cfg = loadConfig()
  const pass = passphrase || process.env.AGENTOS_WALLET_PASSPHRASE

  // Try the vault first (session secret from OS cred store, falls back to passphrase)
  if (hasVaultWallets()) {
    const targetId = walletId || (cfg as any).defaultPayWalletId || process.env.AGENTOS_PAY_WALLET
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
    console.error('  No wallet configured. Create one with: agentos wallet create')
    console.error('  Or configure a keyfile: agentos setup --keyfile /path/to/keypair.json')
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
 * Passphrase resolution: explicit arg → AGENTOS_WALLET_PASSPHRASE env var → fail
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
  const targetId = walletId || (cfg as any).defaultPayWalletId || process.env.AGENTOS_PAY_WALLET
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

export async function paidRequest(
  api: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  passphrase?: string,
): Promise<{ data: any; paid: boolean; txHash?: string }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) opts.body = JSON.stringify(body)

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
      `Either the endpoint doesn't support ${preferredChain} yet, or use: agentos wallet use <ID> --chain ${preferredChain === 'base' ? 'solana' : 'base'}`,
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

      paymentPayload = {
        x402Version: 2,
        scheme: 'exact',
        network: selected.network,
        payload: {
          signature: auth.signature,
          authorization: auth.authorization,
        },
        accepted: { scheme: 'exact', network: selected.network },
      }
      payer = auth.payer
    } else {
      const tx = await buildPaymentTransaction(selected.payTo, selected.amount, selected.feePayer, undefined, passphrase)
      if (!tx) throw new Error('Failed to build Solana payment transaction — no wallet configured')

      paymentPayload = {
        x402Version: 2,
        payload: { transaction: tx.transaction },
        accepted: { scheme: 'exact', network: selected.network },
      }
      payer = tx.payer
    }

    if (spinner) spinner.update(`Waiting for server...`)

    const chosenChain = preferredChain

    const paidOpts: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Payment-Signature': Buffer.from(JSON.stringify(paymentPayload)).toString('base64'),
      },
    }
    if (body) paidOpts.body = JSON.stringify(body)

    const paidRes = await fetch(api + path, paidOpts)
    const paidData = await paidRes.json() as any

    if (paidData.error) {
      const detail = paidData.message && paidData.message !== paidData.error
        ? `${paidData.error}: ${paidData.message}`
        : paidData.error
      if (spinner) spinner.stop(detail, false)
      throw new Error(detail)
    }

    if (spinner) spinner.stop(`Paid ${amountUsdc} USDC on ${chainLabel}`, true)
    log(`payment: ${amountUsdc} USDC → ${path} on ${chosenChain} (payer: ${payer})`)

    return { data: paidData, paid: true, txHash: paidData.txHash }
  } catch (e) {
    if (spinner) spinner.stop(`Payment failed`, false)
    throw e
  }
}
