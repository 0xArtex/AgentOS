/**
 * Hook analysis.
 *
 * The failure mode of a system like this is confident nonsense from three data
 * points — "questions get 4x views!" computed from one post that happened to go
 * viral. So most of what is pinned here is restraint: what it refuses to claim,
 * what it excludes, and where it says "not enough data" instead of a number.
 *
 * The measurement rules that matter:
 *   - lift is against the account's OWN median, never another account's
 *   - a post still distributing is not judged at all
 *   - a pattern below MIN_CONFIDENT_POSTS reports but is not marked confident
 *   - an unconfident 10x never outranks a confident 1.5x in a list read top-down
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import { recordSample } from "../services/tiktok-metrics";
import { registerAccount } from "../services/tiktok-accounts";
import {
  extractHook,
  classifyHook,
  hookReport,
  checkCaption,
  MIN_CONFIDENT_POSTS,
} from "../services/tiktok-hooks";

initDatabase();

const OWNER = "0xHOOKS_owner";
const NOW = Date.parse("2026-08-01T00:00:00Z");

/** A video id whose embedded timestamp puts the post `daysAgo` in the past. */
function idAged(daysAgo: number): string {
  const secs = Math.floor((NOW - daysAgo * 86_400_000) / 1000);
  return (BigInt(secs) << 32n).toString();
}

function seed(accountId: string, posts: { caption: string; views: number; daysAgo: number }[]): void {
  db.prepare("DELETE FROM tiktok_post_metrics WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM tiktok_accounts WHERE id = ?").run(accountId);
  registerAccount({ id: accountId, owner: OWNER, tag: "fitness" });
  recordSample(
    accountId,
    posts.map((p) => ({ id: idAged(p.daysAgo), caption: p.caption, views: p.views, likes: 0, comments: 0 })),
    new Date(NOW).toISOString(),
  );
}

// ── extraction ───────────────────────────────────────────────────────────────

test("the hook is the opening line, not the hashtags", () => {
  assert.equal(extractHook("Stop doing crunches. Do this instead #fitness #gym"), "Stop doing crunches.");
  assert.equal(extractHook("POV: you skipped leg day\n\nagain #fyp"), "POV: you skipped leg day");
});

test("a caption that is only hashtags has no hook, rather than a hook made of hashtags", () => {
  assert.equal(extractHook("#fyp #viral #fitness"), null);
  assert.equal(extractHook("   "), null);
  assert.equal(extractHook(null), null);
  assert.equal(extractHook("https://example.com #ad"), null);
});

test("a run-on caption still only contributes its opening", () => {
  const long = "a".repeat(400);
  const hook = extractHook(long, 120)!;
  assert.equal(hook.length, 120, "the hook is the opening, not the whole caption");
});

// ── classification ───────────────────────────────────────────────────────────

test("recognises the common opening patterns", () => {
  assert.ok(classifyHook("Why does nobody talk about this?").includes("question"));
  assert.ok(classifyHook("POV: you finally hit a PR").includes("pov"));
  assert.ok(classifyHook("3 ways to fix your squat").includes("listicle"));
  assert.ok(classifyHook("How I lost 20kg without cardio").includes("howto"));
  assert.ok(classifyHook("Stop doing crunches").includes("contrarian"));
  assert.ok(classifyHook("This is why your bench is stuck").includes("curiosity_gap"));
  assert.ok(classifyHook("I quit the gym for a month").includes("story"));
  assert.ok(classifyHook("How I got 500k followers in 30 days").includes("social_proof"));
});

test("a hook can be several patterns at once", () => {
  // Forcing one label would discard the overlap that makes some hooks work.
  const p = classifyHook("How do you fix your squat?");
  assert.ok(p.includes("question") && p.includes("howto") && p.includes("direct_address"));
});

test("a plain statement is not forced into a pattern", () => {
  // Inventing a label for everything makes the taxonomy meaningless.
  assert.deepEqual(classifyHook("Leg day at the gym today"), []);
  assert.deepEqual(classifyHook(""), []);
});

// ── the measurement rules ────────────────────────────────────────────────────

test("posts still distributing are excluded, not judged", () => {
  seed("hk-immature", [
    { caption: "Stop doing crunches", views: 50, daysAgo: 1 },
    { caption: "How I fixed my squat", views: 60, daysAgo: 2 },
  ]);
  const r = hookReport({ owner: OWNER, accountId: "hk-immature", now: NOW });

  assert.equal(r.baseline.mature_posts, 0, "a post from yesterday cannot be compared with one from last month");
  assert.equal(r.baseline.excluded_immature, 2);
  assert.deepEqual(r.patterns, [], "nothing mature means nothing to report");
  assert.match(r.notes.join(" "), /No posts old enough/);
});

test("a post whose age is unknown is treated as immature, not as old enough", () => {
  // Guessing "mature" from a missing field inflates a post's apparent quality
  // on nothing at all.
  db.prepare("DELETE FROM tiktok_post_metrics WHERE account_id = ?").run("hk-noage");
  db.prepare("DELETE FROM tiktok_accounts WHERE id = ?").run("hk-noage");
  registerAccount({ id: "hk-noage", owner: OWNER });
  recordSample("hk-noage", [{ id: "not-a-snowflake-id", caption: "Stop doing crunches", views: 999 }], new Date(NOW).toISOString());

  const r = hookReport({ owner: OWNER, accountId: "hk-noage", now: NOW });
  assert.equal(r.baseline.mature_posts, 0);
  assert.equal(r.baseline.excluded_immature, 1);
});

test("lift is measured against this account's own median", () => {
  seed("hk-lift", [
    // Baseline: median of [100, 100, 100, 400, 400, 400] = 250
    { caption: "Leg day today", views: 100, daysAgo: 40 },
    { caption: "Gym session", views: 100, daysAgo: 41 },
    { caption: "Morning workout", views: 100, daysAgo: 42 },
    { caption: "Stop doing crunches", views: 400, daysAgo: 43 },
    { caption: "Stop skipping rest days", views: 400, daysAgo: 44 },
    { caption: "Never train to failure", views: 400, daysAgo: 45 },
  ]);
  const r = hookReport({ owner: OWNER, accountId: "hk-lift", now: NOW });

  assert.equal(r.baseline.median_views, 250);
  const contrarian = r.patterns.find((p) => p.pattern === "contrarian")!;
  assert.equal(contrarian.posts, 3);
  assert.equal(contrarian.median_views, 400);
  assert.equal(contrarian.lift, 1.6, "400 / 250");
  assert.equal(contrarian.confident, true, `${MIN_CONFIDENT_POSTS} posts is the threshold`);
});

test("a pattern seen once reports its numbers but is not called confident", () => {
  seed("hk-anecdote", [
    { caption: "Leg day today", views: 100, daysAgo: 40 },
    { caption: "Gym session", views: 100, daysAgo: 41 },
    { caption: "Morning workout", views: 100, daysAgo: 42 },
    { caption: "POV: you skipped leg day", views: 9000, daysAgo: 43 },
  ]);
  const r = hookReport({ owner: OWNER, accountId: "hk-anecdote", now: NOW });

  const pov = r.patterns.find((p) => p.pattern === "pov")!;
  assert.equal(pov.posts, 1);
  assert.ok((pov.lift ?? 0) > 10, "the number is still shown");
  assert.equal(pov.confident, false, "one viral post is an anecdote, not a finding");
});

test("an unconfident outlier never outranks a confident result", () => {
  // A list people read top-down must not be led by noise.
  seed("hk-order", [
    { caption: "Stop doing crunches", views: 400, daysAgo: 40 },
    { caption: "Stop skipping rest", views: 400, daysAgo: 41 },
    { caption: "Never train to failure", views: 400, daysAgo: 42 },
    { caption: "Leg day today", views: 100, daysAgo: 43 },
    { caption: "POV: you skipped leg day", views: 50_000, daysAgo: 44 },
  ]);
  const r = hookReport({ owner: OWNER, accountId: "hk-order", now: NOW });

  assert.equal(r.patterns[0].confident, true, "a confident result leads");
  assert.equal(r.patterns[0].pattern, "contrarian");
  const povIndex = r.patterns.findIndex((p) => p.pattern === "pov");
  assert.ok(povIndex > 0, "the 100x anecdote is ranked below it");
});

test("a zero-view baseline yields no lift rather than an infinite one", () => {
  seed("hk-zero", [
    { caption: "Stop doing crunches", views: 0, daysAgo: 40 },
    { caption: "Leg day", views: 0, daysAgo: 41 },
    { caption: "Gym", views: 0, daysAgo: 42 },
  ]);
  const r = hookReport({ owner: OWNER, accountId: "hk-zero", now: NOW });
  assert.equal(r.baseline.median_views, 0);
  for (const p of r.patterns) {
    assert.equal(p.lift, null, "a ratio against zero is not a finding");
    assert.equal(p.confident, false);
  }
});

test("top hooks are the actual opening lines of the best posts", () => {
  seed("hk-top", [
    { caption: "Stop doing crunches. Do this #gym", views: 900, daysAgo: 40 },
    { caption: "Leg day today", views: 100, daysAgo: 41 },
  ]);
  const r = hookReport({ owner: OWNER, accountId: "hk-top", now: NOW });
  assert.equal(r.top_hooks[0].hook, "Stop doing crunches.", "actionable without any statistics");
  assert.equal(r.top_hooks[0].views, 900);
});

test("a tag scopes the report across the accounts a wallet owns", () => {
  // The closest honest reading of "best hook for this industry": YOUR accounts
  // in that niche, measured — not a claim about the platform at large.
  seed("hk-niche-a", [{ caption: "Stop doing crunches", views: 500, daysAgo: 40 }]);
  seed("hk-niche-b", [{ caption: "Stop skipping rest", views: 700, daysAgo: 41 }]);

  const r = hookReport({ owner: OWNER, tag: "fitness", now: NOW });
  assert.ok(r.scope.account_ids.includes("hk-niche-a") && r.scope.account_ids.includes("hk-niche-b"));
  assert.equal(r.scope.tag, "fitness");
  assert.ok(r.baseline.mature_posts >= 2, "posts from both accounts are pooled");
});

// ── checking a caption before posting ────────────────────────────────────────

test("a draft caption is classified even with no history to compare against", () => {
  seed("hk-draft", []);
  const c = checkCaption({ owner: OWNER, accountId: "hk-draft", caption: "How do you fix your squat? #gym" });

  assert.equal(c.hook, "How do you fix your squat?");
  const names = c.patterns.map((p) => p.pattern);
  assert.ok(names.includes("question") && names.includes("howto"));
  assert.deepEqual(c.evidence, [], "no history means no evidence");
  assert.match(c.notes.join(" "), /no mature posts/i, "and it says so instead of inventing a verdict");
});

test("a caption with no hook is called out rather than silently scored", () => {
  seed("hk-nohook", []);
  const c = checkCaption({ owner: OWNER, accountId: "hk-nohook", caption: "#fyp #viral" });
  assert.equal(c.hook, null);
  assert.deepEqual(c.patterns, []);
  assert.match(c.notes.join(" "), /No readable hook/);
});

test("a draft is backed by this account's evidence once there is some", () => {
  // The contrarian posts must be a MINORITY, or they define the baseline they
  // are being measured against (see the test below).
  seed("hk-evidence", [
    { caption: "Stop doing crunches", views: 400, daysAgo: 40 },
    { caption: "Stop skipping rest", views: 400, daysAgo: 41 },
    { caption: "Never train to failure", views: 400, daysAgo: 42 },
    { caption: "Leg day today", views: 100, daysAgo: 43 },
    { caption: "Gym session", views: 100, daysAgo: 44 },
    { caption: "Morning workout", views: 100, daysAgo: 45 },
    { caption: "Back day", views: 100, daysAgo: 46 },
    { caption: "Rest day", views: 100, daysAgo: 47 },
  ]);
  const c = checkCaption({ owner: OWNER, accountId: "hk-evidence", caption: "Stop training every day", now: NOW });
  const ev = c.evidence.find((e) => e.pattern === "contrarian")!;
  assert.equal(ev.confident, true);
  assert.equal(ev.lift, 4, "400 against a baseline of 100");
});

test("a pattern that dominates an account cannot show lift, because it IS the baseline", () => {
  // Not a bug — arithmetic. Worth pinning so nobody later "fixes" a lift of
  // 1.0 that is telling the truth: when almost every post uses one opening,
  // that opening is the account's normal, and there is nothing to outperform.
  seed("hk-dominant", [
    { caption: "Stop doing crunches", views: 400, daysAgo: 40 },
    { caption: "Stop skipping rest", views: 400, daysAgo: 41 },
    { caption: "Never train to failure", views: 400, daysAgo: 42 },
    { caption: "Leg day today", views: 100, daysAgo: 43 },
  ]);
  const r = hookReport({ owner: OWNER, accountId: "hk-dominant", now: NOW });
  const contrarian = r.patterns.find((p) => p.pattern === "contrarian")!;
  assert.equal(contrarian.posts, 3);
  assert.equal(contrarian.lift, 1, "3 of 4 posts use it, so it defines the median it is compared to");
});

// ── hooks decay, so old wins are not evidence about now ──────────────────────

test("posts older than the recency window are excluded, and counted", () => {
  // An opening that printed views 18 months ago can be dead today. Averaging
  // it in launders a stale pattern into a current recommendation.
  seed("hk-stale", [
    { caption: "Stop doing crunches", views: 9000, daysAgo: 500 },
    { caption: "Stop skipping rest", views: 9000, daysAgo: 480 },
    { caption: "Never train to failure", views: 9000, daysAgo: 460 },
    { caption: "Leg day today", views: 100, daysAgo: 30 },
  ]);
  const r = hookReport({ owner: OWNER, accountId: "hk-stale", now: NOW });

  assert.equal(r.baseline.mature_posts, 1, "only the recent post is judged");
  assert.equal(r.baseline.excluded_stale, 3);
  assert.equal(r.patterns.find((p) => p.pattern === "contrarian"), undefined,
    "a pattern that only ever won outside the window must not be reported as current");
  assert.match(r.notes.join(" "), /older than 90 days/);
});

test("the report states the span it actually covers", () => {
  // Without this the finding silently means "sometime in this account's whole
  // history", which for something this time-sensitive is not an answer.
  seed("hk-window", [
    { caption: "Stop doing crunches", views: 400, daysAgo: 60 },
    { caption: "Leg day today", views: 100, daysAgo: 20 },
  ]);
  const r = hookReport({ owner: OWNER, accountId: "hk-window", now: NOW });

  assert.equal(r.baseline.recency_days, 90);
  assert.ok(r.baseline.window.from && r.baseline.window.to);
  const spanDays = (Date.parse(r.baseline.window.to!) - Date.parse(r.baseline.window.from!)) / 86_400_000;
  assert.ok(Math.abs(spanDays - 40) < 1, `oldest to newest judged post, got ${spanDays}d`);
});

test("the recency window is adjustable for accounts that post rarely", () => {
  // A weekly poster has too few posts in 90 days to say anything; widening the
  // window is the honest trade (more sample, staler signal) and is the
  // caller's call to make rather than ours.
  seed("hk-widen", [
    { caption: "Stop doing crunches", views: 400, daysAgo: 200 },
    { caption: "Stop skipping rest", views: 400, daysAgo: 220 },
    { caption: "Never train to failure", views: 400, daysAgo: 240 },
    { caption: "Leg day today", views: 100, daysAgo: 30 },
  ]);
  const narrow = hookReport({ owner: OWNER, accountId: "hk-widen", now: NOW });
  assert.equal(narrow.baseline.mature_posts, 1);

  const wide = hookReport({ owner: OWNER, accountId: "hk-widen", recencyDays: 365, now: NOW });
  assert.equal(wide.baseline.mature_posts, 4);
  assert.equal(wide.patterns.find((p) => p.pattern === "contrarian")?.confident, true);
});
