/**
 * Tests for per-country pool pricing + disputes.
 *
 * Coverage:
 *   - country-prices: CRUD, ISO validation, normalization
 *   - disputes: ownership check, 7-day window enforcement, idempotency,
 *     decision tree based on twitterapi.io signal (mocked via global.fetch
 *     and the TWITTER_API_IO_KEY env), replacement happy path, refund
 *     fallback when no replacement available + no payment provenance →
 *     admin_review, admin resolveDisputeAdmin (replace / reject paths).
 *
 * The treasury-signing refund path is exercised indirectly: tests assert
 * that disputes WITHOUT payment_signature columns degrade to admin_review
 * (the production safety net), not that refund SOL/EVM signing works.
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// IMPORTANT: db import triggers initDatabase() which creates the new tables.
// Set test-friendly env BEFORE importing the modules under test.
process.env.POOL_ENCRYPTION_KEY = process.env.POOL_ENCRYPTION_KEY ||
  "a".repeat(64); // 32-byte hex key for AES-256-GCM
delete process.env.TWITTER_API_IO_KEY; // default: no twitterapi, simulates API unavailable

import { db } from "../db";
import {
  setCountryPrice,
  getCountryPrice,
  listCountryPrices,
  deleteCountryPrice,
} from "../services/country-prices";
import { createDispute, resolveDisputeAdmin, getDispute } from "../services/disputes";

const BUYER = "buyer1111111111111111111111111111111";
const SOMEONE_ELSE = "other222222222222222222222222222222";

function insertSoldAccount(args: {
  id: string;
  username: string;
  country: string | null;
  buyer: string;
  soldAtMsAgo: number;
  withPayment?: boolean;
  paidUsdc?: number;
}): void {
  const soldAt = new Date(Date.now() - args.soldAtMsAgo).toISOString();
  db.prepare(`
    INSERT INTO social_account_pool (
      id, platform, username, country, proxy_session_id,
      credentials_encrypted, cookies_encrypted, sale_price_usdc, status,
      sold_to_wallet, sold_at, created_at, tested_at,
      payment_signature, payment_chain, paid_amount_usdc
    ) VALUES (?, 'twitter', ?, ?, ?, ?, ?, ?, 'sold', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.id,
    args.username,
    args.country,
    args.id, // proxy_session_id = id, doesn't matter for these tests
    '{"iv":"","ciphertext":"","tag":""}', // placeholder; we never decrypt in these tests
    '{"iv":"","ciphertext":"","tag":""}',
    args.paidUsdc ?? 5.0,
    args.buyer,
    soldAt,
    soldAt,
    soldAt,
    args.withPayment ? "test_sig_" + args.id : null,
    args.withPayment ? "solana" : null,
    args.withPayment ? (args.paidUsdc ?? 5.0) : null,
  );
}

function insertReadyAccount(args: { id: string; username: string; country: string }): void {
  db.prepare(`
    INSERT INTO social_account_pool (
      id, platform, username, country, proxy_session_id,
      credentials_encrypted, cookies_encrypted, sale_price_usdc, status, created_at, tested_at
    ) VALUES (?, 'twitter', ?, ?, ?, ?, ?, 5.0, 'ready', datetime('now', 'utc'), datetime('now', 'utc'))
  `).run(
    args.id,
    args.username,
    args.country,
    args.id,
    '{"iv":"","ciphertext":"","tag":""}',
    '{"iv":"","ciphertext":"","tag":""}',
  );
}

// Reset both tables between tests so the idempotency / dedup paths are exercised
// against a clean slate.
function wipe() {
  db.exec("DELETE FROM pool_disputes; DELETE FROM social_account_pool; DELETE FROM country_prices;");
}

before(() => { wipe(); });
beforeEach(() => { wipe(); });

/* ─── country-prices CRUD ───────────────────────────────────────────── */

describe("country-prices", () => {
  it("set + get a price", () => {
    const row = setCountryPrice("US", 8.0);
    assert.equal(row.country, "US");
    assert.equal(row.price_usdc, 8.0);
    assert.equal(getCountryPrice("US"), 8.0);
  });

  it("normalizes country codes to uppercase", () => {
    setCountryPrice("us", 7.5);
    assert.equal(getCountryPrice("US"), 7.5);
    assert.equal(getCountryPrice("us"), 7.5);
  });

  it("rejects non-ISO-alpha-2 codes", () => {
    assert.throws(() => setCountryPrice("USA", 5), /ISO 3166-1 alpha-2/);
    assert.throws(() => setCountryPrice("", 5), /ISO 3166-1 alpha-2/);
    assert.throws(() => setCountryPrice("u1", 5), /ISO 3166-1 alpha-2/);
  });

  it("rejects non-positive prices", () => {
    assert.throws(() => setCountryPrice("US", 0), /positive number/);
    assert.throws(() => setCountryPrice("US", -1), /positive number/);
    assert.throws(() => setCountryPrice("US", NaN), /positive number/);
  });

  it("set is idempotent — second call updates the row", () => {
    setCountryPrice("US", 5);
    setCountryPrice("US", 9);
    assert.equal(getCountryPrice("US"), 9);
    assert.equal(listCountryPrices().length, 1);
  });

  it("getCountryPrice returns null for unknown country", () => {
    assert.equal(getCountryPrice("ZZ"), null);
    assert.equal(getCountryPrice(""), null);
  });

  it("list returns rows ordered by country", () => {
    setCountryPrice("DE", 6);
    setCountryPrice("US", 8);
    setCountryPrice("GB", 7);
    const rows = listCountryPrices().map(r => r.country);
    assert.deepEqual(rows, ["DE", "GB", "US"]);
  });

  it("delete returns true when row existed and false otherwise", () => {
    setCountryPrice("US", 5);
    assert.equal(deleteCountryPrice("US"), true);
    assert.equal(getCountryPrice("US"), null);
    assert.equal(deleteCountryPrice("US"), false);
  });
});

/* ─── disputes: validation guards ──────────────────────────────────── */

describe("disputes — guards", () => {
  it("rejects when account_id missing", async () => {
    const r = await createDispute({
      account_id: "",
      claimant_wallet: BUYER,
      reason: "suspended",
    });
    assert.equal(r.success, false);
    assert.match(r.error || "", /account_id required/);
  });

  it("rejects when claimant_wallet missing", async () => {
    const r = await createDispute({
      account_id: "anything",
      claimant_wallet: "",
      reason: "suspended",
    });
    assert.equal(r.success, false);
    assert.match(r.error || "", /claimant_wallet required/);
  });

  it("rejects invalid reason", async () => {
    const r = await createDispute({
      account_id: "anything",
      claimant_wallet: BUYER,
      reason: "garbage" as any,
    });
    assert.equal(r.success, false);
    assert.match(r.error || "", /reason must be/);
  });

  it("rejects when account does not exist", async () => {
    const r = await createDispute({
      account_id: "does_not_exist",
      claimant_wallet: BUYER,
      reason: "suspended",
    });
    assert.equal(r.success, false);
    assert.match(r.error || "", /account not found/);
  });

  it("rejects when caller is not the owner", async () => {
    insertSoldAccount({
      id: "acct1",
      username: "alice",
      country: "US",
      buyer: SOMEONE_ELSE,
      soldAtMsAgo: 60_000,
    });
    const r = await createDispute({
      account_id: "acct1",
      claimant_wallet: BUYER,
      reason: "suspended",
    });
    assert.equal(r.success, false);
    assert.match(r.error || "", /not owned by claimant/);
  });

  it("rejects when 7-day window has expired", async () => {
    insertSoldAccount({
      id: "acct1",
      username: "alice",
      country: "US",
      buyer: BUYER,
      soldAtMsAgo: 8 * 24 * 60 * 60 * 1000,
    });
    const r = await createDispute({
      account_id: "acct1",
      claimant_wallet: BUYER,
      reason: "suspended",
    });
    assert.equal(r.success, false);
    assert.match(r.error || "", /dispute window expired/);
  });

  it("idempotent: second open dispute returns the first one", async () => {
    insertSoldAccount({
      id: "acct1",
      username: "alice",
      country: "US",
      buyer: BUYER,
      soldAtMsAgo: 60_000,
    });
    // With no TWITTER_API_IO_KEY, the dispute queues for admin_review.
    const a = await createDispute({
      account_id: "acct1",
      claimant_wallet: BUYER,
      reason: "suspended",
    });
    assert.equal(a.success, true);
    assert.equal(a.dispute?.status, "admin_review");
    const b = await createDispute({
      account_id: "acct1",
      claimant_wallet: BUYER,
      reason: "suspended",
    });
    assert.equal(b.success, true);
    assert.equal(b.dispute?.id, a.dispute?.id);
  });
});

/* ─── disputes: decision tree ───────────────────────────────────────── */

describe("disputes — decision tree", () => {
  it("twitterapi unavailable (no key) → admin_review queue", async () => {
    insertSoldAccount({
      id: "acct1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000,
    });
    const r = await createDispute({
      account_id: "acct1", claimant_wallet: BUYER, reason: "suspended",
    });
    assert.equal(r.success, true);
    assert.equal(r.dispute?.status, "admin_review");
    assert.equal(r.dispute?.detection_status, "unknown");
  });

  it("reason='other' → always admin_review regardless of API", async () => {
    insertSoldAccount({
      id: "acct1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000,
    });
    const r = await createDispute({
      account_id: "acct1", claimant_wallet: BUYER, reason: "other",
      evidence: "shadowbanned",
    });
    assert.equal(r.success, true);
    assert.equal(r.dispute?.status, "admin_review");
    // Detection isn't run for 'other' — column stays null.
    assert.equal(r.dispute?.detection_status, null);
  });

  it("twitterapi reports active → dispute rejected", async () => {
    insertSoldAccount({
      id: "acct1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000,
    });
    await withMockedFetch(
      { status: "active", username: "alice", country: "US", location_raw: "USA" },
      async () => {
        const r = await createDispute({
          account_id: "acct1", claimant_wallet: BUYER, reason: "suspended",
        });
        assert.equal(r.success, true);
        assert.equal(r.dispute?.status, "rejected");
        assert.match(r.dispute?.resolution || "", /account active/);
      },
    );
  });

  it("twitterapi reports suspended + same-country stock → replaced", async () => {
    insertSoldAccount({
      id: "dead1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000, withPayment: true, paidUsdc: 8,
    });
    insertReadyAccount({ id: "fresh1", username: "bob", country: "US" });

    await withMockedFetch(
      { status: "suspended", username: "alice", country: "US", location_raw: "USA" },
      async () => {
        const r = await createDispute({
          account_id: "dead1", claimant_wallet: BUYER, reason: "suspended",
        });
        assert.equal(r.success, true);
        assert.equal(r.dispute?.status, "replaced");
        assert.equal(r.dispute?.replacement_account_id, "fresh1");

        // Verify the replacement is now owned by the buyer.
        const replacement = db.prepare(
          "SELECT status, sold_to_wallet, paid_amount_usdc FROM social_account_pool WHERE id = 'fresh1'"
        ).get() as any;
        assert.equal(replacement.status, "sold");
        assert.equal(replacement.sold_to_wallet, BUYER);
        // Payment provenance is carried over so a re-dispute can still refund.
        assert.equal(replacement.paid_amount_usdc, 8);

        // And the dead account is marked dead.
        const dead = db.prepare(
          "SELECT status FROM social_account_pool WHERE id = 'dead1'"
        ).get() as any;
        assert.equal(dead.status, "dead");
      },
    );
  });

  it("suspended + no same-country stock + no payment provenance → admin_review", async () => {
    insertSoldAccount({
      id: "dead1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000, withPayment: false,
    });
    // Replacement exists in a DIFFERENT country — must not be auto-used.
    insertReadyAccount({ id: "fresh_de", username: "carlos", country: "DE" });

    await withMockedFetch(
      { status: "suspended", username: "alice", country: "US", location_raw: "USA" },
      async () => {
        const r = await createDispute({
          account_id: "dead1", claimant_wallet: BUYER, reason: "suspended",
        });
        assert.equal(r.success, true);
        assert.equal(r.dispute?.status, "admin_review");
        assert.match(r.dispute?.resolution || "", /no_replacement_available_and_no_payment_provenance/);
        // Dead account is marked dead so it doesn't keep being usable.
        const dead = db.prepare(
          "SELECT status FROM social_account_pool WHERE id = 'dead1'"
        ).get() as any;
        assert.equal(dead.status, "dead");
        // The DE replacement was NOT touched.
        const intact = db.prepare(
          "SELECT status FROM social_account_pool WHERE id = 'fresh_de'"
        ).get() as any;
        assert.equal(intact.status, "ready");
      },
    );
  });
});

/* ─── disputes: admin override ──────────────────────────────────────── */

describe("disputes — admin resolve", () => {
  it("admin reject sets rejected status and leaves account intact", async () => {
    insertSoldAccount({
      id: "acct1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000,
    });
    const created = await createDispute({
      account_id: "acct1", claimant_wallet: BUYER, reason: "suspended",
    });
    assert.equal(created.dispute?.status, "admin_review");

    const r = await resolveDisputeAdmin(created.dispute!.id, "reject", "no signal of suspension");
    assert.equal(r.success, true);
    assert.equal(r.dispute?.status, "rejected");
    assert.match(r.dispute?.resolution || "", /no signal/);

    // Account remains 'sold' (not 'dead') since dispute was denied.
    const acc = db.prepare("SELECT status FROM social_account_pool WHERE id = 'acct1'").get() as any;
    assert.equal(acc.status, "sold");
  });

  it("admin replace swaps in same-country stock", async () => {
    insertSoldAccount({
      id: "dead1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000,
    });
    insertReadyAccount({ id: "fresh1", username: "bob", country: "US" });

    const created = await createDispute({
      account_id: "dead1", claimant_wallet: BUYER, reason: "other",
      evidence: "no creds delivered",
    });
    assert.equal(created.dispute?.status, "admin_review");

    const r = await resolveDisputeAdmin(created.dispute!.id, "replace");
    assert.equal(r.success, true);
    assert.equal(r.dispute?.status, "replaced");
    assert.equal(r.dispute?.replacement_account_id, "fresh1");
  });

  it("admin replace fails cleanly when no same-country stock", async () => {
    insertSoldAccount({
      id: "dead1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000,
    });
    // DE-only stock cannot fill a US dispute.
    insertReadyAccount({ id: "fresh_de", username: "carlos", country: "DE" });

    const created = await createDispute({
      account_id: "dead1", claimant_wallet: BUYER, reason: "other",
    });

    const r = await resolveDisputeAdmin(created.dispute!.id, "replace");
    assert.equal(r.success, false);
    assert.match(r.error || "", /no same-country/);
  });

  it("admin refund without payment provenance fails cleanly", async () => {
    insertSoldAccount({
      id: "acct1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000, withPayment: false,
    });
    const created = await createDispute({
      account_id: "acct1", claimant_wallet: BUYER, reason: "other",
    });

    const r = await resolveDisputeAdmin(created.dispute!.id, "refund");
    assert.equal(r.success, false);
    assert.match(r.error || "", /no payment provenance/);
  });

  it("cannot re-resolve an already-resolved dispute", async () => {
    insertSoldAccount({
      id: "dead1", username: "alice", country: "US",
      buyer: BUYER, soldAtMsAgo: 60_000,
    });
    insertReadyAccount({ id: "fresh1", username: "bob", country: "US" });
    const created = await createDispute({
      account_id: "dead1", claimant_wallet: BUYER, reason: "other",
    });
    const first = await resolveDisputeAdmin(created.dispute!.id, "replace");
    assert.equal(first.success, true);
    const second = await resolveDisputeAdmin(created.dispute!.id, "reject");
    assert.equal(second.success, false);
    assert.match(second.error || "", /already resolved/);
  });
});

/* ─── fetch mocking helper ──────────────────────────────────────────── */

interface MockedTwitterApi {
  status: "active" | "suspended" | "not_found" | "unknown";
  username: string;
  country: string | null;
  location_raw: string | null;
}

async function withMockedFetch(mock: MockedTwitterApi, fn: () => Promise<void>): Promise<void> {
  // The dispute service calls getUserInfo() which short-circuits to null
  // when TWITTER_API_IO_KEY is unset. Set a fake key + replace global.fetch
  // for the duration of the test.
  const originalFetch = global.fetch;
  const originalKey = process.env.TWITTER_API_IO_KEY;
  process.env.TWITTER_API_IO_KEY = "test_key";

  (global as any).fetch = async (url: string) => {
    // Only intercept twitterapi.io traffic — anything else (refund RPC,
    // x402 facilitator) should NOT route through this mock, but the dispute
    // happy-path tests above don't exercise those.
    if (typeof url === "string" && url.includes("api.twitterapi.io")) {
      // user_about doesn't have a per-account suspension flag — X removes
      // suspended profiles, so the signal is HTTP 404. The mock follows
      // that contract: 'suspended' and 'not_found' both map to 404.
      if (mock.status === "not_found" || mock.status === "suspended") {
        return new Response("", { status: 404 });
      }
      const body = {
        data: {
          about_profile: {
            account_based_in: mock.location_raw,
            source: "Web",
            username_changes: { count: "0" },
          },
        },
        status: "success",
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(url);
  };

  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TWITTER_API_IO_KEY;
    else process.env.TWITTER_API_IO_KEY = originalKey;
  }
}
