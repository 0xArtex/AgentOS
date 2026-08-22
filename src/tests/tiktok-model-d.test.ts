/**
 * Model D — server-session TikTok account with credential handover.
 *
 * An account is QR-seeded into the pool (server profile = live session) AND has
 * its raw credentials stored encrypted. On deploy the ownership swaps to the
 * buyer atomically, the buyer can read the credentials (to self-host / change
 * the password), and the previous owner (the pool sentinel) can no longer read
 * them. This verifies the storage + ownership-gated reveal at the service layer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";

if (!process.env.POOL_ENCRYPTION_KEY) {
  process.env.POOL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
}

import { db, initDatabase } from "../db";
import {
  registerPoolAccount,
  markConnected,
  setCredentials,
  getCredentials,
  hasCredentials,
  markRevealed,
  isRevealed,
  leaseFromPool,
  checkOwnership,
  getAccount,
  POOL_OWNER,
} from "../services/tiktok-accounts";

initDatabase();

// Sentinel country used only by this test — clear any rows a crashed prior run
// left so leaseFromPool (which picks the oldest active pool row for the country)
// deterministically hands over the row this test creates.
const SENTINEL = "ZT";
function resetSentinel(): void {
  db.prepare("DELETE FROM tiktok_accounts WHERE country=?").run(SENTINEL);
}

test("model D: seed stores creds, lease transfers ownership, creds survive + reveal is owner-gated", () => {
  resetSentinel();
  const id = "ttmodeld" + randomBytes(4).toString("hex");
  const reg = registerPoolAccount({ id, country: "ZT", proxySessionId: id });
  assert.ok(reg.ok, "pool registration succeeds");

  setCredentials(id, { login: "user1", password: "pw1", email: "e@x.com", email_password: "epw" });
  markConnected(id); // active → leasable

  assert.ok(hasCredentials(id), "credentials are stored");
  assert.equal(getCredentials(id)?.password, "pw1", "stored creds decrypt back");

  // While pooled, an arbitrary wallet is not the owner → reveal would be denied.
  assert.equal(checkOwnership(id, "random_wallet").allowed, false);

  // Deploy = atomic lease to the buyer.
  const buyer = "buyer_" + randomBytes(3).toString("hex");
  const leased = leaseFromPool(buyer, { country: "ZT" });
  assert.ok(leased.ok && leased.row?.id === id, `lease hands over the seeded account: ${JSON.stringify(leased)}`);
  assert.equal(getAccount(id)?.owner, buyer, "ownership transferred to the buyer");

  // Buyer can read the handover creds; the former owner (pool sentinel) cannot.
  assert.equal(checkOwnership(id, buyer).allowed, true, "buyer owns it");
  assert.equal(checkOwnership(id, POOL_OWNER).allowed, false, "former owner is locked out after the swap");
  const after = getCredentials(id);
  assert.equal(after?.login, "user1", "handover creds survive the ownership swap");
  assert.equal(after?.email, "e@x.com");

  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});

test("model D: an account seeded without creds has nothing to hand over", () => {
  resetSentinel();
  const id = "ttnoc" + randomBytes(4).toString("hex");
  registerPoolAccount({ id, country: "ZT", proxySessionId: id });
  assert.equal(hasCredentials(id), false);
  assert.equal(getCredentials(id), null);
  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});

test("reveal gate: a fresh account is sealed; reveal is one-way and idempotent", () => {
  resetSentinel();
  const id = "ttreveal" + randomBytes(4).toString("hex");
  registerPoolAccount({ id, country: "ZT", proxySessionId: id });
  setCredentials(id, { login: "u", password: "p" });

  // Sealed by default → refundable + resellable elsewhere key on this being false.
  assert.equal(isRevealed(id), false, "a fresh account is not revealed");
  assert.equal(getAccount(id)?.revealed_at, null);

  markRevealed(id);
  assert.equal(isRevealed(id), true, "reveal flips the gate");
  const firstAt = getAccount(id)?.revealed_at;
  assert.ok(firstAt, "revealed_at is stamped");

  // Re-revealing keeps the original timestamp (COALESCE) — the commitment is set once.
  markRevealed(id);
  assert.equal(getAccount(id)?.revealed_at, firstAt, "reveal time is not overwritten on a second reveal");

  db.prepare("DELETE FROM tiktok_accounts WHERE id=?").run(id);
});
