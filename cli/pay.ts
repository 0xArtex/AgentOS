/**
 * x402 payment handler for AgentOS CLI
 * Builds, signs, and submits USDC payment transactions on Solana.
 * Supports vault-backed signing when configured, falls back to raw keypair.
 */

import { loadKeypair, loadConfig, log } from './config.js'

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
 * Build and partially sign a USDC transfer transaction for x402 payment.
 * Uses raw keypair for transaction building (needed for multi-instruction Solana txs).
 */
export async function buildPaymentTransaction(
  payTo: string,
  amount: bigint,
  feePayer: string,
): Promise<{ transaction: string; payer: string } | null> {
  const keypairBytes = loadKeypair()
  if (!keypairBytes) {
    console.error('  No keypair configured. Run: agentos setup --keyfile /path/to/keypair.json')
    return null
  }

  // Dynamic import to keep CLI fast when payment isn't needed
  const { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import('@solana/web3.js')
  const { getAssociatedTokenAddress, createTransferCheckedInstruction, getMint } = await import('@solana/spl-token')
  const { Keypair } = await import('@solana/web3.js')

  const connection = new Connection(SOLANA_RPC, 'confirmed')
  const payer = Keypair.fromSecretKey(keypairBytes)
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
 */
export async function paidRequest(
  api: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
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

  // Determine which chain to pay on and load the right keypair
  const payChain = payment.network.startsWith('solana') ? 'solana' : 'base'
  const keypair = loadKeypair(payChain as any)
  if (!keypair) throw new Error(`No ${payChain} keyfile configured. Run: agentos setup --keyfile /path/to/keypair.json --chain ${payChain}`)

  console.log(`  Paying ${Number(payment.amount) / 1e6} USDC on Solana...`)

  const tx = await buildPaymentTransaction(payment.payTo, payment.amount, payment.feePayer)
  if (!tx) throw new Error('Failed to build payment transaction')

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

  if (paidData.error) throw new Error(paidData.error)

  log(`payment: ${Number(payment.amount) / 1e6} USDC → ${path} (payer: ${tx.payer})`)

  return { data: paidData, paid: true, txHash: paidData.txHash }
}
