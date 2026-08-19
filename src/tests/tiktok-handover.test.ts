/**
 * TikTok credential-handover pool: add → buy returns the full credentials.
 *
 * TikTok is sold out of the shared social_account_pool WITHOUT a server login
 * (automated TikTok login is blocked), so poolAddTikTok just stores the raw
 * credentials and poolBuy hands them to the buyer, who signs in themselves.
 * This verifies the whole handover path at the service layer, plus that the
 * old "twitter-only" guard no longer rejects TikTok buys.
 *
 * A unique sentinel country (`ZT`) isolates this test's row from any real
 * TikTok stock, so the buy is deterministic regardless of what else is seeded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";

// getKey() is lazy (only runs inside encrypt/decrypt), but set the key before
// importing the module so nothing can observe it unset.
if (!process.env.POOL_ENCRYPTION_KEY) {
  process.env.POOL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
}

import { db, initDatabase } from "../db";
import { poolAddTikTok, poolBuy, poolReadyStock } from "../services/social-pool";

initDatabase();

const SENTINEL_COUNTRY = "ZT"; // not a real market — isolates the test row

test("tiktok handover: add stores creds, buy hands them back in full", () => {
  db.prepare("DELETE FROM social_account_pool WHERE platform='tiktok' AND country=?").run(SENTINEL_COUNTRY);

  const add = poolAddTikTok({
    username: "@tt_handover_test",
    credentials: { login: "tt_handover_test", password: "s3cret-pw", email: "box@example.com", email_password: "mail-pw" },
    country: SENTINEL_COUNTRY,
    sale_price_usdc: 5,
    notes: "handover-test",
  });
  assert.ok(add.success && add.id, `add should succeed: ${JSON.stringify(add)}`);
  assert.equal(add.warning, undefined, "a full credential set produces no warning");
  assert.equal(poolReadyStock("tiktok").by_country[SENTINEL_COUNTRY], 1, "one ready row under the sentinel country");

  const buy = poolBuy({ platform: "tiktok", country: SENTINEL_COUNTRY, buyer_wallet: "wallet_test_buyer" });
  assert.ok(buy.success && buy.account, `buy should succeed, not the old twitter-only reject: ${JSON.stringify(buy)}`);
  assert.equal(buy.account!.platform, "tiktok");
  assert.equal(buy.account!.credentials.login, "tt_handover_test", "buyer receives the login");
  assert.equal(buy.account!.credentials.password, "s3cret-pw", "buyer receives the password");
  assert.equal(buy.account!.credentials.email, "box@example.com", "buyer receives the recovery email");
  assert.equal(buy.account!.credentials.email_password, "mail-pw", "buyer receives the email password");

  // The row is now sold, so a second buy under the same country finds nothing.
  const again = poolBuy({ platform: "tiktok", country: SENTINEL_COUNTRY, buyer_wallet: "wallet_test_buyer2" });
  assert.equal(again.success, false, "no ready stock left → no match (and definitely not a twitter-only error)");
  assert.ok(!/twitter-only/i.test(again.error || ""), "the rejection is 'no match', not the retired twitter-only guard");

  db.prepare("DELETE FROM social_account_pool WHERE id=?").run(add.id);
});

test("tiktok handover: an account seeded without email is flagged but allowed", () => {
  const add = poolAddTikTok({
    username: "no_email_acct",
    credentials: { login: "no_email_acct", password: "pw" },
    country: SENTINEL_COUNTRY,
    sale_price_usdc: 5,
    notes: "handover-test-noemail",
  });
  assert.ok(add.success && add.id);
  assert.match(add.warning || "", /email/i, "missing email surfaces a handover warning");
  db.prepare("DELETE FROM social_account_pool WHERE id=?").run(add.id);
});
