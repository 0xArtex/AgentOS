/**
 * Per-post engagement history.
 *
 * Analytics used to be a one-shot scrape — the caller paid, got a snapshot, and
 * unless they stored it themselves the history was gone. The properties worth
 * pinning are the ones that make a stored series trustworthy: a sample that did
 * not move is not written twice, a video measured once is never reported as
 * "flat", a post's date is recovered arithmetically rather than scraped, and
 * one account's history is not visible in another's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import {
  recordSample,
  seriesFor,
  latestForAccount,
  growthSince,
  postedAtFromVideoId,
} from "../services/tiktok-metrics";

initDatabase();

function fresh(...accounts: string[]): void {
  for (const a of accounts) db.prepare("DELETE FROM tiktok_post_metrics WHERE account_id = ?").run(a);
}

const idFor = (iso: string): string => (BigInt(Math.floor(Date.parse(iso) / 1000)) << 32n).toString();

test("a post's date is recovered from its id, not scraped from the page", () => {
  // TikTok ids are Snowflake-style: high 32 bits are the creation time. This
  // works for posts made long before Palmyr saw the account, and has no
  // selector or locale-specific date format that can rotate underneath it.
  assert.equal(postedAtFromVideoId(idFor("2023-01-01T00:00:00Z")), "2023-01-01T00:00:00.000Z");
  assert.equal(postedAtFromVideoId(idFor("2020-06-15T12:30:00Z")), "2020-06-15T12:30:00.000Z");
});

test("an id that cannot be a real post decodes to null, never to a wrong date", () => {
  // "unknown" and "1970" are different claims. Returning a plausible-looking
  // wrong instant would silently poison every series it lands in.
  assert.equal(postedAtFromVideoId("123"), null, "too short");
  assert.equal(postedAtFromVideoId("not-a-number"), null);
  assert.equal(postedAtFromVideoId(""), null);
  assert.equal(postedAtFromVideoId("1000000000000000000"), null, "decodes to 1977 — before TikTok existed");
  const future = (BigInt(Math.floor(Date.now() / 1000) + 999_999) << 32n).toString();
  assert.equal(postedAtFromVideoId(future), null, "a post cannot be from the future");
});

test("a sample records the numbers and derives the post date", () => {
  fresh("acct-rec");
  const vid = idFor("2026-07-01T00:00:00Z");
  const r = recordSample("acct-rec", [{ id: vid, caption: "hi", video_url: "https://t/v", views: 100, likes: 5, comments: 1 }], "2026-07-28T10:00:00.000Z");
  assert.deepEqual(r, { recorded: 1, unchanged: 0 });

  const series = seriesFor("acct-rec", vid);
  assert.equal(series.length, 1);
  assert.equal(series[0].views, 100);
  assert.equal(series[0].posted_at, "2026-07-01T00:00:00.000Z", "posted_at is filled in without the scraper providing it");
});

test("numbers that did not move are not written again", () => {
  fresh("acct-dedup");
  const vid = idFor("2026-07-01T00:00:00Z");
  const post = { id: vid, views: 100, likes: 5, comments: 1 };

  assert.deepEqual(recordSample("acct-dedup", [post], "2026-07-28T10:00:00.000Z"), { recorded: 1, unchanged: 0 });
  // A video nobody watches for a month would otherwise write an unbounded run
  // of identical rows. "No row between two equal samples" is the normal sparse
  // encoding — the value simply did not change.
  assert.deepEqual(recordSample("acct-dedup", [post], "2026-07-28T11:00:00.000Z"), { recorded: 0, unchanged: 1 });
  assert.equal(seriesFor("acct-dedup", vid).length, 1);

  // A real change is recorded.
  assert.deepEqual(
    recordSample("acct-dedup", [{ ...post, views: 140 }], "2026-07-28T12:00:00.000Z"),
    { recorded: 1, unchanged: 0 },
  );
  const series = seriesFor("acct-dedup", vid);
  assert.deepEqual(series.map((s) => s.views), [100, 140], "the series is the changes, oldest first");
});

test("growth reports gains, and refuses to call a single sample flat", () => {
  fresh("acct-growth");
  const grown = idFor("2026-07-01T00:00:00Z");
  const once = idFor("2026-07-02T00:00:00Z");

  recordSample("acct-growth", [{ id: grown, views: 100, likes: 10, comments: 2 }], "2026-07-27T00:00:00.000Z");
  recordSample("acct-growth", [{ id: grown, views: 450, likes: 33, comments: 9 }], "2026-07-28T00:00:00.000Z");
  recordSample("acct-growth", [{ id: once, views: 7, likes: 0, comments: 0 }], "2026-07-28T00:00:00.000Z");

  const g = growthSince("acct-growth", "2026-07-01T00:00:00.000Z");
  const a = g.find((x) => x.video_id === grown)!;
  assert.equal(a.comparable, true);
  assert.equal(a.views_gained, 350);
  assert.equal(a.likes_gained, 23);

  const b = g.find((x) => x.video_id === once)!;
  assert.equal(b.comparable, false, "measured once");
  assert.equal(b.views_gained, null, "a gain of 0 would claim we watched it not move — we never did");
});

test("growth ignores samples outside the window", () => {
  fresh("acct-window");
  const vid = idFor("2026-06-01T00:00:00Z");
  recordSample("acct-window", [{ id: vid, views: 10 }], "2026-07-01T00:00:00.000Z");
  recordSample("acct-window", [{ id: vid, views: 900 }], "2026-07-28T00:00:00.000Z");

  // Only the newest sample is inside — one sample, so not comparable, rather
  // than a fabricated 890-view gain measured from outside the window.
  const g = growthSince("acct-window", "2026-07-20T00:00:00.000Z");
  assert.equal(g.length, 1);
  assert.equal(g[0].comparable, false);
  assert.equal(g[0].views, 900);
});

test("the latest view shows one row per video, not the whole history", () => {
  fresh("acct-latest");
  const v1 = idFor("2026-07-01T00:00:00Z");
  const v2 = idFor("2026-07-05T00:00:00Z");
  recordSample("acct-latest", [{ id: v1, views: 1 }, { id: v2, views: 2 }], "2026-07-26T00:00:00.000Z");
  recordSample("acct-latest", [{ id: v1, views: 50 }, { id: v2, views: 60 }], "2026-07-28T00:00:00.000Z");

  const latest = latestForAccount("acct-latest");
  assert.equal(latest.length, 2, "one row per video");
  assert.equal(latest.find((r) => r.video_id === v1)!.views, 50, "and it is the newest one");
  assert.equal(latest[0].video_id, v2, "newest post first");
});

test("one account's history is not visible in another's", () => {
  fresh("acct-mine", "acct-yours");
  const vid = idFor("2026-07-01T00:00:00Z");
  recordSample("acct-mine", [{ id: vid, views: 111 }], "2026-07-28T00:00:00.000Z");
  recordSample("acct-yours", [{ id: vid, views: 222 }], "2026-07-28T00:00:00.000Z");

  // Same video id in both — the account must scope every read, or one caller's
  // series silently absorbs another's numbers.
  assert.equal(seriesFor("acct-mine", vid)[0].views, 111);
  assert.equal(seriesFor("acct-yours", vid)[0].views, 222);
  assert.equal(latestForAccount("acct-mine").length, 1);
});

test("a malformed scrape row is skipped rather than poisoning the series", () => {
  fresh("acct-junk");
  const good = idFor("2026-07-01T00:00:00Z");
  const r = recordSample(
    "acct-junk",
    [{ id: good, views: 5 }, { id: "" } as any, null as any, { views: 9 } as any],
    "2026-07-28T00:00:00.000Z",
  );
  assert.equal(r.recorded, 1, "only the row with a usable id is stored");
  assert.equal(latestForAccount("acct-junk").length, 1);
});
