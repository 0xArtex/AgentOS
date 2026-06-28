/**
 * Money-safety regression tests for the balance ledger.
 *
 * Covers the deposit-monitor / balance.ts hardening:
 *  - deposit() is idempotent on a repeated reference_id (the stable Solana
 *    refId scheme means a replayed credit must NOT double-credit)
 *  - the UNIQUE(reference_id) index is the authoritative backstop even if the
 *    advisory SELECT is bypassed
 *  - NULL reference_ids never collide (many debits/legacy refunds have NULL)
 *  - refund() is idempotent on a repeated reference_id
 *  - refund() never drives total_spent below 0
 *  - debit() + deposit() keep balance and ledger in agreement (transactional)
 *
 * Mirrors concurrency.test.ts: point the data dir at a throwaway temp location
 * BEFORE importing the modules that open the DB at import time.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DATA_DIR = join(tmpdir(), `palmyr-test-deposit-idem-${Date.now()}`);
mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.PALMYR_DATA_DIR = TEST_DATA_DIR;

// Imported AFTER PALMYR_DATA_DIR is set so the SQLite file lands in the temp dir
// and initDatabase() (run on import) builds the schema + UNIQUE index there.
import { db } from "../db";
import { deposit, refund, debit, getBalance } from "../services/balance";
import { creditSolanaTransfer, usdcCreditForOwner, ensureTable } from "../services/deposit-monitor";

function ledgerCount(userId: string, type: string, referenceId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM balance_transactions WHERE user_id = ? AND type = ? AND reference_id = ?"
  ).get(userId, type, referenceId) as { n: number };
  return row.n;
}

describe("deposit idempotency", () => {
  after(() => {
    try { db.close(); } catch {}
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  describe("deposit()", () => {
    it("credits once for a given reference_id and rejects the replay", () => {
      const user = "u-dep-1";
      const refId = "sol_addr_0_5";

      const b1 = deposit(user, 5, refId, "first credit");
      assert.equal(b1.balance_usdc, 5);
      assert.equal(b1.total_deposited, 5);

      // Replaying the SAME reference_id must throw "Duplicate" (callers in
      // deposit-monitor treat that as a skip) and must NOT move the balance.
      assert.throws(() => deposit(user, 5, refId, "replay"), /Duplicate/);

      const after = getBalance(user);
      assert.equal(after.balance_usdc, 5, "balance unchanged after replay");
      assert.equal(after.total_deposited, 5, "total_deposited unchanged after replay");
      assert.equal(ledgerCount(user, "deposit", refId), 1, "exactly one ledger row");
    });

    it("UNIQUE(reference_id) index blocks a direct duplicate insert (authoritative backstop)", () => {
      const user = "u-dep-2";
      deposit(user, 3, "dup-key-xyz", "credit");
      // Simulate the SELECT-bypass race: a raw INSERT with the same reference_id
      // must be rejected by the DB, proving idempotency is not merely advisory.
      assert.throws(() => {
        db.prepare(
          "INSERT INTO balance_transactions (id, user_id, type, amount_usdc, reference_id) VALUES (?, ?, 'deposit', ?, ?)"
        ).run(crypto.randomUUID(), user, 3, "dup-key-xyz");
      }, /UNIQUE|constraint/i);
    });

    it("a genuine re-deposit of the same amount under a new seq IS credited", () => {
      const user = "u-dep-3";
      // Mirrors the stable refId scheme: seq increments per credit, so the same
      // dollar amount deposited twice produces two distinct reference_ids.
      deposit(user, 7, "sol_w_0_7", "deposit #1");
      deposit(user, 7, "sol_w_1_7", "deposit #2");
      const b = getBalance(user);
      assert.equal(b.balance_usdc, 14, "both same-amount deposits credited");
      assert.equal(b.total_deposited, 14);
    });

    it("NULL reference_ids never collide", () => {
      const user = "u-dep-4";
      // Two NULL-reference deposits are distinct rows (SQLite treats NULLs as
      // distinct under a UNIQUE index) and both credit.
      deposit(user, 2, "", "no-ref a");
      deposit(user, 2, "", "no-ref b");
      const b = getBalance(user);
      assert.equal(b.balance_usdc, 4);
    });
  });

  describe("refund()", () => {
    it("is idempotent on a repeated reference_id", () => {
      const user = "u-ref-1";
      deposit(user, 10, "seed-ref-1", "seed");
      debit(user, 4, "svc", "spend"); // balance 6, total_spent 4

      const r1 = refund(user, 4, "refund once", "refund-key-1");
      assert.equal(r1.balance_usdc, 10);
      assert.equal(r1.total_spent, 0);

      // Retried refund with same key: no-op, no double credit.
      const r2 = refund(user, 4, "refund retry", "refund-key-1");
      assert.equal(r2.balance_usdc, 10, "balance not double-credited");
      assert.equal(r2.total_spent, 0);
      assert.equal(ledgerCount(user, "refund", "refund-key-1"), 1, "one refund ledger row");
    });

    it("never drives total_spent below zero", () => {
      const user = "u-ref-2";
      deposit(user, 5, "seed-ref-2", "seed"); // total_spent 0
      // Refund with no prior spend: total_spent must floor at 0, not go negative.
      const r = refund(user, 5, "over-refund", "refund-key-2");
      assert.equal(r.total_spent, 0, "total_spent floored at 0");
      assert.equal(r.balance_usdc, 10);
    });
  });

  describe("debit()", () => {
    it("keeps balance and ledger in agreement", () => {
      const user = "u-deb-1";
      deposit(user, 20, "seed-ref-3", "seed");
      debit(user, 8, "svc", "spend");
      const b = getBalance(user);
      assert.equal(b.balance_usdc, 12);
      assert.equal(b.total_spent, 8);

      const rows = db.prepare(
        "SELECT type, amount_usdc FROM balance_transactions WHERE user_id = ? ORDER BY created_at"
      ).all(user) as Array<{ type: string; amount_usdc: number }>;
      const deposits = rows.filter(r => r.type === "deposit").reduce((s, r) => s + r.amount_usdc, 0);
      const debits = rows.filter(r => r.type === "debit").reduce((s, r) => s + r.amount_usdc, 0);
      assert.equal(deposits - debits, b.balance_usdc, "ledger sum matches balance");
    });

    it("rejects an over-spend and leaves balance untouched", () => {
      const user = "u-deb-2";
      deposit(user, 3, "seed-ref-4", "seed");
      assert.throws(() => debit(user, 99, "svc", "too much"), /Insufficient/);
      assert.equal(getBalance(user).balance_usdc, 3, "balance unchanged after rejected debit");
    });
  });

  // ── Solana signature-based attribution (the deposit-monitor hardening) ──
  // Credits are attributed to a concrete on-chain transfer SIGNATURE and deduped
  // on it (mirroring the Base tx-hash path), NOT derived from a balance snapshot.
  // This proves the two money-safety findings:
  //   #1 one on-chain deposit → exactly one credit, even across a stale
  //      post-sweep RPC re-read / restart, and
  //   #2 a genuine re-deposit of an identical amount IS credited.
  describe("Solana signature attribution (deposit-monitor)", () => {
    const w = { id: "dw-sol-1", user_id: "u-sol-1" };

    before(() => { ensureTable(); }); // deposit_credits / cursor tables for the dedup cache

    it("credits a signature exactly once; a stale/post-sweep re-read is a no-op", () => {
      const sig = "Sig" + "A".repeat(43);

      assert.equal(creditSolanaTransfer(w, sig, 5), true, "first sight credits");
      assert.equal(getBalance("u-sol-1").balance_usdc, 5);

      // The double-credit bug: after a sweep, a stale RPC still reports the old
      // balance and the SAME deposit tx is re-observed next cycle. Signature dedup
      // makes that a no-op instead of a second credit.
      assert.equal(creditSolanaTransfer(w, sig, 5), false, "replay is a no-op");
      assert.equal(getBalance("u-sol-1").balance_usdc, 5, "balance unchanged across stale re-read");
      assert.equal(ledgerCount("u-sol-1", "deposit", `sol_${sig}`), 1, "exactly one ledger row");
    });

    it("credits a genuine re-deposit of an IDENTICAL amount under a new signature", () => {
      const a = "Sig" + "B".repeat(43);
      const b = "Sig" + "C".repeat(43);

      assert.equal(creditSolanaTransfer(w, a, 5), true);
      // Same dollar amount, different signature → a different reference_id → a real
      // second credit. The old balance-equality dedup would have swallowed this.
      assert.equal(creditSolanaTransfer(w, b, 5), true, "identical amount, new signature → credited");
      assert.equal(getBalance("u-sol-1").balance_usdc, 15, "both same-amount re-deposits credited (5+5+5)");
    });

    it("heals after a crash between deposit() and recordCredit (no double-credit on restart)", () => {
      const sig = "Sig" + "D".repeat(43);

      // Simulate a prior run that wrote the ledger row but died before persisting
      // the dedup-cache row: balance_transactions has sol_<sig>, deposit_credits
      // does not. On restart the monitor re-attributes the same signature.
      deposit("u-sol-1", 5, `sol_${sig}`, "prior-run credit");
      const before = getBalance("u-sol-1").balance_usdc;

      // deposit() throws Duplicate (UNIQUE(reference_id) backstop); the monitor
      // swallows it AND heals the cache — never a second credit.
      assert.equal(creditSolanaTransfer(w, sig, 5), false, "duplicate signature is a no-op");
      assert.equal(getBalance("u-sol-1").balance_usdc, before, "no double-credit after restart");
      assert.equal(ledgerCount("u-sol-1", "deposit", `sol_${sig}`), 1, "still exactly one ledger row");
      // Cache healed: the next sight short-circuits before any deposit() call.
      assert.equal(creditSolanaTransfer(w, sig, 5), false, "dedup cache now hits");
    });

    it("usdcCreditForOwner: incoming nets a positive credit, an outgoing sweep nets zero", () => {
      const owner = "Owner1111111111111111111111111111111111111";
      const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
      const idx = 1;

      // Incoming +5 USDC to the owner's USDC token account.
      const incoming = {
        preTokenBalances: [{ accountIndex: idx, mint, owner, uiTokenAmount: { uiAmount: 0 } }],
        postTokenBalances: [{ accountIndex: idx, mint, owner, uiTokenAmount: { uiAmount: 5 } }],
      };
      assert.equal(usdcCreditForOwner(incoming, owner), 5, "incoming transfer credits its delta");

      // Outgoing sweep: 5 → 0. Must read as 0, never a credit (this is exactly the
      // movement the old delta scheme mis-handled).
      const sweep = {
        preTokenBalances: [{ accountIndex: idx, mint, owner, uiTokenAmount: { uiAmount: 5 } }],
        postTokenBalances: [{ accountIndex: idx, mint, owner, uiTokenAmount: { uiAmount: 0 } }],
      };
      assert.equal(usdcCreditForOwner(sweep, owner), 0, "a sweep is not a credit");

      // A transfer touching a different owner / mint is ignored.
      const unrelated = {
        preTokenBalances: [{ accountIndex: 2, mint, owner: "SomeoneElse", uiTokenAmount: { uiAmount: 0 } }],
        postTokenBalances: [{ accountIndex: 2, mint, owner: "SomeoneElse", uiTokenAmount: { uiAmount: 9 } }],
      };
      assert.equal(usdcCreditForOwner(unrelated, owner), 0, "another owner's balance is ignored");
    });
  });
});
