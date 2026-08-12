/**
 * Credential seeding for the deployable pool.
 *
 * Two things worth pinning. First, the parser: suppliers (accsmarket & co.) ship
 * a handful of colon shapes, and a template drives the split rather than a guess
 * — including the "login IS the email" and empty-field variants, and a hard error
 * when the field count doesn't line up (a ':' in a password would otherwise
 * corrupt every field silently). Second, the orchestrator's state machine: a
 * successful login+persist flips the row to 'active' (leasable) and records the
 * real @handle; ANY failure (bad login, or a persist that throws) lands it in
 * 'dead' so poolStock — which counts only 'active' — never hands a half-seeded
 * account to a buyer. The browser is dependency-injected, so this runs without one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import {
  parseCredentialLine,
  beginSeed,
  runSeed,
  SeedDeps,
} from "../services/tiktok-pool-seed";
import { getAccount, poolStock, POOL_OWNER } from "../services/tiktok-accounts";
import type { TikTokLoginResult } from "../services/tiktok-login";

initDatabase();

function clearPool(): void {
  db.prepare("DELETE FROM tiktok_accounts WHERE owner = ?").run(POOL_OWNER);
}

/* ─── parser ─────────────────────────────────────────────────────────────── */

test("parses the default login:password:email:email_password shape", () => {
  const c = parseCredentialLine("user1:pass1:mail@x.com:mailpass");
  assert.deepEqual(c, { login: "user1", password: "pass1", email: "mail@x.com", email_password: "mailpass" });
});

test("login-is-email shape reuses the login as the email for the OTP inbox", () => {
  // login(email):password:password_from_email — three fields, login is the email.
  const c = parseCredentialLine("bob@mail.com:tikpass:mailpass", "login:password:email_password");
  assert.equal(c.login, "bob@mail.com");
  assert.equal(c.password, "tikpass");
  assert.equal(c.email, "bob@mail.com", "no explicit email field → the email login is reused");
  assert.equal(c.email_password, "mailpass");
});

test("handles the empty-second-field variant (login::password:email:email_password)", () => {
  const c = parseCredentialLine("user::tikpass:mail@x.com:mailpass", "login::password:email:email_password");
  assert.deepEqual(c, { login: "user", password: "tikpass", email: "mail@x.com", email_password: "mailpass" });
});

test("a field-count mismatch is a hard error, not silently-wrong data", () => {
  assert.throws(
    () => parseCredentialLine("only:three:fields", "login:password:email:email_password"),
    /3 colon-separated parts but format .* expects 4/,
  );
});

test("rejects a format that doesn't map password, or names an unknown field", () => {
  assert.throws(() => parseCredentialLine("a:b", "login:email"), /must map both login and password/);
  assert.throws(() => parseCredentialLine("a:b", "login:nickname"), /unknown format field "nickname"/);
});

/* ─── orchestrator ───────────────────────────────────────────────────────── */

function fakeDeps(over: Partial<SeedDeps> & { onLogin?: TikTokLoginResult; persistThrows?: boolean; persistCalls?: { n: number } }): SeedDeps {
  return {
    login: over.login || (async () => over.onLogin || { success: true, cookies: [{ name: "sessionid", value: "abc" }], observed_username: "seeded_bob" }),
    persist:
      over.persist ||
      (async () => {
        if (over.persistCalls) over.persistCalls.n++;
        if (over.persistThrows) throw new Error("profile write failed");
      }),
  };
}

test("beginSeed registers a pool row that is NOT yet leasable", () => {
  clearPool();
  const started = beginSeed({ login: "u", password: "p", country: "us" });
  const row = getAccount(started.account_id)!;
  assert.equal(row.owner, POOL_OWNER);
  assert.equal(row.status, "connecting");
  assert.equal(started.proxy_session_id, started.account_id, "the id doubles as the sticky proxy session");
  assert.equal(poolStock().total, 0, "a connecting seed is not ready stock");
});

test("a successful login+persist makes the account active, leasable, and named", async () => {
  clearPool();
  const started = beginSeed({ login: "bob@x.com", password: "p", email: "bob@x.com", email_password: "e", country: "us" });
  const persistCalls = { n: 0 };
  const out = await runSeed(
    { account_id: started.account_id, proxy_session_id: started.proxy_session_id, country: "us", login: "bob@x.com", password: "p" },
    fakeDeps({ persistCalls }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.status, "active");
  assert.equal(out.handle, "seeded_bob", "the observed username becomes the handle");
  assert.equal(persistCalls.n, 1, "the harvested session is persisted into the profile");
  const row = getAccount(started.account_id)!;
  assert.equal(row.status, "active");
  assert.equal(row.handle, "seeded_bob");
  assert.equal(poolStock().total, 1, "now it is ready stock a deploy can hand out");
});

test("a failed login lands the row in 'dead' and never persists or leases", async () => {
  clearPool();
  const started = beginSeed({ login: "u", password: "bad", country: "us" });
  const persistCalls = { n: 0 };
  const out = await runSeed(
    { account_id: started.account_id, proxy_session_id: started.proxy_session_id, country: "us", login: "u", password: "bad" },
    fakeDeps({ onLogin: { success: false, error: "wrong password", error_code: "BAD_CREDENTIALS" }, persistCalls }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.error_code, "BAD_CREDENTIALS");
  assert.equal(persistCalls.n, 0, "a failed login must not proceed to persist");
  assert.equal(getAccount(started.account_id)!.status, "dead");
  assert.equal(getAccount(started.account_id)!.last_error_code, "BAD_CREDENTIALS");
  assert.equal(poolStock().total, 0, "a dead seed is never leasable");
});

test("a login that succeeds but a persist that throws is also 'dead', not a phantom-live account", async () => {
  clearPool();
  const started = beginSeed({ login: "u", password: "p", country: "us" });
  const out = await runSeed(
    { account_id: started.account_id, proxy_session_id: started.proxy_session_id, country: "us", login: "u", password: "p" },
    fakeDeps({ persistThrows: true }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.error_code, "PERSIST_FAILED");
  assert.equal(getAccount(started.account_id)!.status, "dead");
  assert.equal(poolStock().total, 0, "no session on disk → must not be offered as ready");
});
