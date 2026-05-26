/**
 * Tests for the richer pool categorization layer:
 *   - source_multipliers CRUD
 *   - twitter-api.ts about_profile extraction (source, username_changes,
 *     account_based_in, location_accurate, affiliate_username)
 *   - poolBuy filter behavior for --source and --max-renames including
 *     NULL-row handling (rows seeded before the feature shouldn't match
 *     a filtered buy)
 *   - poolStatus breakdowns by source and by rename bucket
 *
 * Price-math (country * source_multiplier) lives in the route layer and is
 * exercised via direct calls to the two service helpers here; the route
 * integration is covered by the existing country-pricing tests + manual
 * verification in the PR test plan.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.POOL_ENCRYPTION_KEY = process.env.POOL_ENCRYPTION_KEY ||
  "a".repeat(64);
delete process.env.TWITTER_API_IO_KEY;

import { db } from "../db";
import {
  setSourceMultiplier,
  getSourceMultiplier,
  listSourceMultipliers,
  deleteSourceMultiplier,
} from "../services/source-multipliers";
import { poolBuy, poolStatus } from "../services/social-pool";
import { getUserInfo, parseRegistration } from "../services/twitter-api";
import { getCountryPrice, setCountryPrice } from "../services/country-prices";
import { randomBytes, createCipheriv } from "crypto";

// Mirrors the AES-256-GCM scheme in social-pool.ts so test inserts produce
// blobs the production decrypt path actually accepts.
function encryptForTest(plaintext: string): string {
  const key = Buffer.from(process.env.POOL_ENCRYPTION_KEY!, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString("hex"),
    ciphertext: ct.toString("hex"),
    tag: tag.toString("hex"),
  });
}
const FAKE_CREDS_BLOB = encryptForTest(JSON.stringify({ login: "test", password: "test" }));
const FAKE_COOKIES_BLOB = encryptForTest(JSON.stringify([]));

const BUYER = "buyer1111111111111111111111111111111";

function wipe() {
  db.exec(`
    DELETE FROM pool_disputes;
    DELETE FROM social_account_pool;
    DELETE FROM country_prices;
    DELETE FROM source_multipliers;
  `);
}

function insertReady(args: {
  id: string;
  username: string;
  country: string | null;
  source: string | null;
  username_change_count: number | null;
  registered_country?: string | null;
  registered_platform?: string | null;
}) {
  db.prepare(`
    INSERT INTO social_account_pool (
      id, platform, username, country, source,
      registered_country, registered_platform, username_change_count,
      proxy_session_id, credentials_encrypted, cookies_encrypted,
      sale_price_usdc, status, created_at, tested_at
    ) VALUES (?, 'twitter', ?, ?, ?, ?, ?, ?, ?, ?, ?, 5.0, 'ready',
              datetime('now', 'utc'), datetime('now', 'utc'))
  `).run(
    args.id,
    args.username,
    args.country,
    args.source,
    args.registered_country ?? null,
    args.registered_platform ?? null,
    args.username_change_count,
    args.id,
    FAKE_CREDS_BLOB,
    FAKE_COOKIES_BLOB,
  );
}

before(() => { wipe(); });
beforeEach(() => { wipe(); });

/* ─── source_multipliers ────────────────────────────────────────────── */

describe("source-multipliers", () => {
  it("set + get a multiplier", () => {
    const row = setSourceMultiplier("web", 1.25);
    assert.equal(row.source, "web");
    assert.equal(row.multiplier, 1.25);
    assert.equal(getSourceMultiplier("web"), 1.25);
  });

  it("normalizes source to lowercase", () => {
    setSourceMultiplier("Web", 1.1);
    assert.equal(getSourceMultiplier("WEB"), 1.1);
    assert.equal(getSourceMultiplier("web"), 1.1);
  });

  it("rejects empty source", () => {
    assert.throws(() => setSourceMultiplier("", 1), /non-empty string/);
    assert.throws(() => setSourceMultiplier("   ", 1), /non-empty string/);
  });

  it("rejects non-positive multipliers", () => {
    assert.throws(() => setSourceMultiplier("web", 0), /positive number/);
    assert.throws(() => setSourceMultiplier("web", -1), /positive number/);
    assert.throws(() => setSourceMultiplier("web", NaN), /positive number/);
  });

  it("upsert: second set overwrites the first", () => {
    setSourceMultiplier("web", 1.1);
    setSourceMultiplier("web", 1.5);
    assert.equal(getSourceMultiplier("web"), 1.5);
    assert.equal(listSourceMultipliers().length, 1);
  });

  it("getSourceMultiplier returns null for unknown source", () => {
    assert.equal(getSourceMultiplier("unknown_source_xyz"), null);
    assert.equal(getSourceMultiplier(""), null);
  });

  it("delete returns true/false correctly", () => {
    setSourceMultiplier("web", 1.2);
    assert.equal(deleteSourceMultiplier("web"), true);
    assert.equal(getSourceMultiplier("web"), null);
    assert.equal(deleteSourceMultiplier("web"), false);
  });
});

/* ─── price math (country * source_multiplier) ─────────────────────── */

describe("buy price math helpers", () => {
  it("country alone → country price", () => {
    setCountryPrice("US", 8);
    assert.equal(getCountryPrice("US"), 8);
    // Multiplier for 'web' not set → caller defaults to 1.0
    assert.equal(getSourceMultiplier("web"), null);
  });

  it("country + multiplier → product (caller applies)", () => {
    setCountryPrice("US", 8);
    setSourceMultiplier("web", 1.25);
    const final = getCountryPrice("US")! * (getSourceMultiplier("web") ?? 1.0);
    assert.equal(final, 10);
  });
});

/* ─── twitter-api.ts about_profile extraction ──────────────────────── */

describe("twitter-api getUserInfo — about_profile", () => {
  it("returns null when TWITTER_API_IO_KEY is unset", async () => {
    delete process.env.TWITTER_API_IO_KEY;
    const info = await getUserInfo("alice");
    assert.equal(info, null);
  });

  it("extracts every about_profile field when present", async () => {
    process.env.TWITTER_API_IO_KEY = "test_key";
    const original = global.fetch;
    (global as any).fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            location: "Austin, TX",
            about_profile: {
              account_based_in: "United States",
              location_accurate: true,
              source: "Web",
              affiliate_username: "@acme",
              username_changes: { count: "3" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      const info = await getUserInfo("alice");
      assert.ok(info);
      assert.equal(info!.status, "active");
      assert.equal(info!.country, "US"); // derived from "United States"
      assert.equal(info!.account_based_in, "United States");
      assert.equal(info!.location_accurate, true);
      assert.equal(info!.source, "web"); // lowercased
      assert.equal(info!.affiliate_username, "@acme");
      assert.equal(info!.username_change_count, 3); // parsed from string
    } finally {
      global.fetch = original;
      delete process.env.TWITTER_API_IO_KEY;
    }
  });

  it("returns null country when about_profile is missing (no fallback to spoofable location)", async () => {
    // Sellers spoof the user-typed `location` field to look American. The
    // ONLY trusted residency signal is about_profile.account_based_in.
    // When that's absent we report country=null so admin can override
    // explicitly rather than silently inheriting a fake.
    process.env.TWITTER_API_IO_KEY = "test_key";
    const original = global.fetch;
    (global as any).fetch = async () =>
      new Response(
        JSON.stringify({
          data: { location: "USA" }, // spoofed user-typed value — must be ignored
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      const info = await getUserInfo("bob");
      assert.ok(info);
      assert.equal(info!.country, null);
      assert.equal(info!.account_based_in, null);
      assert.equal(info!.source, null);
      assert.equal(info!.username_change_count, null);
    } finally {
      global.fetch = original;
      delete process.env.TWITTER_API_IO_KEY;
    }
  });

  it("rejects non-numeric username_changes.count", async () => {
    process.env.TWITTER_API_IO_KEY = "test_key";
    const original = global.fetch;
    (global as any).fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            about_profile: {
              source: "Web",
              username_changes: { count: "not-a-number" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      const info = await getUserInfo("alice");
      assert.equal(info!.username_change_count, null);
    } finally {
      global.fetch = original;
      delete process.env.TWITTER_API_IO_KEY;
    }
  });
});

/* ─── poolBuy filter behavior ──────────────────────────────────────── */

describe("poolBuy — source filter", () => {
  it("returns oldest web account when --source web", () => {
    insertReady({ id: "a", username: "alice", country: "US", source: "web", username_change_count: 0 });
    insertReady({ id: "b", username: "bob", country: "US", source: "mobile", username_change_count: 0 });

    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER, source: "web" });
    assert.equal(r.success, true);
    assert.equal(r.account?.id, "a");
    assert.equal(r.account?.source, "web");
  });

  it("source filter case-insensitive on input", () => {
    insertReady({ id: "a", username: "alice", country: "US", source: "web", username_change_count: 0 });
    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER, source: "WEB" });
    assert.equal(r.success, true);
    assert.equal(r.account?.id, "a");
  });

  it("rows with NULL source do NOT match a source-filtered buy", () => {
    insertReady({ id: "legacy", username: "old", country: "US", source: null, username_change_count: null });
    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER, source: "web" });
    assert.equal(r.success, false);
    assert.match(r.error || "", /source=web/);
  });

  it("no --source filter matches rows regardless of source (including NULL)", () => {
    insertReady({ id: "legacy", username: "old", country: "US", source: null, username_change_count: null });
    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER });
    assert.equal(r.success, true);
    assert.equal(r.account?.id, "legacy");
  });
});

describe("poolBuy — max-renames filter", () => {
  it("--max-renames 0 picks only never-renamed accounts", () => {
    insertReady({ id: "fresh", username: "alice", country: "US", source: "web", username_change_count: 0 });
    insertReady({ id: "stale", username: "bob", country: "US", source: "web", username_change_count: 4 });
    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER, max_username_changes: 0 });
    assert.equal(r.success, true);
    assert.equal(r.account?.id, "fresh");
  });

  it("--max-renames 5 allows up to 5", () => {
    insertReady({ id: "five", username: "alice", country: "US", source: "web", username_change_count: 5 });
    insertReady({ id: "six", username: "bob", country: "US", source: "web", username_change_count: 6 });
    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER, max_username_changes: 5 });
    assert.equal(r.success, true);
    assert.equal(r.account?.id, "five");
  });

  it("rows with NULL username_change_count do NOT match a max-renames filter", () => {
    insertReady({ id: "legacy", username: "old", country: "US", source: "web", username_change_count: null });
    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER, max_username_changes: 0 });
    assert.equal(r.success, false);
    assert.match(r.error || "", /max_renames=0/);
  });
});

describe("poolBuy — combined filters", () => {
  it("country + source + max-renames all applied", () => {
    insertReady({ id: "us_web_0", username: "a", country: "US", source: "web", username_change_count: 0 });
    insertReady({ id: "us_web_3", username: "b", country: "US", source: "web", username_change_count: 3 });
    insertReady({ id: "us_mob_0", username: "c", country: "US", source: "mobile", username_change_count: 0 });
    insertReady({ id: "gb_web_0", username: "d", country: "GB", source: "web", username_change_count: 0 });

    const r = poolBuy({
      platform: "twitter",
      buyer_wallet: BUYER,
      country: "US",
      source: "web",
      max_username_changes: 0,
    });
    assert.equal(r.success, true);
    assert.equal(r.account?.id, "us_web_0");
  });

  it("returns clean error when combined filter has no match", () => {
    insertReady({ id: "us_mob_0", username: "a", country: "US", source: "mobile", username_change_count: 0 });
    const r = poolBuy({
      platform: "twitter",
      buyer_wallet: BUYER,
      country: "US",
      source: "web",
      max_username_changes: 0,
    });
    assert.equal(r.success, false);
    assert.match(r.error || "", /country=US.*source=web.*max_renames=0/);
  });
});

/* ─── poolStatus breakdowns ────────────────────────────────────────── */

describe("poolStatus — breakdowns by source and rename count", () => {
  it("counts by source", () => {
    insertReady({ id: "1", username: "a", country: "US", source: "web", username_change_count: 0 });
    insertReady({ id: "2", username: "b", country: "US", source: "web", username_change_count: 2 });
    insertReady({ id: "3", username: "c", country: "US", source: "mobile", username_change_count: 0 });
    const s = poolStatus();
    assert.equal(s.by_source.web?.ready, 2);
    assert.equal(s.by_source.mobile?.ready, 1);
  });

  it("buckets by rename count: never_renamed / renamed / unknown", () => {
    insertReady({ id: "1", username: "a", country: "US", source: "web", username_change_count: 0 });
    insertReady({ id: "2", username: "b", country: "US", source: "web", username_change_count: 1 });
    insertReady({ id: "3", username: "c", country: "US", source: "web", username_change_count: 5 });
    insertReady({ id: "4", username: "d", country: "US", source: "web", username_change_count: null });
    const s = poolStatus();
    assert.equal(s.by_username_changes.never_renamed.ready, 1);
    assert.equal(s.by_username_changes.renamed.ready, 2);
    assert.equal(s.by_username_changes.unknown.ready, 1);
  });

  it("breakdowns by registered_country and registered_platform", () => {
    insertReady({
      id: "1", username: "a", country: "AR", source: "united kingdom android app",
      registered_country: "GB", registered_platform: "android", username_change_count: 0,
    });
    insertReady({
      id: "2", username: "b", country: "BR", source: "brazil android app",
      registered_country: "BR", registered_platform: "android", username_change_count: 0,
    });
    insertReady({
      id: "3", username: "c", country: "BR", source: "iphone",
      registered_country: null, registered_platform: "ios", username_change_count: 0,
    });
    const s = poolStatus();
    assert.equal(s.by_registered_country.GB?.ready, 1);
    assert.equal(s.by_registered_country.BR?.ready, 1);
    assert.equal(s.by_registered_country["?"]?.ready, 1);
    assert.equal(s.by_registered_platform.android?.ready, 2);
    assert.equal(s.by_registered_platform.ios?.ready, 1);
  });
});

/* ─── parseRegistration ────────────────────────────────────────────── */

describe("parseRegistration — source → country + platform", () => {
  it("parses country + platform from full string", () => {
    assert.deepEqual(parseRegistration("united kingdom android app"), { country: "GB", platform: "android" });
    assert.deepEqual(parseRegistration("argentina android app"), { country: "AR", platform: "android" });
    assert.deepEqual(parseRegistration("russian federation android app"), { country: "RU", platform: "android" });
    assert.deepEqual(parseRegistration("brazil android app"), { country: "BR", platform: "android" });
  });

  it("platform-only strings (no country fragment)", () => {
    assert.deepEqual(parseRegistration("iphone"), { country: null, platform: "ios" });
    assert.deepEqual(parseRegistration("twitter web app"), { country: null, platform: "web" });
    assert.deepEqual(parseRegistration("tweetdeck web app"), { country: null, platform: "web" });
    assert.deepEqual(parseRegistration("web"), { country: null, platform: "web" });
  });

  it("null / empty / whitespace input → nulls", () => {
    assert.deepEqual(parseRegistration(null), { country: null, platform: null });
    assert.deepEqual(parseRegistration(""), { country: null, platform: null });
  });

  it("handles unknown country fragments by returning null country, keeping platform", () => {
    const r = parseRegistration("atlantis android app");
    assert.equal(r.platform, "android");
    assert.equal(r.country, null);
  });

  it("ios variants", () => {
    assert.equal(parseRegistration("germany iphone")?.platform, "ios");
    assert.equal(parseRegistration("germany iphone")?.country, "DE");
    assert.equal(parseRegistration("ipad")?.platform, "ios");
  });
});

/* ─── poolBuy registered-* filters ─────────────────────────────────── */

describe("poolBuy — registered_country and registered_platform filters", () => {
  it("--registered-country GB picks accounts registered from UK regardless of residency", () => {
    insertReady({
      id: "a", username: "alice", country: "AR", source: "united kingdom android app",
      registered_country: "GB", registered_platform: "android", username_change_count: 0,
    });
    insertReady({
      id: "b", username: "bob", country: "GB", source: "argentina android app",
      registered_country: "AR", registered_platform: "android", username_change_count: 0,
    });
    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER, registered_country: "GB" });
    assert.equal(r.success, true);
    assert.equal(r.account?.id, "a");
    assert.equal(r.account?.registered_country, "GB");
  });

  it("--platform android excludes ios rows", () => {
    insertReady({
      id: "android-1", username: "a", country: "US", source: "iphone",
      registered_country: null, registered_platform: "ios", username_change_count: 0,
    });
    insertReady({
      id: "android-2", username: "b", country: "US", source: "united states android app",
      registered_country: "US", registered_platform: "android", username_change_count: 0,
    });
    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER, registered_platform: "android" });
    assert.equal(r.success, true);
    assert.equal(r.account?.id, "android-2");
  });

  it("country + registered_country + platform combine (all three must match)", () => {
    // GB-resident, GB-registered, android
    insertReady({
      id: "match", username: "perfect", country: "GB", source: "united kingdom android app",
      registered_country: "GB", registered_platform: "android", username_change_count: 0,
    });
    // GB-resident, but ios-registered → doesn't match --platform android
    insertReady({
      id: "wrong-platform", username: "ios", country: "GB", source: "united kingdom iphone",
      registered_country: "GB", registered_platform: "ios", username_change_count: 0,
    });
    // android, but residency=US → doesn't match --country GB
    insertReady({
      id: "wrong-country", username: "us", country: "US", source: "united kingdom android app",
      registered_country: "GB", registered_platform: "android", username_change_count: 0,
    });

    const r = poolBuy({
      platform: "twitter",
      buyer_wallet: BUYER,
      country: "GB",
      registered_country: "GB",
      registered_platform: "android",
    });
    assert.equal(r.success, true);
    assert.equal(r.account?.id, "match");
  });

  it("rows with NULL registered_country do NOT match a --registered-country filter", () => {
    insertReady({
      id: "legacy", username: "old", country: "US", source: null,
      registered_country: null, registered_platform: null, username_change_count: null,
    });
    const r = poolBuy({ platform: "twitter", buyer_wallet: BUYER, registered_country: "US" });
    assert.equal(r.success, false);
    assert.match(r.error || "", /registered_country=US/);
  });
});
