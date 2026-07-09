/**
 * /cards/buy pre-paywall gate (routes/cards.ts requireCardPayment).
 *
 * Everything asserted here happens BEFORE any x402 settlement — the whole
 * point of the preflight is that a caller is never charged for an order that
 * can't proceed (bad amount, feature off, issuance ceilings, payer float).
 * requireAuth/x402 itself is out of scope (covered by its own suites); these
 * tests only walk paths that return before it.
 */
process.env.LASO_DAILY_MAX_USD = "100";
process.env.LASO_AGENT_DAILY_MAX_USD = "50";
process.env.LASO_AGENT_DAILY_MAX_CARDS = "3";
process.env.LASO_CARD_FEE_PCT = "0.03";
process.env.LASO_CARD_FEE_MIN_USDC = "0.50";
process.env.LASO_FLOAT_EVM_PRIVATE_KEY = process.env.LASO_FLOAT_EVM_PRIVATE_KEY || "0x" + "11".repeat(32);
if (!process.env.SECRETS_MASTER_KEY) process.env.ALLOW_INSECURE_SECRETS_KEY = "1";

import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { randomUUID } from "crypto";
import { db } from "../db";
import { requireCardPayment } from "../routes/cards";
import { send402Response } from "../middleware/x402";
import { _resetCardWalletCachesForTest, _setFloatCacheForTest } from "../services/card-payer-wallets";

const PAYER = "0x2222222222222222222222222222222222222222";
const FLOAT_KEY = process.env.LASO_FLOAT_EVM_PRIVATE_KEY!;

function mockReq(over: any = {}): any {
  return { headers: {}, body: {}, method: "POST", originalUrl: "/cards/buy", ...over };
}

function mockRes(): any {
  const r: any = { statusCode: 200, headersSent: false, headers: {}, body: undefined, locals: {} };
  r.setHeader = (k: string, v: string) => {
    r.headers[k.toLowerCase()] = v;
  };
  r.status = (c: number) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b: any) => {
    r.body = b;
    return r;
  };
  return r;
}

function evmPaymentHeader(from: string): string {
  return Buffer.from(JSON.stringify({ x402Version: 2, payload: { authorization: { from } } })).toString("base64");
}

function insertUsage(owner: string, cardUsd: number, status = "ready"): void {
  db.prepare(
    `INSERT INTO card_purchases (id, owner, card_usd, fee_usdc, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), owner, cardUsd, 0.5, status, new Date().toISOString());
}

beforeEach(() => {
  db.prepare("DELETE FROM card_purchases").run();
  process.env.LASO_FLOAT_EVM_PRIVATE_KEY = FLOAT_KEY;
  _resetCardWalletCachesForTest();
  _setFloatCacheForTest(10_000); // float never blocks unless a test lowers it
});

test("feature disabled → 503 cards_disabled, wallet not charged", async () => {
  delete process.env.LASO_FLOAT_EVM_PRIVATE_KEY;
  delete process.env.LASO_PAYER_EVM_PRIVATE_KEY; // legacy fallback must be absent too
  _resetCardWalletCachesForTest();
  const res = mockRes();
  let nextCalled = false;
  await requireCardPayment(mockReq({ body: { amount: 20 } }), res, () => {
    nextCalled = true;
  });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.error_code, "cards_disabled");
  assert.match(res.body.hint, /NOT been charged/);
  assert.strictEqual(nextCalled, false);
});

test("invalid amounts → 400 invalid_amount before any paywall", async () => {
  for (const amount of [0, 4.99, 1000.01, 5.001, "twenty", null]) {
    const res = mockRes();
    let nextCalled = false;
    await requireCardPayment(mockReq({ body: { amount } }), res, () => {
      nextCalled = true;
    });
    assert.strictEqual(res.statusCode, 400, `amount ${amount} should 400`);
    assert.strictEqual(res.body.error_code, "invalid_amount");
    assert.strictEqual(nextCalled, false);
  }
});

test("global 24h ceiling → 429 daily_global with Retry-After, even for anonymous probes", async () => {
  insertUsage("someone-else", 95);
  const res = mockRes();
  let nextCalled = false;
  await requireCardPayment(mockReq({ body: { amount: 20 } }), res, () => {
    nextCalled = true;
  });
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(res.body.error_code, "daily_global");
  assert.strictEqual(res.headers["retry-after"], "3600");
  assert.match(res.body.hint, /NOT been charged/);
  assert.strictEqual(nextCalled, false);
});

test("per-agent 24h ceiling → 429 daily_agent for the CLAIMED payer on the paid retry", async () => {
  insertUsage(PAYER, 45); // 45/50 used by this wallet
  const res = mockRes();
  let nextCalled = false;
  await requireCardPayment(
    mockReq({ body: { amount: 10 }, headers: { "x-payment": evmPaymentHeader(PAYER) } }),
    res,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(res.body.error_code, "daily_agent");
  assert.strictEqual(res.body.used_usd, 45);
  assert.strictEqual(res.body.limit_usd, 50);
  assert.strictEqual(nextCalled, false);
});

test("per-agent card COUNT cap (issuer 6/day; 3 here) → 429 daily_agent_cards for the claimed payer", async () => {
  for (let i = 0; i < 3; i++) insertUsage(PAYER, 5); // 3 cards, only $15 — dollars nowhere near the cap
  const res = mockRes();
  let nextCalled = false;
  await requireCardPayment(
    mockReq({ body: { amount: 5 }, headers: { "x-payment": evmPaymentHeader(PAYER) } }),
    res,
    () => {
      nextCalled = true;
    }
  );
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(res.body.error_code, "daily_agent_cards");
  assert.strictEqual(res.body.used_cards, 3);
  assert.strictEqual(res.body.limit_cards, 3);
  assert.strictEqual(nextCalled, false);
});

test("another wallet's usage does not trip a clean payer's per-agent cap", async () => {
  insertUsage("0x3333333333333333333333333333333333333333", 45);
  // Global is 45/100, agent is 0/50 → preflight passes and hands off to the
  // paywall; we stop the test at the hand-off by lowering the float instead
  // (issuer_float_low fires AFTER the limit checks, BEFORE requireAuth).
  _setFloatCacheForTest(5);
  const res = mockRes();
  await requireCardPayment(
    mockReq({ body: { amount: 10 }, headers: { "x-payment": evmPaymentHeader(PAYER) } }),
    res,
    () => {}
  );
  // Reaching the float gate proves both ceilings passed.
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.error_code, "issuer_float_low");
});

test("payer float below the card amount → 503 issuer_float_low, wallet not charged", async () => {
  _setFloatCacheForTest(15);
  const res = mockRes();
  let nextCalled = false;
  await requireCardPayment(mockReq({ body: { amount: 20 } }), res, () => {
    nextCalled = true;
  });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.error_code, "issuer_float_low");
  assert.strictEqual(res.headers["retry-after"], "300");
  assert.match(res.body.hint, /NOT been charged/);
  assert.strictEqual(nextCalled, false);
});

test("failed rows do not consume the window at the route gate either", async () => {
  insertUsage("someone-else", 95, "failed");
  _setFloatCacheForTest(5); // stop at the float gate = both ceilings passed
  const res = mockRes();
  await requireCardPayment(mockReq({ body: { amount: 20 } }), res, () => {});
  assert.strictEqual(res.body.error_code, "issuer_float_low");
});

// ─── Bazaar settlement-registration suppression ───
// The CDP facilitator registers the CONCRETE resource URL of every settled
// Base payment using the challenge's bazaar extension. Per-id routes must
// carry discoverable:false there, or each caller's real card UUID becomes its
// own public explorer entry (the /compute delete-server failure mode).

function challengeFor(metadata: any, url: string, routePath?: string): any {
  const res = mockRes();
  const req = mockReq({ method: "GET", originalUrl: url });
  req.get = (h: string) => (h.toLowerCase() === "host" ? "palmyr.ai" : undefined);
  if (routePath) req.route = { path: routePath };
  send402Response(res, req, 0.01, "pay up", metadata);
  return res.body;
}

test("402 challenges honor metadata.discoverable=false in the bazaar extension", () => {
  const hidden = challengeFor({ description: "d", discoverable: false }, "/cards/some-uuid");
  assert.strictEqual(hidden.extensions.bazaar.discoverable, false);
  const listed = challengeFor({ description: "d" }, "/cards/buy");
  assert.strictEqual(listed.extensions.bazaar.discoverable, true);
});

test("parameterized routes auto-suppress settlement registration — no per-route flag needed", () => {
  // Any route whose matched Express path carries a param: phone sends, compute
  // exec/delete, DNS, … Their settles' concrete URLs must never index.
  for (const routePath of ["/numbers/:id/send", "/servers/:id", "/:domain/dns", "/accounts/:id/*"]) {
    const c = challengeFor({ description: "d" }, "/whatever/8f3a-real-id/send", routePath);
    assert.strictEqual(c.extensions.bazaar.discoverable, false, `route ${routePath} should suppress`);
  }
  // Static routes keep their stable single Bazaar entry.
  const stat = challengeFor({ description: "d" }, "/phone/numbers", "/numbers");
  assert.strictEqual(stat.extensions.bazaar.discoverable, true);
  // Explicit metadata opt-out still wins on static paths too.
  const optOut = challengeFor({ description: "d", discoverable: false }, "/phone/numbers", "/numbers");
  assert.strictEqual(optOut.extensions.bazaar.discoverable, false);
});

test("the per-id card read advertises discoverable:false on its live 402", async () => {
  // Unpaid probe of GET /cards/:id goes through requireAuth's 402 path with
  // the route's metadata — assert the wire carries the suppression flag.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cardsRouter = require("../routes/cards").default;
  const layer = cardsRouter.stack.find(
    (l: any) => l.route?.path === "/:id" && l.route?.methods?.get
  );
  assert.ok(layer, "GET /cards/:id route exists");
  const authLayer = layer.route.stack[0];
  assert.strictEqual(authLayer.handle._x402Metadata?.discoverable, false);
});
