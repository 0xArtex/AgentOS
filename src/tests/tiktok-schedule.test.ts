/**
 * Scheduled posts — Palmyr's own record of what it asked TikTok to publish.
 *
 * TikTok exposes no way to read pending posts back (a held post's row is
 * byte-for-byte identical to a published one), so this record is the only place
 * the answer exists — which makes it authoritative about our INTENT and merely
 * a belief about TikTok's state.
 *
 * That gap is what these tests are mostly about. The dangerous failure is not
 * missing data, it is confident data: reporting "published" without evidence,
 * or "cancelled" for a post that is still going to go out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import { recordSample } from "../services/tiktok-metrics";
import { listScheduled, getScheduled, markCancelled, SCHEDULE_RECORD_CAVEAT } from "../services/tiktok-schedule";

initDatabase();

const OWNER = "0xSCHED_owner";
const OTHER = "0xSCHED_other";
const ACCT = "sched-acct";
const NOW = Date.parse("2026-08-02T12:00:00Z");
const iso = (minsFromNow: number) => new Date(NOW + minsFromNow * 60_000).toISOString();

function wipe(): void {
  db.prepare("DELETE FROM tiktok_post_jobs WHERE owner IN (?, ?)").run(OWNER, OTHER);
  db.prepare("DELETE FROM tiktok_post_metrics WHERE account_id = ?").run(ACCT);
}

function seedScheduled(id: string, opts: { owner?: string; at: string; videoId?: string | null; status?: string }): void {
  db.prepare(
    `INSERT INTO tiktok_post_jobs (id, account_id, owner, caption, schedule_at, status, video_id, video_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, ACCT, opts.owner ?? OWNER, `caption ${id}`, opts.at, opts.status ?? "posted",
    opts.videoId === undefined ? `vid-${id}` : opts.videoId,
    opts.videoId === null ? null : `https://www.tiktok.com/@a/video/vid-${id}`,
    new Date(NOW - 3_600_000).toISOString(),
  );
}

test("a post whose time has not come is scheduled, with the wait reported", () => {
  wipe();
  seedScheduled("s1", { at: iso(120) });
  const [p] = listScheduled(OWNER, { now: NOW });
  assert.equal(p.state, "scheduled");
  assert.equal(p.minutes_until, 120);
});

test("a post past its time is DUE, not published — we have no evidence either way", () => {
  // The honest middle state. TikTok will not confirm publication, so claiming
  // it would be inventing a fact; claiming failure would be worse.
  wipe();
  seedScheduled("s2", { at: iso(-60) });
  const [p] = listScheduled(OWNER, { now: NOW });
  assert.equal(p.state, "due");
  assert.equal(p.observed_views, null);
  assert.ok(p.minutes_until < 0);
});

test("views seen after the scheduled time confirm publication", () => {
  // A held post cannot gather views, so views after the hour are the one real
  // signal available.
  wipe();
  seedScheduled("s3", { at: iso(-120) });
  recordSample(ACCT, [{ id: "vid-s3", caption: "caption s3", views: 4200 }], iso(-30));

  const [p] = listScheduled(OWNER, { includeDone: true, now: NOW })
    .filter((x) => x.operation_id === "s3");
  assert.equal(p.state, "published");
  assert.equal(p.observed_views, 4200);
});

test("views recorded BEFORE the scheduled time prove nothing", () => {
  // A sample taken while the post was still held says nothing about whether it
  // later published — counting it would confirm publication from evidence that
  // predates it.
  wipe();
  seedScheduled("s4", { at: iso(-10) });
  recordSample(ACCT, [{ id: "vid-s4", caption: "caption s4", views: 900 }], iso(-600));

  const [p] = listScheduled(OWNER, { now: NOW });
  assert.equal(p.state, "due", "evidence from before the publish time is not evidence");
  assert.equal(p.observed_views, null);
});

test("zero views does not downgrade a due post to failed", () => {
  // A real published post can genuinely have no views yet. Absence of views is
  // not evidence of absence of publication.
  wipe();
  seedScheduled("s5", { at: iso(-30) });
  recordSample(ACCT, [{ id: "vid-s5", caption: "caption s5", views: 0 }], iso(-5));
  const [p] = listScheduled(OWNER, { now: NOW });
  assert.equal(p.state, "due");
});

test("cancelling is recorded and drops the post from the live list", () => {
  wipe();
  seedScheduled("s6", { at: iso(90) });
  markCancelled("s6", iso(-1));

  assert.deepEqual(listScheduled(OWNER, { now: NOW }), [], "a cancelled post is not still pending");
  const p = getScheduled(OWNER, "s6", NOW)!;
  assert.equal(p.state, "cancelled");
  assert.ok(p.cancelled_at);
});

test("cancelling twice does not rewrite the original time", () => {
  wipe();
  seedScheduled("s7", { at: iso(90) });
  markCancelled("s7", iso(-10));
  markCancelled("s7", iso(-1));
  assert.equal(getScheduled(OWNER, "s7", NOW)!.cancelled_at, iso(-10), "the first cancellation is the real one");
});

test("one wallet cannot see or address another's scheduled posts", () => {
  wipe();
  seedScheduled("s8", { owner: OTHER, at: iso(60) });
  assert.deepEqual(listScheduled(OWNER, { now: NOW }), []);
  assert.equal(getScheduled(OWNER, "s8", NOW), null, "an operation_id alone must not be access");
  assert.ok(getScheduled(OTHER, "s8", NOW), "its real owner still sees it");
});

test("a post that never actually posted is not listed as scheduled", () => {
  // A failed job had a schedule_at, but nothing is queued at TikTok — listing
  // it would show a post waiting to go out that does not exist.
  wipe();
  seedScheduled("s9", { at: iso(60), status: "failed" });
  assert.deepEqual(listScheduled(OWNER, { now: NOW }), []);
});

test("immediate posts never appear in the schedule", () => {
  wipe();
  db.prepare(
    `INSERT INTO tiktok_post_jobs (id, account_id, owner, caption, schedule_at, status, created_at)
     VALUES ('s10', ?, ?, 'now', NULL, 'posted', ?)`,
  ).run(ACCT, OWNER, new Date(NOW).toISOString());
  assert.deepEqual(listScheduled(OWNER, { includeDone: true, now: NOW }), []);
});

test("the drift caveat is one shared string, so it cannot say two things", () => {
  // The same limitation described two ways in two places teaches an agent to
  // trust neither wording.
  assert.match(SCHEDULE_RECORD_CAVEAT, /TikTok does not expose which posts are pending/);
  assert.match(SCHEDULE_RECORD_CAVEAT, /TikTok Studio/);
});
