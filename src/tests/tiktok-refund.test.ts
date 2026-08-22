/**
 * Auto-refund provenance + eligibility building blocks (service layer).
 *
 * A pool sale (deploy) records purchase provenance so it can be refunded while
 * sealed + unused; a resale clears that provenance (the seller holds the money,
 * so the buyer can't refund against the treasury); reclaim returns it to the
 * pool and wipes buyer state; and "used since purchase" counts real value ops
 * (follow/like/delete/post) but NOT the deploy rebrand (profile/avatar).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";

if (!process.env.POOL_ENCRYPTION_KEY) {
  process.env.POOL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
}

import { db, initDatabase } from "../db";
import "../services/tiktok-ops-jobs"; // side effect: ensures tiktok_op_jobs exists
import {
  registerAccount,
  markConnected,
  recordPurchase,
  hasBuyerUsedSince,
  reclaimToPool,
  listForSale,
  buyFromMarket,
  getAccount,
  POOL_OWNER,
} from "../services/tiktok-accounts";

initDatabase();

const CT = "ZR";
const BUYER = "0x" + "c".repeat(40);

test("refund: recordPurchase stamps provenance; reclaim returns to pool + wipes it", () => {
  const id = "rf" + randomBytes(4).toString("hex");
  registerAccount({ id, owner: BUYER, country: CT, proxySessionId: id });
  markConnected(id);
  recordPurchase(id, { amountUsdc: 3, paymentSig: "sig123", chain: "base" });

  const bought = getAccount(id)!;
  assert.ok(bought.bought_at, "bought_at stamped");
  assert.equal(bought.bought_amount_usdc, 3);
  assert.equal(bought.bought_payment_sig, "sig123");

  reclaimToPool(id);
  const reclaimed = getAccount(id)!;
  assert.equal(reclaimed.owner, POOL_OWNER, "returned to the pool");
  assert.equal(reclaimed.bought_at, null, "provenance wiped");
  assert.equal(reclaimed.bought_amount_usdc, null);

  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});

test("refund: 'used since purchase' counts value ops, not the deploy rebrand", () => {
  const id = "rfu" + randomBytes(4).toString("hex");
  registerAccount({ id, owner: BUYER, country: CT, proxySessionId: id });
  markConnected(id);
  recordPurchase(id, { amountUsdc: 3 });
  const boughtAt = getAccount(id)!.bought_at!;

  assert.equal(hasBuyerUsedSince(id, boughtAt), false, "fresh purchase is unused");

  // The deploy rebrand (profile/avatar) must NOT count as usage.
  const opRow = (op: string, when: string) =>
    db.prepare("INSERT INTO tiktok_op_jobs (id, op, account_id, owner, status, created_at) VALUES (?, ?, ?, ?, 'done', ?)")
      .run("job" + randomBytes(4).toString("hex"), op, id, BUYER, when);
  opRow("profile", "2099-01-01T00:00:00.000Z");
  opRow("avatar", "2099-01-01T00:00:00.000Z");
  assert.equal(hasBuyerUsedSince(id, boughtAt), false, "rebrand ops don't count as usage");

  // A real value op after purchase does count.
  opRow("follow", "2099-01-01T00:00:00.000Z");
  assert.equal(hasBuyerUsedSince(id, boughtAt), true, "a follow after purchase = used");

  db.prepare("DELETE FROM tiktok_op_jobs WHERE account_id=?").run(id);
  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});

test("refund: a resold account loses its pool provenance (not refundable)", () => {
  db.prepare("DELETE FROM tiktok_accounts WHERE country=?").run(CT);
  const id = "rfr" + randomBytes(4).toString("hex");
  const seller = "0x" + "d".repeat(40);
  registerAccount({ id, owner: seller, country: CT, proxySessionId: id });
  markConnected(id);
  recordPurchase(id, { amountUsdc: 3, paymentSig: "origsig", chain: "base" });
  assert.ok(getAccount(id)!.bought_at, "pool provenance present before resale");

  listForSale(id, seller, 9);
  const bought = buyFromMarket(BUYER, id);
  assert.ok(bought.ok);
  assert.equal(getAccount(id)!.owner, BUYER, "resold to buyer");
  assert.equal(getAccount(id)!.bought_at, null, "resale wipes pool provenance → the new owner can't refund vs treasury");

  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});
