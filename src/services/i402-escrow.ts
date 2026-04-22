import crypto from "crypto";
import { db } from "../db";
import {
  getSession,
  getSessionForWallet,
  addEscrow as sessionAddEscrow,
  debitEscrow as sessionDebitEscrow,
  refundEscrow as sessionRefundEscrow,
} from "./i402-session";
import type { EscrowKind, EscrowLedgerEntry, I402Session } from "./i402-types";

// -------------------- Row shape --------------------

interface LedgerRow {
  id: string;
  session_id: string;
  plan_id: string | null;
  step_id: string | null;
  kind: EscrowKind;
  amount_usdc: number;
  balance_after_usdc: number;
  tx_signature: string | null;
  chain: "solana" | "base" | null;
  notes: string | null;
  created_at: string;
}

function rowToEntry(row: LedgerRow): EscrowLedgerEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    planId: row.plan_id ?? undefined,
    stepId: row.step_id ?? undefined,
    kind: row.kind,
    amountUsdc: row.amount_usdc,
    balanceAfterUsdc: row.balance_after_usdc,
    txSignature: row.tx_signature ?? undefined,
    chain: row.chain ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
  };
}

function writeLedgerEntry(
  kind: EscrowKind,
  input: {
    sessionId: string;
    planId?: string;
    stepId?: string;
    amountUsdc: number;
    balanceAfterUsdc: number;
    txSignature?: string;
    chain?: "solana" | "base";
    notes?: string;
  }
): EscrowLedgerEntry {
  const id = `esc_${crypto.randomBytes(6).toString("hex")}`;
  db.prepare(
    `INSERT INTO i402_escrow_ledger (
       id, session_id, plan_id, step_id, kind, amount_usdc, balance_after_usdc,
       tx_signature, chain, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.planId ?? null,
    input.stepId ?? null,
    kind,
    input.amountUsdc,
    input.balanceAfterUsdc,
    input.txSignature ?? null,
    input.chain ?? null,
    input.notes ?? null
  );
  const row = db.prepare(`SELECT * FROM i402_escrow_ledger WHERE id = ?`).get(id) as LedgerRow | undefined;
  if (!row) throw new Error(`Failed to write ledger entry ${id}`);
  return rowToEntry(row);
}

// -------------------- Public API --------------------

export interface DepositInput {
  sessionId: string;
  amountUsdc: number;
  txSignature?: string;
  chain?: "solana" | "base";
  notes?: string;
}

/**
 * Deposit USDC into session escrow. In production, the caller is responsible
 * for verifying the x402 payment landed onchain before calling this — the
 * tx_signature is persisted for audit. Use `depositVerified()` to couple
 * verification + deposit atomically.
 */
export function deposit(input: DepositInput): { session: I402Session; entry: EscrowLedgerEntry } {
  if (input.amountUsdc <= 0) throw new Error("deposit amount must be positive");
  const tx = db.transaction(() => {
    const session = sessionAddEscrow(input.sessionId, input.amountUsdc);
    const entry = writeLedgerEntry("deposit", {
      sessionId: input.sessionId,
      amountUsdc: input.amountUsdc,
      balanceAfterUsdc: session.escrowUsdc,
      txSignature: input.txSignature,
      chain: input.chain,
      notes: input.notes,
    });
    return { session, entry };
  });
  return tx();
}

export interface DebitStepInput {
  sessionId: string;
  planId: string;
  stepId: string;
  amountUsdc: number;
  txSignature?: string;
  chain?: "solana" | "base";
  notes?: string;
}

/**
 * Debit escrow to pay for a completed step. Also increments session.spent_usdc.
 * Throws if insufficient escrow.
 */
export function debitStep(input: DebitStepInput): { session: I402Session; entry: EscrowLedgerEntry } {
  if (input.amountUsdc < 0) throw new Error("debit amount must be non-negative");
  if (input.amountUsdc === 0) {
    // Free step; still write a zero-amount ledger entry for audit
    const session = getSession(input.sessionId);
    if (!session) throw new Error(`Session ${input.sessionId} not found`);
    const entry = writeLedgerEntry("debit_step", {
      sessionId: input.sessionId,
      planId: input.planId,
      stepId: input.stepId,
      amountUsdc: 0,
      balanceAfterUsdc: session.escrowUsdc,
      txSignature: input.txSignature,
      chain: input.chain,
      notes: input.notes ?? "free step",
    });
    return { session, entry };
  }
  const tx = db.transaction(() => {
    const session = sessionDebitEscrow(input.sessionId, input.amountUsdc);
    const entry = writeLedgerEntry("debit_step", {
      sessionId: input.sessionId,
      planId: input.planId,
      stepId: input.stepId,
      amountUsdc: input.amountUsdc,
      balanceAfterUsdc: session.escrowUsdc,
      txSignature: input.txSignature,
      chain: input.chain,
      notes: input.notes,
    });
    return { session, entry };
  });
  return tx();
}

export interface DebitFeeInput {
  sessionId: string;
  planId: string;
  amountUsdc: number;
  notes?: string;
}

/**
 * Debit the orchestration fee from escrow. Same mechanics as debitStep but a
 * distinct ledger `kind` for reporting.
 */
export function debitOrchestrationFee(input: DebitFeeInput): {
  session: I402Session;
  entry: EscrowLedgerEntry;
} {
  if (input.amountUsdc < 0) throw new Error("fee amount must be non-negative");
  const tx = db.transaction(() => {
    const session = input.amountUsdc === 0 ? getSession(input.sessionId)! : sessionDebitEscrow(input.sessionId, input.amountUsdc);
    if (!session) throw new Error(`Session ${input.sessionId} not found`);
    const entry = writeLedgerEntry("debit_orchestration_fee", {
      sessionId: input.sessionId,
      planId: input.planId,
      amountUsdc: input.amountUsdc,
      balanceAfterUsdc: session.escrowUsdc,
      notes: input.notes,
    });
    return { session, entry };
  });
  return tx();
}

export interface RefundInput {
  sessionId: string;
  txSignature?: string;
  chain?: "solana" | "base";
  notes?: string;
}

/**
 * Refund all remaining escrow. Typically called on session close or cancellation.
 * If there is no escrow to refund, writes a zero-amount ledger entry for audit.
 */
export function refund(input: RefundInput): {
  session: I402Session;
  entry: EscrowLedgerEntry;
  refundedUsdc: number;
} {
  const tx = db.transaction(() => {
    const { refundedUsdc, session } = sessionRefundEscrow(input.sessionId);
    const entry = writeLedgerEntry("refund", {
      sessionId: input.sessionId,
      amountUsdc: refundedUsdc,
      balanceAfterUsdc: session.escrowUsdc,
      txSignature: input.txSignature,
      chain: input.chain,
      notes: input.notes,
    });
    return { session, entry, refundedUsdc };
  });
  return tx();
}

// -------------------- Queries --------------------

export function getBalance(sessionId: string): number {
  const session = getSession(sessionId);
  if (!session) return 0;
  return session.escrowUsdc;
}

export function getLedger(sessionId: string, limit = 1000): EscrowLedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM i402_escrow_ledger
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(sessionId, limit) as LedgerRow[];
  return rows.map(rowToEntry);
}

export function getLedgerSummary(sessionId: string): {
  totalDeposited: number;
  totalSpent: number;
  totalRefunded: number;
  currentBalance: number;
} {
  const rows = db
    .prepare(
      `SELECT kind, SUM(amount_usdc) AS total
       FROM i402_escrow_ledger
       WHERE session_id = ?
       GROUP BY kind`
    )
    .all(sessionId) as Array<{ kind: EscrowKind; total: number }>;

  let totalDeposited = 0,
    totalSpent = 0,
    totalRefunded = 0;
  for (const row of rows) {
    if (row.kind === "deposit") totalDeposited = row.total;
    else if (row.kind === "debit_step" || row.kind === "debit_orchestration_fee") totalSpent += row.total;
    else if (row.kind === "refund") totalRefunded = row.total;
  }

  return {
    totalDeposited,
    totalSpent,
    totalRefunded,
    currentBalance: getBalance(sessionId),
  };
}

// -------------------- Guarded APIs (wallet-scoped) --------------------

/**
 * Guarded variant of deposit that verifies wallet ownership first.
 */
export function depositForWallet(
  input: DepositInput & { walletAddress: string }
): { session: I402Session; entry: EscrowLedgerEntry } {
  getSessionForWallet(input.sessionId, input.walletAddress); // throws on mismatch
  return deposit(input);
}

/**
 * Guarded variant of refund that verifies wallet ownership first.
 */
export function refundForWallet(
  input: RefundInput & { walletAddress: string }
): { session: I402Session; entry: EscrowLedgerEntry; refundedUsdc: number } {
  getSessionForWallet(input.sessionId, input.walletAddress);
  return refund(input);
}
