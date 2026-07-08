/**
 * Laso provider client (services/laso.ts).
 *
 * Pins the auth ladder (cached token → refresh grant → SIWX wallet sign-in),
 * encryption-at-rest of the token cache, and the buy flow's error taxonomy
 * (definitive decline vs ambiguous-after-payment) that the card state machine
 * depends on. The SIWX test exercises the REAL @x402/extensions helper against
 * a faked Laso: challenge → EIP-191 signature → verified server-side with the
 * same package's verifier.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { db } from "../db";

// Env must be in place before the service module loads. The payer key is a
// deterministic zero-entropy test key (0x1111…11) — not a real secret.
process.env.LASO_PAYER_EVM_PRIVATE_KEY = process.env.LASO_PAYER_EVM_PRIVATE_KEY || "0x" + "11".repeat(32);
if (!process.env.SECRETS_MASTER_KEY) process.env.ALLOW_INSECURE_SECRETS_KEY = "1";

import {
  lasoEnabled,
  loadLasoPayer,
  persistTokens,
  readCachedTokens,
  getLasoIdToken,
  lasoBuyUsCard,
  lasoListCards,
  LasoDeclinedError,
  _resetLasoCachesForTest,
} from "../services/laso";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ethers: testEthers } = require("ethers");
const TEST_ADDR = new testEthers.Wallet(process.env.LASO_PAYER_EVM_PRIVATE_KEY!).address;
const LASO_REQ = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "20000000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};

function challenge402(): Response {
  const challenge = { x402Version: 2, accepts: [LASO_REQ], resource: { url: "https://laso.test/get-card" } };
  return new Response("{}", {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    },
  });
}

function json(status: number, body: any, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  db.prepare("DELETE FROM laso_account_tokens").run();
  _resetLasoCachesForTest();
});

test("payer wallet loads from env and gates the feature", () => {
  assert.strictEqual(lasoEnabled(), true);
  const w = loadLasoPayer();
  assert.strictEqual(w.address, TEST_ADDR);
});

test("token cache roundtrips and is ciphertext at rest", () => {
  persistTokens("id-token-1", "refresh-token-1");
  const raw = db.prepare("SELECT tokens_ciphertext FROM laso_account_tokens WHERE id = 1").get() as any;
  assert.ok(raw.tokens_ciphertext.startsWith("enc:v1:"));
  assert.ok(!raw.tokens_ciphertext.includes("id-token-1"));
  const tokens = readCachedTokens();
  assert.strictEqual(tokens!.id_token, "id-token-1");
  assert.strictEqual(tokens!.refresh_token, "refresh-token-1");
});

test("getLasoIdToken serves a fresh cached token without any network call", async () => {
  persistTokens("fresh-token", "refresh-1");
  const fetchImpl = (async () => {
    throw new Error("should not be called");
  }) as any;
  assert.strictEqual(await getLasoIdToken(fetchImpl), "fresh-token");
});

test("getLasoIdToken refreshes a stale token via the refresh_token grant", async () => {
  persistTokens("stale-token", "refresh-1");
  // Age the cache row past the staleness window.
  db.prepare("UPDATE laso_account_tokens SET obtained_at = ? WHERE id = 1").run(
    new Date(Date.now() - 60 * 60 * 1000).toISOString()
  );
  let refreshBody: any = null;
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.endsWith("/auth"));
    refreshBody = JSON.parse(String(init?.body));
    return json(200, { auth: { id_token: "new-id", refresh_token: "new-refresh", expires_in: "3600" } });
  }) as any;
  assert.strictEqual(await getLasoIdToken(fetchImpl), "new-id");
  assert.strictEqual(refreshBody.grant_type, "refresh_token");
  assert.strictEqual(refreshBody.refresh_token, "refresh-1");
  // New tokens persisted for the next caller.
  assert.strictEqual(readCachedTokens()!.id_token, "new-id");
});

test("getLasoIdToken falls back to SIWX sign-in when no cache exists (real helper, verified signature)", async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const siwx = require("@x402/extensions/sign-in-with-x");
  const siwxChallenge = {
    x402Version: 2,
    error: "auth required",
    accepts: [{ ...LASO_REQ, amount: "0" }],
    extensions: {
      "sign-in-with-x": {
        supportedChains: [{ chainId: "eip155:8453", type: "eip191" }],
        info: {
          domain: "laso.test",
          uri: "https://laso.test/auth",
          statement: "Sign in to Laso",
          version: "1",
          nonce: "abcdef12345678",
          issuedAt: new Date().toISOString(),
        },
      },
    },
  };
  let sawVerifiedSignIn = false;
  const fetchImpl = (async (input: any) => {
    const req = input instanceof Request ? input : new Request(String(input));
    const header = req.headers.get("sign-in-with-x");
    if (!header) {
      return new Response("{}", {
        status: 402,
        headers: {
          "content-type": "application/json",
          "payment-required": Buffer.from(JSON.stringify(siwxChallenge)).toString("base64"),
        },
      });
    }
    // Server side of the exchange: parse + cryptographically verify the proof
    // with the same package Laso uses.
    const payload = siwx.parseSIWxHeader(header);
    assert.strictEqual(payload.address.toLowerCase(), TEST_ADDR.toLowerCase());
    const verdict = await siwx.verifySIWxSignature(payload);
    assert.strictEqual(verdict.valid, true, `SIWX signature invalid: ${JSON.stringify(verdict)}`);
    sawVerifiedSignIn = true;
    return json(200, { auth: { id_token: "siwx-id", refresh_token: "siwx-refresh", expires_in: "3600" }, user_id: TEST_ADDR });
  }) as any;

  assert.strictEqual(await getLasoIdToken(fetchImpl), "siwx-id");
  assert.strictEqual(sawVerifiedSignIn, true);
  assert.strictEqual(readCachedTokens()!.id_token, "siwx-id");
});

test("lasoBuyUsCard pays the challenge, returns the card handle, persists tokens", async () => {
  const nonces: string[] = [];
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers as any);
    const payment = headers.get("x-payment");
    assert.ok(url.includes("/get-card?amount=20"));
    if (!payment) return challenge402();
    const decoded = JSON.parse(Buffer.from(payment, "base64").toString("utf8"));
    assert.strictEqual(decoded.payload.authorization.value, "20000000");
    return json(200, {
      auth: { id_token: "buy-id", refresh_token: "buy-refresh", expires_in: "3600" },
      user_id: TEST_ADDR.toLowerCase(),
      card: { card_id: "card_abc", usd_amount: 20, country: "US", status: "pending" },
    });
  }) as any;

  const out = await lasoBuyUsCard(20, (info) => {
    nonces.push(info.nonce);
  }, fetchImpl);
  assert.strictEqual(out.cardId, "card_abc");
  assert.strictEqual(out.status, "pending");
  assert.strictEqual(out.paidUsdc, 20);
  assert.strictEqual(out.nonce, nonces[0]);
  // Tokens from the paid response are cached for the poll loop.
  assert.strictEqual(readCachedTokens()!.id_token, "buy-id");
});

test("lasoBuyUsCard: probe-level 4xx (never paid) raises LasoDeclinedError", async () => {
  const fetchImpl = (async () => json(400, { error: "Amount must be at least $5. Received: $2" })) as any;
  await assert.rejects(
    lasoBuyUsCard(2, () => {}, fetchImpl),
    (e: any) => e instanceof LasoDeclinedError && e.httpStatus === 400
  );
});

test("lasoBuyUsCard: 402 AFTER payment is ambiguous and carries the nonce", async () => {
  let nonce = "";
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const headers = new Headers(init?.headers as any);
    if (!headers.get("x-payment")) return challenge402();
    return challenge402(); // payment rejected → fresh challenge
  }) as any;
  await assert.rejects(
    lasoBuyUsCard(20, (i) => {
      nonce = i.nonce;
    }, fetchImpl),
    (e: any) => e.ambiguous === true && e.nonce === nonce
  );
});

test("lasoBuyUsCard: upstream asking MORE than the card amount aborts before signing", async () => {
  const inflated = {
    x402Version: 2,
    accepts: [{ ...LASO_REQ, amount: "21000000" }], // asks $21 for a $20 card
  };
  let signed = 0;
  const fetchImpl = (async () =>
    new Response("{}", {
      status: 402,
      headers: {
        "content-type": "application/json",
        "payment-required": Buffer.from(JSON.stringify(inflated)).toString("base64"),
      },
    })) as any;
  await assert.rejects(
    lasoBuyUsCard(20, () => {
      signed++;
    }, fetchImpl),
    /exceeds the ceiling/
  );
  assert.strictEqual(signed, 0);
});

test("lasoListCards normalizes list and single-card shapes", async () => {
  const listImpl = (async () => json(200, { cards: [{ card_id: "a", status: "ready" }] })) as any;
  const cards = await lasoListCards("tok", listImpl);
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].card_id, "a");

  const authRejected = (async () => json(401, { error: "expired" })) as any;
  await assert.rejects(lasoListCards("tok", authRejected), /laso_auth_rejected:401/);
});
