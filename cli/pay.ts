/**
 * x402 payment handler for AgentOS CLI
 * Builds, signs, and submits USDC payment transactions on Solana.
 * Supports vault-backed signing when configured, falls back to raw keypair.
 */

import { loadKeypair, loadConfig, log } from './config.js'
import { getVaultSolanaKeypair, hasVaultWallets, listVaultWallets } from './vault.js'
import type { Keypair as SolanaKeypair } from '@solana/web3.js'

// Solana constants
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com'

/**
 * Parse a 402 response and extract payment requirements
 */
export function parsePaymentRequired(data: any): {
  amount: bigint
  payTo: string
  feePayer: string
  asset: string
  network: string
} | null {
  const accepts = data.accepts || []
  // Prefer Solana
  const solana = accepts.find((a: any) => a.network?.startsWith('solana:'))
  if (solana) {
    return {
      amount: BigInt(solana.amount),
      payTo: solana.payTo,
      feePayer: solana.extra?.feePayer || '',
      asset: solana.asset || USDC_MINT,
      network: solana.network,
    }
  }
  return null
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

  // 402 — need to pay
  const payment = parsePaymentRequired(data)
  if (!payment) throw new Error('Cannot parse payment requirements from 402 response')

  if (!payment.network.startsWith('solana')) {
    throw new Error(`Only Solana x402 payments are supported in this CLI. Got: ${payment.network}`)
  }

  console.log(`  Paying ${Number(payment.amount) / 1e6} USDC on Solana...`)

  const tx = await buildPaymentTransaction(payment.payTo, payment.amount, payment.feePayer, undefined, passphrase)
  if (!tx) throw new Error('Failed to build payment transaction — no wallet configured')

  // Retry with payment header
  const paymentPayload = {
    x402Version: 2,
    payload: { transaction: tx.transaction },
    accepted: {
      scheme: 'exact',
      network: payment.network,
    }
  }

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
    // Server returned an error — include message detail for diagnosis
    const detail = paidData.message && paidData.message !== paidData.error
      ? `${paidData.error}: ${paidData.message}`
      : paidData.error
    throw new Error(detail)
  }

  log(`payment: ${Number(payment.amount) / 1e6} USDC → ${path} (payer: ${tx.payer})`)

  return { data: paidData, paid: true, txHash: paidData.txHash }
}
