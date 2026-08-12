/**
 * The one-click deploy route, end to end over HTTP.
 *
 * The pool unit tests prove leaseFromPool swaps ownership atomically. They do
 * NOT prove the route consults it, binds the payer as owner, and — crucially —
 * makes the caller whole when it can't deliver. requireAuth settles payment
 * BEFORE the handler runs, so a no-stock or bad-input rejection means the caller
 * already paid; answering with a bare 4xx would bill for an account never handed
 * over. This pins that the deploy path either delivers an owned account or
 * refunds, and that a pre-lease validation miss never burns a pool account.
 *
 * Harness mirrors tiktok-ownership-route: self-hosted mode bypasses requireAuth
 * and the IPROYAL gate, and a shim injects a full req.payment so each request
 * acts as a chosen wallet AND can be refunded like a real settlement. Deploys
 * here pass no name/bio/photo on purpose, so the async rebrand op (a real
 * browser) never fires — the lease and money behaviour are what's under test.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, initDatabase } from "../db";
import socialRouter from "../routes/social";
import { registerPoolAccount, markConnected, getAccount, poolStock, POOL_OWNER } from "../services/tiktok-accounts";
import { PaymentProof } from "../types";

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const BUYER = `0xBUYER_deploy_${SUFFIX}`;
const SETTLED_USDC = 0.01; // what the shim pretends requireAuth settled
const TREASURY_ENV = ["TREASURY_SOL_PRIVATE_KEY", "SVM_PRIVATE_KEY", "TREASURY_EVM_PRIVATE_KEY"];

let server: any;
let port: number;
let savedSelfHosted: string | undefined;
let savedSelfHostedForce: string | undefined;
const savedTreasury: Record<string, string | undefined> = {};
let paymentSeq = 0;

function nextSignature(): string {
  return `sig_deploy_${SUFFIX}_${++paymentSeq}`;
}

async function post(path: string, payer: string, body: unknown): Promise<{ status: number; json: any; signature: string }> {
  const signature = nextSignature();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-payer": payer, "x-test-signature": signature },
    body: JSON.stringify(body),
  });
  let json: any = {};
  try { json = JSON.parse(await res.text()); } catch { json = {}; }
  return { status: res.status, json, signature };
}

async function getPublic(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  let json: any = {};
  try { json = JSON.parse(await res.text()); } catch { json = {}; }
  return { status: res.status, json };
}

function assertRefunded(r: { json: any; signature: string }, payer: string, endpoint: string): void {
  assert.equal(r.json.refund?.chain, "solana", `${endpoint} must report the refund back to the caller`);
  assert.equal(r.json.refund?.amount_usdc, SETTLED_USDC, "the whole settled amount goes back");
  const row = db.prepare(
    "SELECT payer, chain, amount_usdc, endpoint FROM refunds WHERE original_payment_signature = ?"
  ).get(r.signature) as any;
  assert.ok(row, `${endpoint} must go through the refund path, not answer with a bare rejection`);
  assert.equal(row.payer, payer, "the refund is owed to whoever paid");
  assert.equal(row.endpoint, endpoint);
}

function clearPool(): void {
  db.prepare("DELETE FROM tiktok_accounts WHERE owner = ?").run(POOL_OWNER);
}
function seedReady(id: string, country: string): void {
  db.prepare("DELETE FROM tiktok_accounts WHERE id = ?").run(id);
  registerPoolAccount({ id, country, proxySessionId: id });
  markConnected(id); // a completed QR scan → active → deliverable
}

before(async () => {
  initDatabase();
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1";
  for (const k of TREASURY_ENV) {
    savedTreasury[k] = process.env[k];
    delete process.env[k]; // the refund path is real; unset keys so it can't move money
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const payer = req.headers["x-test-payer"];
    if (payer) {
      const payment: PaymentProof = {
        signature: String(req.headers["x-test-signature"] || nextSignature()),
        payer: String(payer),
        amountLamports: BigInt(Math.round(SETTLED_USDC * 1e6)),
        verifiedAt: Date.now(),
        chain: "solana",
      };
      (req as any).payment = payment;
    }
    next();
  });
  app.use("/social", socialRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  port = (server.address() as any).port;
});

after(async () => {
  if (savedSelfHosted === undefined) delete process.env.PALMYR_SELF_HOSTED; else process.env.PALMYR_SELF_HOSTED = savedSelfHosted;
  if (savedSelfHostedForce === undefined) delete process.env.PALMYR_SELF_HOSTED_FORCE; else process.env.PALMYR_SELF_HOSTED_FORCE = savedSelfHostedForce;
  for (const k of TREASURY_ENV) {
    if (savedTreasury[k] === undefined) delete process.env[k]; else process.env[k] = savedTreasury[k];
  }
  clearPool();
  db.prepare("DELETE FROM tiktok_accounts WHERE owner = ?").run(BUYER);
  db.prepare("DELETE FROM refunds WHERE original_payment_signature LIKE ?").run(`sig_deploy_${SUFFIX}_%`);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  clearPool();
  db.prepare("DELETE FROM tiktok_accounts WHERE owner = ?").run(BUYER);
});

describe("POST /social/tiktok/deploy", () => {
  it("hands a ready pool account to the payer and binds ownership", async () => {
    const id = `dep_ok_${SUFFIX}`;
    seedReady(id, "us");
    assert.equal(poolStock().total, 1, "the seeded account is ready stock");

    const r = await post("/social/tiktok/deploy", BUYER, {});
    assert.equal(r.status, 202);
    assert.equal(r.json.deployed, true);
    assert.equal(r.json.account_id, id, "the payer gets the account that was in the pool");
    assert.equal(r.json.owner, BUYER);
    assert.equal(r.json.rebrand, null, "no name/bio/photo passed → no rebrand op fired");
    assert.equal(getAccount(id)!.owner, BUYER, "ownership transferred off the sentinel");
    assert.equal(poolStock().total, 0, "and the account left the pool");
  });

  it("refunds the payer when the pool is empty rather than charging for nothing", async () => {
    clearPool();
    const r = await post("/social/tiktok/deploy", BUYER, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.available, false);
    assertRefunded(r, BUYER, "POST /social/tiktok/deploy");
  });

  it("refunds a country miss and still names what is in stock", async () => {
    seedReady(`dep_us_${SUFFIX}`, "us");
    const r = await post("/social/tiktok/deploy", BUYER, { country: "de" });
    assert.equal(r.status, 409);
    assert.match(JSON.stringify(r.json), /US/, "the in-stock hint tells the caller to change the filter");
    assertRefunded(r, BUYER, "POST /social/tiktok/deploy");
    // The US account must be untouched — a wrong-country ask must not consume it.
    assert.equal(poolStock().by_country["US"], 1, "a filtered miss leases nothing");
  });

  it("rejects an over-long bio before leasing, refunds, and burns no account", async () => {
    const id = `dep_badbio_${SUFFIX}`;
    seedReady(id, "us");
    const r = await post("/social/tiktok/deploy", BUYER, { bio: "x".repeat(81) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error_code, "INVALID_INPUT");
    assertRefunded(r, BUYER, "POST /social/tiktok/deploy");
    // Validation runs BEFORE the lease, so the pool account is still there.
    assert.equal(getAccount(id)!.owner, POOL_OWNER, "a typo must not hand out (or consume) a scarce account");
    assert.equal(poolStock().total, 1);
  });
});

describe("GET /social/tiktok/pool/stock", () => {
  it("reports availability and price without auth", async () => {
    clearPool();
    seedReady(`dep_stock_${SUFFIX}`, "br");
    const r = await getPublic("/social/tiktok/pool/stock");
    assert.equal(r.status, 200);
    assert.equal(r.json.price_usdc, 3);
    assert.equal(r.json.total, 1);
    assert.equal(r.json.by_country["BR"], 1);
  });
});
