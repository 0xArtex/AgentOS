/**
 * The top-level /market router, end to end over HTTP.
 *
 * Service-level tests (tiktok-marketplace.test.ts) prove the list/buy logic.
 * This proves the NEW router is mounted and wired: the public browse, the
 * pre-paywall validation, and a real buy that swaps ownership + attempts the
 * seller payout. Harness mirrors tiktok-deploy-route: self-hosted mode bypasses
 * requireAuth + the IPROYAL gate, a shim injects req.payment so a request acts
 * as a chosen wallet, and treasury keys are unset so the payout can't move money.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomBytes } from "crypto";

if (!process.env.POOL_ENCRYPTION_KEY) process.env.POOL_ENCRYPTION_KEY = randomBytes(32).toString("hex");

import { db, initDatabase } from "../db";
import marketRouter from "../routes/market";
import { registerAccount, markConnected, markRevealed, getAccount } from "../services/tiktok-accounts";
import { PaymentProof } from "../types";

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const SELLER = "0x" + "a".repeat(40);
const BUYER = "0x" + "b".repeat(40);
const CT = "ZQ"; // sentinel country isolates this test's listings
const TREASURY_ENV = ["TREASURY_SOL_PRIVATE_KEY", "SVM_PRIVATE_KEY", "TREASURY_EVM_PRIVATE_KEY"];

let server: any;
let port: number;
let savedSelfHosted: string | undefined;
let savedSelfHostedForce: string | undefined;
const savedTreasury: Record<string, string | undefined> = {};
let seq = 0;

function acct(): string { return "mktr" + randomBytes(4).toString("hex"); }
function seed(id: string, owner = SELLER): void {
  registerAccount({ id, owner, country: CT, proxySessionId: id });
  markConnected(id); // → active, listable
}

async function req(method: string, path: string, payer?: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (payer) { headers["x-test-payer"] = payer; headers["x-test-signature"] = `sig_mktr_${SUFFIX}_${++seq}`; }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = {};
  try { json = JSON.parse(await res.text()); } catch { /* empty */ }
  return { status: res.status, json };
}

before(async () => {
  initDatabase();
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1";
  for (const k of TREASURY_ENV) { savedTreasury[k] = process.env[k]; delete process.env[k]; }

  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => {
    const payer = r.headers["x-test-payer"];
    if (payer) {
      const payment: PaymentProof = {
        signature: String(r.headers["x-test-signature"]),
        payer: String(payer),
        amountLamports: BigInt(10_000),
        verifiedAt: Date.now(),
        chain: "solana",
      };
      (r as any).payment = payment;
    }
    next();
  });
  app.use("/market", marketRouter);
  await new Promise<void>((res) => { server = app.listen(0, "127.0.0.1", () => res()); });
  port = (server.address() as any).port;
});

after(async () => {
  if (savedSelfHosted === undefined) delete process.env.PALMYR_SELF_HOSTED; else process.env.PALMYR_SELF_HOSTED = savedSelfHosted;
  if (savedSelfHostedForce === undefined) delete process.env.PALMYR_SELF_HOSTED_FORCE; else process.env.PALMYR_SELF_HOSTED_FORCE = savedSelfHostedForce;
  for (const k of TREASURY_ENV) { if (savedTreasury[k] === undefined) delete process.env[k]; else process.env[k] = savedTreasury[k]; }
  db.prepare("DELETE FROM tiktok_accounts WHERE country = ?").run(CT);
  db.prepare("DELETE FROM refunds WHERE original_payment_signature LIKE ?").run(`sig_mktr_${SUFFIX}_%`);
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(() => { db.prepare("DELETE FROM tiktok_accounts WHERE country = ?").run(CT); });

describe("/market router", () => {
  it("GET /market/listings is public and shows a listed account", async () => {
    const id = acct();
    seed(id);
    const listed = await req("POST", "/market/list", SELLER, { platform: "tiktok", account_id: id, price_usdc: 7 });
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.equal(listed.json.listed, true);

    const browse = await req("GET", `/market/listings?platform=tiktok&country=${CT}`);
    assert.equal(browse.status, 200);
    assert.equal(browse.json.count, 1);
    assert.equal(browse.json.listings[0].account_id, id);
    assert.equal(browse.json.listings[0].platform, "tiktok");
  });

  it("POST /market/buy rejects a missing platform before charging", async () => {
    const r = await req("POST", "/market/buy", BUYER, { account_id: "whatever" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /platform required/i);
  });

  it("POST /market/buy 404s something that isn't listed", async () => {
    const r = await req("POST", "/market/buy", BUYER, { platform: "tiktok", account_id: "not-listed-xyz" });
    assert.equal(r.status, 404);
  });

  it("POST /market/buy swaps ownership and attempts the seller payout", async () => {
    const id = acct();
    seed(id);
    await req("POST", "/market/list", SELLER, { platform: "tiktok", account_id: id, price_usdc: 7 });

    const bought = await req("POST", "/market/buy", BUYER, { platform: "tiktok", account_id: id });
    assert.equal(bought.status, 200, JSON.stringify(bought.json));
    assert.equal(bought.json.bought, true);
    assert.equal(getAccount(id)?.owner, BUYER, "ownership transferred to the buyer");
    assert.ok(bought.json.seller_payout, "a seller payout was attempted");
    // Listing is cleared after the sale.
    const browse = await req("GET", `/market/listings?platform=tiktok&country=${CT}`);
    assert.equal(browse.json.count, 0);
  });

  it("won't list a revealed account", async () => {
    const id = acct();
    seed(id);
    markRevealed(id);
    const r = await req("POST", "/market/list", SELLER, { platform: "tiktok", account_id: id, price_usdc: 7 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /revealed/i);
  });

  it("rejects an unknown platform", async () => {
    const r = await req("POST", "/market/list", SELLER, { platform: "myspace", account_id: "x", price_usdc: 5 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not on the marketplace/i);
  });
});
