/**
 * Tests for DELETE /email/inboxes/:id — inboxes are disposable.
 *
 * Covers:
 *  - owner can delete: 200, row soft-deleted (active=0), hidden from
 *    getInbox/listInboxes, stored messages retained in the DB
 *  - reads of a deleted inbox 404 (getInbox filters inactive rows — the
 *    check every per-inbox route runs first — and a second DELETE 404s)
 *  - non-owner is rejected with 403 and the inbox stays active
 *  - Mailgun cleanup is best-effort: an upstream failure still completes
 *    the local delete and reports mailgun_cleanup: false
 *  - the custom-domain Mailgun registration is only removed when the LAST
 *    active inbox on that domain is deleted
 *  - inbound mail to a deleted inbox is dropped, not stored
 *
 * Harness style mirrors phone-webhook-security.test.ts: PALMYR_SELF_HOSTED
 * bypasses the x402 paywall in requireAuth (the ownership checks under test
 * are independent of payment), and a shim middleware injects req.payment
 * from an `x-test-payer` header so distinct payer identities can be driven
 * over real HTTP through the real router.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

process.env.EMAIL_DOMAIN = "palmyr.ai";

import { db, initDatabase } from "../db";
import { storage } from "../services/storage";
import * as emailService from "../services/email";
import emailRouter from "../routes/email";

const WALLET_A = "WALLETaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "WALLETbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let server: http.Server;
let port = 0;
let savedSelfHosted: string | undefined;
let savedSelfHostedForce: string | undefined;
let savedMailgunKey: string | undefined;

function wipeEmailTables(): void {
  // FK-dependency order (PRAGMA foreign_keys=ON).
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
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  savedMailgunKey = process.env.MAILGUN_API_KEY;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1"; // engage even if NODE_ENV=production
  delete process.env.MAILGUN_API_KEY; // tests opt in per-case

  const app = express();
  app.use(express.json());
  // Identity shim: requireAuth is bypassed by self-hosted mode, and the
  // handlers resolve the caller from req.payment?.payer — inject it here so
  // each request can act as a chosen wallet.
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
  if (savedSelfHosted === undefined) delete process.env.PALMYR_SELF_HOSTED;
  else process.env.PALMYR_SELF_HOSTED = savedSelfHosted;
  if (savedSelfHostedForce === undefined) delete process.env.PALMYR_SELF_HOSTED_FORCE;
  else process.env.PALMYR_SELF_HOSTED_FORCE = savedSelfHostedForce;
  if (savedMailgunKey === undefined) delete process.env.MAILGUN_API_KEY;
  else process.env.MAILGUN_API_KEY = savedMailgunKey;
  wipeEmailTables();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  wipeEmailTables();
});

describe("DELETE /email/inboxes/:id — owner delete", () => {
  it("soft-deletes: 200, row kept with active=0, hidden from reads and list, messages retained", async () => {
    const inbox = emailService.createInbox("todelete", WALLET_A);
    // Store a message so retention is observable.
    const stored = emailService.handleInboundEmail(inbox.address, "peer@example.com", "hi", "body text");
    assert.ok(stored, "test setup: inbound message should store while inbox is active");

    const res = await request("DELETE", `/email/inboxes/${inbox.id}`, { "x-test-payer": WALLET_A });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.deleted, true);
    assert.equal(res.json.id, inbox.id);
    assert.equal(res.json.address, "todelete@palmyr.ai");
    assert.equal(res.json.mailgun_cleanup, true, "default-domain inbox has nothing to clean upstream");
    assert.equal(res.json.messages_retained, true);

    // Soft delete: the row survives with active=0 — recoverable, address reserved.
    const row = db.prepare("SELECT active FROM email_inboxes WHERE id = ?").get(inbox.id) as any;
    assert.ok(row, "row must NOT be hard-deleted");
    assert.equal(row.active, 0);
    assert.equal(storage.hasEmailAddress("todelete@palmyr.ai"), true, "address stays reserved");

    // Hidden from the API: getInbox (what every per-inbox route checks first) and the list.
    assert.equal(emailService.getInbox(inbox.id), undefined);
    assert.equal(emailService.listInboxes(WALLET_A).length, 0);

    // Messages retained (encrypted at rest) in the DB.
    const msgCount = db.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE inbox_id = ?").get(inbox.id) as any;
    assert.equal(msgCount.n, 1);
  });

  it("404s reads of a deleted inbox (second DELETE included)", async () => {
    const inbox = emailService.createInbox("gone", WALLET_A);
    const first = await request("DELETE", `/email/inboxes/${inbox.id}`, { "x-test-payer": WALLET_A });
    assert.equal(first.status, 200);

    // getInbox is the gate every read route (messages/send/threads/webhooks)
    // resolves through before doing anything — undefined ⇒ they all 404.
    assert.equal(emailService.getInbox(inbox.id), undefined);

    const again = await request("DELETE", `/email/inboxes/${inbox.id}`, { "x-test-payer": WALLET_A });
    assert.equal(again.status, 404, JSON.stringify(again.json));
  });

  it("404s an inbox id that never existed", async () => {
    const res = await request("DELETE", "/email/inboxes/no-such-id", { "x-test-payer": WALLET_A });
    assert.equal(res.status, 404);
  });
});

describe("DELETE /email/inboxes/:id — ownership", () => {
  it("rejects a non-owner with 403 and leaves the inbox active", async () => {
    const inbox = emailService.createInbox("mine", WALLET_A);
    const res = await request("DELETE", `/email/inboxes/${inbox.id}`, { "x-test-payer": WALLET_B });
    assert.equal(res.status, 403, JSON.stringify(res.json));

    const still = emailService.getInbox(inbox.id);
    assert.ok(still, "inbox must remain active after a rejected delete");
    assert.equal(still!.active, true);
  });

  it("rejects a caller with no established identity", async () => {
    const inbox = emailService.createInbox("anon", WALLET_A);
    // No x-test-payer → self-hosted identity ('self-hosted'), which is not the owner.
    const res = await request("DELETE", `/email/inboxes/${inbox.id}`);
    assert.equal(res.status, 403);
    assert.ok(emailService.getInbox(inbox.id));
  });
});

describe("DELETE /email/inboxes/:id — Mailgun cleanup is best-effort", () => {
  const realFetch = global.fetch;

  after(() => { global.fetch = realFetch; });

  it("still deletes locally when Mailgun errors, reporting mailgun_cleanup: false", async () => {
    process.env.MAILGUN_API_KEY = "key-test";
    const calls: string[] = [];
    global.fetch = (async (url: any, init?: any) => {
      calls.push(`${init?.method || "GET"} ${String(url)}`);
      return new Response('{"message":"boom"}', { status: 500 });
    }) as any;

    try {
      const inbox = emailService.createInbox("solo", WALLET_A, undefined, "deltest-fail.xyz");
      const res = await request("DELETE", `/email/inboxes/${inbox.id}`, { "x-test-payer": WALLET_A });

      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.deleted, true, "local delete must complete despite the upstream failure");
      assert.equal(res.json.mailgun_cleanup, false);
      assert.equal(calls.length, 1, "one Mailgun delete attempt expected");

      const row = db.prepare("SELECT active FROM email_inboxes WHERE id = ?").get(inbox.id) as any;
      assert.equal(row.active, 0, "inbox must be deactivated even when Mailgun fails");
    } finally {
      global.fetch = realFetch;
      delete process.env.MAILGUN_API_KEY;
    }
  });

  it("only removes the Mailgun domain when the LAST active inbox on it is deleted", async () => {
    process.env.MAILGUN_API_KEY = "key-test";
    const calls: string[] = [];
    global.fetch = (async (url: any, init?: any) => {
      calls.push(`${init?.method || "GET"} ${String(url)}`);
      return new Response("{}", { status: 200 });
    }) as any;

    try {
      const first = emailService.createInbox("one", WALLET_A, undefined, "deltest-shared.xyz");
      const second = emailService.createInbox("two", WALLET_A, undefined, "deltest-shared.xyz");

      const res1 = await request("DELETE", `/email/inboxes/${first.id}`, { "x-test-payer": WALLET_A });
      assert.equal(res1.status, 200);
      assert.equal(res1.json.mailgun_cleanup, true);
      assert.equal(calls.length, 0, "domain still in use — Mailgun must NOT be called");

      const res2 = await request("DELETE", `/email/inboxes/${second.id}`, { "x-test-payer": WALLET_A });
      assert.equal(res2.status, 200);
      assert.equal(res2.json.mailgun_cleanup, true);
      assert.equal(calls.length, 1, "last inbox gone — exactly one Mailgun delete expected");
      assert.match(calls[0], /^DELETE .*\/v3\/domains\/deltest-shared\.xyz$/);
    } finally {
      global.fetch = realFetch;
      delete process.env.MAILGUN_API_KEY;
    }
  });

  it("skips Mailgun entirely when it is not configured", async () => {
    const calls: string[] = [];
    global.fetch = (async (url: any, init?: any) => {
      calls.push(`${init?.method || "GET"} ${String(url)}`);
      return new Response("{}", { status: 200 });
    }) as any;

    try {
      const inbox = emailService.createInbox("nofig", WALLET_A, undefined, "deltest-nokey.xyz");
      const res = await request("DELETE", `/email/inboxes/${inbox.id}`, { "x-test-payer": WALLET_A });
      assert.equal(res.status, 200);
      assert.equal(res.json.mailgun_cleanup, true);
      assert.equal(calls.length, 0);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe("delete → re-provision — inboxes are truly disposable", () => {
  it("rejects an ACTIVE duplicate with a FREE 409 before the paywall settles", async () => {
    emailService.createInbox("dup", WALLET_A);
    // A payment header engages the pre-payment validator (validateInboxInputs),
    // which must 409 BEFORE requireAuth can settle the $2 charge.
    const res = await request("POST", "/email/inboxes", { "x-payment": "unsigned-probe" }, { name: "dup" });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.match(String(res.json.hint || ""), /NOT been charged/i);
  });

  it("reactivates a soft-deleted inbox for its former owner (same id, reads work again)", async () => {
    const original = emailService.createInbox("phoenix", WALLET_A);
    const del = await request("DELETE", `/email/inboxes/${original.id}`, { "x-test-payer": WALLET_A });
    assert.equal(del.status, 200);
    assert.equal(emailService.getInbox(original.id), undefined);

    const res = await request("POST", "/email/inboxes", { "x-test-payer": WALLET_A }, { name: "phoenix" });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.reactivated, true);
    assert.equal(res.json.inbox.id, original.id, "reactivation must reuse the original inbox (keys + retained messages)");
    assert.equal(res.json.inbox.address, "phoenix@palmyr.ai");

    // The inbox works again: visible to reads/list, and inbound mail stores.
    const revived = emailService.getInbox(original.id);
    assert.ok(revived && revived.active);
    assert.equal(emailService.listInboxes(WALLET_A).length, 1);
    const msg = emailService.handleInboundEmail(original.address, "peer@example.com", "welcome back", "body");
    assert.ok(msg, "inbound mail must store again after reactivation");
  });

  it("refunds a DIFFERENT wallet colliding with a deleted inbox's reserved address (409, not a charged 500)", async () => {
    const original = emailService.createInbox("held", WALLET_A);
    assert.equal(emailService.deleteInbox(original.id), true);

    const res = await request("POST", "/email/inboxes", { "x-test-payer": WALLET_B }, { name: "held" });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json.error, "Conflict");
    assert.match(String(res.json.message || ""), /refunded/i);

    // The reserved inbox is neither reassigned nor reactivated.
    const row = db.prepare("SELECT owner, active FROM email_inboxes WHERE id = ?").get(original.id) as any;
    assert.equal(row.owner, WALLET_A);
    assert.equal(row.active, 0);
  });

  it("refunds an active-duplicate collision that reaches the handler (409, not a charged 500)", async () => {
    emailService.createInbox("racy", WALLET_A);
    // No payment header → the free preflight is skipped (mirrors the race
    // where a duplicate lands between preflight and INSERT) — the handler
    // must respond with the refunded 409, never a bare 500.
    const res = await request("POST", "/email/inboxes", { "x-test-payer": WALLET_B }, { name: "racy" });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json.error, "Conflict");
  });
});

describe("deleted inbox — inbound mail", () => {
  it("drops inbound mail to a deleted inbox instead of storing it", async () => {
    const inbox = emailService.createInbox("dead-drop", WALLET_A);
    assert.equal(emailService.deleteInbox(inbox.id), true);

    const msg = emailService.handleInboundEmail(inbox.address, "peer@example.com", "hello?", "anyone there");
    assert.equal(msg, null, "mail to a deleted inbox must be dropped");

    const count = db.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE inbox_id = ?").get(inbox.id) as any;
    assert.equal(count.n, 0);
  });
});
