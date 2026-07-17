/**
 * Full agent-checkout chain — hermetic, local, NO real money, NO external
 * services. Proves the whole primitive stack a checkout flow leans on works
 * end-to-end in self-hosted single-operator mode:
 *
 *   1. a DISPOSABLE temp email inbox is provisioned (tmp-<hex>@<domain>),
 *   2. an order-confirmation email is DELIVERED to it via a forged-but-valid
 *      Mailgun inbound webhook (real HMAC signature) and stored encrypted,
 *   3. the owner READS it back through the paid read route as PLAINTEXT — this
 *      is the path Part A of this branch unblocks (the bare x402() read route
 *      now honors the self-hosted bypass, so a self-hoster can read their mail),
 *   4. a phone number receives an SMS OTP via a forged-but-valid Telnyx Ed25519
 *      webhook, and `wait-otp` extracts the code, and
 *   5. the /cards buy state machine returns 202 + poll_url + pricing and its
 *      poll reaches a terminal state (the real async worker, with the card
 *      issuer unreachable, fails definitively); the ready→PAN path is proven
 *      with a labeled in-process (dependency-injected) mock issuer.
 *
 * Hermeticity: self-hosted mode (PALMYR_SELF_HOSTED[_FORCE]=1) bypasses auth +
 * x402 so no on-chain payment is needed; the operator identity
 * (PALMYR_SELF_HOSTED_WALLET) owns every resource so the ownership checks
 * resolve. Mailgun/Telnyx are authenticated by signatures we forge with keys
 * the test holds. No real upstream is ever contacted: TELNYX_API_KEY /
 * MAILGUN_API_KEY are unset, and BASE_RPC + LASO_API_BASE point at a tiny
 * in-process fake server (a fake Base RPC that reports a fat USDC balance so no
 * funding transfer is attempted, and a fake card issuer that declines at the
 * probe so the buy fails without ever signing a payment). Data lives in an
 * isolated PALMYR_DATA_DIR. Booted on an ephemeral port over real HTTP.
 *
 * Every step console.logs a narrated transcript — that transcript is a
 * deliverable: reading the test output shows the temp address, the received
 * email, the decrypted plaintext, the extracted OTP, and the card state.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import nacl from "tweetnacl";
import { createHmac, randomBytes } from "node:crypto";
import type { PhoneNumber } from "../types";
import type { CardPurchaseDeps } from "../services/card-purchases";

// ── Fixtures + env (set BEFORE the app modules are require()'d in before(),
//    since db/config/services read env at module load). ──

const OPERATOR = "operator-e2e-wallet";
const EMAIL_DOMAIN = "palmyr.ai";
const MAILGUN_SIGNING_KEY = "e2e-mailgun-webhook-signing-key";
// One Ed25519 keypair stands in for Telnyx's signing key: the PUBLIC key goes in
// TELNYX_WEBHOOK_SECRET (what the server verifies against); the test holds the
// PRIVATE key and signs its forged webhooks with it.
const telnyxKp = nacl.sign.keyPair();
const TELNYX_PUBLIC_KEY_B64 = Buffer.from(telnyxKp.publicKey).toString("base64");
const E2E_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "palmyr-e2e-"));

process.env.PALMYR_DATA_DIR = E2E_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.PALMYR_SELF_HOSTED = "1";
process.env.PALMYR_SELF_HOSTED_FORCE = "1"; // engage regardless of NODE_ENV
process.env.PALMYR_SELF_HOSTED_WALLET = OPERATOR; // operator identity owns everything
process.env.EMAIL_DOMAIN = EMAIL_DOMAIN;
process.env.MAILGUN_WEBHOOK_SIGNING_KEY = MAILGUN_SIGNING_KEY;
process.env.TELNYX_WEBHOOK_SECRET = TELNYX_PUBLIC_KEY_B64;
delete process.env.TELNYX_API_KEY; // no real Telnyx
delete process.env.MAILGUN_API_KEY; // no real Mailgun (send stays unavailable)
// Cards: enable the feature (float key present) with generous ceilings so the
// small test purchases fit; the real upstreams are replaced by an in-process
// fake (BASE_RPC + LASO_API_BASE are pointed at it in before(), once its
// ephemeral port is known and BEFORE the app modules are required).
process.env.LASO_FLOAT_EVM_PRIVATE_KEY = "0x" + "11".repeat(32);
process.env.LASO_DAILY_MAX_USD = "1000";
process.env.LASO_AGENT_DAILY_MAX_USD = "500";
process.env.LASO_AGENT_DAILY_MAX_CARDS = "10";
process.env.LASO_CARD_FEE_PCT = "0.03";
process.env.LASO_CARD_FEE_MIN_USDC = "0.50";
process.env.LASO_MIN_CARD_USD = "5";
if (!process.env.SECRETS_MASTER_KEY) process.env.ALLOW_INSECURE_SECRETS_KEY = "1";

// App modules — assigned in before() AFTER the fake upstream is up so BASE_RPC /
// LASO_API_BASE captured at module load point at it (no real network).
let db: any;
let initDatabase: () => void;
let storage: any;
let emailService: any;
let emailRouter: any;
let phoneRouter: any;
let cardsRouter: any;
let createCardPurchase: (input: any, deps?: CardPurchaseDeps) => any;
let getCardPurchase: (id: string) => any;
let LasoDeclinedError: any;
let setFloatCache: (v: number) => void;
let resetCardWalletCaches: () => void;

// ── narration ──
const log = (...a: unknown[]) => console.log("[checkout-e2e]", ...a);
const banner = (n: string, t: string) => console.log(`\n[checkout-e2e] ═══ STEP ${n}: ${t} ═══`);

// ── HTTP client ──
let server: http.Server;
let port = 0;

function send(
  method: string,
  urlPath: string,
  opts: { json?: unknown; form?: Record<string, string>; raw?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers || {}) };
    let payload: string | undefined;
    if (opts.json !== undefined) {
      payload = JSON.stringify(opts.json);
      headers["content-type"] = "application/json";
    } else if (opts.form !== undefined) {
      payload = new URLSearchParams(opts.form).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (opts.raw !== undefined) {
      payload = opts.raw;
      headers["content-type"] = headers["content-type"] || "application/json";
    }
    if (payload !== undefined) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode || 0, json, text: buf });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// ── forged (but valid) upstream webhooks ──

// Mailgun inbound: HMAC-SHA256(timestamp + token, signing_key), hex.
function mailgunInboundForm(recipient: string, from: string, subject: string, bodyPlain: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = "tok-" + randomBytes(8).toString("hex");
  const signature = createHmac("sha256", MAILGUN_SIGNING_KEY).update(timestamp + token).digest("hex");
  return { timestamp, token, signature, recipient, sender: from, subject, "body-plain": bodyPlain };
}

// Telnyx inbound: Ed25519 detached signature over `${timestamp}|${rawBody}`.
function telnyxInboundSms(toNumber: string, fromNumber: string, text: string): { raw: string; headers: Record<string, string> } {
  const raw = JSON.stringify({
    data: {
      event_type: "message.received",
      payload: { from: { phone_number: fromNumber }, to: [{ phone_number: toNumber }], text },
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(`${timestamp}|${raw}`, "utf8")), telnyxKp.secretKey),
  ).toString("base64");
  return { raw, headers: { "telnyx-signature-ed25519": sig, "telnyx-timestamp": timestamp } };
}

// ── in-process fake upstream: fake Base RPC + fake card issuer ──
// One server answers BOTH BASE_RPC (JSON-RPC POST) and LASO_API_BASE (the card
// issuer, GET). The RPC reports a fat USDC balance so the card worker never
// attempts a funding transfer; the issuer declines every probe (non-402,
// nothing signed) so the buy fails DEFINITIVELY — "no reachable card issuer" —
// without any on-chain payment. Because the RPC answers eth_chainId, ethers
// detects the network and the provider goes idle (no infinite retry / block
// poller keeping the process alive).
function makeFakeUpstream(): http.Server {
  const FAT_BALANCE = "0x" + BigInt(1_000_000_000).toString(16).padStart(64, "0"); // 1000 USDC (6dp)
  return http.createServer((req, res) => {
    if (req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        let j: any = {};
        try { j = JSON.parse(b); } catch { /* */ }
        const batch = Array.isArray(j) ? j : [j];
        const out = batch.map((r: any) => {
          let result = "0x0";
          if (r?.method === "eth_chainId") result = "0x2105"; // Base 8453
          else if (r?.method === "eth_blockNumber") result = "0x1";
          else if (r?.method === "eth_call") result = FAT_BALANCE; // balanceOf → 1000 USDC ⇒ no funding transfer
          else if (r?.method === "net_version") result = "8453";
          return { jsonrpc: "2.0", id: r?.id ?? null, result };
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(j) ? out : out[0]));
      });
      return;
    }
    res.statusCode = 400; // card-issuer probe declines — definitive, nothing signed
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "e2e fake upstream: card issuer unavailable" }));
  });
}
let fakeUpstream: http.Server;

// ── labeled in-process mock Laso issuer (dependency-injected — no real issuer) ──
const MOCK_CARD = { card_number: "4111222233334444", exp_month: "12", exp_year: "2030", cvv: "456", available_balance: 5 };

function mockCardDeps(over: Partial<CardPurchaseDeps> = {}): CardPurchaseDeps {
  return {
    ensureFunded: async () => ({ address: "0xpayerMOCK", fundedUsdc: 0, fundingTx: null }),
    buyCard: async (_owner: string, amountUsd: number, onBeforePay: (i: any) => any) => {
      await onBeforePay({ nonce: "0x" + "ab".repeat(32), validBefore: Math.floor(Date.now() / 1000) + 600 });
      return { cardId: "laso-mock-card", status: "pending", usdAmount: amountUsd, lasoUserId: "0xuser", paidUsdc: amountUsd, raw: {} } as any;
    },
    getCardData: async (_owner: string, id: string) => ({ card_id: id, status: "ready", usd_amount: 5, card_details: MOCK_CARD } as any),
    listCards: async () => [],
    authorizationConsumed: async () => false,
    accountBalance: async () => 0,
    withdraw: async () => {},
    refund: async () => ({ ok: true, refundId: "REF-E2E-MOCK", refundTx: "0xrefund" } as any),
    refundDashboard: () => {},
    payerAddressFor: () => "0xpayerMOCK",
    pollIntervalMs: 5,
    pollBudgetMs: 800,
    ...over,
  };
}

async function waitForCardStatus(id: string, pred: (s: string) => boolean, budgetMs = 8000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const row = getCardPurchase(id);
    if (row && pred(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`card ${id} did not reach target status in ${budgetMs}ms (status=${getCardPurchase(id)?.status})`);
}

// ── suite ──

before(async () => {
  // Bring up the fake upstream first, then point BASE_RPC / LASO_API_BASE at it
  // BEFORE requiring the app so the module-load env captures resolve to it.
  fakeUpstream = makeFakeUpstream();
  await new Promise<void>((r) => fakeUpstream.listen(0, "127.0.0.1", () => r()));
  const fp = (fakeUpstream.address() as any).port;
  process.env.BASE_RPC = `http://127.0.0.1:${fp}`;
  process.env.LASO_API_BASE = `http://127.0.0.1:${fp}`;

  /* eslint-disable @typescript-eslint/no-var-requires */
  ({ db, initDatabase } = require("../db"));
  storage = require("../services/storage").storage;
  emailService = require("../services/email");
  emailRouter = require("../routes/email").default;
  phoneRouter = require("../routes/phone").default;
  cardsRouter = require("../routes/cards").default;
  ({ createCardPurchase, getCardPurchase } = require("../services/card-purchases"));
  ({ LasoDeclinedError } = require("../services/laso"));
  ({ _setFloatCacheForTest: setFloatCache, _resetCardWalletCachesForTest: resetCardWalletCaches } =
    require("../services/card-payer-wallets"));
  /* eslint-enable @typescript-eslint/no-var-requires */

  initDatabase();

  const app = express();
  // Capture byte-faithful rawBody so the Telnyx signature verifies against the
  // exact bytes (the webhook route's own express.raw is skipped once a body is
  // parsed). JSON only — the Mailgun inbound route parses its own urlencoded.
  app.use(express.json({ verify: (req: any, _res: unknown, buf: Buffer) => { req.rawBody = Buffer.from(buf); } }));
  app.use("/email", emailRouter);
  app.use("/phone", phoneRouter);
  app.use("/cards", cardsRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  port = (server.address() as any).port;
  log(`booted self-hosted app on 127.0.0.1:${port}; operator identity="${OPERATOR}"; fake upstream on :${fp}`);
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => fakeUpstream.close(() => r()));
  try { fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true }); } catch { /* best effort — db handle may hold the file on Windows */ }
});

describe("full agent-checkout chain (hermetic, self-hosted)", () => {
  let tempInboxId = "";
  let tempAddress = "";
  const ORDER_SUBJECT = "Your order #A1B2 is confirmed";
  const ORDER_BODY =
    "Hello,\n\nYour order #A1B2 is confirmed and will ship soon.\nOrder number: A1B2\nTotal: $42.00\n\nThanks for shopping with Palmyr Goods.";

  it("STEP 1 — provisions a disposable temp inbox (tmp-<hex>@domain + expires_at)", async () => {
    banner("1", "provision disposable temp inbox");
    const res = await send("POST", "/email/temp");
    assert.equal(res.status, 201, res.text);
    assert.ok(res.json.id, "temp inbox id");
    assert.match(String(res.json.address), new RegExp(`^tmp-[0-9a-f]{8}@${EMAIL_DOMAIN.replace(".", "\\.")}$`),
      `address ${res.json.address} must be tmp-<8 hex>@${EMAIL_DOMAIN}`);
    assert.ok(res.json.expires_at, "expires_at present (disposable)");
    // Owned by the self-hosted operator identity — the SAME identity the paid
    // read below authenticates as, which is exactly what makes the read pass.
    assert.equal(storage.getEmailInbox(res.json.id).owner, OPERATOR);
    tempInboxId = res.json.id;
    tempAddress = res.json.address;
    log(`temp address created: ${tempAddress}`);
    log(`  inbox id=${tempInboxId}  expires_at=${res.json.expires_at}  owner=${OPERATOR}`);
  });

  it("STEP 2 — receives an order-confirmation email via a valid Mailgun inbound webhook", async () => {
    banner("2", "deliver order-confirmation email (forged-but-valid Mailgun webhook)");
    const form = mailgunInboundForm(tempAddress, "orders@palmyr-goods.example", ORDER_SUBJECT, ORDER_BODY);
    const res = await send("POST", "/email/inbound", { form });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.received, true, "inbound accepted + stored");
    assert.ok(res.json.messageId, "stored message id");
    // Stored encrypted at rest: server-side AES ("s:" prefix), never plaintext.
    const rawRow = db.prepare("SELECT subject, body FROM email_messages WHERE inbox_id = ?").get(tempInboxId) as any;
    assert.ok(String(rawRow.subject).startsWith("s:"), "subject stored server-encrypted (s:)");
    assert.ok(String(rawRow.body).startsWith("s:"), "body stored server-encrypted (s:)");
    log(`email received at ${tempAddress}`);
    log(`  from=orders@palmyr-goods.example  subject="${ORDER_SUBJECT}"`);
    log(`  stored id=${res.json.messageId}  at-rest subject ciphertext="${String(rawRow.subject).slice(0, 16)}…" (encrypted)`);
  });

  it("STEP 3 — reads the email back as PLAINTEXT through the paid read route (Part A unblock)", async () => {
    banner("3", "read inbox as plaintext (GET /email/inboxes/:id/messages — self-hosted x402 bypass)");
    const res = await send("GET", `/email/inboxes/${tempInboxId}/messages`);
    assert.equal(res.status, 200, res.text); // 402 before Part A — a self-hoster couldn't read their own mail
    assert.equal(res.json.paidBy, OPERATOR, "payer resolved to the operator identity");
    assert.equal(res.json.messages.length, 1, "the one confirmation email");
    const msg = res.json.messages[0];
    // Decrypted to plaintext on read — NOT ciphertext, NOT an s:/w: prefix.
    assert.equal(msg.subject, ORDER_SUBJECT);
    assert.equal(msg.body, ORDER_BODY, "body must decrypt to the exact sent plaintext");
    assert.ok(!String(msg.body).startsWith("s:") && !String(msg.body).startsWith("w:"), "no ciphertext prefix leaks");
    assert.equal(msg.e2e, false, "server-side (non-E2E) inbox → decrypted server-side");
    log(`read back ${res.json.messages.length} message as plaintext (paidBy=${res.json.paidBy}):`);
    log(`  subject: ${msg.subject}`);
    log(`  body:    ${JSON.stringify(msg.body)}`);
  });

  it("STEP 4 — receives an SMS OTP via a valid Telnyx webhook and wait-otp extracts it", async () => {
    banner("4", "phone OTP (forged-but-valid Telnyx Ed25519 webhook → POST wait-otp)");
    const numberId = "pn-e2e-checkout";
    const phoneNumber = "+15550100777";
    const record: PhoneNumber = {
      id: numberId, phoneNumber, country: "US", owner: OPERATOR,
      provisionedAt: new Date().toISOString(), active: true, sharedWith: [],
    };
    storage.setPhoneNumber(numberId, record);
    log(`operator owns number ${phoneNumber} (id=${numberId})`);

    // Deliver the OTP SMS through the signed inbound webhook.
    const otp = telnyxInboundSms(phoneNumber, "+18885551212", "Your verification code is 483920");
    const wh = await send("POST", "/phone/webhooks/telnyx", { raw: otp.raw, headers: otp.headers });
    assert.equal(wh.status, 200, wh.text);
    log(`inbound SMS delivered via Telnyx webhook: "Your verification code is 483920"`);

    // wait-otp reads the just-arrived code (within the default lookback window).
    const res = await send("POST", `/phone/numbers/${numberId}/wait-otp`, { json: { timeout_s: 5 } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.found, true, "OTP found");
    assert.equal(res.json.code, "483920", "extracted code");
    assert.equal(res.json.message_text, "Your verification code is 483920");
    log(`wait-otp extracted code: ${res.json.code}  (message_id=${res.json.message_id})`);
  });

  it("STEP 5a — card buy → 202 + poll_url + pricing → poll reaches terminal 'failed'", async () => {
    banner("5a", "card buy state machine — live 202 + poll → terminal (real worker, fake upstream)");
    setFloatCache(10_000); // operator-float preflight passes deterministically
    const buy = await send("POST", "/cards/buy", { json: { amount: 5 } });
    assert.equal(buy.status, 202, buy.text);
    assert.ok(buy.json.operation_id, "operation_id");
    assert.match(String(buy.json.poll_url), /^\/cards\/operations\//, "poll_url");
    // pricing = amount + fee (fee = max(3%·5, $0.50) = $0.50).
    assert.equal(buy.json.pricing.card_usd, 5);
    assert.equal(buy.json.pricing.fee_usdc, 0.5);
    assert.equal(buy.json.pricing.charged_usdc, 5.5);
    log(`POST /cards/buy {amount:5} → 202 operation_id=${buy.json.operation_id}`);
    log(`  pricing: card_usd=${buy.json.pricing.card_usd} fee_usdc=${buy.json.pricing.fee_usdc} charged_usdc=${buy.json.pricing.charged_usdc}`);
    log(`  poll_url=${buy.json.poll_url}`);

    // The async worker has no reachable card issuer (fake declines the probe →
    // nothing signed → definitive failure). Poll until terminal.
    await waitForCardStatus(buy.json.operation_id, (s) => s === "failed");
    const poll = await send("GET", buy.json.poll_url);
    assert.equal(poll.status, 200, poll.text);
    assert.equal(poll.json.operation_id, buy.json.operation_id);
    assert.equal(poll.json.status, "failed");
    assert.equal(poll.json.done, true);
    log(`  poll → status="${poll.json.status}" done=${poll.json.done} error_code="${poll.json.error_code}"`);
    resetCardWalletCaches();
  });

  it("STEP 5b — the ready + PAN-retrieval path (labeled in-process mock issuer)", async () => {
    banner("5b", "card ready + PAN retrieval (labeled in-process mock issuer)");
    const job = createCardPurchase(
      { owner: OPERATOR, paymentSignature: "sig-ready", paymentChain: "base", chargedUsdc: 5.5, cardUsd: 5, feeUsdc: 0.5 },
      mockCardDeps(),
    );
    await waitForCardStatus(job.id, (s) => s === "ready");
    const detail = await send("GET", `/cards/${job.id}`); // owner-verified read as the operator identity
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.status, "ready");
    assert.equal(detail.json.card.card_number, MOCK_CARD.card_number, "PAN returned to the owner");
    assert.equal(detail.json.last4, "4444");
    log(`ready + PAN path proven (MOCK issuer — fake card): card_id=${job.id} last4=${detail.json.last4} exp=${detail.json.card.exp_month}/${detail.json.card.exp_year}`);
    log(`  NOTE: card issuance requires a real/mock Laso upstream — here proven with a labeled in-process mock;`);
    log(`  real issuance (real Visa PAN + on-chain auto-refund) was proven separately on prod 2026-07-09.`);
    log(`\n[checkout-e2e] ✔ full checkout chain proven locally: temp inbox → email → plaintext read → OTP → card buy state machine`);
  });
});
