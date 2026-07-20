/**
 * Security regression tests for src/routes/phone.ts:
 *
 *  1. Telnyx webhook signature verification (Ed25519 over `${timestamp}|${rawBody}`)
 *     on BOTH /phone/webhooks/telnyx and /phone/webhooks/voice:
 *       • valid signature  → processed (inbound SMS stored / call event applied)
 *       • forged signature → 401, side effect NOT applied
 *       • missing headers  → 401
 *       • stale timestamp  → 401 (replay window applied AFTER signature validity)
 *       • key not configured → 503 (FAIL CLOSED — never skip the check)
 *       • re-serialize fallback still verifies a legit compact payload
 *  2. Outbound call/transfer destination validation + toll-fraud policy:
 *       • malformed `to`            → 400 (pre-charge, "NOT been charged")
 *       • high-cost/premium prefix  → 403
 *       • normal US number          → accepted (reaches dial)
 *  3. Call-control access gate fails CLOSED for an untracked callControlId.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import nacl from "tweetnacl";

import { db, initDatabase } from "../db";
import { config } from "../config";
import { storage } from "../services/storage";
import * as phoneService from "../services/phone";
import phoneRouter from "../routes/phone";
import { PhoneNumber } from "../types";

const OWNER = "WALLEToooooooooooooooooooooooooooooooooooo";
const NUMBER = "+15550009999";

// One Ed25519 keypair stands in for Telnyx's signing key for the whole file.
const kp = nacl.sign.keyPair();
const PUBLIC_KEY_B64 = Buffer.from(kp.publicKey).toString("base64");

function telnyxSign(timestamp: string, rawBody: string): string {
  const msg = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
  return Buffer.from(nacl.sign.detached(new Uint8Array(msg), kp.secretKey)).toString("base64");
}

function nowSecs(deltaSecs = 0): string {
  return String(Math.floor(Date.now() / 1000) + deltaSecs);
}

function request(
  port: number,
  method: string,
  path: string,
  rawBody?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } },
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
    if (rawBody !== undefined) req.write(rawBody);
    req.end();
  });
}

function insertNumber(id: string): PhoneNumber {
  const record: PhoneNumber = {
    id,
    phoneNumber: NUMBER,
    country: "US",
    owner: OWNER,
    provisionedAt: new Date().toISOString(),
    active: true,
    sharedWith: [],
  };
  storage.setPhoneNumber(id, record);
  return record;
}

// App that captures the exact request bytes via an express.json `verify` hook —
// the recommended production wiring, exercising the byte-faithful rawBody path.
let hookServer: http.Server;
let hookPort = 0;
// App with a plain JSON parser (no rawBody capture) — exercises the safe
// re-serialization fallback.
let plainServer: http.Server;
let plainPort = 0;

let savedSecret: string;
let savedSelfHosted: string | undefined;
let savedSelfHostedForce: string | undefined;

before(async () => {
  initDatabase();
  savedSecret = config.telnyxWebhookSecret;
  (config as any).telnyxWebhookSecret = PUBLIC_KEY_B64;
  // Self-hosted bypasses requireAuth so call/transfer/hangup handlers are
  // reachable without on-chain payment (the destination + access checks under
  // test are independent of payment).
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1"; // engage even if NODE_ENV=production

  const hookApp = express();
  hookApp.use(express.json({ verify: (req: any, _res, buf: Buffer) => { req.rawBody = Buffer.from(buf); } }));
  hookApp.use("/phone", phoneRouter);
  hookServer = http.createServer(hookApp);
  await new Promise<void>((r) => hookServer.listen(0, () => r()));
  hookPort = (hookServer.address() as any).port;

  const plainApp = express();
  plainApp.use(express.json());
  plainApp.use("/phone", phoneRouter);
  plainServer = http.createServer(plainApp);
  await new Promise<void>((r) => plainServer.listen(0, () => r()));
  plainPort = (plainServer.address() as any).port;
});

after(async () => {
  (config as any).telnyxWebhookSecret = savedSecret;
  if (savedSelfHosted === undefined) delete process.env.PALMYR_SELF_HOSTED;
  else process.env.PALMYR_SELF_HOSTED = savedSelfHosted;
  if (savedSelfHostedForce === undefined) delete process.env.PALMYR_SELF_HOSTED_FORCE;
  else process.env.PALMYR_SELF_HOSTED_FORCE = savedSelfHostedForce;
  await new Promise<void>((r) => hookServer.close(() => r()));
  await new Promise<void>((r) => plainServer.close(() => r()));
});

beforeEach(() => {
  db.exec("DELETE FROM sms_messages; DELETE FROM phone_numbers;");
});

describe("Telnyx webhook signature verification — /webhooks/telnyx", () => {
  function inboundBody(text: string): string {
    return JSON.stringify({
      data: {
        event_type: "message.received",
        payload: { from: { phone_number: "+15551112222" }, to: [{ phone_number: NUMBER }], text },
      },
    });
  }

  it("accepts a valid signature and stores the inbound SMS", async () => {
    insertNumber("pn-wh-1");
    const ts = nowSecs();
    const body = inboundBody("your code is 654321");
    const res = await request(hookPort, "POST", "/phone/webhooks/telnyx", body, {
      "telnyx-signature-ed25519": telnyxSign(ts, body),
      "telnyx-timestamp": ts,
    });
    assert.equal(res.status, 200);
    const msgs = phoneService.getMessages("pn-wh-1", OWNER);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].body, "your code is 654321");
  });

  it("rejects a forged signature (401) and does NOT store the SMS", async () => {
    insertNumber("pn-wh-2");
    const ts = nowSecs();
    const body = inboundBody("fake OTP 000000 — attacker injected");
    // Sign the WRONG bytes so the signature does not match the posted body.
    const badSig = telnyxSign(ts, inboundBody("different"));
    const res = await request(hookPort, "POST", "/phone/webhooks/telnyx", body, {
      "telnyx-signature-ed25519": badSig,
      "telnyx-timestamp": ts,
    });
    assert.equal(res.status, 401);
    assert.equal(phoneService.getMessages("pn-wh-2", OWNER).length, 0);
  });

  it("rejects a missing signature/timestamp (401)", async () => {
    const body = inboundBody("no headers");
    const res = await request(hookPort, "POST", "/phone/webhooks/telnyx", body, {});
    assert.equal(res.status, 401);
  });

  it("rejects a stale timestamp even with a valid signature (401)", async () => {
    insertNumber("pn-wh-3");
    const ts = nowSecs(-600); // 10 minutes old, outside the 5-minute window
    const body = inboundBody("replayed");
    const res = await request(hookPort, "POST", "/phone/webhooks/telnyx", body, {
      "telnyx-signature-ed25519": telnyxSign(ts, body),
      "telnyx-timestamp": ts,
    });
    assert.equal(res.status, 401);
    assert.equal(phoneService.getMessages("pn-wh-3", OWNER).length, 0);
  });

  it("FAILS CLOSED with 503 when the public key is not configured", async () => {
    const saved = config.telnyxWebhookSecret;
    (config as any).telnyxWebhookSecret = "";
    try {
      const ts = nowSecs();
      const body = inboundBody("unconfigured");
      const res = await request(hookPort, "POST", "/phone/webhooks/telnyx", body, {
        "telnyx-signature-ed25519": telnyxSign(ts, body),
        "telnyx-timestamp": ts,
      });
      assert.equal(res.status, 503);
    } finally {
      (config as any).telnyxWebhookSecret = saved;
    }
  });

  it("verifies a legit compact payload via the re-serialization fallback (no verify hook)", async () => {
    insertNumber("pn-wh-4");
    const ts = nowSecs();
    const body = inboundBody("fallback path");
    const res = await request(plainPort, "POST", "/phone/webhooks/telnyx", body, {
      "telnyx-signature-ed25519": telnyxSign(ts, body),
      "telnyx-timestamp": ts,
    });
    assert.equal(res.status, 200);
    assert.equal(phoneService.getMessages("pn-wh-4", OWNER).length, 1);
  });

  // Real Telnyx payloads are NOT byte-identical to JSON.stringify(parsed)
  // (whitespace, key order, unicode escaping), so the re-serialize fallback
  // cannot reproduce the signed bytes. Production MUST capture rawBody via the
  // global json `verify` hook — without it every inbound SMS silently 401'd
  // (the index.ts bug these two tests guard against).
  function prettyInboundBody(text: string): string {
    return JSON.stringify({
      data: {
        event_type: "message.received",
        payload: { from: { phone_number: "+15551112222" }, to: [{ phone_number: NUMBER }], text },
      },
    }, null, 2); // pretty-printed → differs from the compact JSON.stringify(parsed)
  }

  it("stores a real-world (non-round-trippable) payload when rawBody is preserved (hook wiring)", async () => {
    insertNumber("pn-wh-raw-ok");
    const ts = nowSecs();
    const raw = prettyInboundBody("code 424242");
    assert.notEqual(raw, JSON.stringify(JSON.parse(raw)), "setup: raw bytes must differ from compact re-serialization");
    const res = await request(hookPort, "POST", "/phone/webhooks/telnyx", raw, {
      "telnyx-signature-ed25519": telnyxSign(ts, raw),
      "telnyx-timestamp": ts,
    });
    assert.equal(res.status, 200);
    const msgs = phoneService.getMessages("pn-wh-raw-ok", OWNER);
    assert.equal(msgs.length, 1, "hook wiring must store a real-world (pretty) payload");
    assert.equal(msgs[0].body, "code 424242");
  });

  it("DROPS the same real-world payload (401) under the plain re-serialize fallback — the production bug this guards", async () => {
    insertNumber("pn-wh-raw-drop");
    const ts = nowSecs();
    const raw = prettyInboundBody("code 424242");
    const res = await request(plainPort, "POST", "/phone/webhooks/telnyx", raw, {
      "telnyx-signature-ed25519": telnyxSign(ts, raw),
      "telnyx-timestamp": ts,
    });
    assert.equal(res.status, 401, "plain wiring cannot verify a non-round-trippable payload");
    assert.equal(phoneService.getMessages("pn-wh-raw-drop", OWNER).length, 0);
  });
});

describe("Telnyx webhook signature verification — /webhooks/voice", () => {
  function callBody(eventType: string, ccid: string): string {
    return JSON.stringify({ data: { event_type: eventType, payload: { call_control_id: ccid } } });
  }

  it("applies a valid-signature call.answered to the tracked call", async () => {
    const ccid = "ccid-voice-ok";
    storage.setCall("call-voice-1", {
      id: "call-voice-1", callControlId: ccid, callLegId: ccid, phoneNumberId: "pn-v1",
      from: NUMBER, to: "+15551110000", direction: "outbound", status: "ringing",
      startedAt: new Date().toISOString(),
    });
    const ts = nowSecs();
    const body = callBody("call.answered", ccid);
    const res = await request(hookPort, "POST", "/phone/webhooks/voice", body, {
      "telnyx-signature-ed25519": telnyxSign(ts, body),
      "telnyx-timestamp": ts,
    });
    assert.equal(res.status, 200);
    assert.equal(storage.getCallByControlId(ccid).status, "answered");
  });

  it("rejects a forged call event (401) and leaves call state untouched", async () => {
    const ccid = "ccid-voice-forge";
    storage.setCall("call-voice-2", {
      id: "call-voice-2", callControlId: ccid, callLegId: ccid, phoneNumberId: "pn-v2",
      from: NUMBER, to: "+15551110000", direction: "outbound", status: "answered",
      startedAt: new Date().toISOString(),
    });
    const ts = nowSecs();
    const body = callBody("call.hangup", ccid);
    const res = await request(hookPort, "POST", "/phone/webhooks/voice", body, {
      "telnyx-signature-ed25519": telnyxSign(ts, callBody("call.hangup", "other")),
      "telnyx-timestamp": ts,
    });
    assert.equal(res.status, 401);
    assert.equal(storage.getCallByControlId(ccid).status, "answered");
  });
});

describe("Outbound destination validation + toll-fraud policy", () => {
  it("preflight rejects a malformed destination pre-charge (400, not charged)", async () => {
    const res = await request(hookPort, "POST", "/phone/numbers/pn-x/call", JSON.stringify({ to: "not-e164" }), {
      "x-payment": "stub",
    });
    assert.equal(res.status, 400);
    assert.match(res.json.hint, /NOT been charged/i);
  });

  it("preflight rejects a high-cost / premium-rate destination (403, not charged)", async () => {
    const res = await request(hookPort, "POST", "/phone/numbers/pn-x/call", JSON.stringify({ to: "+8823214567" }), {
      "x-payment": "stub",
    });
    assert.equal(res.status, 403);
    assert.match(res.json.hint, /NOT been charged/i);
  });

  it("in-handler defense rejects a blocked destination (403) when no preflight ran", async () => {
    // No payment header → preflight is skipped; self-hosted lets the handler run.
    const res = await request(hookPort, "POST", "/phone/numbers/pn-x/call", JSON.stringify({ to: "+881234567890" }));
    assert.equal(res.status, 403);
    assert.equal(res.json.error, "Destination not allowed");
  });

  it("accepts a normal US destination (reaches dial, not a policy rejection)", async () => {
    const res = await request(hookPort, "POST", "/phone/numbers/no-such/call", JSON.stringify({ to: "+15551234567" }));
    // Destination passed validation; dial then fails on the missing number.
    assert.equal(res.status, 500);
    assert.equal(res.json.error, "Call Failed");
  });

  it("transfer preflight rejects a high-cost destination (403, not charged)", async () => {
    const res = await request(hookPort, "POST", "/phone/calls/ccid-any/transfer", JSON.stringify({ to: "+8823214567" }), {
      "x-payment": "stub",
    });
    assert.equal(res.status, 403);
    assert.match(res.json.hint, /NOT been charged/i);
  });
});

describe("Call-control access gate fails closed", () => {
  it("denies an untracked callControlId (403)", async () => {
    const res = await request(hookPort, "POST", "/phone/calls/ccid-unknown-xyz/hangup", JSON.stringify({}));
    assert.equal(res.status, 403);
    assert.equal(res.json.error, "Forbidden");
  });

  it("does NOT block a tracked call (reaches the provider call instead of 403)", async () => {
    const ccid = "ccid-tracked-hangup";
    storage.setCall("call-track-1", {
      id: "call-track-1", callControlId: ccid, callLegId: ccid, phoneNumberId: "pn-untracked",
      from: NUMBER, to: "+15551110000", direction: "outbound", status: "answered",
      startedAt: new Date().toISOString(),
    });
    const res = await request(hookPort, "POST", `/phone/calls/${ccid}/hangup`, JSON.stringify({}));
    assert.notEqual(res.status, 403);
  });
});
