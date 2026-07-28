/**
 * Loading the WHOLE post list, not just the first screen.
 *
 * The content manager lazy-loads. Reading it without scrolling captures only
 * the newest handful of posts and reports that as the account's entire history
 * — which, for a time series, silently deletes every older video from the
 * record. Nothing errors; the numbers are just quietly wrong forever.
 *
 * The loop lives behind an authenticated browser session, so it was previously
 * unreachable by any test. It drives `page` through exactly two calls —
 * counting rows and scrolling — so a stand-in page can model a lazy-loading
 * list precisely and deterministically, with no browser and no network.
 *
 * What this proves: the algorithm collects everything, tolerates a stalled
 * fetch, terminates, and reports truncation instead of hiding it. What it does
 * NOT prove: that TikTok's list lazy-loads on scroll rather than paginating by
 * button — that needs an account with enough posts to page, which we don't yet
 * have. Recorded honestly rather than implied.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadAllPostRows } from "../services/tiktok-operations";

/**
 * A page that reveals `pageSize` more rows each time it is scrolled, up to
 * `total`. `stallAt` optionally makes ONE scroll return no new rows — the slow
 * fetch that a naive "stop when the count stops growing" loop mistakes for the
 * end of the list.
 */
function fakePage(opts: { total: number; pageSize: number; stallAt?: number }) {
  const state = {
    visible: Math.min(opts.pageSize, opts.total),
    scrollCount: 0,
    waits: 0,
  };
  return {
    state,
    async evaluate(script: string) {
      if (String(script).includes("querySelectorAll")) return state.visible;
      if (String(script).includes("scrollTo")) {
        state.scrollCount++;
        // The stalled round yields nothing, mimicking a fetch still in flight.
        if (opts.stallAt !== undefined && state.scrollCount === opts.stallAt) return null;
        state.visible = Math.min(state.visible + opts.pageSize, opts.total);
        return null;
      }
      return null;
    },
    async waitForTimeout(_ms: number) { state.waits++; },
  };
}

describe("loading every post row", () => {
  it("keeps scrolling until the whole list is loaded", async () => {
    // 97 posts revealed 20 at a time — the case the old code got wrong by
    // reading 20 and calling it the account's complete history.
    const page = fakePage({ total: 97, pageSize: 20 });
    const r = await loadAllPostRows(page, { settleMs: 0 });
    assert.equal(r.rows, 97, "every row must be loaded, not just the first screen");
    assert.equal(r.truncated, false);
  });

  it("does not mistake one stalled round for the end of the list", async () => {
    // A single flat check is ambiguous: end-of-list, or a fetch still running.
    // Stopping on it would drop every post below the stall.
    const page = fakePage({ total: 80, pageSize: 20, stallAt: 2 });
    const r = await loadAllPostRows(page, { settleMs: 0 });
    assert.equal(r.rows, 80, "a slow fetch must not be read as the end of the list");
  });

  it("stops promptly once the list really has ended", async () => {
    // Terminating matters as much as completeness — each round costs a
    // scroll and a settle against a live browser.
    const page = fakePage({ total: 40, pageSize: 20 });
    const r = await loadAllPostRows(page, { settleMs: 0 });
    assert.equal(r.rows, 40);
    assert.ok(r.scrolls <= 5, `should settle quickly, took ${r.scrolls} scrolls`);
  });

  it("handles an account with a single page of posts", async () => {
    const page = fakePage({ total: 7, pageSize: 20 });
    const r = await loadAllPostRows(page, { settleMs: 0 });
    assert.equal(r.rows, 7);
    assert.equal(r.truncated, false);
  });

  it("reports truncation instead of passing a partial list off as complete", async () => {
    // A list that never stops growing must hit the cap AND say so. Silently
    // returning what it managed to load is how a partial history gets read as
    // the whole thing and produces confidently wrong totals.
    const page = fakePage({ total: 100_000, pageSize: 20 });
    const r = await loadAllPostRows(page, { maxScrolls: 5, settleMs: 0 });
    assert.equal(r.truncated, true, "hitting the cap must be reported");
    assert.equal(r.scrolls, 5, "and must respect the cap");
  });

  it("terminates on a page that never loads anything", async () => {
    const page = fakePage({ total: 0, pageSize: 0 });
    const r = await loadAllPostRows(page, { settleMs: 0 });
    assert.equal(r.rows, 0);
    assert.equal(r.truncated, false, "an empty list ended normally — it was not truncated");
  });

  it("survives a page that throws on evaluate", async () => {
    // A detached frame or a navigation mid-scroll rejects. Collecting nothing
    // is acceptable; crashing the whole paid analytics run is not.
    const broken = {
      async evaluate() { throw new Error("Execution context was destroyed"); },
      async waitForTimeout() { /* no-op */ },
    };
    const r = await loadAllPostRows(broken, { settleMs: 0, maxScrolls: 3 });
    assert.equal(r.rows, 0);
  });
});
