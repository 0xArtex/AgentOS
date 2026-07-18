/**
 * Tests for POST /email/temp/:id/extend — the $0.50 rent extension that pushes
 * a live disposable temp inbox's expiry exactly 7 days further per call.
 *
 * Covers:
 *  - owner extend → 200 with { id, address, expires_at } where expires_at is
 *    EXACTLY previous expires_at + 7 days (604800s), persisted in storage
 *  - a second extend stacks: each call is exactly +7d on the previous expiry
 *    (+14d total from the original) — no cap, no params
 *  - non-owner → 403 and the expiry is untouched
 *  - a normal (persistent, expires_at NULL) inbox → 400 "not a temp inbox";
 *    with a payment header present the pre-paywall guard rejects it FREE
 *    (asserted via the "has NOT been charged" hint)
 *  - an expired temp inbox → 404, no revival; also free via the guard when a
 *    payment header is present; unknown ids 404 the same way
 *  - an extended inbox is still receive-only (send hard-403s pre-paywall) and
 *    still live/readable by its owner (getInbox resolves, inbound mail stores)
 *  - the extension is visible via getInbox / listInboxes (new expiry listed)
 *  - storage.updateEmailInboxExpiry never touches a NULL-expiry (normal) inbox
 *  - charged rejections (post-settlement 403 wallet-mismatch and 404
 *    expired-during-settlement) route through refundAndRespond — asserted via
 *    the payment_signature + refund hint only that path emits
 *
 * Harness mirrors email-temp-inbox.test.ts: PALMYR_SELF_HOSTED bypasses the
 * x402 paywall (the logic under test is independent of payment) and a shim
 * injects req.payment from an `x-test-payer` header. Without a payment header
 * the pre-paywall guard is skipped by design (discovery probes must reach the
 * 402), so the handler's own re-checks are what most tests drive; the guard's
 * free-rejection path is driven explicitly with a dummy payment-signature
 * header and asserted via its "not charged" hint.
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

const SEVEN_DAYS_MS = 604800 * 1000;
// A syntactically-present but undecodable payment header: enough to make the
// pre-paywall guard run (it only checks header PRESENCE before its free
// rejections), while extractClaimedSvmPayer safely returns null on it.
const DUMMY_PAYMENT_HEADER = "bm90LWEtcmVhbC1wYXltZW50";

let server: http.Server;
let port = 0;
let savedSelfHosted: string | undefined;
let savedSelfHostedForce: string | undefined;
let savedMailgunKey: string | undefined;

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
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  savedMailgunKey = process.env.MAILGUN_API_KEY;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1";
  delete process.env.MAILGUN_API_KEY;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const payer = req.headers["x-test-payer"];
    // Deliberately NO `chain`: refundAndRespond then stops at its missing-chain
    // branch (still emitting payment_signature + a refund hint) instead of
    // attempting a real on-chain transfer. The refund transfer itself is
    // covered by the x402 refund suites; here we assert the ROUTING — that
    // every charged rejection goes through refundAndRespond.
    if (payer) (req as any).payment = { payer: String(payer), signature: "test-sig-extend" };
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

describe("POST /email/temp/:id/extend — owner extends", () => {
  it("returns 200 with expires_at exactly +7d from the previous expiry, persisted", async () => {
    const temp = emailService.createInbox("tmp-e0000001", WALLET_A, undefined, undefined, 86400);
    const before = Date.parse(temp.expiresAt!);

    const res = await request("POST", `/email/temp/${temp.id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.id, temp.id);
    assert.equal(res.json.address, temp.address);
    assert.ok(res.json.expires_at, "must return the new expires_at");
    assert.equal(
      Date.parse(res.json.expires_at) - before,
      SEVEN_DAYS_MS,
      "extension must be EXACTLY +7 days on the previous expiry",
    );

    // Persisted — the stored row carries the new expiry.
    const stored = storage.getEmailInbox(temp.id)!;
    assert.equal(stored.expiresAt, res.json.expires_at);
  });

  it("stacks: a second extend adds another exact 7 days (+14d total)", async () => {
    const temp = emailService.createInbox("tmp-e0000002", WALLET_A, undefined, undefined, 86400);
    const original = Date.parse(temp.expiresAt!);

    const first = await request("POST", `/email/temp/${temp.id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const second = await request("POST", `/email/temp/${temp.id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(second.status, 200, JSON.stringify(second.json));

    assert.equal(Date.parse(second.json.expires_at) - Date.parse(first.json.expires_at), SEVEN_DAYS_MS, "second call must be +7d on the first");
    assert.equal(Date.parse(second.json.expires_at) - original, 2 * SEVEN_DAYS_MS, "two calls must stack to +14d total");
    assert.equal(storage.getEmailInbox(temp.id)!.expiresAt, second.json.expires_at);
  });

  it("is visible via getInbox and listInboxes (new expiry listed)", async () => {
    const temp = emailService.createInbox("tmp-e0000003", WALLET_A, undefined, undefined, 86400);
    const res = await request("POST", `/email/temp/${temp.id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(res.status, 200, JSON.stringify(res.json));

    const viaGet = emailService.getInbox(temp.id);
    assert.ok(viaGet, "extended temp inbox must still resolve via getInbox");
    assert.equal(viaGet!.expiresAt, res.json.expires_at);

    const listed = emailService.listInboxes(WALLET_A).find(i => i.id === temp.id);
    assert.ok(listed, "extended temp inbox must still list for its owner");
    assert.equal(listed!.expiresAt, res.json.expires_at, "listInboxes must show the new expiry");
  });
});

describe("POST /email/temp/:id/extend — owner-only", () => {
  it("403s a non-owner and leaves the expiry untouched", async () => {
    const temp = emailService.createInbox("tmp-e0000004", WALLET_A, undefined, undefined, 86400);
    const before = storage.getEmailInbox(temp.id)!.expiresAt;

    const res = await request("POST", `/email/temp/${temp.id}/extend`, { "x-test-payer": WALLET_B });
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.match(String(res.json.error || ""), /mismatch/i);
    assert.equal(storage.getEmailInbox(temp.id)!.expiresAt, before, "a rejected extend must not move the expiry");
    // The guard can't pre-check a Base payer, so this rejection fires AFTER
    // settlement — it must route through refundAndRespond, never keep the
    // charge. payment_signature + a refund hint only exist on that path.
    assert.equal(res.json.payment_signature, "test-sig-extend", "charged 403 must surface the payment signature for the refund");
    assert.match(String(res.json.hint || ""), /refund/i, "charged 403 must be a refunding rejection");
  });
});

describe("POST /email/temp/:id/extend — temp-only (normal inboxes have no TTL)", () => {
  it("400s a normal (persistent) inbox", async () => {
    const normal = emailService.createInbox("keeper-extend", WALLET_A); // no ttl → expires_at NULL
    const res = await request("POST", `/email/temp/${normal.id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.match(String(res.json.error || ""), /not a temp inbox/i);
    assert.equal(storage.getEmailInbox(normal.id)!.expiresAt, undefined, "a normal inbox must never gain an expiry");
  });

  it("rejects it FREE in the pre-paywall guard when a payment header is present", async () => {
    const normal = emailService.createInbox("keeper-extend2", WALLET_A);
    const res = await request(
      "POST",
      `/email/temp/${normal.id}/extend`,
      { "payment-signature": DUMMY_PAYMENT_HEADER },
    );
    assert.equal(res.status, 400, JSON.stringify(res.json));
    // The "NOT been charged" hint only exists on the guard's responses — its
    // presence proves the rejection ran BEFORE the paywall.
    assert.match(String(res.json.hint || ""), /NOT been charged/i);
  });
});

describe("POST /email/temp/:id/extend — live-only (expired means gone)", () => {
  it("404s an expired temp inbox — no revival", async () => {
    const temp = emailService.createInbox("tmp-e0000005", WALLET_A, undefined, undefined, 86400);
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE email_inboxes SET expires_at = ? WHERE id = ?").run(past, temp.id);

    const res = await request("POST", `/email/temp/${temp.id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(res.status, 404, JSON.stringify(res.json));
    assert.equal(storage.getEmailInbox(temp.id)!.expiresAt, past, "an expired inbox's expiry must never move");
    // TOCTOU shape: the free guard passed (or was skipped) but the inbox was
    // expired by the time the charged handler ran — the charge must be
    // refunded, not kept for a resource that no longer exists.
    assert.equal(res.json.payment_signature, "test-sig-extend", "charged 404 must surface the payment signature for the refund");
    assert.match(String(res.json.hint || ""), /refund/i, "charged 404 must be a refunding rejection");
  });

  it("404s an unknown inbox id", async () => {
    const res = await request("POST", "/email/temp/no-such-inbox/extend", { "x-test-payer": WALLET_A });
    assert.equal(res.status, 404, JSON.stringify(res.json));
  });

  it("rejects expired + unknown FREE in the pre-paywall guard when a payment header is present", async () => {
    const temp = emailService.createInbox("tmp-e0000006", WALLET_A, undefined, undefined, 86400);
    db.prepare("UPDATE email_inboxes SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), temp.id);

    const expired = await request("POST", `/email/temp/${temp.id}/extend`, { "payment-signature": DUMMY_PAYMENT_HEADER });
    assert.equal(expired.status, 404, JSON.stringify(expired.json));
    assert.match(String(expired.json.hint || ""), /NOT been charged/i);

    const unknown = await request("POST", "/email/temp/no-such-inbox/extend", { "payment-signature": DUMMY_PAYMENT_HEADER });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
    assert.match(String(unknown.json.hint || ""), /NOT been charged/i);
  });
});

describe("extended temp inbox — lifecycle semantics unchanged", () => {
  it("stays receive-only (send hard-403s) and stays readable/receiving for its owner", async () => {
    const temp = emailService.createInbox("tmp-e0000007", WALLET_A, undefined, undefined, 86400);
    const extended = await request("POST", `/email/temp/${temp.id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(extended.status, 200, JSON.stringify(extended.json));

    // Still receive-only: blockTempSend keys off expires_at, which the
    // extension only pushed forward — the pre-paywall 403 must still fire.
    const send = await request(
      "POST",
      `/email/inboxes/${temp.id}/send`,
      { "x-test-payer": WALLET_A },
      { to: "x@y.com", subject: "hi", body: "spam" },
    );
    assert.equal(send.status, 403, JSON.stringify(send.json));
    assert.match(String(send.json.error || ""), /receive-only/i);

    // Still live: getInbox resolves (the gate every read route goes through)
    // and inbound mail still stores.
    assert.ok(emailService.getInbox(temp.id), "extended inbox must remain readable");
    const stored = emailService.handleInboundEmail(temp.address, "noreply@shop.example", "shipment update", "still moving");
    assert.ok(stored, "inbound mail must store on an extended temp inbox");
  });

  it("keeps the sweep's grace anchored to the NEW expiry (WHERE expires_at < cutoff)", async () => {
    // An inbox whose ORIGINAL expiry is >48h in the past would be swept — but
    // after an extension moved expires_at forward, the same sweep must skip it.
    const temp = emailService.createInbox("tmp-e0000008", WALLET_A, undefined, undefined, 86400);
    const longAgo = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
    db.prepare("UPDATE email_inboxes SET expires_at = ? WHERE id = ?").run(longAgo, temp.id);

    // Simulate the rent having been paid before expiry: push the stored expiry
    // forward through the same storage method the route uses.
    const renewed = new Date(Date.parse(longAgo) + SEVEN_DAYS_MS).toISOString();
    assert.equal(storage.updateEmailInboxExpiry(temp.id, renewed), true);

    const deleted = storage.deleteExpiredTempInboxes(48 * 3600);
    assert.equal(deleted, 0, "sweep must honor the renewed expiry with no code change");
    assert.ok(db.prepare("SELECT 1 FROM email_inboxes WHERE id = ?").get(temp.id), "renewed inbox must survive the sweep");
  });

  it("still sweeps a renewed-then-re-expired inbox 48h after its NEW expiry", async () => {
    // The other direction: renewal must delay the sweep, never exempt from it.
    // Extend once (real route), then age the RENEWED expiry past the grace —
    // the inbox must be hard-deleted like any other expired temp.
    const temp = emailService.createInbox("tmp-e0000009", WALLET_A, undefined, undefined, 86400);
    const extended = await request("POST", `/email/temp/${temp.id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(extended.status, 200, JSON.stringify(extended.json));

    const pastGrace = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
    db.prepare("UPDATE email_inboxes SET expires_at = ? WHERE id = ?").run(pastGrace, temp.id);

    const deleted = storage.deleteExpiredTempInboxes(48 * 3600);
    assert.equal(deleted, 1, "a renewed-then-re-expired inbox must still be swept");
    assert.equal(db.prepare("SELECT 1 FROM email_inboxes WHERE id = ?").get(temp.id), undefined, "row must be hard-deleted, freeing the address");
  });
});

describe("storage.updateEmailInboxExpiry — temp-only scope", () => {
  it("refuses to give a normal (expires_at NULL) inbox an expiry, and false on unknown ids", () => {
    const normal = emailService.createInbox("keeper-extend3", WALLET_A);
    const attempt = storage.updateEmailInboxExpiry(normal.id, new Date(Date.now() + SEVEN_DAYS_MS).toISOString());
    assert.equal(attempt, false, "a NULL-expiry inbox must never gain one here");
    assert.equal(storage.getEmailInbox(normal.id)!.expiresAt, undefined);

    assert.equal(storage.updateEmailInboxExpiry("no-such-inbox", new Date().toISOString()), false);
  });
});
