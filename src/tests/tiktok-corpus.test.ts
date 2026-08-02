/**
 * The niche hook corpus — what is working on TikTok at large.
 *
 * This exists because `tiktok hooks <username>` needs your own posting history
 * and a new account has none. The corpus needs none. But it introduces a
 * different way to be wrong: these are OTHER PEOPLE's posts, and a hook that
 * printed five million views for an established creator is not a prediction
 * about a new account.
 *
 * So the properties pinned here are the separations and the dates: corpus
 * results never merge with account results, a stale corpus says so, posts too
 * old to matter are dropped even from a fresh collection, and every example
 * carries when it worked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import {
  parseUpstreamPost,
  storeCollection,
  corpusReport,
  corpusFreshness,
  recordCollectionRun,
  collectionHistory,
} from "../services/tiktok-corpus";
import { resolveNiche, NICHES } from "../services/tiktok-niches";

initDatabase();

const NOW = Date.parse("2026-08-01T00:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function wipe(niche: string): void {
  db.prepare("DELETE FROM tiktok_niche_corpus WHERE niche = ?").run(niche);
  db.prepare("DELETE FROM tiktok_niche_collections WHERE niche = ?").run(niche);
}

function post(id: string, caption: string, views: number, daysAgo: number) {
  return { video_id: id, author: "someone", caption, views, likes: 0, comments: 0, shares: 0, saves: 0, posted_at: iso(daysAgo) };
}

// ── niche resolution ─────────────────────────────────────────────────────────

test("a canonical niche resolves to itself and is not reported as substituted", () => {
  const r = resolveNiche("fitness")!;
  assert.equal(r.niche.id, "fitness");
  assert.equal(r.resolved, false, "an exact ask was not redirected");
});

test("an unlisted word resolves to the nearest niche, and SAYS it was redirected", () => {
  // Refusing "sourdough" when "cooking" is plainly the right shelf helps
  // nobody — but silently answering about a different niche would be worse.
  const r = resolveNiche("sourdough")!;
  assert.equal(r.niche.id, "cooking");
  assert.equal(r.resolved, true, "the caller must be able to tell a redirect from a hit");
});

test("aliases and hashtag-ish input resolve", () => {
  assert.equal(resolveNiche("#gym")!.niche.id, "fitness");
  assert.equal(resolveNiche("Weight Loss")!.niche.id, "nutrition");
  assert.equal(resolveNiche("dropshipping")!.niche.id, "business");
});

test("nonsense resolves to nothing rather than to a wrong niche", () => {
  // Guessing here would hand back confident findings about a niche the caller
  // never asked about.
  assert.equal(resolveNiche("zzzzqqq"), null);
  assert.equal(resolveNiche(""), null);
});

test("every niche has several distinct queries", () => {
  // Four pages of one search return four pages of the same content; distinct
  // angles are what make the sample varied enough to mean anything.
  for (const n of NICHES) {
    assert.ok(n.queries.length >= 3, `${n.id} needs several angles, has ${n.queries.length}`);
    assert.equal(new Set(n.queries).size, n.queries.length, `${n.id} has duplicate queries`);
  }
});

// ── parsing the upstream ─────────────────────────────────────────────────────

test("parses a real upstream post shape", () => {
  // Field-for-field the shape observed live from Scrape Creators.
  const p = parseUpstreamPost({
    aweme_id: "7661640609324748063",
    desc: "Start doing simple exercise moves #fitnesstips",
    create_time: 1783864749,
    author: { unique_id: "growyoungfitness" },
    statistics: { play_count: 73606, digg_count: 1431, comment_count: 17, share_count: 921, collect_count: 873 },
  })!;
  assert.equal(p.video_id, "7661640609324748063");
  assert.equal(p.views, 73606);
  assert.equal(p.saves, 873);
  assert.equal(p.author, "growyoungfitness");
  assert.equal(p.posted_at, "2026-07-12T13:59:09.000Z", "create_time is the date the hook worked");
});

test("an implausible create_time becomes null, never 1970", () => {
  // "we don't know when" and "it worked in 1970" are different claims, and a
  // decay model only survives one of them.
  assert.equal(parseUpstreamPost({ aweme_id: "1", create_time: 0 })!.posted_at, null);
  assert.equal(parseUpstreamPost({ aweme_id: "1", create_time: 99_999_999_999 })!.posted_at, null);
  assert.equal(parseUpstreamPost({ aweme_id: "" }), null, "a post with no id is not a post");
});

// ── the report ───────────────────────────────────────────────────────────────

test("reports which openings lead in a niche, with examples that carry their date", () => {
  wipe("fitness");
  storeCollection("fitness", "fitness tips", [
    post("1", "Stop doing crunches", 400_000, 10),
    post("2", "Stop skipping rest days", 400_000, 12),
    post("3", "Never train to failure", 400_000, 14),
    post("4", "Leg day today", 100_000, 16),
    post("5", "Gym session", 100_000, 18),
  ], iso(1));

  const r = corpusReport({ niche: "fitness", now: NOW })!;
  assert.equal(r.niche, "fitness");
  assert.equal(r.window.posts, 5);
  assert.equal(r.window.median_views, 400_000);

  const contrarian = r.patterns.find((p) => p.pattern === "contrarian")!;
  assert.equal(contrarian.posts, 3);
  assert.equal(contrarian.confident, true);
  assert.ok(contrarian.examples.length > 0, "an agent needs real phrasing, not just a label");
  assert.ok(contrarian.examples[0].posted_at, "and needs to know how recent it is");
  assert.ok(contrarian.examples[0].video_url.includes("/video/"));
});

test("a corpus result always states it is not measured on your account", () => {
  wipe("fitness");
  storeCollection("fitness", "q", [post("1", "Stop doing crunches", 400_000, 10)], iso(1));
  const r = corpusReport({ niche: "fitness", now: NOW })!;
  assert.match(r.notes.join(" "), /NOT measured on yours/i,
    "another creator's reach must never read as a prediction about the caller's account");
});

test("old posts are dropped even from a fresh collection", () => {
  // A collection made today can still be full of year-old videos, and those
  // say nothing about what works now. Collection freshness is not post
  // freshness — conflating them is how a decayed hook gets recommended.
  wipe("fitness");
  storeCollection("fitness", "q", [
    post("1", "Stop doing crunches", 900_000, 400),
    post("2", "Stop skipping rest", 900_000, 420),
    post("3", "Leg day today", 100_000, 10),
  ], iso(0));

  const r = corpusReport({ niche: "fitness", now: NOW })!;
  assert.equal(r.window.posts, 1, "only the recent post counts");
  assert.equal(r.patterns.find((p) => p.pattern === "contrarian"), undefined,
    "a pattern that only won a year ago is not evidence about now");
});

test("a stale corpus says so and names the fix", () => {
  wipe("fitness");
  storeCollection("fitness", "q", [post("1", "Stop doing crunches", 400_000, 10)], iso(30));
  const r = corpusReport({ niche: "fitness", now: NOW })!;
  assert.equal(r.freshness.stale, true);
  assert.match(r.notes.join(" "), /corpus refresh fitness/, "tell the operator how to fix it");
});

test("an empty niche says it has no corpus rather than returning nothing", () => {
  wipe("gaming");
  const r = corpusReport({ niche: "gaming", now: NOW })!;
  assert.equal(r.window.posts, 0);
  assert.deepEqual(r.patterns, []);
  assert.match(r.notes.join(" "), /No corpus collected/);
});

test("only the newest collection is reported, not every snapshot pooled", () => {
  // Pooling snapshots would double-count videos that appear in both and blur
  // exactly the change over time the dates exist to expose.
  wipe("fitness");
  storeCollection("fitness", "q", [post("1", "Stop doing crunches", 100, 20)], iso(20));
  storeCollection("fitness", "q", [post("1", "Stop doing crunches", 900, 20), post("2", "Leg day", 100, 20)], iso(1));

  const r = corpusReport({ niche: "fitness", now: NOW })!;
  assert.equal(r.window.posts, 2, "the newest snapshot only");
  assert.equal(r.window.median_views, 500, "median of 900 and 100, not of all three rows");
});

test("collection runs are recorded even when they store nothing", () => {
  // A niche whose collection keeps failing must be visible as failing, not
  // indistinguishable from one nobody has asked for.
  wipe("pets");
  recordCollectionRun({ niche: "pets", collectedAt: iso(1), queries: 4, posts: 0, costUsdc: 0.24, error: "collection stored no posts" });
  const h = collectionHistory("pets");
  assert.equal(h.length, 1);
  assert.equal(h[0].posts, 0);
  assert.equal(h[0].cost_usdc, 0.24, "what we paid is recorded even when we got nothing");
  assert.match(String(h[0].error), /no posts/);
});

test("freshness reflects the newest collection", () => {
  wipe("cooking");
  assert.equal(corpusFreshness("cooking", 5, NOW).stale, true, "never collected counts as stale");
  storeCollection("cooking", "q", [post("1", "Stop overcooking chicken", 1000, 5)], iso(2));
  const f = corpusFreshness("cooking", 5, NOW);
  assert.equal(f.stale, false);
  assert.equal(f.age_days, 2);
  assert.equal(f.posts, 1);
});
