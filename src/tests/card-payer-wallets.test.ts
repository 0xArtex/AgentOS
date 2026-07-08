/**
 * Per-agent payer wallets (services/card-payer-wallets.ts).
 *
 * Custody + funding are the two money-critical properties:
 *  - one deterministic encrypted wallet per owner = one Laso account per agent
 *  - shortfall-only just-in-time funding (self-recycles stranded USDC, can't
 *    double-fund under the per-owner lock, fails DEFINITIVELY only when the
 *    operator float is provably insolvent)
 */
process.env.LASO_FLOAT_EVM_PRIVATE_KEY = process.env.LASO_FLOAT_EVM_PRIVATE_KEY || "0x" + "22".repeat(32);
if (!process.env.SECRETS_MASTER_KEY) process.env.ALLOW_INSECURE_SECRETS_KEY = "1";

import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { randomUUID } from "crypto";
import { db } from "../db";
import {
  lasoEnabled,
  loadFloatWallet,
  getOrCreatePayerWallet,
  getPayerWalletRow,
  payerAddressFor,
  payerAuthCtx,
  clearPayerTokens,
  ensurePayerFunded,
  CardFundingError,
  withOwnerLock,
  _resetCardWalletCachesForTest,
  _setFloatCacheForTest,
} from "../services/card-payer-wallets";

beforeEach(() => {
  db.prepare("DELETE FROM card_payer_wallets").run();
  _resetCardWalletCachesForTest();
  _setFloatCacheForTest(10_000);
});

const owner = () => `OWNER_${randomUUID().slice(0, 8)}`;

test("feature gates on the float key (new name, legacy fallback)", () => {
  assert.strictEqual(lasoEnabled(), true);
  const w = loadFloatWallet();
  assert.ok(w.address.startsWith("0x"));

  const saved = process.env.LASO_FLOAT_EVM_PRIVATE_KEY;
  delete process.env.LASO_FLOAT_EVM_PRIVATE_KEY;
  _resetCardWalletCachesForTest();
  process.env.LASO_PAYER_EVM_PRIVATE_KEY = "0x" + "33".repeat(32); // legacy name
  assert.strictEqual(lasoEnabled(), true);
  assert.ok(loadFloatWallet().address.startsWith("0x"));
  delete process.env.LASO_PAYER_EVM_PRIVATE_KEY;
  _resetCardWalletCachesForTest();
  assert.strictEqual(lasoEnabled(), false);
  process.env.LASO_FLOAT_EVM_PRIVATE_KEY = saved;
  _resetCardWalletCachesForTest();
});

test("one deterministic wallet per owner, key ciphertext at rest", () => {
  const o = owner();
  const first = getOrCreatePayerWallet(o);
  const again = getOrCreatePayerWallet(o);
  assert.strictEqual(first.wallet.address, again.wallet.address); // stable per owner
  const other = getOrCreatePayerWallet(owner());
  assert.notStrictEqual(other.wallet.address, first.wallet.address); // isolated per owner

  const row = getPayerWalletRow(o)!;
  assert.ok(row.key_ciphertext.startsWith("enc:v1:"));
  assert.ok(!row.key_ciphertext.includes(first.wallet.privateKey.slice(2, 20)));
  assert.strictEqual(payerAddressFor(o), first.wallet.address);
  assert.strictEqual(payerAddressFor("never-seen"), null);
});

test("auth ctx stores tokens encrypted on the wallet row; clear forces re-auth", () => {
  const o = owner();
  const ctx = payerAuthCtx(o);
  assert.strictEqual(ctx.readTokens(), null);
  ctx.persistTokens("id-1", "refresh-1");
  const row = getPayerWalletRow(o)!;
  assert.ok(row.tokens_ciphertext!.startsWith("enc:v1:"));
  assert.ok(!row.tokens_ciphertext!.includes("id-1"));
  assert.strictEqual(payerAuthCtx(o).readTokens()!.id_token, "id-1");
  clearPayerTokens(o);
  assert.strictEqual(payerAuthCtx(o).readTokens(), null);
});

test("ensurePayerFunded: sufficient balance → no transfer at all", async () => {
  const o = owner();
  let transfers = 0;
  const out = await ensurePayerFunded(o, 20, {
    balanceOf: async () => 20,
    transfer: async () => {
      transfers++;
      return "0xnever";
    },
  });
  assert.strictEqual(out.fundedUsdc, 0);
  assert.strictEqual(out.fundingTx, null);
  assert.strictEqual(transfers, 0);
});

test("ensurePayerFunded: funds exactly the shortfall (stranded USDC recycles)", async () => {
  const o = owner();
  let sent: { to: string; amount: number } | null = null;
  const out = await ensurePayerFunded(o, 20, {
    balanceOf: async () => 6.34, // left behind by an earlier failed purchase
    transfer: async (to, amount) => {
      sent = { to, amount };
      return "0xfund";
    },
  });
  assert.strictEqual(out.fundedUsdc, 13.66);
  assert.strictEqual(sent!.amount, 13.66);
  assert.strictEqual(sent!.to, payerAddressFor(o));
  assert.strictEqual(out.fundingTx, "0xfund");
});

test("ensurePayerFunded: insolvent float → DEFINITIVE CardFundingError", async () => {
  _setFloatCacheForTest(5); // float can't cover the shortfall
  await assert.rejects(
    ensurePayerFunded(owner(), 20, { balanceOf: async () => 0 }),
    (e: any) => e instanceof CardFundingError && e.definitive === true
  );
});

test("ensurePayerFunded: transfer/RPC hiccups are NON-definitive (park + retry)", async () => {
  await assert.rejects(
    ensurePayerFunded(owner(), 20, {
      balanceOf: async () => 0,
      transfer: async () => {
        throw new Error("nonce too low");
      },
    }),
    (e: any) => e instanceof CardFundingError && e.definitive === false
  );
  await assert.rejects(
    ensurePayerFunded(owner(), 20, {
      balanceOf: async () => {
        throw new Error("rpc down");
      },
    }),
    (e: any) => e instanceof CardFundingError && e.definitive === false
  );
});

test("withOwnerLock serializes same-owner work and isolates owners", async () => {
  const events: string[] = [];
  const slow = withOwnerLock("A", async () => {
    events.push("a1-start");
    await new Promise((r) => setTimeout(r, 60));
    events.push("a1-end");
  });
  const queued = withOwnerLock("A", async () => {
    events.push("a2-start");
  });
  const other = withOwnerLock("B", async () => {
    events.push("b1");
  });
  await Promise.all([slow, queued, other]);
  // a2 must not start before a1 finished; B is free to interleave.
  assert.ok(events.indexOf("a1-end") < events.indexOf("a2-start"));
  assert.deepStrictEqual(
    events.filter((e) => e.startsWith("a")),
    ["a1-start", "a1-end", "a2-start"]
  );
});
