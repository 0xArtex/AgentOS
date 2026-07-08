/**
 * Outbound x402 client (services/x402-client.ts).
 *
 * Money-critical: this module signs payments FROM a server-held wallet. These
 * tests pin the wire format (v2 header challenges, full-requirement echo in
 * the payload — the CDP facilitator rejects stubs), the spend ceiling (abort
 * BEFORE signing), the nonce-persistence hook ordering, and the
 * same-header-on-retry rule that makes transient failures double-pay-proof.
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  parse402,
  pickEvmRequirement,
  buildEvmAuthorization,
  encodeXPayment,
  paidFetch,
  SpendCeilingError,
  authorizationConsumed,
  baseUsdcBalance,
  BASE_USDC,
  PaymentRequirement,
} from "../services/x402-client";

// Deterministic zero-entropy test key (0x1111…11) — obviously not a real
// secret, never holds funds, and can't trip secret scanners.
const TEST_PK = "0x" + "11".repeat(32);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ethers } = require("ethers");
const wallet = new ethers.Wallet(TEST_PK);
const TEST_ADDR = wallet.address;

// The Base entry of Laso's live challenge (captured 2026-07-08 from
// GET https://laso.finance/get-card?amount=20 — public data).
const LASO_REQ: PaymentRequirement = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "20000000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};

const LASO_CHALLENGE = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://laso.finance/get-card?amount=20",
    description: "Get a prepaid card for use inside the United States",
    mimeType: "text/html",
  },
  accepts: [
    LASO_REQ,
    {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "20000000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "3MZVk97x9SeRxbYpc3jhzRfU2fyA3emYutnqfn9kNfYX",
      maxTimeoutSeconds: 300,
      extra: { feePayer: "D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM" },
    },
  ],
};

function headerChallengeResponse(challenge: any = LASO_CHALLENGE): Response {
  return new Response("{}", {
    status: 402,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    },
  });
}

test("parse402 decodes a v2 PAYMENT-REQUIRED header challenge (Laso style)", () => {
  const res = headerChallengeResponse();
  const parsed = parse402(res.headers, {});
  assert.ok(parsed);
  assert.strictEqual(parsed!.x402Version, 2);
  assert.strictEqual(parsed!.accepts.length, 2);
  const evm = pickEvmRequirement(parsed!);
  assert.ok(evm);
  assert.strictEqual(evm!.amount, "20000000");
  assert.strictEqual(evm!.payTo, "0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37");
  assert.strictEqual(parsed!.resource.url, "https://laso.finance/get-card?amount=20");
});

test("parse402 falls back to a JSON body challenge (our server's style)", () => {
  const res = new Response(JSON.stringify(LASO_CHALLENGE), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
  const parsed = parse402(res.headers, LASO_CHALLENGE);
  assert.ok(parsed);
  assert.strictEqual(pickEvmRequirement(parsed!)!.amount, "20000000");
});

test("parse402 returns null when no challenge is present", () => {
  const res = new Response("{}", { status: 402, headers: { "content-type": "application/json" } });
  assert.strictEqual(parse402(res.headers, {}), null);
});

test("buildEvmAuthorization signs a recoverable EIP-3009 authorization", async () => {
  const signed = await buildEvmAuthorization(wallet, LASO_REQ, 600);
  assert.strictEqual(signed.payer, TEST_ADDR);
  assert.match(signed.nonce, /^0x[0-9a-f]{64}$/);
  assert.strictEqual(signed.authorization.value, "20000000");
  assert.strictEqual(
    signed.authorization.to.toLowerCase(),
    "0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37".toLowerCase()
  );
  const now = Math.floor(Date.now() / 1000);
  assert.ok(signed.validBefore > now + 500 && signed.validBefore <= now + 601);

  // The signature must recover to the payer under the exact domain the
  // facilitator verifies (Circle USDC v2 on Base).
  const domain = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: LASO_REQ.asset };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const recovered = ethers.verifyTypedData(domain, types, signed.authorization, signed.signature);
  assert.strictEqual(recovered, TEST_ADDR);
});

test("encodeXPayment echoes the FULL requirement + resource in a v2 payload", async () => {
  const signed = await buildEvmAuthorization(wallet, LASO_REQ);
  const encoded = encodeXPayment(signed, LASO_REQ, LASO_CHALLENGE.resource, undefined);
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.strictEqual(decoded.x402Version, 2);
  assert.deepStrictEqual(decoded.accepted, LASO_REQ); // stubbing this breaks CDP verification
  assert.deepStrictEqual(decoded.resource, LASO_CHALLENGE.resource);
  assert.strictEqual(decoded.payload.signature, signed.signature);
  assert.deepStrictEqual(decoded.payload.authorization, signed.authorization);
});

test("paidFetch returns non-402 probe responses as-is without paying", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ hello: 1 }), { status: 200, headers: { "content-type": "application/json" } })) as any;
  const out = await paidFetch("https://x.test/free", { wallet, maxUsdc: 1, fetchImpl });
  assert.strictEqual(out.paid, false);
  assert.strictEqual(out.data.hello, 1);
});

test("paidFetch enforces the spend ceiling BEFORE signing", async () => {
  let beforePayCalls = 0;
  const fetchImpl = (async () => headerChallengeResponse()) as any;
  await assert.rejects(
    paidFetch("https://x.test/get-card", {
      wallet,
      maxUsdc: 19.99, // challenge asks 20.00
      fetchImpl,
      onBeforePay: () => {
        beforePayCalls++;
      },
    }),
    (e: any) => e instanceof SpendCeilingError
  );
  assert.strictEqual(beforePayCalls, 0);
});

test("paidFetch pays a header-challenge 402 and surfaces the settle receipt", async () => {
  const calls: Array<{ url: string; payment: string | null }> = [];
  const events: string[] = [];
  const receipt = { success: true, transaction: "0xsettletx", network: "eip155:8453" };
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers as any);
    // v2 servers read ONLY payment-signature (x-payment is the v1 name) —
    // this stub reads the v2 header and ALSO asserts both are sent equal.
    const payment = headers.get("payment-signature");
    calls.push({ url, payment });
    events.push(payment ? "paid-request" : "probe");
    if (!payment) return headerChallengeResponse();
    assert.strictEqual(headers.get("x-payment"), payment); // v1 alias carried too
    // Verify the paid retry carries a decodable, spec-shaped payload.
    const decoded = JSON.parse(Buffer.from(payment, "base64").toString("utf8"));
    assert.strictEqual(decoded.x402Version, 2);
    assert.deepStrictEqual(decoded.accepted, LASO_REQ);
    return new Response(JSON.stringify({ card: { card_id: "card_1", status: "pending" } }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "payment-response": Buffer.from(JSON.stringify(receipt)).toString("base64"),
      },
    });
  }) as any;

  const out = await paidFetch("https://x.test/get-card?amount=20", {
    wallet,
    maxUsdc: 20.01,
    fetchImpl,
    onBeforePay: (info) => {
      events.push("before-pay");
      assert.match(info.nonce, /^0x[0-9a-f]{64}$/);
      assert.strictEqual(info.amountUsdc, 20);
      assert.strictEqual(info.payer, TEST_ADDR);
    },
  });
  assert.strictEqual(out.paid, true);
  assert.strictEqual(out.paidUsdc, 20);
  assert.strictEqual(out.data.card.card_id, "card_1");
  assert.deepStrictEqual(out.receipt, receipt);
  // Hook ordering: nonce persisted BEFORE the paid request went out.
  assert.deepStrictEqual(events, ["probe", "before-pay", "paid-request"]);
  assert.strictEqual(calls.length, 2);
});

test("paidFetch retries a transient network failure with the IDENTICAL header (never re-signs)", async () => {
  const paymentsSeen: string[] = [];
  let beforePayCalls = 0;
  let paidAttempts = 0;
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const headers = new Headers(init?.headers as any);
    const payment = headers.get("x-payment");
    if (!payment) return headerChallengeResponse();
    paymentsSeen.push(payment);
    paidAttempts++;
    if (paidAttempts === 1) throw new Error("socket hang up");
    return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;

  const out = await paidFetch("https://x.test/get-card", {
    wallet,
    maxUsdc: 25,
    fetchImpl,
    onBeforePay: () => {
      beforePayCalls++;
    },
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(beforePayCalls, 1); // signed exactly once
  assert.strictEqual(paymentsSeen.length, 2);
  assert.strictEqual(paymentsSeen[0], paymentsSeen[1]); // same nonce, idempotent replay
});

test("paidFetch marks a total post-signing failure as ambiguous with the nonce attached", async () => {
  let nonceFromHook = "";
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const headers = new Headers(init?.headers as any);
    if (!headers.get("x-payment")) return headerChallengeResponse();
    throw new Error("connection reset");
  }) as any;

  await assert.rejects(
    paidFetch("https://x.test/get-card", {
      wallet,
      maxUsdc: 25,
      fetchImpl,
      onBeforePay: (i) => {
        nonceFromHook = i.nonce;
      },
    }),
    (e: any) => {
      assert.strictEqual(e.ambiguous, true);
      assert.strictEqual(e.nonce, nonceFromHook);
      assert.ok(e.validBefore > 0);
      return true;
    }
  );
});

test("authorizationConsumed / baseUsdcBalance decode eth_call results via an injected provider", async () => {
  // authorizationState → true
  const providerTrue = {
    async call(tx: { to: string; data: string }) {
      assert.strictEqual(tx.to, BASE_USDC);
      return "0x" + "0".repeat(63) + "1";
    },
  };
  assert.strictEqual(await authorizationConsumed(TEST_ADDR, "0x" + "11".repeat(32), providerTrue), true);

  // balanceOf → 123.45 USDC
  const providerBal = {
    async call() {
      return "0x" + BigInt(123_450_000).toString(16).padStart(64, "0");
    },
  };
  assert.strictEqual(await baseUsdcBalance(TEST_ADDR, providerBal), 123.45);
});
