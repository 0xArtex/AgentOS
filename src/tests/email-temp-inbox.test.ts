/**
 * Tests for POST /email/temp — disposable, receive-only, auto-expiring inboxes.
 *
 * Covers:
 *  - temp create returns a random `tmp-XXXXXXXX@<default-domain>` address plus
 *    an `expires_at`, with `ttl_seconds` clamped to [300, 604800] (default 24h)
 *  - the inbox is NOT E2E: even when a Solana wallet key is offered (in the body
 *    or as the owner), the route/service use server-side AES, so the owner reads
 *    PLAINTEXT — never `w:` ciphertext. This is the key regression guard: a
 *    Solana payer must not silently get E2E they'd have to decrypt.
 *  - the shared owner model holds (owner value set; non-owner rejected on the
 *    owner-gated DELETE route, which reads use the identical check)
 *  - send is hard-403'd for a temp inbox (receive-only), BEFORE the paywall
 *  - after expiry a read 404s (getInbox → undefined, the gate every read route
 *    resolves through) and inbound mail is dropped
 *  - deleteExpiredTempInboxes hard-deletes an expired temp inbox (row gone,
 *    address freed, child rows cascaded) and does NOT touch a normal (non-temp,
 *    expires_at NULL) inbox nor an unexpired temp one
 *
 * Harness mirrors email-delete-inbox.test.ts: PALMYR_SELF_HOSTED bypasses the
 * x402 paywall in BOTH requireAuth and bare x402() routes (the logic under test
 * is independent of payment), and a shim injects req.payment from an
 * `x-test-payer` header — which the x402 bypass now preserves, so the paid
 * read/send routes resolve the same wallet identity as the requireAuth routes.
 * The full paid-read plaintext path is exercised end-to-end in
 * full-checkout-e2e.test.ts; here we assert the receive-only send guard and the
 * service-layer plaintext behavior.
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
// A REAL, valid Solana base58 pubkey (decodes to 32 bytes) — used to prove that
// even a genuine Solana owner gets server-side (non-E2E) encryption on a temp
// inbox, i.e. the route never routes a wallet key into createInbox.
const SOL_OWNER = "4R67MWivvc52g9BSzQRvQyD8GshttW1QLbnj46usBrcQ";

const DEFAULT_DOMAIN = "palmyr.ai";
const TMP_ADDRESS_RE = /^tmp-[0-9a-f]{8}@palmyr\.ai$/;

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

/** Seconds between an ISO expires_at and now. */
function ttlOf(expiresAt: string): number {
  return (Date.parse(expiresAt) - Date.now()) / 1000;
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

describe("POST /email/temp — create", () => {
  it("returns a random tmp-XXXXXXXX@palmyr.ai address and an expires_at (default 24h)", async () => {
    const res = await request("POST", "/email/temp", { "x-test-payer": WALLET_A });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.ok(res.json.id, "must return an id");
    assert.match(String(res.json.address), TMP_ADDRESS_RE, `address ${res.json.address} must be tmp-<8 hex>@${DEFAULT_DOMAIN}`);
    assert.ok(res.json.expires_at, "must return expires_at");
    // Default TTL is 24h (86400s).
    assert.ok(Math.abs(ttlOf(res.json.expires_at) - 86400) < 60, `default ttl ~24h, got ${ttlOf(res.json.expires_at)}s`);

    // The row exists and is a live inbox reachable through getInbox.
    const inbox = emailService.getInbox(res.json.id);
    assert.ok(inbox, "temp inbox must be readable via getInbox");
    assert.equal(inbox!.address, res.json.address);
  });

  it("clamps ttl_seconds to [300, 604800]", async () => {
    const tooSmall = await request("POST", "/email/temp", { "x-test-payer": WALLET_A }, { ttl_seconds: 10 });
    assert.equal(tooSmall.status, 201, JSON.stringify(tooSmall.json));
    assert.ok(Math.abs(ttlOf(tooSmall.json.expires_at) - 300) < 60, `10s must clamp up to 300s, got ${ttlOf(tooSmall.json.expires_at)}s`);

    const tooBig = await request("POST", "/email/temp", { "x-test-payer": WALLET_A }, { ttl_seconds: 99999999 });
    assert.equal(tooBig.status, 201, JSON.stringify(tooBig.json));
    assert.ok(Math.abs(ttlOf(tooBig.json.expires_at) - 604800) < 60, `huge ttl must clamp to 604800s, got ${ttlOf(tooBig.json.expires_at)}s`);

    const custom = await request("POST", "/email/temp", { "x-test-payer": WALLET_A }, { ttl_seconds: 3600 });
    assert.equal(custom.status, 201);
    assert.ok(Math.abs(ttlOf(custom.json.expires_at) - 3600) < 60, `1h must pass through, got ${ttlOf(custom.json.expires_at)}s`);
  });

  it("issues distinct random addresses across calls", async () => {
    const a = await request("POST", "/email/temp", { "x-test-payer": WALLET_A });
    const b = await request("POST", "/email/temp", { "x-test-payer": WALLET_A });
    assert.notEqual(a.json.address, b.json.address);
  });
});

describe("POST /email/temp — NOT E2E (key regression guard)", () => {
  it("ignores any wallet key offered in the body — inbox stays server-side (no E2E)", async () => {
    const res = await request(
      "POST",
      "/email/temp",
      { "x-test-payer": SOL_OWNER },
      // Deliberately offer a Solana key the way POST /email/inboxes would accept
      // one. The temp route must NOT read these — E2E must never turn on.
      { walletAddress: SOL_OWNER, solanaPublicKey: SOL_OWNER },
    );
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const inbox = storage.getEmailInbox(res.json.id)!;
    assert.equal(inbox.e2eEnabled, false, "temp inbox must NOT be E2E");
    assert.ok(!inbox.solanaPublicKey, "no wallet key must be stored");
    assert.ok(!inbox.publicKey, "no derived X25519 key must be stored");
  });

  it("a Solana owner reads PLAINTEXT, not ciphertext (server-side AES, decryptable on read)", () => {
    // Mirrors EXACTLY what the route does: createInbox(name, owner, undefined,
    // undefined, ttl) — undefined key ⇒ server-side encryption ⇒ plaintext on
    // read — with the owner being a genuine Solana pubkey.
    const inbox = emailService.createInbox("tmp-deadbeef", SOL_OWNER, undefined, undefined, 86400);
    assert.equal(inbox.e2eEnabled, false);
    assert.ok(inbox.expiresAt, "ttl must set expiresAt");

    const original = { subject: "Your verification code", body: "Code: 123456" };
    const stored = emailService.handleInboundEmail(inbox.address, "noreply@shop.example", original.subject, original.body);
    assert.ok(stored, "inbound mail must store while the temp inbox is live");

    // Raw at-rest ciphertext must be server-encrypted ("s:"), never wallet/E2E ("w:").
    const row = db.prepare("SELECT subject, body FROM email_messages WHERE inbox_id = ?").get(inbox.id) as any;
    assert.ok(String(row.subject).startsWith("s:"), `subject must be server-encrypted, got ${String(row.subject).slice(0, 3)}`);
    assert.ok(!String(row.subject).startsWith("w:"), "subject must NOT be E2E (w:) ciphertext");
    assert.ok(String(row.body).startsWith("s:"), "body must be server-encrypted");

    // The server can decrypt to the original plaintext — exactly what the paid
    // read route returns to the owning wallet for a non-E2E inbox.
    assert.equal(emailService.serverDecrypt(inbox.id, row.subject), original.subject);
    assert.equal(emailService.serverDecrypt(inbox.id, row.body), original.body);
  });
});

describe("POST /email/temp — owner model unchanged", () => {
  it("sets owner to the paying wallet and enforces owner-only on the shared DELETE route", async () => {
    // A temp inbox is owned like any inbox — the read route's ownership check
    // (payer === owner || payer === solanaPublicKey) is identical to DELETE's,
    // which we CAN drive (requireAuth is bypassed; the handler still checks).
    const inbox = emailService.createInbox("tmp-11112222", WALLET_A, undefined, undefined, 86400);
    assert.equal(inbox.owner, WALLET_A);

    // Non-owner is rejected and the inbox survives.
    const nonOwner = await request("DELETE", `/email/inboxes/${inbox.id}`, { "x-test-payer": WALLET_B });
    assert.equal(nonOwner.status, 403, JSON.stringify(nonOwner.json));
    assert.ok(emailService.getInbox(inbox.id), "temp inbox must survive a rejected non-owner delete");

    // Owner succeeds.
    const owner = await request("DELETE", `/email/inboxes/${inbox.id}`, { "x-test-payer": WALLET_A });
    assert.equal(owner.status, 200, JSON.stringify(owner.json));
  });
});

describe("POST /email/inboxes/:id/send — temp inboxes are receive-only", () => {
  it("hard-403s a send from a temp inbox (before the paywall)", async () => {
    const temp = emailService.createInbox("tmp-33334444", WALLET_A, undefined, undefined, 86400);
    const res = await request(
      "POST",
      `/email/inboxes/${temp.id}/send`,
      { "x-test-payer": WALLET_A },
      { to: "x@y.com", subject: "hi", body: "spam" },
    );
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.match(String(res.json.error || ""), /receive-only/i);
  });

  it("does NOT block a normal (non-temp) inbox — the receive-only guard passes it through", async () => {
    const normal = emailService.createInbox("normal-box", WALLET_A);
    const res = await request(
      "POST",
      `/email/inboxes/${normal.id}/send`,
      { "x-test-payer": WALLET_A },
      { to: "x@y.com", subject: "hi", body: "legit" },
    );
    // blockTempSend only rejects disposable temp inboxes; a normal inbox passes
    // it. In self-hosted mode the x402 paywall is now bypassed (it used to 402
    // here), the shim's WALLET_A payer owns the inbox, so the request reaches
    // the send handler and 500s ONLY because Mailgun isn't configured in-test —
    // never the receive-only guard, never a wallet mismatch.
    assert.notEqual(res.status, 403);
    assert.notEqual(res.json?.error, "temp inboxes are receive-only");
    assert.equal(res.status, 500, JSON.stringify(res.json));
    assert.match(String(res.json?.error || ""), /Mailgun|send unavailable|MAILGUN_API_KEY/i);
  });
});

describe("temp inbox expiry — functionally gone at expiry", () => {
  it("404s reads (getInbox → undefined) and drops inbound mail once expired", async () => {
    const temp = emailService.createInbox("tmp-55556666", WALLET_A, undefined, undefined, 86400);
    // Force it past expiry deterministically (no sleeping).
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE email_inboxes SET expires_at = ? WHERE id = ?").run(past, temp.id);

    // getInbox is the gate every read route resolves through first.
    assert.equal(emailService.getInbox(temp.id), undefined, "expired temp inbox must read as gone");
    assert.equal(emailService.listInboxes(WALLET_A).length, 0, "expired temp inbox must not list");

    const dropped = emailService.handleInboundEmail(temp.address, "peer@example.com", "late", "too late");
    assert.equal(dropped, null, "inbound mail to an expired temp inbox must be dropped");
    const count = db.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE inbox_id = ?").get(temp.id) as any;
    assert.equal(count.n, 0);

    // The row still exists (reserved) until the sweep hard-deletes it.
    const row = db.prepare("SELECT 1 FROM email_inboxes WHERE id = ?").get(temp.id);
    assert.ok(row, "row survives functional expiry; only the sweep removes it");
  });
});

describe("storage.deleteExpiredTempInboxes — hard delete frees the address", () => {
  it("hard-deletes a temp inbox expired past the grace, cascading its children", async () => {
    const temp = emailService.createInbox("tmp-77778888", WALLET_A, undefined, undefined, 86400);
    // A message (+ attachment) and a thread via inbound, plus a webhook row.
    emailService.handleInboundEmail(
      temp.address, "peer@example.com", "receipt", "your order",
      undefined,
      [{ filename: "r.txt", contentType: "text/plain", content: "x".repeat(10) }],
    );
    storage.setEmailWebhook("wh-temp", { id: "wh-temp", inboxId: temp.id, url: "https://example.com/hook", events: ["message.received"], createdAt: new Date().toISOString() });

    // Expired 49h ago — beyond the 48h grace.
    const long = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
    db.prepare("UPDATE email_inboxes SET expires_at = ? WHERE id = ?").run(long, temp.id);

    const deleted = storage.deleteExpiredTempInboxes(48 * 3600);
    assert.equal(deleted, 1, "exactly one temp inbox should be hard-deleted");

    // Row gone, address freed for reuse.
    assert.equal(db.prepare("SELECT 1 FROM email_inboxes WHERE id = ?").get(temp.id), undefined);
    assert.equal(storage.hasEmailAddress(temp.address), false, "address must be freed");

    // Children cascaded.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM email_messages WHERE inbox_id = ?").get(temp.id) as any).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM email_threads WHERE inbox_id = ?").get(temp.id) as any).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM email_webhooks WHERE inbox_id = ?").get(temp.id) as any).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM email_attachments").get() as any).n, 0, "attachments must cascade");
  });

  it("does NOT touch a normal (expires_at NULL) inbox or an unexpired temp one", async () => {
    const normal = emailService.createInbox("keeper", WALLET_A); // no ttl → expires_at NULL
    const freshTemp = emailService.createInbox("tmp-99990000", WALLET_A, undefined, undefined, 86400); // expires in the future
    // A temp expired only 1h ago is still within the 48h grace — also untouched.
    const withinGrace = emailService.createInbox("tmp-aaaabbbb", WALLET_A, undefined, undefined, 86400);
    db.prepare("UPDATE email_inboxes SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3600 * 1000).toISOString(), withinGrace.id);

    const deleted = storage.deleteExpiredTempInboxes(48 * 3600);
    assert.equal(deleted, 0, "nothing is beyond the grace window");

    assert.ok(db.prepare("SELECT 1 FROM email_inboxes WHERE id = ?").get(normal.id), "normal inbox must survive");
    assert.ok(db.prepare("SELECT 1 FROM email_inboxes WHERE id = ?").get(freshTemp.id), "unexpired temp inbox must survive");
    assert.ok(db.prepare("SELECT 1 FROM email_inboxes WHERE id = ?").get(withinGrace.id), "within-grace temp inbox must survive");
  });
});
