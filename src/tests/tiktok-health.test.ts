/**
 * GET /social/tiktok/health — aggregate operation outcomes.
 *
 * Nothing in the product read the TikTok job tables before this. That is why
 * five failed operations sat unexamined for five weeks, why nobody could say
 * whether the feature had ever worked in production, and why every judgement
 * about which failure mattered most was a guess.
 *
 * The properties that matter: counts must be right, "nothing ran" must be
 * distinguishable from "everything failed", and no account-identifying data may
 * appear in an unauthenticated response.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { db, initDatabase } from "../db";
import { tiktokHealthSnapshot } from "../services/tiktok-health";

initDatabase();

const ACCOUNT = "acct-health-probe";
const SECRET_CAPTION = "a caption nobody outside the owner should see";

/** The test DB persists across runs, so a baseline is only meaningful once the
 *  previous run's rows are gone — clearing inside seed() would delete and
 *  re-insert identical rows and net every delta to zero. */
function clearAccount(): void {
  db.prepare("DELETE FROM tiktok_post_jobs WHERE account_id = ?").run(ACCOUNT);
  db.prepare("DELETE FROM tiktok_op_jobs WHERE account_id = ?").run(ACCOUNT);
}

function seed(): void {
  const now = new Date().toISOString();

  const post = (status: string, code: string | null) =>
    db.prepare(
      `INSERT INTO tiktok_post_jobs
         (id, account_id, owner, caption, privacy, schedule_at, payment_signature, payment_chain, charged_usdc, status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), ACCOUNT, "OWNER-health", SECRET_CAPTION, null, null, "0xsig", "base", 0.01, status, code, now);

  const op = (opName: string, status: string, code: string | null) =>
    db.prepare(
      `INSERT INTO tiktok_op_jobs
         (id, op, account_id, owner, payment_signature, payment_chain, charged_usdc, status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), opName, ACCOUNT, "OWNER-health", "0xsig", "base", 0.001, status, code, now);

  post("posted", null);
  post("posted", null);
  post("failed", "UPLOAD_FAILED");
  op("follow", "failed", "NOT_READY");
  op("follow", "failed", "NOT_READY");
  op("delete", "done", null);
  op("like", "running", null);
}

/** Exercises the SAME function the route serves — not a copy of its SQL. */
async function getHealth(hours = 24): Promise<any> {
  return tiktokHealthSnapshot(hours);
}

/** Counts are repo-wide by design, so assert on the DELTA this seed produces. */
function delta(before: any, after: any, op: string, field: string): number {
  return ((after.operations[op] || {})[field] || 0) - ((before.operations[op] || {})[field] || 0);
}

test("counts succeeded, failed and pending per operation", async () => {
  clearAccount();
  const before = await getHealth();
  seed();
  const after = await getHealth();

  assert.equal(delta(before, after, "post", "succeeded"), 2);
  assert.equal(delta(before, after, "post", "failed"), 1);
  assert.equal(delta(before, after, "follow", "failed"), 2);
  assert.equal(delta(before, after, "delete", "succeeded"), 1);
  // 'running' is neither a success nor a failure — counting it as either would
  // misstate the success rate in whichever direction was convenient.
  assert.equal(delta(before, after, "like", "pending"), 1);
  assert.equal(delta(before, after, "like", "succeeded"), 0);
  assert.equal(delta(before, after, "like", "failed"), 0);
});

test("reports no success rate at all for an idle window, rather than zero", async () => {
  // A one-hour window with nothing terminal in it must not read as a 0% outage.
  clearAccount();
  const idle = tiktokHealthSnapshot(1);
  for (const op of Object.values(idle.operations)) {
    if (op.succeeded + op.failed === 0) assert.equal(op.success_rate_pct, undefined);
  }
});

test("surfaces the error-code distribution that makes a failure diagnosable", async () => {
  clearAccount();
  const before = await getHealth();
  seed();
  const after = await getHealth();

  const codeDelta = (op: string, code: string) =>
    (((after.operations[op] || {}).error_codes || {})[code] || 0) -
    (((before.operations[op] || {}).error_codes || {})[code] || 0);

  assert.equal(codeDelta("follow", "NOT_READY"), 2);
  assert.equal(codeDelta("post", "UPLOAD_FAILED"), 1);
});

test("leaks no account-identifying data — the endpoint is unauthenticated", async () => {
  clearAccount();
  seed();
  const blob = JSON.stringify(await getHealth());

  assert.ok(!blob.includes(SECRET_CAPTION), "captions must never appear");
  assert.ok(!blob.includes(ACCOUNT), "account ids must never appear");
  assert.ok(!blob.includes("OWNER-health"), "owner wallets must never appear");
});
