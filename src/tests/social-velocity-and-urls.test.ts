/**
 * Regressions for the X/Twitter operation hardening (security audit 2026-06-28):
 *
 *   #35 — every X op must pass a protective per-account velocity gate BEFORE it
 *         opens a browser session. Previously POLICIES.twitter was dead code, so
 *         an agent could drive a pooled account to suspension at unlimited speed.
 *   #69 — tweet_url must be host-pinned to x.com/twitter.com, not a bare
 *         `/status/<id>` substring match that let the authed browser navigate to
 *         an attacker URL (SSRF / open web-fetch through the residential IP).
 *   #70 — authenticated-session screenshots must not be written to world-readable
 *         /tmp by default; capture is opt-in via an explicit debug flag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, initDatabase } from "../db";
import {
  isValidTweetUrl,
  socialShotsEnabled,
  likeTweet,
  postTweet,
} from "../services/social-operations";

initDatabase();

function seedAction(accountId: string, operation: string, ageMs: number): void {
  db.prepare(
    "INSERT INTO social_action_log (account_id, platform, operation, acted_at) VALUES (?, 'twitter', ?, ?)"
  ).run(accountId, operation, Date.now() - ageMs);
}

/* ─── #69: tweet_url host validation ─────────────────────────────────────── */

test("isValidTweetUrl accepts genuine x.com / twitter.com tweet URLs", () => {
  assert.equal(isValidTweetUrl("https://x.com/jack/status/123456789"), true);
  assert.equal(isValidTweetUrl("https://twitter.com/jack/status/123"), true);
  assert.equal(isValidTweetUrl("https://www.x.com/jack/status/123"), true);
  assert.equal(isValidTweetUrl("https://mobile.twitter.com/jack/status/123"), true);
  // The system itself hands back this /i/web/status/ form — must round-trip.
  assert.equal(isValidTweetUrl("https://x.com/i/web/status/123"), true);
});

test("isValidTweetUrl rejects non-X hosts and SSRF targets (the #69 bypass)", () => {
  // The old guard (/\/status\/\d+/) matched all of these.
  assert.equal(isValidTweetUrl("https://attacker.example/status/1"), false);
  assert.equal(isValidTweetUrl("http://169.254.169.254/status/1"), false);
  assert.equal(isValidTweetUrl("https://x.com.evil.com/status/1"), false);
  assert.equal(isValidTweetUrl("https://evilx.com/status/1"), false);
  // http on a real host is rejected — X is https-only.
  assert.equal(isValidTweetUrl("http://x.com/jack/status/1"), false);
  // Missing the /status/<id> segment.
  assert.equal(isValidTweetUrl("https://x.com/jack"), false);
  // Garbage / empty.
  assert.equal(isValidTweetUrl("not a url"), false);
  assert.equal(isValidTweetUrl(""), false);
});

test("likeTweet rejects a non-X tweet_url before launching any browser session", async () => {
  const r = await likeTweet({
    account_id: "vel-host-1",
    cookies: [],
    tweet_url: "http://169.254.169.254/status/1",
  });
  assert.equal(r.success, false);
  assert.equal(r.error_code, "INVALID_INPUT");
});

/* ─── #35: protective velocity gate fires before the browser ─────────────── */

test("likeTweet is blocked by minimum-spacing BEFORE opening a session", async () => {
  const acct = "vel-spacing-1";
  // An action 1s ago — inside the 5s min spacing window.
  seedAction(acct, "like", 1_000);
  const r = await likeTweet({
    account_id: acct,
    cookies: [],
    tweet_url: "https://x.com/jack/status/123",
  });
  // If the op were still unguarded (the #35 bug) it would have tried to launch a
  // browser and returned LAUNCH_FAILED — RATE_LIMITED_PROTECTIVE proves the gate
  // short-circuited first.
  assert.equal(r.success, false);
  assert.equal(r.error_code, "RATE_LIMITED_PROTECTIVE");
  assert.equal(typeof r.retry_after_ms, "number");
  assert.ok((r.retry_after_ms ?? 0) > 0);
});

test("postTweet is blocked by the per-hour post cap BEFORE opening a session", async () => {
  const acct = "vel-window-1";
  // 20 posts, all ~10s ago: clears the 5s spacing rule but hits the 20/h cap.
  for (let i = 0; i < 20; i++) seedAction(acct, "post", 10_000 + i);
  const r = await postTweet({ account_id: acct, cookies: [], text: "hello world" });
  assert.equal(r.success, false);
  assert.equal(r.error_code, "RATE_LIMITED_PROTECTIVE");
  assert.equal(typeof r.retry_after_ms, "number");
});

/* ─── #70: screenshots are off unless explicitly enabled ─────────────────── */

test("socialShotsEnabled is false by default and true only under a debug flag", () => {
  const saved = {
    a: process.env.PALMYR_SOCIAL_DEBUG,
    b: process.env.PALMYR_DEBUG_SHOTS,
  };
  try {
    delete process.env.PALMYR_SOCIAL_DEBUG;
    delete process.env.PALMYR_DEBUG_SHOTS;
    assert.equal(socialShotsEnabled(), false);

    process.env.PALMYR_SOCIAL_DEBUG = "1";
    assert.equal(socialShotsEnabled(), true);
    delete process.env.PALMYR_SOCIAL_DEBUG;

    process.env.PALMYR_DEBUG_SHOTS = "1";
    assert.equal(socialShotsEnabled(), true);
  } finally {
    if (saved.a === undefined) delete process.env.PALMYR_SOCIAL_DEBUG;
    else process.env.PALMYR_SOCIAL_DEBUG = saved.a;
    if (saved.b === undefined) delete process.env.PALMYR_DEBUG_SHOTS;
    else process.env.PALMYR_DEBUG_SHOTS = saved.b;
  }
});
