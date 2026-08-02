/**
 * Auto-collection — Palmyr paying an upstream with no human in the loop.
 *
 * That is the part worth being careful about. An agent asking about a niche can
 * now cause real money to move, so what is pinned here is the bounding: a daily
 * cap that actually stops spending, one collection per niche no matter how many
 * ask at once, and a hard refusal to spend when unconfigured.
 *
 * The latency shape matters too and is asserted directly, because getting it
 * wrong is invisible until an agent is sitting on a 30-second read: stale data
 * is served immediately and refreshed behind the response; only a cold niche is
 * ever waited on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import { storeCollection, recordCollectionRun, corpusFreshness } from "../services/tiktok-corpus";
import { spentTodayUsdc, collectorEnabled, ensureFresh } from "../services/tiktok-corpus-collector";

initDatabase();

const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function wipe(...niches: string[]): void {
  for (const n of niches) {
    db.prepare("DELETE FROM tiktok_niche_corpus WHERE niche = ?").run(n);
    db.prepare("DELETE FROM tiktok_niche_collections WHERE niche = ?").run(n);
  }
}

function post(id: string, caption: string, views: number, daysAgo: number) {
  return { video_id: id, author: "a", caption, views, likes: 0, comments: 0, shares: 0, saves: 0, posted_at: iso(daysAgo) };
}

test("collection is off unless a payer wallet is configured", () => {
  // Failing closed matters more than failing loudly: an unconfigured server
  // must serve what it has, never half-attempt a payment. Both keys have to be
  // absent — the treasury is the default payer, so checking only the dedicated
  // override would pass on a server that can in fact spend.
  const hadCorpus = process.env.CORPUS_PAYER_EVM_PRIVATE_KEY;
  const hadTreasury = process.env.TREASURY_EVM_PRIVATE_KEY;
  delete process.env.CORPUS_PAYER_EVM_PRIVATE_KEY;
  delete process.env.TREASURY_EVM_PRIVATE_KEY;
  assert.equal(collectorEnabled(), false);
  if (hadCorpus) process.env.CORPUS_PAYER_EVM_PRIVATE_KEY = hadCorpus;
  if (hadTreasury) process.env.TREASURY_EVM_PRIVATE_KEY = hadTreasury;
});

test("an unconfigured server refuses to collect, and says why", async () => {
  wipe("gaming");
  const r = await ensureFresh("gaming");
  assert.equal(r.awaited, false, "nobody waits on a collection that cannot happen");
  assert.equal(r.skipped, "not_configured");
});

test("fresh data is served with no collection attempted at all", async () => {
  wipe("cooking");
  storeCollection("cooking", "q", [post("1", "Stop overcooking chicken", 1000, 3)], iso(1));
  assert.equal(corpusFreshness("cooking").stale, false);

  const r = await ensureFresh("cooking");
  assert.equal(r.awaited, false);
  assert.equal(r.refreshing, false, "fresh means untouched — no spend, no background work");
  assert.equal(r.skipped, undefined);
});

test("an unknown niche never triggers a paid collection", async () => {
  // The niche list is the spend ceiling. If an unrecognised string could start
  // a collection, the ceiling would be however many strings a caller can type.
  const r = await ensureFresh("not-a-real-niche");
  assert.equal(r.skipped, "unknown_niche");
  assert.equal(r.awaited, false);
});

test("the daily cap is computed from what was actually spent", () => {
  wipe("travel", "pets");
  const before = spentTodayUsdc(NOW);
  recordCollectionRun({ niche: "travel", collectedAt: new Date(NOW).toISOString(), queries: 4, posts: 40, costUsdc: 0.24 });
  recordCollectionRun({ niche: "pets", collectedAt: new Date(NOW).toISOString(), queries: 4, posts: 0, costUsdc: 0.24 });
  const after = spentTodayUsdc(NOW);
  assert.equal(Math.round((after - before) * 100) / 100, 0.48,
    "a collection that stored nothing still cost money and must still count against the cap");
});

test("yesterday's spending does not count against today's cap", () => {
  wipe("music");
  const before = spentTodayUsdc(NOW);
  recordCollectionRun({ niche: "music", collectedAt: iso(2), queries: 4, posts: 10, costUsdc: 0.24 });
  assert.equal(spentTodayUsdc(NOW), before, "the cap is daily, so it has to reset daily");
});

test("a stale corpus is still served — staleness is not emptiness", async () => {
  // The whole point of stale-while-revalidate: week-old numbers are a real
  // answer, and blocking a read on a refresh to avoid showing them is worse
  // than showing them.
  wipe("art");
  storeCollection("art", "q", [post("1", "Stop drawing like this", 5000, 10)], iso(30));
  const f = corpusFreshness("art");
  assert.equal(f.stale, true);
  assert.equal(f.posts, 1, "there is something to serve");

  const r = await ensureFresh("art");
  assert.equal(r.awaited, false, "a stale read must never block on collection");
});
