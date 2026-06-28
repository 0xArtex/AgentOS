import { db } from "../db";

export interface Balance {
  balance_usdc: number;
  total_deposited: number;
  total_spent: number;
}

export function ensureUser(userId: string): void {
  const exists = db.prepare("SELECT 1 FROM balances WHERE user_id = ?").get(userId);
  if (!exists) {
    db.prepare(
      "INSERT INTO balances (id, user_id, balance_usdc, total_deposited, total_spent) VALUES (?, ?, 0, 0, 0)"
    ).run(crypto.randomUUID(), userId);
  }
}

export function getBalance(userId: string): Balance {
  ensureUser(userId);
  const row = db.prepare("SELECT balance_usdc, total_deposited, total_spent FROM balances WHERE user_id = ?").get(userId) as any;
  return { balance_usdc: row.balance_usdc, total_deposited: row.total_deposited, total_spent: row.total_spent };
}

// SQLite raises this when a write violates the UNIQUE index on
// balance_transactions.reference_id — our authoritative idempotency signal.
function isUniqueViolation(e: any): boolean {
  return e?.code === "SQLITE_CONSTRAINT_UNIQUE" || e?.code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

export function deposit(userId: string, amount: number, referenceId: string, description: string): Balance {
  ensureUser(userId);

  // Normalise an absent reference to SQL NULL. The UNIQUE index treats every
  // NULL as distinct, but an empty STRING ('') is a real value that would
  // collide across unrelated reference-less deposits — so coerce falsy → null.
  const ref = referenceId || null;

  // Fast-path dup check (cheap, avoids opening a write tx for an obvious
  // replay). NOT authoritative on its own — two concurrent poll cycles can
  // both pass this SELECT before either INSERTs. The UNIQUE index on
  // reference_id inside the transaction below is what actually makes this safe.
  if (ref) {
    const dup = db.prepare("SELECT 1 FROM balance_transactions WHERE reference_id = ? AND type = 'deposit'").get(ref);
    if (dup) throw new Error("Duplicate deposit: already credited");
  }

  // Credit the balance and write the ledger row atomically — if the ledger
  // INSERT throws (disk full, constraint), the balance update must roll back
  // too, otherwise we'd credit funds with no audit record. The ledger INSERT
  // runs FIRST so a UNIQUE(reference_id) violation aborts the tx before the
  // balance is ever touched.
  const apply = db.transaction(() => {
    db.prepare(
      "INSERT INTO balance_transactions (id, user_id, type, amount_usdc, description, reference_id, created_at) VALUES (?, ?, 'deposit', ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), userId, amount, description, ref);

    db.prepare(
      "UPDATE balances SET balance_usdc = balance_usdc + ?, total_deposited = total_deposited + ?, updated_at = datetime('now') WHERE user_id = ?"
    ).run(amount, amount, userId);
  });

  try {
    apply();
  } catch (e: any) {
    // A racing cycle already inserted this exact reference_id. The credit
    // happened once; treat the replay as the no-op it is. Preserve the legacy
    // "Duplicate" error string so existing callers (deposit-monitor) still
    // recognise it and skip.
    if (ref && isUniqueViolation(e)) throw new Error("Duplicate deposit: already credited");
    throw e;
  }

  return getBalance(userId);
}

export function debit(userId: string, amount: number, serviceType: string, description: string): Balance {
  if (amount <= 0) return getBalance(userId);
  ensureUser(userId);

  const bal = getBalance(userId);
  if (bal.balance_usdc < amount) {
    throw new Error(`Insufficient balance: have $${bal.balance_usdc.toFixed(2)}, need $${amount.toFixed(2)}`);
  }

  // Decrement balance and write the ledger row atomically. Without the
  // transaction, a throw on the INSERT (disk full, constraint) would leave the
  // balance debited with no matching ledger entry — balance and ledger desync.
  const apply = db.transaction(() => {
    db.prepare(
      "UPDATE balances SET balance_usdc = balance_usdc - ?, total_spent = total_spent + ?, updated_at = datetime('now') WHERE user_id = ?"
    ).run(amount, amount, userId);

    db.prepare(
      "INSERT INTO balance_transactions (id, user_id, type, amount_usdc, description, service_type, created_at) VALUES (?, ?, 'debit', ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), userId, amount, description, serviceType);
  });
  apply();

  return getBalance(userId);
}

/**
 * Atomically reserve (debit) `amount` only if the balance can cover it.
 *
 * The conditional `WHERE balance_usdc >= ?` makes the check-and-debit a SINGLE
 * statement, so two concurrent callers can never both pass the check and then
 * both debit (the TOCTOU that a separate getBalance()-then-debit() opens). The
 * loser of the race sees `changes === 0` and is told there are insufficient
 * funds. The ledger row is written in the same transaction (same desync
 * rationale as debit()). Returns true if the reservation succeeded.
 *
 * Used by dashboard metering to reserve before a handler runs, then refund() on
 * failure — so paid infra can't be over-provisioned under concurrency.
 */
export function reserve(userId: string, amount: number, serviceType: string, description: string): boolean {
  if (amount <= 0) return true;
  ensureUser(userId);

  const apply = db.transaction(() => {
    const res = db.prepare(
      "UPDATE balances SET balance_usdc = balance_usdc - ?, total_spent = total_spent + ?, updated_at = datetime('now') WHERE user_id = ? AND balance_usdc >= ?"
    ).run(amount, amount, userId, amount);
    if (res.changes === 0) return false; // insufficient balance — nothing debited

    db.prepare(
      "INSERT INTO balance_transactions (id, user_id, type, amount_usdc, description, service_type, created_at) VALUES (?, ?, 'debit', ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), userId, amount, description, serviceType);
    return true;
  });

  return apply() as boolean;
}

export function refund(userId: string, amount: number, description: string, referenceId?: string): Balance {
  ensureUser(userId);

  // Same NULL-coercion as deposit(): falsy reference → SQL NULL (distinct under
  // the UNIQUE index) rather than '' (which would collide across unrelated
  // reference-less refunds).
  const ref = referenceId || null;

  // Idempotency: a retried refund (same reference_id) must credit at most once.
  // Fast-path check, backed by the UNIQUE(reference_id) index inside the tx.
  if (ref) {
    const dup = db.prepare("SELECT 1 FROM balance_transactions WHERE reference_id = ? AND type = 'refund'").get(ref);
    if (dup) return getBalance(userId); // already refunded — no-op
  }

  // Credit the refund and write the ledger row atomically (same rationale as
  // deposit/debit). total_spent is decremented but floored at 0 so a refund
  // that exceeds recorded spend (or a double-fire that slips past the dup
  // check) can never drive total_spent negative.
  const apply = db.transaction(() => {
    db.prepare(
      "INSERT INTO balance_transactions (id, user_id, type, amount_usdc, description, reference_id, created_at) VALUES (?, ?, 'refund', ?, ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), userId, amount, description, ref);

    db.prepare(
      "UPDATE balances SET balance_usdc = balance_usdc + ?, total_spent = MAX(0, total_spent - ?), updated_at = datetime('now') WHERE user_id = ?"
    ).run(amount, amount, userId);
  });

  try {
    apply();
  } catch (e: any) {
    // Concurrent retry won the race and already inserted this reference_id.
    if (ref && isUniqueViolation(e)) return getBalance(userId);
    throw e;
  }

  return getBalance(userId);
}

export function getTransactions(userId: string, limit = 50): any[] {
  return db.prepare(
    "SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(userId, limit);
}
