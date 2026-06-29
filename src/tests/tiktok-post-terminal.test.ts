/**
 * Regression for security audit #72 — an unreconcilable ambiguous TikTok post
 * used to be left status='publishing' forever (poll done=false), with the payer
 * still charged and resolution depending on a manual-ops step gated only on a
 * process restart. The recovery sweep now runs on an interval, so every such job
 * reaches a TERMINAL state without a restart. This test drives the worker into
 * the unresolved state, then proves the recovery sweep terminalizes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { db, initDatabase } from "../db";
import {
  runTikTokPost,
  recoverStuckTikTokPosts,
  getPostJob,
  TikTokPostDeps,
} from "../services/tiktok-post-jobs";

initDatabase();

function insertPendingJob(): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tiktok_post_jobs
       (id, account_id, owner, caption, privacy, schedule_at, payment_signature, payment_chain, charged_usdc, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(id, "acct-72", "OWNER-72", "my unresolved caption", null, null, "0xsig72", "base", 0.05, new Date().toISOString());
  return id;
}

test("an ambiguous + undetermined post becomes terminal via the recovery sweep (no blind refund)", async () => {
  const id = insertPendingJob();
  const request = { account_id: "acct-72", cookies: [{}], caption: "my unresolved caption" } as any;

  let refundCalls = 0;
  const deps: TikTokPostDeps = {
    // Ambiguous failure — Submit may have landed → reconcile, don't blind-fail.
    postVideo: async () => ({ success: false, error: "ui timeout", error_code: "UI_TIMEOUT" }),
    // Reconciliation can't open/scrape a session → undetermined.
    checkPosted: async () => ({ success: true, data: { determined: false, posted: false } }),
    refund: async () => {
      refundCalls++;
      return { ok: true, refundId: "should-not-happen" };
    },
  };

  // 1. Worker leaves it in the (previously permanent) unresolved 'publishing' state.
  await runTikTokPost(id, request, deps);
  let job = getPostJob(id)!;
  assert.equal(job.status, "publishing");
  assert.equal(job.error_code, "reconcile_unresolved");
  assert.equal(job.refund_status, "manual_needed");
  assert.equal(refundCalls, 0, "must not blind-refund an ambiguous post");

  // 2. The recurring recovery sweep (now interval-armed) terminalizes it once the
  //    job is older than the publish window. Backdate created_at and sweep.
  db.prepare("UPDATE tiktok_post_jobs SET created_at=? WHERE id=?")
    .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), id);
  await recoverStuckTikTokPosts(deps);

  job = getPostJob(id)!;
  assert.equal(job.status, "failed", "stuck job must reach a terminal state");
  assert.equal(job.error_code, "unconfirmed_after_recovery_window");
  // refund_status preserved as a manual breadcrumb; still no automated refund of
  // a post that may actually have published.
  assert.equal(job.refund_status, "manual_needed");
  assert.equal(refundCalls, 0);
});

test("a 'pending' job orphaned past the window is failed AND auto-refunded", async () => {
  const id = insertPendingJob();
  db.prepare("UPDATE tiktok_post_jobs SET created_at=? WHERE id=?")
    .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), id);

  let refundCalls = 0;
  const deps: TikTokPostDeps = {
    postVideo: async () => ({ success: true, data: {} }),
    checkPosted: async () => ({ success: true, data: { determined: false, posted: false } }),
    refund: async () => {
      refundCalls++;
      return { ok: true, refundId: "r-pending" };
    },
  };

  await recoverStuckTikTokPosts(deps);
  const job = getPostJob(id)!;
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "server_restarted_before_publish");
  assert.equal(refundCalls, 1, "a never-started post is definitively unposted → refund");
  assert.equal(job.refund_status, "sent");
});
