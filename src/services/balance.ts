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

export function deposit(userId: string, amount: number, referenceId: string, description: string): Balance {
  ensureUser(userId);
  
  // Check for duplicate reference
  if (referenceId) {
    const dup = db.prepare("SELECT 1 FROM balance_transactions WHERE reference_id = ? AND type = 'deposit'").get(referenceId);
    if (dup) throw new Error("Duplicate deposit: already credited");
  }

  db.prepare(
    "UPDATE balances SET balance_usdc = balance_usdc + ?, total_deposited = total_deposited + ?, updated_at = datetime('now') WHERE user_id = ?"
  ).run(amount, amount, userId);

  db.prepare(
    "INSERT INTO balance_transactions (id, user_id, type, amount_usdc, description, reference_id, created_at) VALUES (?, ?, 'deposit', ?, ?, ?, datetime('now'))"
  ).run(crypto.randomUUID(), userId, amount, description, referenceId);

  return getBalance(userId);
}

export function debit(userId: string, amount: number, serviceType: string, description: string): Balance {
  if (amount <= 0) return getBalance(userId);
  ensureUser(userId);
  
  const bal = getBalance(userId);
  if (bal.balance_usdc < amount) {
    throw new Error(`Insufficient balance: have $${bal.balance_usdc.toFixed(2)}, need $${amount.toFixed(2)}`);
  }

  db.prepare(
    "UPDATE balances SET balance_usdc = balance_usdc - ?, total_spent = total_spent + ?, updated_at = datetime('now') WHERE user_id = ?"
  ).run(amount, amount, userId);

  db.prepare(
    "INSERT INTO balance_transactions (id, user_id, type, amount_usdc, description, service_type, created_at) VALUES (?, ?, 'debit', ?, ?, ?, datetime('now'))"
  ).run(crypto.randomUUID(), userId, amount, description, serviceType);

  return getBalance(userId);
}

export function refund(userId: string, amount: number, description: string): Balance {
  ensureUser(userId);
  
  db.prepare(
    "UPDATE balances SET balance_usdc = balance_usdc + ?, total_spent = total_spent - ?, updated_at = datetime('now') WHERE user_id = ?"
  ).run(amount, amount, userId);

  db.prepare(
    "INSERT INTO balance_transactions (id, user_id, type, amount_usdc, description, created_at) VALUES (?, ?, 'refund', ?, ?, datetime('now'))"
  ).run(crypto.randomUUID(), userId, amount, description);

  return getBalance(userId);
}

export function getTransactions(userId: string, limit = 50): any[] {
  return db.prepare(
    "SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(userId, limit);
}
