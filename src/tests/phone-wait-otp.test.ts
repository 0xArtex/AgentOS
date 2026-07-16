/**
 * Tests for the wait-otp primitive.
 *
 * Unit: extractOtp — the default format ladder (standalone digits, code is/
 * code:, G-XXXXXX), custom pattern override, no-match / bad-regex paths, and
 * the date/price false-positive guards. isTimeoutExempt — the wait-otp route
 * (and only it, phone-wise) skips the global 30s request timeout. waitForOtp —
 * shouldAbort stops the poll loop when the client is gone.
 *
 * Route: POST /phone/numbers/:id/wait-otp booted on an ephemeral port in
 * self-hosted mode (auth bypass, identity = PALMYR_SELF_HOSTED_WALLET), same
 * harness style as phone-webhook-security.test.ts. Covers: a message inserted
 * MID-WAIT is returned; lookback catches a code that arrived before the call
 * but the 10s default does NOT re-serve a 20s-old stale code; timeout answers
 * 200 { found: false }; outbound messages never match; oversized patterns are
 * rejected pre-payment; a catastrophic (ReDoS) pattern is killed by the
 * worker budget, degrades to default extraction, and reports pattern_timeout;
 * and the ownership / existence gates (403 / 404).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { db, initDatabase } from "../db";
import { storage } from "../services/storage";
import { extractOtp, waitForOtp, OTP_PATTERN_MAX_LENGTH } from "../services/phone";
import { isTimeoutExempt } from "../middleware/timeout";
import { PhoneNumber, SmsMessage } from "../types";

// ── global 30s timeout exemption ────────────────────────────

describe("isTimeoutExempt — wait-otp is exempt from the global 30s cap", () => {
  it("exempts exactly the wait-otp route (incl. trailing slash)", () => {
    assert.equal(isTimeoutExempt("/phone/numbers/pn-1/wait-otp"), true);
    assert.equal(isTimeoutExempt("/phone/numbers/pn-1/wait-otp/"), true);
  });

  it("does NOT exempt the rest of /phone", () => {
    assert.equal(isTimeoutExempt("/phone/numbers"), false);
    assert.equal(isTimeoutExempt("/phone/numbers/pn-1/send"), false);
    assert.equal(isTimeoutExempt("/phone/numbers/pn-1/messages"), false);
    assert.equal(isTimeoutExempt("/phone/numbers/pn-1/wait-otp/extra"), false);
  });

  it("keeps the pre-existing exemptions", () => {
    assert.equal(isTimeoutExempt("/social/twitter/post"), true);
    assert.equal(isTimeoutExempt("/chat"), true);
    assert.equal(isTimeoutExempt("/mcp"), true);
    assert.equal(isTimeoutExempt("/domains/register"), true);
    assert.equal(isTimeoutExempt("/domains"), false);
  });
});

// ── extractOtp (unit) ───────────────────────────────────────

describe("extractOtp — default formats", () => {
  it("standalone 4–8 digit code", () => {
    assert.equal(extractOtp("Your verification code is 482913"), "482913");
    assert.equal(extractOtp("1234 is your PIN"), "1234");
    assert.equal(extractOtp("Use 55667788 to continue."), "55667788");
  });

  it("'code is' / 'code:' followed by an alphanumeric token", () => {
    assert.equal(extractOtp("Your code is X7K2P9"), "X7K2P9");
    assert.equal(extractOtp("code: AB12CD"), "AB12CD");
    assert.equal(extractOtp("Your Acme code is x9y8z7w6."), "x9y8z7w6");
  });

  it("Google-style G-XXXXXX (returned with the G- prefix)", () => {
    assert.equal(extractOtp("G-482913 is your Google verification code."), "G-482913");
  });

  it("prefers the standalone digit code when several formats coexist", () => {
    assert.equal(extractOtp("Enter 123456 or use code ABCDEF"), "123456");
  });

  it("does not match digits inside longer runs (phone numbers)", () => {
    assert.equal(extractOtp("Call us at +15551234567 for help"), null);
    assert.equal(extractOtp("Text 555-123-4567 to opt out"), null);
  });

  it("does not match too-short or absent codes", () => {
    assert.equal(extractOtp("Your code is 12"), null);
    assert.equal(extractOtp("no code here"), null);
    assert.equal(extractOtp(""), null);
  });

  it("does not match dates or prices", () => {
    assert.equal(extractOtp("Your appointment is on 07/16/2026"), null);
    assert.equal(extractOtp("Delivery window 2026/07/16"), null);
    assert.equal(extractOtp("Renewal on 2026-07-16"), null);
    assert.equal(extractOtp("Total due: $2026"), null);
    assert.equal(extractOtp("Prix: €2026"), null);
  });
});

describe("extractOtp — custom pattern", () => {
  it("uses the first capture group when present", () => {
    assert.equal(extractOtp("Your PIN 55555 expires soon", "PIN (\\d{5})"), "55555");
  });

  it("falls back to the full match without a capture group", () => {
    assert.equal(extractOtp("token=ZX99Q", "ZX\\d{2}Q"), "ZX99Q");
  });

  it("a custom pattern overrides (not augments) the defaults", () => {
    // Default would find 482913; the custom pattern doesn't match → null.
    assert.equal(extractOtp("Your code is 482913", "PIN (\\d{5})"), null);
  });

  it("an invalid regex returns null instead of throwing", () => {
    assert.equal(extractOtp("Your code is 482913", "("), null);
  });
});

// ── Route (integration) ─────────────────────────────────────

const IDENTITY = "WALLETwaitotpOwnerooooooooooooooooooooooooo";
const STRANGER = "WALLETwaitotpStrangerssssssssssssssssssssss";

let savedSelfHosted: string | undefined;
let savedSelfHostedForce: string | undefined;
let savedSelfHostedWallet: string | undefined;
let server: http.Server;
let port: number;

function insertNumber(id: string, owner: string): PhoneNumber {
  const record: PhoneNumber = {
    id,
    phoneNumber: `+1555010${id.slice(-4).padStart(4, "0")}`,
    country: "US",
    owner,
    provisionedAt: new Date().toISOString(),
    active: true,
  };
  storage.setPhoneNumber(id, record);
  return record;
}

function insertInbound(phoneNumberId: string, body: string, receivedAt: Date = new Date()): SmsMessage {
  const msg: SmsMessage = {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    phoneNumberId,
    direction: "inbound",
    from: "+15550009999",
    to: "+15550100000",
    body,
    timestamp: receivedAt.toISOString(),
  };
  storage.pushSmsMessage(phoneNumberId, msg);
  return msg;
}

function waitOtp(
  id: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/phone/numbers/${id}/wait-otp`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers },
      },
      res => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", c => (buf += c));
        res.on("end", () => {
          let parsed: any = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end(payload);
  });
}

before(async () => {
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  savedSelfHostedWallet = process.env.PALMYR_SELF_HOSTED_WALLET;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1"; // engage even if NODE_ENV=production
  process.env.PALMYR_SELF_HOSTED_WALLET = IDENTITY;

  initDatabase();

  const phoneRoutes = (await import("../routes/phone")).default;
  const app = express();
  app.use(express.json());
  app.use("/phone", phoneRoutes);
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind failed");
      port = addr.port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>(r => server.close(() => r()));
  if (savedSelfHosted === undefined) delete process.env.PALMYR_SELF_HOSTED;
  else process.env.PALMYR_SELF_HOSTED = savedSelfHosted;
  if (savedSelfHostedForce === undefined) delete process.env.PALMYR_SELF_HOSTED_FORCE;
  else process.env.PALMYR_SELF_HOSTED_FORCE = savedSelfHostedForce;
  if (savedSelfHostedWallet === undefined) delete process.env.PALMYR_SELF_HOSTED_WALLET;
  else process.env.PALMYR_SELF_HOSTED_WALLET = savedSelfHostedWallet;
});

beforeEach(() => {
  db.exec("DELETE FROM sms_messages; DELETE FROM phone_numbers;");
});

describe("POST /phone/numbers/:id/wait-otp", () => {
  it("returns a code from a message inserted MID-WAIT", async () => {
    insertNumber("pn-wait-1", IDENTITY);
    const pending = waitOtp("pn-wait-1", { timeout_s: 8 });
    // Land the OTP while the endpoint is already blocking (first poll missed).
    setTimeout(() => insertInbound("pn-wait-1", "Your verification code is 482913"), 300);
    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(res.body.found, true);
    assert.equal(res.body.code, "482913");
    assert.equal(res.body.message_text, "Your verification code is 482913");
    assert.ok(res.body.message_id, "message_id present");
    assert.ok(res.body.received_at, "received_at present");
  });

  it("lookback catches a code that arrived BEFORE the request", async () => {
    insertNumber("pn-wait-2", IDENTITY);
    insertInbound("pn-wait-2", "G-777888 is your Google verification code.", new Date(Date.now() - 5_000));
    const res = await waitOtp("pn-wait-2", { timeout_s: 5 });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, true);
    assert.equal(res.body.code, "G-777888");
  });

  it("the DEFAULT lookback (10s) does not re-serve a stale code from an earlier signup", async () => {
    insertNumber("pn-wait-2b", IDENTITY);
    // Signup #1's code arrived 20s ago; with the old 30s default this would
    // instantly (and wrongly) answer signup #2.
    insertInbound("pn-wait-2b", "Your verification code is 111333", new Date(Date.now() - 20_000));
    const res = await waitOtp("pn-wait-2b", { timeout_s: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, false);
  });

  it("a message OLDER than the lookback window does not match", async () => {
    insertNumber("pn-wait-3", IDENTITY);
    insertInbound("pn-wait-3", "Your verification code is 111222", new Date(Date.now() - 60_000));
    const res = await waitOtp("pn-wait-3", { timeout_s: 1, lookback_s: 5 });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, false);
    assert.equal(typeof res.body.waited_s, "number");
  });

  it("times out with 200 { found: false, waited_s } (not an error)", async () => {
    insertNumber("pn-wait-4", IDENTITY);
    const res = await waitOtp("pn-wait-4", { timeout_s: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, false);
    assert.ok(res.body.waited_s >= 1, `waited_s >= 1 (got ${res.body.waited_s})`);
  });

  it("ignores OUTBOUND messages even when they contain a code", async () => {
    insertNumber("pn-wait-5", IDENTITY);
    storage.pushSmsMessage("pn-wait-5", {
      id: "msg-out-1",
      phoneNumberId: "pn-wait-5",
      direction: "outbound",
      from: "+15550100000",
      to: "+15550009999",
      body: "Your verification code is 999000",
      timestamp: new Date().toISOString(),
    });
    const res = await waitOtp("pn-wait-5", { timeout_s: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, false);
  });

  it("custom pattern overrides the default extraction", async () => {
    insertNumber("pn-wait-6", IDENTITY);
    insertInbound("pn-wait-6", "Your PIN 55555 and ref 482913");
    const res = await waitOtp("pn-wait-6", { timeout_s: 3, pattern: "PIN (\\d{5})" });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, true);
    assert.equal(res.body.code, "55555");
  });

  it("rejects an invalid custom pattern with 400", async () => {
    insertNumber("pn-wait-7", IDENTITY);
    const res = await waitOtp("pn-wait-7", { timeout_s: 1, pattern: "(" });
    assert.equal(res.status, 400);
  });

  it("rejects an oversized pattern with 400 (handler path)", async () => {
    insertNumber("pn-wait-7b", IDENTITY);
    const res = await waitOtp("pn-wait-7b", { timeout_s: 1, pattern: "a".repeat(OTP_PATTERN_MAX_LENGTH + 1) });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /too long/i);
  });

  it("rejects an oversized pattern PRE-payment in the preflight (payment header present)", async () => {
    insertNumber("pn-wait-7c", IDENTITY);
    // A payment header engages the preflight, which must 400 BEFORE the
    // paywall settles — the caller keeps their USDC.
    const res = await waitOtp(
      "pn-wait-7c",
      { timeout_s: 1, pattern: "a".repeat(OTP_PATTERN_MAX_LENGTH + 1) },
      { "x-payment": "probe" },
    );
    assert.equal(res.status, 400);
    assert.match(String(res.body.hint), /NOT been charged/i);
  });

  it("a catastrophic custom pattern is dropped mid-wait: worker times out, extraction degrades to defaults, pattern_timeout reported", async () => {
    insertNumber("pn-wait-7d", IDENTITY);
    // (a+)+$ against a long a-run that fails at the end → exponential
    // backtracking, far beyond the 100ms worker budget. The same message also
    // carries a default-extractable code, proving graceful degradation.
    insertInbound("pn-wait-7d", "a".repeat(40) + "b your code is 482913");
    const res = await waitOtp("pn-wait-7d", { timeout_s: 8, pattern: "(a+)+$" });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, true);
    assert.equal(res.body.code, "482913");
    assert.equal(res.body.pattern_timeout, true);
  });

  it("waitForOtp stops polling when shouldAbort flips (client gone)", async () => {
    insertNumber("pn-wait-7e", IDENTITY);
    let gone = false;
    setTimeout(() => { gone = true; }, 300);
    const started = Date.now();
    const result = await waitForOtp("pn-wait-7e", {
      timeoutMs: 30_000,
      lookbackMs: 0,
      shouldAbort: () => gone,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.hit, null);
    assert.ok(elapsed < 10_000, `aborted early (took ${elapsed}ms, deadline was 30s)`);
  });

  it("403s on a number owned by another wallet", async () => {
    insertNumber("pn-wait-8", STRANGER);
    const res = await waitOtp("pn-wait-8", { timeout_s: 1 });
    assert.equal(res.status, 403);
  });

  it("404s on an unknown number id", async () => {
    const res = await waitOtp("pn-wait-nope", { timeout_s: 1 });
    assert.equal(res.status, 404);
  });
});
