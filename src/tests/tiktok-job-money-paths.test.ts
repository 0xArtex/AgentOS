/**
 * Regressions for three defects that took real money from payers.
 *
 * Each was confirmed by reading the code, and the first was reachable on every
 * ambiguous post to any account that had ever posted before:
 *
 *  1. The reconciliation oracle could not answer "not posted". findPostedVideo
 *     falls back to the account's NEWEST video when no row matches the caption,
 *     and checkPostedByCaption treated any returned URL as proof — so a post
 *     that never published was marked 'posted', handed an unrelated video's URL,
 *     and never refunded.
 *  2. The ops recovery sweep ran once at boot with no recurring interval, so a
 *     job wedged in-process stayed non-terminal forever and was never refunded.
 *  3. The stuck-post sweep could not tell "wedged" from "queued behind the
 *     3-slot browser semaphore", so it failed live posts with
 *     refund_status='manual_needed' while the worker went on to publish them —
 *     the caller retried into a double post and a double charge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { db, initDatabase } from "../db";
import {
  runTikTokPost,
  recoverStuckTikTokPosts,
  getPostJob,
  isPostJobInFlight,
  TikTokPostDeps,
} from "../services/tiktok-post-jobs";
import { findPostedVideo } from "../services/tiktok-operations";

initDatabase();

/**
 * Minimal stand-in for the Studio content-manager page. `captionHref` is what a
 * caption search resolves to (null = this post's row is not present);
 * `newestHref` is what the newest-post fallback would find.
 */
function fakeStudioPage(opts: { captionHref: string | null; newestHref: string | null }) {
  let call = 0;
  return {
    url: () => "https://www.tiktok.com/tiktokstudio/content",
    goto: async () => {},
    waitForTimeout: async () => {},
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    evaluate: async (_src: string) => {
      // The caption lookup is polled up to 4 times before the fallback runs.
      call++;
      const isFallback = String(_src).includes("bestId");
      return isFallback ? opts.newestHref : opts.captionHref;
    },
  };
}

// ── 1a. The oracle's own logic, not an injected stand-in ─────────────────────

test("findPostedVideo labels a newest-post guess as such, so it cannot pass for proof", async () => {
  // Our caption is absent from the list; the account has prior content. This is
  // the exact shape that made the oracle report posted:true forever.
  const page = fakeStudioPage({ captionHref: null, newestHref: "/@someone/video/111" });
  const res = await findPostedVideo(page as any, "a caption that is not in the list");

  assert.equal(res.matched, "newest", "a fallback hit must be distinguishable from a caption match");
  assert.ok(res.video_url, "the fallback still resolves a URL for callers that legitimately want it");
});

test("findPostedVideo reports a real caption match as such", async () => {
  const page = fakeStudioPage({ captionHref: "/@me/video/222", newestHref: "/@me/video/999" });
  const res = await findPostedVideo(page as any, "my caption");

  assert.equal(res.matched, "caption");
  assert.equal(res.video_id, "222", "the matched row wins over the newest post");
});

test("findPostedVideo reports nothing found when the list is empty", async () => {
  const page = fakeStudioPage({ captionHref: null, newestHref: null });
  const res = await findPostedVideo(page as any, "anything");

  assert.equal(res.matched, "none");
  assert.ok(!res.video_url);
});

function insertPendingJob(caption: string, ageMinutes = 0): string {
  const id = randomUUID();
  const created = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO tiktok_post_jobs
       (id, account_id, owner, caption, privacy, schedule_at, payment_signature, payment_chain, charged_usdc, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(id, "acct-money", "OWNER-money", caption, null, null, "0xsigmoney", "base", 0.01, created);
  return id;
}

// ── 1. The reconciliation oracle must be able to say "not posted" ────────────

test("an ambiguous post that did NOT publish is failed and refunded, not reported as posted", async () => {
  const id = insertPendingJob("caption that never landed");
  const request = { account_id: "acct-money", cookies: [{}], caption: "caption that never landed" } as any;

  let refunded = 0;
  const deps: TikTokPostDeps = {
    postVideo: async () => ({ success: false, error: "ui timeout", error_code: "UI_TIMEOUT" }),
    // The oracle scraped the content manager, found no row matching OUR caption,
    // and correctly reports not-posted. Before the fix it returned posted:true
    // with the newest video's URL for any account with prior content.
    checkPosted: async () => ({ success: true, data: { determined: true, posted: false } }),
    refund: async () => {
      refunded++;
      return { ok: true, refundId: "refund-not-posted" };
    },
  };

  await runTikTokPost(id, request, deps);

  const job = getPostJob(id)!;
  assert.equal(job.status, "failed", "a post that never published must not be marked posted");
  assert.equal(refunded, 1, "the payer must be refunded exactly once");
  assert.equal(job.refund_status, "sent");
  assert.ok(!job.video_url, "no video_url may be attached to a post that did not publish");
});

test("an ambiguous post that DID publish is marked posted and is never refunded", async () => {
  const id = insertPendingJob("caption that landed");
  const request = { account_id: "acct-money", cookies: [{}], caption: "caption that landed" } as any;

  let refunded = 0;
  const deps: TikTokPostDeps = {
    postVideo: async () => ({ success: false, error: "ui timeout", error_code: "UI_TIMEOUT" }),
    checkPosted: async () => ({
      success: true,
      data: { determined: true, posted: true, video_url: "https://www.tiktok.com/@a/video/123", video_id: "123" },
    }),
    refund: async () => {
      refunded++;
      return { ok: true, refundId: "should-not-happen" };
    },
  };

  await runTikTokPost(id, request, deps);

  const job = getPostJob(id)!;
  assert.equal(job.status, "posted");
  assert.equal(job.video_url, "https://www.tiktok.com/@a/video/123");
  assert.equal(refunded, 0, "a post that landed must never be refunded");
});

// ── 3. Queued is not stuck ───────────────────────────────────────────────────

test("the stuck sweep leaves an in-flight post alone even when it is older than the cutoff", async () => {
  // Backdated well past STUCK_AGE_MS: exactly the shape of a post that has been
  // sitting in the browser semaphore's queue behind other uploads.
  const id = insertPendingJob("slow but alive", 30);
  const request = { account_id: "acct-money", cookies: [{}], caption: "slow but alive" } as any;

  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });

  let sweepRefunds = 0;
  const workerDeps: TikTokPostDeps = {
    postVideo: async () => {
      await held; // still working — this is what the semaphore queue looks like
      return { success: true, data: { video_url: "https://www.tiktok.com/@a/video/999", video_id: "999" } };
    },
    checkPosted: async () => ({ success: true, data: { determined: false, posted: false } }),
    refund: async () => ({ ok: true, refundId: "no" }),
  };

  const running = runTikTokPost(id, request, workerDeps);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(isPostJobInFlight(id), true, "the worker should own the job while it waits");

  // The sweep fires mid-flight — previously this terminalized the job as failed
  // with manual_needed, and the worker then published anyway.
  await recoverStuckTikTokPosts({
    postVideo: async () => ({ success: false, error: "unused", error_code: "UNKNOWN" }),
    checkPosted: async () => ({ success: true, data: { determined: false, posted: false } }),
    refund: async () => {
      sweepRefunds++;
      return { ok: true, refundId: "sweep" };
    },
  });

  let job = getPostJob(id)!;
  assert.equal(job.status, "publishing", "an in-flight job must not be terminalized by age alone");
  assert.equal(sweepRefunds, 0);

  release();
  await running;

  job = getPostJob(id)!;
  assert.equal(job.status, "posted", "the job completes normally once its slot frees");
  assert.equal(isPostJobInFlight(id), false, "the in-flight marker must be released");
});

test("a genuinely orphaned post (no live worker) is still terminalized by the sweep", async () => {
  // Same age, but no worker owns it — the restart case the sweep exists for.
  const id = insertPendingJob("orphaned by a restart", 30);

  await recoverStuckTikTokPosts({
    postVideo: async () => ({ success: false, error: "unused", error_code: "UNKNOWN" }),
    checkPosted: async () => ({ success: true, data: { determined: false, posted: false } }),
    refund: async () => ({ ok: true, refundId: "orphan-refund" }),
  });

  const job = getPostJob(id)!;
  assert.equal(job.status, "failed", "an orphaned job must reach a terminal state");
  assert.equal(job.refund_status, "sent", "a post that never began must be refunded");
});
