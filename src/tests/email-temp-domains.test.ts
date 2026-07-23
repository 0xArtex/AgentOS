/**
 * Tests for the disposable temp-inbox DOMAIN POOL + natural local parts.
 *
 * The point of the feature: never mint "disposable" traffic on the apex
 * (palmyr.ai) — it would risk the apex (and the owned $2 inboxes) landing on
 * disposable-email blocklists. Temp inboxes go on dedicated pool domains
 * (TEMP_EMAIL_DOMAINS) with human-plausible local parts that clear fraud
 * scorers.
 *
 * Env is set BEFORE importing config so the module-level TEMP_EMAIL_DOMAINS
 * parse sees it (mirrors email-temp-inbox.test.ts pinning EMAIL_DOMAIN early).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

process.env.EMAIL_DOMAIN = "palmyr.ai";
process.env.TEMP_EMAIL_DOMAINS = "inbox-aaa.com, inbox-bbb.com";

import { config, isSystemEmailDomain } from "../config";
import { generateTempLocalPart } from "../services/temp-email-identity";
import { db, initDatabase } from "../db";
import { storage } from "../services/storage";
import * as emailService from "../services/email";
import emailRouter from "../routes/email";

const WALLET_A = "WALLETaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL = ["inbox-aaa.com", "inbox-bbb.com"];

let server: http.Server;
let port = 0;
const saved: Record<string, string | undefined> = {};

function wipeEmailTables(): void {
  db.exec(
    "DELETE FROM email_attachments; DELETE FROM email_messages; DELETE FROM email_threads; DELETE FROM email_webhooks; DELETE FROM email_inboxes;"
  );
}

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const baseHeaders: Record<string, string> = { accept: "application/json", ...headers };
    if (payload !== undefined) {
      baseHeaders["content-type"] = "application/json";
      baseHeaders["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: baseHeaders },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

before(async () => {
  initDatabase();
  for (const k of ["PALMYR_SELF_HOSTED", "PALMYR_SELF_HOSTED_FORCE", "MAILGUN_API_KEY"]) saved[k] = process.env[k];
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1";
  delete process.env.MAILGUN_API_KEY;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const payer = req.headers["x-test-payer"];
    if (payer) (req as any).payment = { payer: String(payer) };
    next();
  });
  app.use("/email", emailRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  port = (server.address() as any).port;
});

after(async () => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  wipeEmailTables();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => wipeEmailTables());

describe("config.tempEmailDomains", () => {
  it("parses TEMP_EMAIL_DOMAINS into a trimmed, lowercased pool", () => {
    assert.deepEqual(config.tempEmailDomains, POOL);
    // The apex must NOT be in the temp pool when TEMP_EMAIL_DOMAINS is set.
    assert.ok(!config.tempEmailDomains.includes(config.emailDomain), "apex must be excluded from the temp pool");
  });

  it("isSystemEmailDomain covers the apex AND every pool domain, but not a custom domain", () => {
    assert.equal(isSystemEmailDomain("palmyr.ai"), true, "apex is a system domain");
    for (const d of POOL) assert.equal(isSystemEmailDomain(d), true, `${d} is a system (pool) domain`);
    assert.equal(isSystemEmailDomain("INBOX-AAA.COM"), true, "match is case-insensitive");
    assert.equal(isSystemEmailDomain("some-agent-owned.xyz"), false, "a per-inbox custom domain is NOT a system domain");
  });
});

describe("generateTempLocalPart", () => {
  it("produces charset-safe, natural handles — never tmp-*, always starting with a letter", () => {
    for (let i = 0; i < 500; i++) {
      const lp = generateTempLocalPart();
      assert.match(lp, /^[a-z][a-z0-9._-]*[0-9]$/, `handle ${lp} must be a natural charset-safe local part`);
      assert.ok(!lp.startsWith("tmp-"), `handle ${lp} must not use the tmp- prefix`);
      // Survives createInbox's sanitizer unchanged (nothing stripped).
      assert.equal(lp.replace(/[^a-z0-9\-_.]/g, ""), lp, `handle ${lp} must survive the sanitizer intact`);
    }
  });

  it("has enough entropy to rarely collide over a realistic pool", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateTempLocalPart());
    // Not a hard guarantee, but 2000 draws should stay well above ~1900 unique.
    assert.ok(seen.size > 1900, `expected high uniqueness, got ${seen.size}/2000`);
  });
});

describe("POST /email/temp — pool-domain placement", () => {
  it("mints temp inboxes on a pool domain, NEVER the apex", async () => {
    for (let i = 0; i < 12; i++) {
      const res = await request("POST", "/email/temp", { "x-test-payer": WALLET_A });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      const domain = String(res.json.address).split("@")[1];
      assert.ok(POOL.includes(domain), `address ${res.json.address} must land on a pool domain, not the apex`);
      assert.notEqual(domain, "palmyr.ai", "temp inbox must NOT be minted on the apex");
    }
  });

  it("distributes across the whole pool over many calls", async () => {
    const domains = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const res = await request("POST", "/email/temp", { "x-test-payer": WALLET_A });
      domains.add(String(res.json.address).split("@")[1]);
    }
    // With 2 domains over 40 random picks, both should appear (P(miss) ~ 2^-39).
    assert.deepEqual([...domains].sort(), [...POOL].sort(), "both pool domains should be used");
  });
});

describe("delete route — never tears down a shared pool domain", () => {
  it("deleting the last temp inbox on a pool domain returns 200 and does NOT deregister the domain", async () => {
    // Two agents lease temp inboxes that happen to land on the same pool domain.
    const a = emailService.createInbox("alice.reyes7", WALLET_A, undefined, "inbox-aaa.com", 86400);
    const b = emailService.createInbox("bob.shaw12", WALLET_A, undefined, "inbox-aaa.com", 86400);
    assert.equal(a.address.split("@")[1], "inbox-aaa.com");

    // Delete both — even when the LAST inbox on the pool domain goes, the route's
    // `!isSystemEmailDomain(inboxDomain)` guard must skip Mailgun teardown. (The
    // guard is what protects every other agent still on that shared domain; here
    // Mailgun is also unconfigured, so no teardown is even attempted.)
    for (const inbox of [a, b]) {
      const res = await request("DELETE", `/email/inboxes/${inbox.id}`, { "x-test-payer": WALLET_A });
      assert.equal(res.status, 200, JSON.stringify(res.json));
    }
    // The guard condition itself: a pool domain is a system domain, so teardown is skipped.
    assert.equal(isSystemEmailDomain("inbox-aaa.com"), true);
  });
});
