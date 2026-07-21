/**
 * Tests for the disposable receive-only temp-number POOL — POST /phone/temp,
 * POST /phone/temp/:id/extend, the receive-only guards, the expiry/410 reads,
 * the sweep, the per-wallet caps, and (the security headline) MESSAGE ISOLATION
 * between successive lessees of a recycled pool number.
 *
 * MESSAGE ISOLATION is guaranteed by TWO independent mechanisms, both proven
 * here:
 *   1. Fresh lease ROW + realloc delete: leasing a recycled number hard-deletes
 *      the prior lease row AND its SMS, and inserts a brand-new row (new id,
 *      new lease_start). A read keyed on the new row id can't reach the old
 *      rows, and the old messages are physically gone.
 *   2. lease_start window clamp: getMessages / waitForOtp clamp the visible
 *      window to `max(now - lookback, lease_start)`, so even a message left
 *      against a row (e.g. arriving before the lease began) is never returned.
 * Plus the inbound half: handleInboundSms routes ONLY to a LIVE lease, so a
 * stray code during the inter-lease quarantine is dropped, not stored.
 *
 * Harness mirrors phone-wait-otp.test.ts + email-temp-inbox.test.ts:
 * PALMYR_SELF_HOSTED(+FORCE) bypasses the paywall (the logic under test is
 * independent of payment), and a shim sets BOTH req.agentId and req.payment
 * from an `x-test-payer` header so each request resolves a distinct owning
 * wallet AND charged-rejection paths have a payment to refund. The shim omits
 * `chain`, so refundAndRespond stops at its missing-chain branch (still emitting
 * payment_signature + a refund hint) — we assert the ROUTING to refundAndRespond,
 * the on-chain transfer itself is covered by the x402 refund suites.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { db, initDatabase } from "../db";
import { storage } from "../services/storage";
import * as phoneService from "../services/phone";
import { PhoneNumber, SmsMessage } from "../types";

const WALLET_A = "WALLETtempAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "WALLETtempBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WALLET_C = "WALLETtempCccccccccccccccccccccccccccccccc";

// A syntactically-present but undecodable payment header: makes the pre-paywall
// guards RUN (they only check header presence before their free rejections),
// while extractClaimedSvmPayer safely returns null on it.
const DUMMY_PAYMENT_HEADER = "bm90LWEtcmVhbC1wYXltZW50";

let server: http.Server;
let port = 0;
let savedSelfHosted: string | undefined;
let savedSelfHostedForce: string | undefined;
let savedSelfHostedWallet: string | undefined;

function wipe(): void {
  db.exec("DELETE FROM sms_messages; DELETE FROM phone_numbers; DELETE FROM phone_pool; DELETE FROM temp_phone_leases;");
}

let poolSeq = 0;
/** Seed N pool numbers, returning their E.164 strings. */
function seedPool(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const num = `+1555${String(4000000 + poolSeq++).padStart(7, "0")}`;
    storage.addPoolNumber(num, `telnyx-${num}`);
    out.push(num);
  }
  return out;
}

function insertInbound(phoneNumberId: string, to: string, body: string, receivedAt: Date = new Date()): SmsMessage {
  const msg: SmsMessage = {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    phoneNumberId,
    direction: "inbound",
    from: "+15559990000",
    to,
    body,
    timestamp: receivedAt.toISOString(),
  };
  storage.pushSmsMessage(phoneNumberId, msg);
  return msg;
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
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: baseHeaders }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode || 0, json });
      });
    });
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
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  savedSelfHostedWallet = process.env.PALMYR_SELF_HOSTED_WALLET;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1";
  process.env.PALMYR_SELF_HOSTED_WALLET = "self-hosted-temp-test";

  initDatabase();

  const phoneRoutes = (await import("../routes/phone")).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const payer = req.headers["x-test-payer"];
    if (payer) {
      // Set BOTH so the resolved owner is the x-test-payer wallet in every
      // handler (req.agentId||payer AND payer||req.agentId), and so charged
      // rejections have a payment to route through refundAndRespond. No `chain`.
      (req as any).agentId = String(payer);
      (req as any).payment = { payer: String(payer), signature: "test-sig-phone" };
    }
    next();
  });
  app.use("/phone", phoneRoutes);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  port = (server.address() as any).port;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore("PALMYR_SELF_HOSTED", savedSelfHosted);
  restore("PALMYR_SELF_HOSTED_FORCE", savedSelfHostedForce);
  restore("PALMYR_SELF_HOSTED_WALLET", savedSelfHostedWallet);
  wipe();
});

beforeEach(() => { wipe(); });

// ── Lease: shape + TTL clamp ────────────────────────────────

describe("POST /phone/temp — lease", () => {
  it("leases a pool number and returns { id, phone_number, expires_at, note } (default 30min)", async () => {
    const [num] = seedPool(1);
    const res = await request("POST", "/phone/temp", { "x-test-payer": WALLET_A });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.ok(res.json.id, "must return a lease id");
    assert.equal(res.json.phone_number, num, "must return the pooled number");
    assert.ok(res.json.expires_at, "must return expires_at");
    assert.match(String(res.json.note || ""), /receive-only/i, "note must state the receive-only VoIP caveat");
    assert.match(String(res.json.note || ""), /VoIP|Telegram|WhatsApp/i, "note must surface the VoIP-blocking reality");
    assert.ok(Math.abs(ttlOf(res.json.expires_at) - 1800) < 30, `default ttl ~30min, got ${ttlOf(res.json.expires_at)}s`);

    // The row is a temp lease owned by the payer.
    const number = phoneService.getNumber(res.json.id)!;
    assert.equal(number.owner, WALLET_A);
    assert.equal(number.poolNumber, true);
    assert.ok(number.leaseStart, "lease_start must be set");
  });

  it("clamps ttl_seconds to [300, 1800]", async () => {
    seedPool(3);
    const tooSmall = await request("POST", "/phone/temp", { "x-test-payer": WALLET_A }, { ttl_seconds: 10 });
    assert.ok(Math.abs(ttlOf(tooSmall.json.expires_at) - 300) < 30, `10s must clamp up to 300s, got ${ttlOf(tooSmall.json.expires_at)}s`);

    const tooBig = await request("POST", "/phone/temp", { "x-test-payer": WALLET_A }, { ttl_seconds: 99999 });
    assert.ok(Math.abs(ttlOf(tooBig.json.expires_at) - 1800) < 30, `huge ttl must clamp to 1800s, got ${ttlOf(tooBig.json.expires_at)}s`);

    const mid = await request("POST", "/phone/temp", { "x-test-payer": WALLET_A }, { ttl_seconds: 900 });
    assert.ok(Math.abs(ttlOf(mid.json.expires_at) - 900) < 30, `900s must pass through, got ${ttlOf(mid.json.expires_at)}s`);
  });
});

// ── MESSAGE ISOLATION (security headline) ───────────────────

describe("MESSAGE ISOLATION — a recycled number never leaks a prior lessee's SMS", () => {
  it("lessee B, leasing the SAME pooled number after A, cannot see A's code", async () => {
    const [num] = seedPool(1);

    // A leases and receives a code.
    const leaseA = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    assert.equal(leaseA.phoneNumber, num);
    phoneService.handleInboundSms("+15550001111", num, "Your code is 111111");
    const aMsgs = phoneService.getMessages(leaseA.id, WALLET_A);
    assert.equal(aMsgs.length, 1, "A must see its own code");
    assert.match(aMsgs[0].body, /111111/);

    // A's lease expires and clears quarantine (expired 20min ago > 15min grace).
    db.prepare("UPDATE phone_numbers SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), leaseA.id);

    // B leases — must get the SAME pooled number, as a FRESH row.
    const leaseB = storage.leaseTempNumber(WALLET_B, 1800, 900)!;
    assert.equal(leaseB.phoneNumber, num, "B must recycle the same pooled number");
    assert.notEqual(leaseB.id, leaseA.id, "B must get a brand-new lease row id");

    // A's row + SMS are physically gone; B sees an empty inbox.
    assert.equal(db.prepare("SELECT 1 FROM phone_numbers WHERE id = ?").get(leaseA.id), undefined, "A's lease row must be hard-deleted on realloc");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE phone_number_id = ?").get(leaseA.id) as any).n, 0, "A's SMS must be gone");
    const bMsgs = phoneService.getMessages(leaseB.id, WALLET_B);
    assert.equal(bMsgs.length, 0, "B must NOT see A's code");
  });

  it("window clamp: getMessages / waitForOtp hide any SMS older than lease_start", async () => {
    seedPool(1);
    const lease = storage.leaseTempNumber(WALLET_B, 1800, 900)!;

    // Pin lease_start to a known instant, then plant one SMS BEFORE it and one AFTER.
    const t0 = Date.now();
    db.prepare("UPDATE phone_numbers SET lease_start = ? WHERE id = ?").run(new Date(t0).toISOString(), lease.id);
    insertInbound(lease.id, lease.phoneNumber, "stale code 999999", new Date(t0 - 30_000)); // before lease
    insertInbound(lease.id, lease.phoneNumber, "my code 424242", new Date(t0 + 30_000));    // after lease

    const visible = phoneService.getMessages(lease.id, WALLET_B);
    assert.equal(visible.length, 1, "only the post-lease message may be visible");
    assert.match(visible[0].body, /424242/);
    assert.ok(!visible.some(m => /999999/.test(m.body)), "a pre-lease-start message must be clamped out");

    // Isolate the stale (pre-lease-start) message for the waitForOtp clamp check.
    db.prepare("DELETE FROM sms_messages WHERE phone_number_id = ?").run(lease.id);
    insertInbound(lease.id, lease.phoneNumber, "stale code 999999", new Date(t0 - 30_000));

    // waitForOtp with a LARGE lookback would grab the stale 999999 without the
    // clamp; the clamp gates it (windowStart = max(now - lookback, lease_start))
    // → found:false.
    const before = await phoneService.waitForOtp(lease.id, { timeoutMs: 400, lookbackMs: 5 * 60 * 1000 });
    assert.equal(before.hit, null, "wait-otp must not surface a pre-lease-start code even with a huge lookback");

    // Move lease_start back before the stale message → now it IS in-window.
    db.prepare("UPDATE phone_numbers SET lease_start = ? WHERE id = ?").run(new Date(t0 - 60_000).toISOString(), lease.id);
    const after = await phoneService.waitForOtp(lease.id, { timeoutMs: 400, lookbackMs: 5 * 60 * 1000 });
    assert.ok(after.hit, "with lease_start moved back, the same message is now in-window");
    assert.match(after.hit!.code, /999999/);
  });

  it("inbound during the inter-lease quarantine is dropped (no live lease to route to)", async () => {
    const [num] = seedPool(1);
    const lease = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    // Expire the lease NOW (within grace → quarantined, row still present).
    db.prepare("UPDATE phone_numbers SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), lease.id);

    phoneService.handleInboundSms("+15550002222", num, "late code 555555");

    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE phone_number_id = ?").get(lease.id) as any).n,
      0,
      "an SMS arriving after expiry (during quarantine) must be dropped, not stored on the dead lease",
    );
  });
});

// ── Expiry → 410 on reads/wait ──────────────────────────────

describe("temp pool — a permanent number sharing an E.164 is never leased or deleted (NULL-blindness guard)", () => {
  it("excludes a permanent (expires_at NULL) number from the pool and never hijacks/deletes it", () => {
    const [num] = seedPool(1);
    // A dedicated/permanent number row for the SAME E.164 — expires_at NULL,
    // owned by a victim, holding a private code. NULL > cutoff is falsy in SQL,
    // so a naive free-check would classify + pick + delete this row.
    const permId = "perm-victim-otp";
    storage.setPhoneNumber(permId, {
      id: permId, phoneNumber: num, country: "US", owner: WALLET_C,
      provisionedAt: new Date().toISOString(), active: true, sharedWith: [],
    });
    insertInbound(permId, num, "victim private code 111222");

    assert.equal(phoneService.countFreePoolNumbers(), 0, "a permanent number must not count as free");

    const lease = phoneService.leaseTempNumber(WALLET_A, 1800);
    assert.equal(lease, undefined, "must never lease over a permanent number");
    assert.ok(storage.getPhoneNumber(permId), "victim's permanent row must survive");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE phone_number_id = ?").get(permId) as any).n, 1,
      "victim's stored SMS must survive",
    );
  });

  it("addPoolNumber refuses a number that already has a permanent row", () => {
    const num = "+15559990001";
    storage.setPhoneNumber("perm-x", {
      id: "perm-x", phoneNumber: num, country: "US", owner: WALLET_C,
      provisionedAt: new Date().toISOString(), active: true, sharedWith: [],
    });
    assert.throws(() => storage.addPoolNumber(num), /permanent/i);
  });

  it("still leases a genuinely-free number when a permanent number exists on a DIFFERENT E.164", () => {
    const [free] = seedPool(1);
    storage.setPhoneNumber("perm-other", {
      id: "perm-other", phoneNumber: "+15558887777", country: "US", owner: WALLET_C,
      provisionedAt: new Date().toISOString(), active: true, sharedWith: [],
    });
    const lease = phoneService.leaseTempNumber(WALLET_A, 1800);
    assert.ok(lease && lease.phoneNumber === free, "the genuinely-free pool number should lease");
  });
});

describe("temp lease expiry — 410 on read/wait", () => {
  it("410s the messages route and wait-otp when the lease has expired", async () => {
    seedPool(1);
    const lease = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    db.prepare("UPDATE phone_numbers SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), lease.id);

    const msgs = await request("GET", `/phone/numbers/${lease.id}/messages`, { "x-test-payer": WALLET_A });
    assert.equal(msgs.status, 410, JSON.stringify(msgs.json));
    assert.match(String(msgs.json.message || ""), /lease has expired/i);

    const wait = await request("POST", `/phone/numbers/${lease.id}/wait-otp`, { "x-test-payer": WALLET_A }, { timeout_s: 1 });
    assert.equal(wait.status, 410, JSON.stringify(wait.json));
    assert.match(String(wait.json.message || ""), /lease has expired/i);
  });

  it("preflightWaitOtp rejects an expired lease FREE when a payment header is present", async () => {
    seedPool(1);
    const lease = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    db.prepare("UPDATE phone_numbers SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), lease.id);
    const res = await request("POST", `/phone/numbers/${lease.id}/wait-otp`, { "payment-signature": DUMMY_PAYMENT_HEADER }, { timeout_s: 1 });
    assert.equal(res.status, 410, JSON.stringify(res.json));
    assert.match(String(res.json.hint || ""), /NOT been charged/i);
  });
});

// ── Receive-only guards (pre-paywall 403) ───────────────────

describe("temp numbers are receive-only — send/call/transfer/share/unshare hard-403 pre-paywall", () => {
  it("403s send, call, transfer-ownership, share and unshare on a temp lease", async () => {
    seedPool(1);
    const lease = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    const id = lease.id;

    const cases: Array<[string, string, any]> = [
      ["POST", `/phone/numbers/${id}/send`, { to: "+15551234567", body: "hi" }],
      ["POST", `/phone/numbers/${id}/call`, { to: "+15551234567" }],
      ["POST", `/phone/numbers/${id}/transfer-ownership`, { new_owner: WALLET_B }],
      ["POST", `/phone/numbers/${id}/share`, { with: WALLET_B }],
      ["POST", `/phone/numbers/${id}/unshare`, { wallet: WALLET_B }],
    ];
    for (const [method, path, body] of cases) {
      const res = await request(method, path, { "x-test-payer": WALLET_A }, body);
      assert.equal(res.status, 403, `${path} must 403: ${JSON.stringify(res.json)}`);
      assert.match(String(res.json.error || ""), /receive-only/i, `${path} must cite receive-only`);
      assert.match(String(res.json.hint || ""), /NOT been charged/i, `${path} must say not charged`);
    }
  });

  it("does NOT block a permanent (bought) number — the guard passes it through", async () => {
    const record: PhoneNumber = {
      id: "pn-permanent-1", phoneNumber: "+15557770000", country: "US",
      owner: WALLET_A, provisionedAt: new Date().toISOString(), active: true,
    };
    storage.setPhoneNumber(record.id, record);
    // share is owner-gated but NOT temp-blocked → reaches the handler (200).
    const res = await request("POST", `/phone/numbers/${record.id}/share`, { "x-test-payer": WALLET_A }, { with: WALLET_B });
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 200, JSON.stringify(res.json));
  });
});

// ── Extend: +30m stacks, 24h cap ────────────────────────────

describe("POST /phone/temp/:id/extend", () => {
  it("stacks +30min per call on the current expiry", async () => {
    seedPool(1);
    const res = await request("POST", "/phone/temp", { "x-test-payer": WALLET_A });
    const id = res.json.id;
    const first = Date.parse(res.json.expires_at);

    const e1 = await request("POST", `/phone/temp/${id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(e1.status, 200, JSON.stringify(e1.json));
    assert.equal(Date.parse(e1.json.expires_at) - first, 1800 * 1000, "extend must be exactly +30min");

    const e2 = await request("POST", `/phone/temp/${id}/extend`, { "x-test-payer": WALLET_A });
    assert.equal(e2.status, 200, JSON.stringify(e2.json));
    assert.equal(Date.parse(e2.json.expires_at) - Date.parse(e1.json.expires_at), 1800 * 1000, "second extend stacks another +30min");
    assert.equal(storage.getPhoneNumber(id)!.expiresAt, e2.json.expires_at, "new expiry persisted");
  });

  it("rejects an extend past the 24h total cap FREE in the guard (payment header present)", async () => {
    seedPool(1);
    const lease = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    // Push expiry to lease_start + (24h - 10min): a +30min extend overflows 24h.
    const start = Date.parse(lease.leaseStart!);
    db.prepare("UPDATE phone_numbers SET expires_at = ? WHERE id = ?")
      .run(new Date(start + (24 * 3600 - 600) * 1000).toISOString(), lease.id);

    const res = await request("POST", `/phone/temp/${lease.id}/extend`, { "payment-signature": DUMMY_PAYMENT_HEADER });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.match(String(res.json.message || ""), /24h total|reached the cap/i);
    assert.match(String(res.json.hint || ""), /NOT been charged/i);
  });

  it("400s a permanent number FREE in the guard (nothing to extend)", async () => {
    const record: PhoneNumber = {
      id: "pn-permanent-2", phoneNumber: "+15557770001", country: "US",
      owner: WALLET_A, provisionedAt: new Date().toISOString(), active: true,
    };
    storage.setPhoneNumber(record.id, record);
    const res = await request("POST", `/phone/temp/${record.id}/extend`, { "payment-signature": DUMMY_PAYMENT_HEADER });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.match(String(res.json.error || ""), /not a temp number/i);
    assert.match(String(res.json.hint || ""), /NOT been charged/i);
  });

  it("404s an expired lease FREE in the guard — no revival", async () => {
    seedPool(1);
    const lease = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    db.prepare("UPDATE phone_numbers SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), lease.id);
    const res = await request("POST", `/phone/temp/${lease.id}/extend`, { "payment-signature": DUMMY_PAYMENT_HEADER });
    assert.equal(res.status, 404, JSON.stringify(res.json));
    assert.match(String(res.json.hint || ""), /NOT been charged/i);
  });
});

// ── Sweep + re-lease by a different wallet ──────────────────

describe("storage.deleteExpiredTempPhoneLeases — sweep frees the pool number", () => {
  it("hard-deletes an expired lease (past grace) and lets a DIFFERENT wallet re-lease the number", async () => {
    const [num] = seedPool(1);
    const leaseA = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    phoneService.handleInboundSms("+15550003333", num, "code 313131");

    // Expired 20min ago (> 15min grace).
    db.prepare("UPDATE phone_numbers SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), leaseA.id);

    const swept = storage.deleteExpiredTempPhoneLeases(15 * 60);
    assert.equal(swept, 1, "exactly one expired lease should be swept");
    assert.equal(db.prepare("SELECT 1 FROM phone_numbers WHERE id = ?").get(leaseA.id), undefined, "lease row gone");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE phone_number_id = ?").get(leaseA.id) as any).n, 0, "lease SMS cascaded");

    // The pooled number is free again; a different wallet gets it.
    assert.equal(phoneService.countFreePoolNumbers(), 1, "number returns to the free pool");
    const leaseB = storage.leaseTempNumber(WALLET_B, 1800, 900)!;
    assert.equal(leaseB.phoneNumber, num);
    assert.equal(leaseB.owner, WALLET_B);
  });

  it("does NOT sweep a within-grace expired lease, a live lease, or a permanent number", async () => {
    seedPool(2);
    const live = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    const withinGrace = storage.leaseTempNumber(WALLET_A, 1800, 900)!;
    db.prepare("UPDATE phone_numbers SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), withinGrace.id); // expired 1min ago
    const perm: PhoneNumber = { id: "pn-perm-3", phoneNumber: "+15557770002", country: "US", owner: WALLET_A, provisionedAt: new Date().toISOString(), active: true };
    storage.setPhoneNumber(perm.id, perm);

    assert.equal(storage.deleteExpiredTempPhoneLeases(15 * 60), 0, "nothing is past the grace window");
    assert.ok(db.prepare("SELECT 1 FROM phone_numbers WHERE id = ?").get(live.id), "live lease survives");
    assert.ok(db.prepare("SELECT 1 FROM phone_numbers WHERE id = ?").get(withinGrace.id), "within-grace lease survives");
    assert.ok(db.prepare("SELECT 1 FROM phone_numbers WHERE id = ?").get(perm.id), "permanent number is never touched");
  });
});

// ── Per-wallet caps ─────────────────────────────────────────

describe("per-wallet caps — 3 concurrent, 12 per rolling 24h", () => {
  it("429s (and refunds) the 4th concurrent lease", async () => {
    seedPool(6);
    for (let i = 0; i < 3; i++) {
      const ok = await request("POST", "/phone/temp", { "x-test-payer": WALLET_A });
      assert.equal(ok.status, 201, `lease ${i + 1} should succeed: ${JSON.stringify(ok.json)}`);
    }
    const fourth = await request("POST", "/phone/temp", { "x-test-payer": WALLET_A });
    assert.equal(fourth.status, 429, JSON.stringify(fourth.json));
    assert.match(String(fourth.json.message || ""), /max 3 active|12 per day/i);
    // Charged path (handler) → refund routing: payment_signature + refund hint.
    assert.equal(fourth.json.payment_signature, "test-sig-phone", "a charged 429 must surface the payment signature for the refund");
  });

  it("429s when 12 leases already exist in the rolling 24h window", async () => {
    seedPool(2);
    // Pre-seed the durable ledger (leases may have been swept — the ledger is
    // what backs the 24h count). No active rows → concurrent cap is not the tripwire.
    const now = new Date().toISOString();
    for (let i = 0; i < 12; i++) {
      db.prepare("INSERT INTO temp_phone_leases (id, owner, leased_at) VALUES (?, ?, ?)").run(`led-${i}`, WALLET_C, now);
    }
    const res = await request("POST", "/phone/temp", { "x-test-payer": WALLET_C });
    assert.equal(res.status, 429, JSON.stringify(res.json));
    assert.equal(phoneService.checkTempLeaseLimits(WALLET_C).ok, false);
    // A different wallet is unaffected.
    assert.equal(phoneService.checkTempLeaseLimits(WALLET_A).ok, true);
  });
});

// ── Pool exhaustion ─────────────────────────────────────────

describe("pool exhaustion", () => {
  it("503s pre-paywall (NOT charged) when the pool is dry", async () => {
    const [num] = seedPool(1);
    storage.leaseTempNumber(WALLET_C, 1800, 900); // take the only number
    assert.equal(phoneService.countFreePoolNumbers(), 0);

    // A payment header engages the preflight, which 503s before the paywall.
    const res = await request("POST", "/phone/temp", { "payment-signature": DUMMY_PAYMENT_HEADER });
    assert.equal(res.status, 503, JSON.stringify(res.json));
    assert.equal(res.json.error, "No temp numbers available");
    assert.match(String(res.json.message || ""), /currently in use/i);
    assert.match(String(res.json.hint || ""), /NOT been charged/i);
    assert.ok(num);
  });

  it("refunds the residual post-payment race (pool emptied after the free preflight)", async () => {
    seedPool(1);
    storage.leaseTempNumber(WALLET_C, 1800, 900); // pool now empty
    // No payment header → preflight skipped → handler's leaseTempNumber returns
    // null → refundAndRespond (503) with the payment signature.
    const res = await request("POST", "/phone/temp", { "x-test-payer": WALLET_A });
    assert.equal(res.status, 503, JSON.stringify(res.json));
    assert.equal(res.json.payment_signature, "test-sig-phone", "a charged pool-race must refund");
    assert.match(String(res.json.hint || ""), /refund/i);
  });
});

// ── DELETE = early release to the pool (no Telnyx) ──────────

describe("DELETE /phone/numbers/:id — temp lease early-releases to the pool", () => {
  it("releases without a Telnyx call and returns the number to the pool", async () => {
    // TELNYX_API_KEY is unset in-test: if deleteNumber tried to release upstream
    // it would throw (getClient()) → the route would 404 "Delete Failed".
    // A clean 200 proves the temp branch skipped Telnyx entirely.
    const [num] = seedPool(1);
    const created = await request("POST", "/phone/temp", { "x-test-payer": WALLET_A });
    const id = created.json.id;

    const del = await request("DELETE", `/phone/numbers/${id}`, { "x-test-payer": WALLET_A });
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.equal(del.json.success, true);
    assert.equal(del.json.returned_to_pool, true, "temp DELETE must report a pool return, not a Telnyx release");

    // Lease row still exists but is now expired (early release = expires_at now).
    const row = storage.getPhoneNumber(id)!;
    assert.ok(phoneService.isNumberExpired(row), "early release expires the lease immediately");
    assert.equal(row.phoneNumber, num);
    // The number is quarantined (not free yet) but never left our Telnyx account.
    assert.equal(phoneService.countFreePoolNumbers(), 0, "just-released number is quarantined, not immediately free");
  });
});
