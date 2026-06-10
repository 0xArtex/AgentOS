/**
 * On-chain USDC refund service — treasury → payer.
 *
 * x402 settles payments BEFORE the handler runs (`req.payment` is populated
 * post-settlement). If the handler can't deliver the resource because of an
 * upstream failure on OUR side (Telnyx out of credit, registrar down, RPC
 * outage), the user's USDC is already in the treasury. This module sends it
 * back automatically and records the refund for audit.
 *
 * Used by `refundAndRespond(req, res, ...)` from route handlers — they pass
 * the entire request context and we extract chain/payer/signature/amount
 * from `req.payment`.
 *
 * Idempotency: the `refunds` table has a UNIQUE constraint on
 * `original_payment_signature` so duplicate handler-error paths can't issue
 * two refunds for the same x402 settlement.
 *
 * Required env:
 *   TREASURY_SOL_PRIVATE_KEY  — bs58-encoded 64-byte Solana secret key
 *   TREASURY_EVM_PRIVATE_KEY  — 0x-prefixed hex private key for treasury EVM wallet
 *
 * Without these, refundUsdcToPayer returns ok:false with a clear reason and
 * the route handler surfaces "contact ops for manual refund" to the user.
 * Server keeps running — the alternative (crash on first failure) is worse.
 */
import { Response } from "express";
import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { db } from "../db";
import { config } from "../config";
import { AuthenticatedRequest } from "../types";

const SOL_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const SOL_RPC = process.env.HELIUS_RPC || process.env.SOLANA_MAINNET_RPC || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";

// ─── DB schema — refunds ledger ───
db.exec(`
  CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY,
    original_payment_signature TEXT NOT NULL UNIQUE,
    payer TEXT NOT NULL,
    chain TEXT NOT NULL CHECK(chain IN ('solana', 'base')),
    amount_usdc REAL NOT NULL,
    refund_tx TEXT,
    reason TEXT NOT NULL,
    endpoint TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_refunds_payer ON refunds(payer);
  CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
`);

// ─── Treasury signer loading ───
//
// Lazily resolved on first refund. Keeps the server bootable without the env
// in dev. In production, a refund request with missing keys returns a clear
// "ops must refund manually" — better than swallowing the failure silently.

let _solKeypair: Keypair | null = null;
let _evmWallet: any = null;
// Why the treasury signer is unusable — surfaced in the refund error instead
// of a blanket "not configured" that hides key-mismatch/parse problems.
let _solDisabledReason: string | null = null;
let _evmDisabledReason: string | null = null;

function loadSolTreasury(): Keypair | null {
  if (_solKeypair) return _solKeypair;
  const raw = process.env.TREASURY_SOL_PRIVATE_KEY || process.env.SVM_PRIVATE_KEY;
  if (!raw) {
    _solDisabledReason = "TREASURY_SOL_PRIVATE_KEY not configured";
    return null;
  }
  try {
    _solKeypair = Keypair.fromSecretKey(bs58.decode(raw));
    // Sanity: refunds MUST originate from the address advertised as `payTo`
    // in x402 responses, otherwise treasury funds drain from the wrong wallet
    // and the payer can't reconcile the refund tx against their original payment.
    if (_solKeypair.publicKey.toBase58() !== config.treasuryWallet) {
      _solDisabledReason =
        `TREASURY_SOL_PRIVATE_KEY pubkey ${_solKeypair.publicKey.toBase58()} ` +
        `does not match TREASURY_WALLET ${config.treasuryWallet}`;
      console.error(`[refund] ${_solDisabledReason}. Refunds disabled on Solana.`);
      _solKeypair = null;
      return null;
    }
    _solDisabledReason = null;
    return _solKeypair;
  } catch (e: any) {
    _solDisabledReason = `TREASURY_SOL_PRIVATE_KEY failed to parse: ${e.message}`;
    console.error("[refund] Failed to load TREASURY_SOL_PRIVATE_KEY:", e.message);
    return null;
  }
}

function loadEvmTreasury(): any {
  if (_evmWallet) return _evmWallet;
  const raw = process.env.TREASURY_EVM_PRIVATE_KEY;
  if (!raw) {
    _evmDisabledReason = "TREASURY_EVM_PRIVATE_KEY not configured";
    return null;
  }
  try {
    const { ethers } = require("ethers");
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const wallet = new ethers.Wallet(raw, provider);
    if (wallet.address.toLowerCase() !== config.treasuryEvmWallet.toLowerCase()) {
      _evmDisabledReason =
        `TREASURY_EVM_PRIVATE_KEY address ${wallet.address} ` +
        `does not match TREASURY_EVM_WALLET ${config.treasuryEvmWallet}`;
      console.error(`[refund] ${_evmDisabledReason}. Refunds disabled on Base.`);
      return null;
    }
    _evmWallet = wallet;
    _evmDisabledReason = null;
    return wallet;
  } catch (e: any) {
    _evmDisabledReason = `TREASURY_EVM_PRIVATE_KEY failed to parse: ${e.message}`;
    console.error("[refund] Failed to load TREASURY_EVM_PRIVATE_KEY:", e.message);
    return null;
  }
}

// ─── Public API ───

export interface RefundResult {
  ok: boolean;
  refundId: string;
  refundTx?: string;
  reason?: string;
}

export interface RefundOpts {
  chain: "solana" | "base";
  payer: string;
  amountUsdc: number;
  reason: string;
  originalPaymentSignature: string;
  endpoint: string;
}

/**
 * Send USDC from the treasury back to the payer and record the refund.
 *
 * Idempotent: a second call with the same `originalPaymentSignature` returns
 * the existing refund record (status either 'sent' or 'failed').
 */
export async function refundUsdcToPayer(opts: RefundOpts): Promise<RefundResult> {
  // Idempotency: if we already have a refund row for this payment, return it.
  // Catches double-error paths AND retries from a misbehaving handler.
  const existing = db.prepare(
    "SELECT id, refund_tx, status, error FROM refunds WHERE original_payment_signature = ?"
  ).get(opts.originalPaymentSignature) as any;
  if (existing) {
    return {
      ok: existing.status === "sent",
      refundId: existing.id,
      refundTx: existing.refund_tx || undefined,
      reason: existing.status === "failed" ? `previous attempt failed: ${existing.error}` : undefined,
    };
  }

  const refundId = "refund_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  // Pre-insert as 'pending' so concurrent error paths short-circuit via the
  // UNIQUE constraint on original_payment_signature.
  try {
    db.prepare(
      "INSERT INTO refunds (id, original_payment_signature, payer, chain, amount_usdc, reason, endpoint, status) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')"
    ).run(refundId, opts.originalPaymentSignature, opts.payer, opts.chain, opts.amountUsdc, opts.reason, opts.endpoint);
  } catch (e: any) {
    // UNIQUE violation = another concurrent path beat us to it. Re-read.
    if (String(e.message || "").includes("UNIQUE")) {
      const winner = db.prepare(
        "SELECT id, refund_tx, status, error FROM refunds WHERE original_payment_signature = ?"
      ).get(opts.originalPaymentSignature) as any;
      return {
        ok: winner.status === "sent",
        refundId: winner.id,
        refundTx: winner.refund_tx || undefined,
      };
    }
    return { ok: false, refundId, reason: "db_insert_failed: " + e.message };
  }

  return executeRefundTransfer(refundId, opts.chain, opts.payer, opts.amountUsdc, opts.reason);
}

/**
 * Run the on-chain transfer for an existing 'pending'/'failed' refund row and
 * update its status. The tx hash is persisted AT BROADCAST (via onBroadcast),
 * before confirmation — so a confirm timeout can never leave a row that looks
 * never-attempted. Retry logic relies on this: rows with refund_tx IS NULL
 * are guaranteed to have had nothing hit the chain and are safe to re-send.
 */
async function executeRefundTransfer(
  refundId: string,
  chain: "solana" | "base",
  payer: string,
  amountUsdc: number,
  reason: string,
): Promise<RefundResult> {
  const onBroadcast = (tx: string) => {
    db.prepare("UPDATE refunds SET refund_tx = ? WHERE id = ?").run(tx, refundId);
  };

  let refundTx: string | null = null;
  let error: string | null = null;
  try {
    if (chain === "solana") {
      refundTx = await sendSolanaRefund(payer, amountUsdc, onBroadcast);
    } else {
      refundTx = await sendBaseRefund(payer, amountUsdc, onBroadcast);
    }
  } catch (e: any) {
    error = e?.message || String(e);
    console.error(`[refund] [REFUND_FAILED] ${refundId} chain=${chain} payer=${payer} amount=${amountUsdc} reason="${reason}":`, error);
  }

  if (refundTx) {
    db.prepare(
      "UPDATE refunds SET refund_tx = ?, status = 'sent', error = NULL, completed_at = datetime('now', 'utc') WHERE id = ?"
    ).run(refundTx, refundId);
    console.log(`[refund] [REFUND_SENT] ${refundId} ${chain} ${amountUsdc} USDC → ${payer} tx=${refundTx} reason="${reason}"`);
    return { ok: true, refundId, refundTx };
  }

  db.prepare(
    "UPDATE refunds SET status = 'failed', error = ?, completed_at = datetime('now', 'utc') WHERE id = ?"
  ).run(error || "unknown", refundId);
  return { ok: false, refundId, reason: error || "refund_failed" };
}

// Don't let two retry sweeps run concurrently — the refund_tx IS NULL guard
// is read-then-send, so overlapping sweeps could double-pay the same row.
let retryInflight = false;

/**
 * Re-attempt refunds that failed BEFORE anything was broadcast on-chain
 * (refund_tx IS NULL — typically "treasury key not configured" or an RPC
 * outage). Rows with a recorded tx are never retried automatically: the tx
 * may have landed even if confirmation timed out, so those stay manual.
 *
 * Called at boot and on an interval, so configuring the treasury keys on a
 * running deployment automatically drains the backlog of owed refunds.
 */
export async function retryFailedRefunds(limit: number = 50): Promise<{ retried: number; sent: number }> {
  if (retryInflight) return { retried: 0, sent: 0 };
  retryInflight = true;
  try {
    const rows = db.prepare(
      "SELECT id, chain, payer, amount_usdc, reason FROM refunds " +
      "WHERE status = 'failed' AND refund_tx IS NULL ORDER BY created_at ASC LIMIT ?"
    ).all(limit) as Array<{ id: string; chain: "solana" | "base"; payer: string; amount_usdc: number; reason: string }>;
    if (rows.length === 0) return { retried: 0, sent: 0 };

    // Fast skip per chain when its treasury key still isn't loadable — no
    // point re-failing every row just to rewrite the same error string.
    const solReady = !!loadSolTreasury();
    const evmReady = !!loadEvmTreasury();

    let retried = 0;
    let sent = 0;
    for (const row of rows) {
      if (row.chain === "solana" ? !solReady : !evmReady) continue;
      retried++;
      const result = await executeRefundTransfer(row.id, row.chain, row.payer, row.amount_usdc, row.reason);
      if (result.ok) sent++;
    }
    if (retried > 0) {
      console.log(`[refund] retry sweep: ${sent}/${retried} previously-failed refunds sent`);
    }
    return { retried, sent };
  } finally {
    retryInflight = false;
  }
}

/**
 * Boot hook: warn loudly when refunds can't work, then sweep the failed
 * backlog now and every hour. Safe to call exactly once from index.ts.
 */
export function startRefundRetryLoop(): void {
  if (!process.env.TREASURY_SOL_PRIVATE_KEY && !process.env.SVM_PRIVATE_KEY) {
    console.warn("[refund] TREASURY_SOL_PRIVATE_KEY not set — Solana refunds will fail until configured");
  }
  if (!process.env.TREASURY_EVM_PRIVATE_KEY) {
    console.warn("[refund] TREASURY_EVM_PRIVATE_KEY not set — Base refunds will fail until configured");
  }
  retryFailedRefunds().catch(err => console.error("[refund] boot retry sweep failed:", err?.message ?? err));
  setInterval(() => {
    retryFailedRefunds().catch(err => console.error("[refund] retry sweep failed:", err?.message ?? err));
  }, 60 * 60 * 1000).unref();
}

async function sendSolanaRefund(payerAddress: string, amountUsdc: number, onBroadcast?: (tx: string) => void): Promise<string> {
  const kp = loadSolTreasury();
  if (!kp) throw new Error("TREASURY_SOL_PRIVATE_KEY not configured — ops must refund manually");

  const conn = new Connection(SOL_RPC, "confirmed");
  const fromPubkey = kp.publicKey;
  const toPubkey = new PublicKey(payerAddress);
  const fromAta = getAssociatedTokenAddressSync(SOL_USDC_MINT, fromPubkey);
  const toAta = getAssociatedTokenAddressSync(SOL_USDC_MINT, toPubkey);
  const amountRaw = BigInt(Math.floor(amountUsdc * 1_000_000));

  // Verify the recipient ATA exists. Creating one costs ~0.002 SOL (rent) and
  // the treasury would have to fund it — usually the payer's ATA already
  // exists because they just paid us USDC FROM it. If it doesn't, the
  // transfer reverts; let the caller decide whether to surface
  // "refund pending, contact ops" vs auto-create.
  const ataInfo = await conn.getAccountInfo(toAta);
  if (!ataInfo) {
    throw new Error(`Payer USDC ATA ${toAta.toBase58()} does not exist (recipient must initialize it)`);
  }

  const ix = createTransferInstruction(fromAta, toAta, fromPubkey, amountRaw, [], TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(ix);
  tx.feePayer = fromPubkey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(kp);

  const sig = await conn.sendRawTransaction(tx.serialize());
  // Persist the signature the moment it's broadcast — a confirm timeout must
  // not leave this refund looking like it never touched the chain.
  onBroadcast?.(sig);
  // Confirm so the caller can include the signature in their error response
  // with confidence that it landed. 30s cap matches x402 maxTimeoutSeconds.
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function sendBaseRefund(payerAddress: string, amountUsdc: number, onBroadcast?: (tx: string) => void): Promise<string> {
  const wallet = loadEvmTreasury();
  if (!wallet) throw new Error("TREASURY_EVM_PRIVATE_KEY not configured — ops must refund manually");

  const { ethers } = require("ethers");
  const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
  const amountRaw = BigInt(Math.floor(amountUsdc * 1_000_000));
  const data = iface.encodeFunctionData("transfer", [payerAddress, amountRaw]);

  const tx = await wallet.sendTransaction({
    to: BASE_USDC,
    data,
    gasLimit: 65000,
  });
  onBroadcast?.(tx.hash);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Refund tx reverted: ${tx.hash}`);
  }
  return tx.hash;
}

// ─── Route-handler convenience ───

/**
 * One-call refund-and-respond for paid routes whose upstream call failed.
 *
 * Reads chain / payer / amount / payment-signature from `req.payment`, fires
 * the refund, and writes a 502 response with the refund details. Designed
 * to be the single line a handler runs in its catch block.
 *
 * Example:
 *   try {
 *     const number = await phoneService.provisionNumber(...)
 *     res.status(201).json(number)
 *   } catch (err) {
 *     await refundAndRespond(req, res, {
 *       reason: `Telnyx provision failed: ${err.message}`,
 *       userMessage: "Could not provision number — your payment is being refunded.",
 *     })
 *   }
 */
export async function refundAndRespond(
  req: AuthenticatedRequest,
  res: Response,
  opts: {
    reason: string;
    userMessage?: string;
    httpStatus?: number;
    /** Top-level `error` field for the response. Defaults to "Upstream failure". */
    errorLabel?: string;
    /** Extra top-level fields merged into the JSON response (e.g. availableIn). */
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const errorLabel = opts.errorLabel || "Upstream failure";
  const extra = opts.extra || {};
  const payment = req.payment;
  if (!payment) {
    // No settled payment to refund. Should never happen on a paid route —
    // the x402 middleware populates this before next() — but be defensive.
    console.error("[refund] refundAndRespond called with no req.payment:", opts.reason);
    res.status(opts.httpStatus || 502).json({
      error: errorLabel,
      message: opts.userMessage || opts.reason,
      ...extra,
      hint: "No payment record found to refund. Contact support if you were charged.",
    });
    return;
  }

  if (!payment.chain) {
    console.error("[refund] req.payment.chain missing for", opts.reason);
    res.status(opts.httpStatus || 502).json({
      error: errorLabel,
      message: opts.userMessage || opts.reason,
      ...extra,
      hint: "Refund could not be issued automatically (missing chain info). Contact ops with your payment signature: " + payment.signature,
      payment_signature: payment.signature,
    });
    return;
  }

  const amountUsdc = Number(payment.amountLamports) / 1_000_000;
  const result = await refundUsdcToPayer({
    chain: payment.chain,
    payer: payment.payer,
    amountUsdc,
    reason: opts.reason,
    originalPaymentSignature: payment.signature,
    endpoint: req.method + " " + (req.originalUrl || req.url || "").split("?")[0],
  });

  if (result.ok) {
    res.status(opts.httpStatus || 502).json({
      error: errorLabel,
      message: opts.userMessage || opts.reason,
      ...extra,
      refund: {
        ok: true,
        tx: result.refundTx,
        amount_usdc: amountUsdc,
        chain: payment.chain,
        id: result.refundId,
      },
      hint: "Your payment was automatically refunded.",
    });
  } else {
    res.status(opts.httpStatus || 502).json({
      error: errorLabel,
      message: opts.userMessage || opts.reason,
      ...extra,
      refund: {
        ok: false,
        id: result.refundId,
        reason: result.reason,
        amount_usdc: amountUsdc,
        chain: payment.chain,
      },
      payment_signature: payment.signature,
      hint: "Automatic refund failed. It will be retried automatically; the refund ID + payment_signature are your receipt.",
    });
  }
}
