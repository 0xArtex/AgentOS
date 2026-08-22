/**
 * Agent-to-agent resale marketplace (service layer).
 *
 * An owner lists an UNREVEALED, active account; a buyer takes it via an atomic
 * ownership swap (the live session transfers with the row); the sale returns the
 * seller + price so the route can pay them. Revealed / inactive / non-owned
 * accounts can't be listed, and you can't buy your own listing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";

if (!process.env.POOL_ENCRYPTION_KEY) {
  process.env.POOL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
}

import { db, initDatabase } from "../db";
import {
  registerAccount,
  markConnected,
  markRevealed,
  listForSale,
  unlist,
  marketListings,
  buyFromMarket,
  getAccount,
} from "../services/tiktok-accounts";

initDatabase();

const CT = "ZM"; // sentinel country, isolates this test's listings
const SELLER = "0x" + "a".repeat(40); // wallet-shaped
const BUYER = "0x" + "b".repeat(40);

function freshActive(id: string, owner = SELLER): void {
  registerAccount({ id, owner, country: CT, proxySessionId: id });
  markConnected(id); // → active
}

test("marketplace: list an active unrevealed account, buy it, ownership + listing update", () => {
  db.prepare("DELETE FROM tiktok_accounts WHERE country=?").run(CT);
  const id = "mkt" + randomBytes(4).toString("hex");
  freshActive(id);

  const listed = listForSale(id, SELLER, 12);
  assert.ok(listed.ok, `list should succeed: ${JSON.stringify(listed)}`);
  const listings = marketListings({ country: CT });
  assert.equal(listings.length, 1, "the listing shows in the market");
  assert.equal(listings[0].account_id, id);
  assert.equal(listings[0].price_usdc, 12);

  // You can't buy your own listing.
  const own = buyFromMarket(SELLER, id);
  assert.equal(own.ok, false);
  assert.equal(own.ownListing, true);

  // A real buyer takes it: ownership swaps, listing clears, seller + price returned.
  const bought = buyFromMarket(BUYER, id);
  assert.ok(bought.ok, `buy should succeed: ${JSON.stringify(bought)}`);
  assert.equal(bought.seller, SELLER, "seller returned for payout");
  assert.equal(bought.price_usdc, 12);
  assert.equal(getAccount(id)?.owner, BUYER, "ownership transferred to the buyer");
  assert.equal(getAccount(id)?.list_price_usdc, null, "listing cleared after sale");
  assert.equal(marketListings({ country: CT }).length, 0, "no longer in the market");

  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});

test("marketplace: a revealed account cannot be listed", () => {
  db.prepare("DELETE FROM tiktok_accounts WHERE country=?").run(CT);
  const id = "mktrev" + randomBytes(4).toString("hex");
  freshActive(id);
  markRevealed(id);
  const r = listForSale(id, SELLER, 10);
  assert.equal(r.ok, false);
  assert.match(r.error || "", /revealed/i);
  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});

test("marketplace: cannot list a non-active account, or someone else's account", () => {
  db.prepare("DELETE FROM tiktok_accounts WHERE country=?").run(CT);
  const id = "mktinact" + randomBytes(4).toString("hex");
  registerAccount({ id, owner: SELLER, country: CT, proxySessionId: id }); // 'connecting', not active
  assert.equal(listForSale(id, SELLER, 10).ok, false, "connecting account is not listable");

  markConnected(id);
  assert.equal(listForSale(id, BUYER, 10).ok, false, "a non-owner cannot list it");
  assert.ok(listForSale(id, SELLER, 10).ok, "the owner can");

  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});

test("marketplace: unlist withdraws a listing; a withdrawn account can't be bought", () => {
  db.prepare("DELETE FROM tiktok_accounts WHERE country=?").run(CT);
  const id = "mktunl" + randomBytes(4).toString("hex");
  freshActive(id);
  listForSale(id, SELLER, 8);
  assert.equal(marketListings({ country: CT }).length, 1);

  const u = unlist(id, SELLER);
  assert.ok(u.ok);
  assert.equal(marketListings({ country: CT }).length, 0);
  assert.equal(buyFromMarket(BUYER, id).ok, false, "an unlisted account is not buyable");

  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});
