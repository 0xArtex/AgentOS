/**
 * The TikTok account registry.
 *
 * `account_id` used to be a string the caller made up, bound to nobody: any
 * wallet could name any account and act on it, and the protective velocity caps
 * keyed on that string reset the moment you changed it. Server-side logins made
 * it worse — they produced a browser profile on disk and no record at all, so
 * "which accounts do I own, and are they still logged in" had no answer.
 *
 * The properties worth pinning: ownership is enforced for registered accounts,
 * the older cookie-carrying flow keeps working, a re-connect repairs rather
 * than duplicates, another wallet cannot claim an account, and status only
 * moves on evidence that actually says something about the account.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import {
  registerAccount,
  getAccount,
  markConnected,
  noteSuccess,
  noteFailure,
  listByOwner,
  checkOwnership,
} from "../services/tiktok-accounts";

initDatabase();

const ALICE = "0xALICE_registry";
const BOB = "0xBOB_registry";

function fresh(id: string): void {
  db.prepare("DELETE FROM tiktok_accounts WHERE id = ?").run(id);
}

test("registering binds the account to a wallet", () => {
  fresh("acct-bind");
  const r = registerAccount({ id: "acct-bind", owner: ALICE, country: "ae" });
  assert.equal(r.ok, true);
  const row = getAccount("acct-bind")!;
  assert.equal(row.owner, ALICE);
  assert.equal(row.country, "ae");
  assert.equal(row.status, "connecting", "an account is not active until a login completes");
});

test("another wallet cannot claim an account that is already registered", () => {
  fresh("acct-claim");
  registerAccount({ id: "acct-claim", owner: ALICE });
  const stolen = registerAccount({ id: "acct-claim", owner: BOB });

  assert.equal(stolen.ok, false, "a re-connect by a different wallet must not silently transfer ownership");
  assert.equal(getAccount("acct-claim")!.owner, ALICE);
});

test("re-connecting your own account repairs it rather than duplicating it", () => {
  fresh("acct-repair");
  registerAccount({ id: "acct-repair", owner: ALICE, country: "ae" });
  markConnected("acct-repair");
  noteSuccess("acct-repair");
  const before = getAccount("acct-repair")!;

  // Same wallet, re-login (say the session died). Identity and history survive.
  const again = registerAccount({ id: "acct-repair", owner: ALICE });
  assert.equal(again.ok, true);
  const after = getAccount("acct-repair")!;
  assert.equal(after.created_at, before.created_at, "a re-connect is a repair, not a new account");
  assert.equal(after.country, "ae", "known facts are not erased by a re-connect that omits them");
  assert.equal(after.status, "connecting");
});

test("ownership is enforced for registered accounts", () => {
  fresh("acct-owned");
  registerAccount({ id: "acct-owned", owner: ALICE });

  assert.equal(checkOwnership("acct-owned", ALICE).allowed, true);

  const bob = checkOwnership("acct-owned", BOB);
  assert.equal(bob.allowed, false);
  if (!bob.allowed) assert.match(bob.reason, /another wallet/);

  // No identity at all must not pass either — otherwise the binding is bypassed
  // by simply not authenticating.
  assert.equal(checkOwnership("acct-owned", undefined).allowed, false);
});

test("an unregistered account id still works, so the older flow is not broken", () => {
  fresh("acct-legacy");
  // The cookie-carrying flow proves possession by supplying a live jar.
  // Enforcing ownership on ids nobody registered would break every existing
  // account without making anything safer.
  const verdict = checkOwnership("acct-legacy", BOB);
  assert.equal(verdict.allowed, true);
  if (verdict.allowed) assert.equal(verdict.registered, false);
});

test("status moves only on evidence that speaks to the account", () => {
  fresh("acct-status");
  registerAccount({ id: "acct-status", owner: ALICE });
  markConnected("acct-status");
  assert.equal(getAccount("acct-status")!.status, "active");

  // A page that failed to render says NOTHING about whether the account is
  // logged in. Inferring "logged out" from it is how the old code produced
  // confident, wrong diagnoses.
  noteFailure("acct-status", "NOT_READY");
  let row = getAccount("acct-status")!;
  assert.equal(row.status, "active", "a readiness failure must not be read as a dead session");
  assert.equal(row.last_error_code, "NOT_READY", "but it is still recorded");

  noteFailure("acct-status", "SESSION_EXPIRED");
  assert.equal(getAccount("acct-status")!.status, "logged_out");

  noteFailure("acct-status", "ACCOUNT_RESTRICTED");
  assert.equal(getAccount("acct-status")!.status, "restricted");
});

test("a success clears the stale error and revives a logged-out account, but not a restricted one", () => {
  fresh("acct-revive");
  registerAccount({ id: "acct-revive", owner: ALICE });
  markConnected("acct-revive");

  // A transient failure, then the very next operation works.
  noteFailure("acct-revive", "UNKNOWN");
  noteSuccess("acct-revive");
  const row = getAccount("acct-revive")!;
  assert.equal(row.last_error_code, null, "an account that just succeeded must not still advertise an old error");
  assert.equal(row.last_error_at, null);

  // A working session is direct proof the account is not logged out.
  noteFailure("acct-revive", "SESSION_EXPIRED");
  assert.equal(getAccount("acct-revive")!.status, "logged_out");
  noteSuccess("acct-revive");
  assert.equal(getAccount("acct-revive")!.status, "active", "a successful op disproves 'logged out'");

  // But restrictions are feature-scoped: succeeding at a follow says nothing
  // about a block on some other capability, so it must not clear itself.
  noteFailure("acct-revive", "ACCOUNT_RESTRICTED");
  assert.equal(getAccount("acct-revive")!.status, "restricted");
  noteSuccess("acct-revive");
  assert.equal(
    getAccount("acct-revive")!.status,
    "restricted",
    "one op succeeding is not evidence that a restriction on a different capability lifted",
  );
});

test("listing is owner-scoped and reports whether a profile really exists", () => {
  fresh("acct-mine-1");
  fresh("acct-mine-2");
  fresh("acct-theirs");
  registerAccount({ id: "acct-mine-1", owner: ALICE, tag: "fitness" });
  registerAccount({ id: "acct-mine-2", owner: ALICE });
  registerAccount({ id: "acct-theirs", owner: BOB });

  const mine = listByOwner(ALICE);
  const ids = mine.map((a) => a.id);
  assert.ok(ids.includes("acct-mine-1") && ids.includes("acct-mine-2"));
  assert.ok(!ids.includes("acct-theirs"), "one wallet must never see another's accounts");

  // A row claiming to exist whose browser profile is absent from this host is
  // not usable, and saying so beats trusting the status alone.
  assert.equal(mine.find((a) => a.id === "acct-mine-1")!.profile_present, false);

  const tagged = listByOwner(ALICE, "fitness");
  assert.deepEqual(tagged.map((a) => a.id), ["acct-mine-1"], "tag is a real server-side filter");
});
