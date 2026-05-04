/**
 * Tests for the multi-domain inbox feature (provision_email_inbox with a
 * caller-owned custom domain).
 *
 * Covers:
 *  - createInbox builds {name}@{domain} when a custom domain is passed
 *  - createInbox falls back to config.emailDomain when domain is omitted
 *  - createInbox rejects malformed domains by falling back (defensive)
 *  - hasEmailAddress allows the same local-part on different domains
 *  - The domain-ownership SQL the route uses correctly authorizes / rejects
 *    based on (domain, owner) — the security guarantee for the new feature
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.EMAIL_DOMAIN = "agntos.dev";

import { db, initDatabase } from "../db";
import { storage } from "../services/storage";
import { createInbox } from "../services/email";

const WALLET_A = "WALLETaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "WALLETbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOL_PUBKEY_A = "11111111111111111111111111111111"; // 32-char base58 placeholder; createInbox decodes it

// Insert a domain row for tests.
function insertDomain(domainName: string, owner: string, status: string = "active") {
  db.prepare(`
    INSERT INTO domains (id, domain, owner, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "test-" + domainName,
    domainName,
    owner,
    status,
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    new Date().toISOString()
  );
}

before(() => {
  initDatabase();
  // Delete in FK-dependency order so PRAGMA foreign_keys=ON doesn't reject
  // the email_inboxes wipe when stale email_messages rows exist (e.g. from
  // a real `agentos email send` run against the dev DB).
  db.exec("DELETE FROM email_messages; DELETE FROM email_inboxes; DELETE FROM domains;");
});

beforeEach(() => {
  // Delete in FK-dependency order so PRAGMA foreign_keys=ON doesn't reject
  // the email_inboxes wipe when stale email_messages rows exist (e.g. from
  // a real `agentos email send` run against the dev DB).
  db.exec("DELETE FROM email_messages; DELETE FROM email_inboxes; DELETE FROM domains;");
});

describe("createInbox — custom domain", () => {
  it("builds {name}@{custom-domain} when a domain is passed", () => {
    const inbox = createInbox("hello", WALLET_A, SOL_PUBKEY_A, "stealthkicks.xyz");
    assert.equal(inbox.address, "hello@stealthkicks.xyz");
  });

  it("falls back to config.emailDomain when domain is omitted", () => {
    const inbox = createInbox("hello", WALLET_A, SOL_PUBKEY_A);
    assert.equal(inbox.address, "hello@agntos.dev");
  });

  it("falls back to config.emailDomain when an invalid domain is passed", () => {
    const inbox = createInbox("hello", WALLET_A, SOL_PUBKEY_A, "not a real domain!!!");
    assert.equal(inbox.address, "hello@agntos.dev");
  });

  it("normalizes a custom domain to lowercase", () => {
    const inbox = createInbox("hello", WALLET_A, SOL_PUBKEY_A, "StealthKicks.XYZ");
    assert.equal(inbox.address, "hello@stealthkicks.xyz");
  });
});

describe("hasEmailAddress — multi-domain dedup", () => {
  it("allows the same local-part on different domains", () => {
    createInbox("hello", WALLET_A, SOL_PUBKEY_A, "stealthkicks.xyz");
    // Same local-part on a different domain should NOT collide.
    assert.equal(storage.hasEmailAddress("hello@agntos.dev"), false);
    assert.equal(storage.hasEmailAddress("hello@stealthkicks.xyz"), true);

    // Provision the second one — must succeed (would have failed under the
    // old hasEmailLocalPart check).
    const second = createInbox("hello", WALLET_A, SOL_PUBKEY_A);
    assert.equal(second.address, "hello@agntos.dev");
  });

  it("rejects exact-address duplicates", () => {
    createInbox("hello", WALLET_A, SOL_PUBKEY_A, "stealthkicks.xyz");
    assert.throws(
      () => createInbox("hello", WALLET_A, SOL_PUBKEY_A, "stealthkicks.xyz"),
      /already exists/
    );
  });
});

describe("schema migration — drop legacy UNIQUE(local_part)", () => {
  it("detects + drops the auto-named UNIQUE index from the original CREATE TABLE", () => {
    // Simulate a pre-migration DB by re-creating the email_inboxes table
    // with the legacy schema (UNIQUE on local_part inline).
    db.exec("DROP TABLE IF EXISTS email_inboxes");
    db.exec(`
      CREATE TABLE email_inboxes (
        id TEXT PRIMARY KEY,
        address TEXT UNIQUE NOT NULL,
        local_part TEXT UNIQUE NOT NULL,
        owner TEXT NOT NULL,
        public_key TEXT,
        solana_public_key TEXT,
        e2e_enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        active INTEGER DEFAULT 1
      );
    `);

    // Confirm the legacy unique index actually exists before migration.
    const before = db.prepare("PRAGMA index_list(email_inboxes)").all() as Array<{ name: string; unique: number; origin: string }>;
    const legacyUnique = before.find(idx => {
      if (idx.unique !== 1 || idx.origin !== 'u') return false;
      const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{ name: string }>;
      return cols.length === 1 && cols[0].name === 'local_part';
    });
    assert.ok(legacyUnique, "test setup invalid — legacy UNIQUE on local_part not present");

    // Re-run migrations.
    initDatabase();

    // After migration, no UNIQUE index on local_part should exist.
    const after = db.prepare("PRAGMA index_list(email_inboxes)").all() as Array<{ name: string; unique: number; origin: string }>;
    const stillUnique = after.find(idx => {
      if (idx.unique !== 1 || idx.origin !== 'u') return false;
      const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{ name: string }>;
      return cols.length === 1 && cols[0].name === 'local_part';
    });
    assert.equal(stillUnique, undefined, "migration failed — UNIQUE on local_part still present");

    // Sanity check: same local-part on different domains can now coexist.
    db.prepare(`INSERT INTO email_inboxes (id, address, local_part, owner, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run("i1", "hello@one.xyz", "hello", WALLET_A, new Date().toISOString());
    db.prepare(`INSERT INTO email_inboxes (id, address, local_part, owner, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run("i2", "hello@two.xyz", "hello", WALLET_A, new Date().toISOString());
    const rows = db.prepare("SELECT address FROM email_inboxes WHERE local_part = ?").all("hello") as Array<{ address: string }>;
    assert.equal(rows.length, 2);
  });
});

describe("domain-ownership SQL — the route's security check", () => {
  // The route uses:
  //   SELECT 1 FROM domains WHERE domain = ? AND owner = ? AND status != 'expired'
  // before allowing provision_email_inbox on a custom domain. Validate that
  // contract directly against the schema so we don't have to spend real
  // USDC to prove the authorization works.
  const checkOwnership = (domain: string, wallet: string): boolean => {
    const row = db
      .prepare("SELECT 1 FROM domains WHERE domain = ? AND owner = ? AND status != ?")
      .get(domain, wallet, "expired");
    return !!row;
  };

  it("authorizes the owner", () => {
    insertDomain("stealthkicks.xyz", WALLET_A);
    assert.equal(checkOwnership("stealthkicks.xyz", WALLET_A), true);
  });

  it("rejects a different wallet", () => {
    insertDomain("stealthkicks.xyz", WALLET_A);
    assert.equal(checkOwnership("stealthkicks.xyz", WALLET_B), false);
  });

  it("rejects an unowned (unregistered) domain entirely", () => {
    assert.equal(checkOwnership("randomly-unowned.xyz", WALLET_A), false);
  });

  it("rejects an expired domain even for the owner", () => {
    insertDomain("expired-brand.xyz", WALLET_A, "expired");
    assert.equal(checkOwnership("expired-brand.xyz", WALLET_A), false);
  });

  it("scopes by owner correctly when multiple wallets own different domains", () => {
    insertDomain("brand-a.xyz", WALLET_A);
    insertDomain("brand-b.xyz", WALLET_B);
    assert.equal(checkOwnership("brand-a.xyz", WALLET_A), true);
    assert.equal(checkOwnership("brand-a.xyz", WALLET_B), false);
    assert.equal(checkOwnership("brand-b.xyz", WALLET_B), true);
    assert.equal(checkOwnership("brand-b.xyz", WALLET_A), false);
  });
});
