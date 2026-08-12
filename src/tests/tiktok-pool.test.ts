/**
 * The deployable TikTok pool.
 *
 * A ready account is just a registry row owned by a reserved sentinel; deploying
 * it is an atomic owner swap. The properties worth pinning: a seeded row is
 * pool-owned and only becomes deliverable once its login completes (status
 * 'active'), a lease hands exactly one account to the buyer and removes it from
 * the pool, the country filter is honoured, an empty (or wrong-country) pool
 * refunds via a clean no-stock error, and a leased account can never be leased a
 * second time — which is what stops two concurrent deploys getting the same one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import {
  registerPoolAccount,
  leaseFromPool,
  poolStock,
  POOL_OWNER,
  markConnected,
  getAccount,
  checkOwnership,
} from "../services/tiktok-accounts";

initDatabase();

const BUYER = "0xBUYER_pool";
const BUYER2 = "0xBUYER2_pool";

/**
 * Clean slate for a test: drop the exact rows it uses (by id, regardless of who
 * owns them now — a prior run leaves them owned by the buyer), and clear any
 * sentinel rows left elsewhere so poolStock totals reflect only this test.
 */
function reset(...ids: string[]): void {
  const del = db.prepare("DELETE FROM tiktok_accounts WHERE id = ?");
  for (const id of ids) del.run(id);
  db.prepare("DELETE FROM tiktok_accounts WHERE owner = ?").run(POOL_OWNER);
}

test("a seeded account is pool-owned and not deliverable until its login completes", () => {
  reset("pool-seed-1");
  const r = registerPoolAccount({ id: "pool-seed-1", country: "us", proxySessionId: "sess-1" });
  assert.equal(r.ok, true);
  const row = getAccount("pool-seed-1")!;
  assert.equal(row.owner, POOL_OWNER);
  assert.equal(row.status, "connecting");

  // A row still connecting has no live session to hand over, so stock is empty
  // and a lease finds nothing.
  assert.equal(poolStock().total, 0, "a connecting seed is not ready stock");
  assert.equal(leaseFromPool(BUYER).ok, false, "a connecting account must not be leased");

  // The QR scan completes → active → now it is deliverable.
  markConnected("pool-seed-1");
  const stock = poolStock();
  assert.equal(stock.total, 1);
  assert.equal(stock.by_country["US"], 1, "stock is grouped by upper-cased country");
});

test("leasing hands the account to the buyer and removes it from the pool", () => {
  reset("pool-lease-1");
  registerPoolAccount({ id: "pool-lease-1", country: "gb", proxySessionId: "sess-2" });
  markConnected("pool-lease-1");

  const leased = leaseFromPool(BUYER, { tag: "brand-x" });
  assert.equal(leased.ok, true);
  assert.equal(leased.row!.id, "pool-lease-1");
  assert.equal(leased.row!.owner, BUYER, "ownership transferred to the buyer");
  assert.equal(leased.row!.tag, "brand-x", "an optional tag is applied on lease");

  // It is the buyer's now — they pass ownership, the pool does not.
  assert.equal(checkOwnership("pool-lease-1", BUYER).allowed, true);
  assert.equal(poolStock().total, 0, "a leased account leaves the pool");
});

test("the same account can never be leased twice", () => {
  reset("pool-once");
  registerPoolAccount({ id: "pool-once", country: "us", proxySessionId: "sess-3" });
  markConnected("pool-once");

  const first = leaseFromPool(BUYER);
  assert.equal(first.ok, true);
  assert.equal(first.row!.id, "pool-once");

  // With the pool now empty, a second buyer gets a clean no-stock error rather
  // than the already-sold account — the guard that makes concurrent deploys safe.
  const second = leaseFromPool(BUYER2);
  assert.equal(second.ok, false);
  assert.match(second.error!, /no ready pool accounts/);
  assert.equal(getAccount("pool-once")!.owner, BUYER, "the first buyer keeps it");
});

test("the country filter only matches its market, and a miss reports the country", () => {
  reset("pool-us", "pool-br");
  registerPoolAccount({ id: "pool-us", country: "us", proxySessionId: "s-us" });
  registerPoolAccount({ id: "pool-br", country: "br", proxySessionId: "s-br" });
  markConnected("pool-us");
  markConnected("pool-br");

  const br = leaseFromPool(BUYER, { country: "br" });
  assert.equal(br.ok, true);
  assert.equal(br.row!.id, "pool-br", "country filter picks the matching market");

  // No German stock → a no-stock error that names the country (the route turns
  // this into a refund + an in-stock hint).
  const de = leaseFromPool(BUYER, { country: "de" });
  assert.equal(de.ok, false);
  assert.match(de.error!, /country=DE/);

  // The US account is untouched and still leasable.
  assert.equal(poolStock().by_country["US"], 1);
  assert.equal(leaseFromPool(BUYER, { country: "us" }).ok, true);
});

test("the pool sentinel is never a valid buyer", () => {
  reset("pool-sentinel-guard");
  registerPoolAccount({ id: "pool-sentinel-guard", country: "us", proxySessionId: "s-g" });
  markConnected("pool-sentinel-guard");
  const bad = leaseFromPool(POOL_OWNER);
  assert.equal(bad.ok, false, "leasing to the sentinel would just re-own it to the pool");
  assert.equal(getAccount("pool-sentinel-guard")!.owner, POOL_OWNER, "and the account stays in the pool");
});
