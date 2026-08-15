/**
 * The one-click X/Twitter deploy route, end to end over HTTP.
 *
 * Twitter is the mirror image of TikTok: buying hands the caller the creds, and
 * ops require cookies on every call. Deploy makes it TikTok-like — lease a pool
 * account, own it, and drive it by id with the session hydrated server-side. The
 * properties worth pinning: a lease binds sold_to_wallet to the payer; a no-stock
 * deploy refunds rather than charging for nothing; the public stock endpoint
 * reports availability + price without auth; and the new validateOpBody fallback
 * lets the OWNER drive an account with cookies omitted (hydrated from the encrypted
 * jar) while a non-owner still gets the missing-session error.
 *
 * Harness mirrors tiktok-deploy-route: self-hosted bypasses requireAuth + the
 * proxy gate, and a shim injects a full req.payment so each request acts as a
 * chosen wallet AND can be refunded like a real settlement. Deploys pass no
 * name/bio/photo, so the async rebrand (a real browser) never fires.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createCipheriv, randomBytes } from "crypto";
import { db, initDatabase } from "../db";
import socialRouter from "../routes/social";
import { setCountryPrice, deleteCountryPrice } from "../services/country-prices";
import { PaymentProof } from "../types";

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const BUYER = `0xBUYER_xdeploy_${SUFFIX}`;
const OTHER = `0xOTHER_xdeploy_${SUFFIX}`;
const SETTLED_USDC = 0.01;
const TREASURY_ENV = ["TREASURY_SOL_PRIVATE_KEY", "SVM_PRIVATE_KEY", "TREASURY_EVM_PRIVATE_KEY"];
// Generated per run (not a hardcoded literal) so the secret scanner has nothing
// to flag — it only needs to be consistent within this process for encrypt/decrypt.
const POOL_KEY = randomBytes(32).toString("hex");

let server: any, port: number, paymentSeq = 0;
let savedSelfHosted: string | undefined, savedSelfHostedForce: string | undefined, savedPoolKey: string | undefined;
const savedTreasury: Record<string, string | undefined> = {};

function nextSignature(): string { return `sig_xdeploy_${SUFFIX}_${++paymentSeq}`; }

/** Encrypt exactly like social-pool.ts so poolBuy/poolAccountsAccessibleBy can decrypt. */
function encPool(plaintext: string): string {
  const key = Buffer.from(process.env.POOL_ENCRYPTION_KEY!, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString("hex"), ciphertext: ct.toString("hex"), tag: tag.toString("hex") });
}

function seedPool(opts: { id: string; country: string; status?: "ready" | "sold"; owner?: string | null }): void {
  db.prepare("DELETE FROM social_account_pool WHERE id = ?").run(opts.id);
  db.prepare(
    `INSERT INTO social_account_pool
       (id, platform, username, country, proxy_session_id, credentials_encrypted, cookies_encrypted,
        sale_price_usdc, status, sold_to_wallet, shared_with, created_at)
     VALUES (?, 'twitter', ?, ?, ?, ?, ?, 5, ?, ?, '[]', ?)`,
  ).run(
    opts.id,
    "user_" + opts.id,
    opts.country,
    opts.id,
    encPool(JSON.stringify({ login: "u", password: "p", auth_token: "tok" })),
    encPool(JSON.stringify([{ name: "auth_token", value: "tok", domain: ".x.com", path: "/" }])),
    opts.status || "ready",
    opts.owner ?? null,
    new Date().toISOString(),
  );
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
function assertRefunded(r: { json: any; signature: string }, payer: string): void {
  assert.equal(r.json.refund?.chain, "solana", "must report the refund back to the caller");
  const row = db.prepare("SELECT payer FROM refunds WHERE original_payment_signature = ?").get(r.signature) as any;
  assert.ok(row, "must go through the refund path, not a bare rejection");
  assert.equal(row.payer, payer);
}

before(async () => {
  initDatabase();
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  savedPoolKey = process.env.POOL_ENCRYPTION_KEY;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1";
  process.env.POOL_ENCRYPTION_KEY = POOL_KEY;
  for (const k of TREASURY_ENV) { savedTreasury[k] = process.env[k]; delete process.env[k]; }
  // validateBuyFilters rejects a country with no configured price, so price the
  // two synthetic test markets (ZY = has stock, ZZ = priced but empty → no-stock).
  setCountryPrice("ZY", 5);
  setCountryPrice("ZZ", 5);

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
  if (savedPoolKey === undefined) delete process.env.POOL_ENCRYPTION_KEY; else process.env.POOL_ENCRYPTION_KEY = savedPoolKey;
  for (const k of TREASURY_ENV) { if (savedTreasury[k] === undefined) delete process.env[k]; else process.env[k] = savedTreasury[k]; }
  db.prepare("DELETE FROM social_account_pool WHERE username LIKE ?").run(`user_%${SUFFIX}%`);
  db.prepare("DELETE FROM refunds WHERE original_payment_signature LIKE ?").run(`sig_xdeploy_${SUFFIX}_%`);
  try { deleteCountryPrice("ZY"); deleteCountryPrice("ZZ"); } catch { /* best effort */ }
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  db.prepare("DELETE FROM social_account_pool WHERE username LIKE ?").run(`user_%${SUFFIX}%`);
});

describe("POST /social/twitter/deploy", () => {
  it("leases a ready pool account to the payer and binds ownership", async () => {
    const id = `xd_ok_${SUFFIX}`;
    seedPool({ id, country: "ZY" }); // unique country → deterministic match
    const r = await post("/social/twitter/deploy", BUYER, { country: "ZY" });
    assert.equal(r.status, 202);
    assert.equal(r.json.deployed, true);
    assert.equal(r.json.account_id, id);
    assert.equal(r.json.rebrand, null, "no name/bio/photo → no rebrand op fired");
    const row = db.prepare("SELECT status, sold_to_wallet FROM social_account_pool WHERE id = ?").get(id) as any;
    assert.equal(row.status, "sold");
    assert.equal(row.sold_to_wallet, BUYER, "ownership bound to the payer");
  });

  it("refunds the payer when no account matches rather than charging for nothing", async () => {
    const r = await post("/social/twitter/deploy", BUYER, { country: "ZZ" }); // no ZZ stock
    assert.equal(r.status, 409);
    assert.equal(r.json.available, false);
    assertRefunded(r, BUYER);
  });

  it("refunds an over-long bio before leasing", async () => {
    seedPool({ id: `xd_badbio_${SUFFIX}`, country: "ZY" });
    const r = await post("/social/twitter/deploy", BUYER, { country: "ZY", bio: "x".repeat(161) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error_code, "INVALID_INPUT");
    assertRefunded(r, BUYER);
    const row = db.prepare("SELECT status FROM social_account_pool WHERE id = ?").get(`xd_badbio_${SUFFIX}`) as any;
    assert.equal(row.status, "ready", "a typo must not consume a scarce account");
  });

  it("refunds an invalid requested username before leasing", async () => {
    const id = `xd_baduser_${SUFFIX}`;
    seedPool({ id, country: "ZY" });
    const r = await post("/social/twitter/deploy", BUYER, { country: "ZY", username: "not-valid-handle" });
    assert.equal(r.status, 400);
    assert.equal(r.json.error_code, "INVALID_INPUT");
    assert.match(r.json.message, /username must be 4-15 chars/i);
    assertRefunded(r, BUYER);
    const row = db.prepare("SELECT status FROM social_account_pool WHERE id = ?").get(id) as any;
    assert.equal(row.status, "ready", "an invalid username must not consume an account");
  });
});

describe("GET /social/twitter/pool/stock", () => {
  it("reports availability and price without auth", async () => {
    seedPool({ id: `xd_stock_${SUFFIX}`, country: "ZY" });
    const r = await getPublic("/social/twitter/pool/stock");
    assert.equal(r.status, 200);
    assert.ok(r.json.by_country.ZY, "the seeded country shows up");
    assert.equal(r.json.by_country.ZY.ready, 1);
    assert.equal(typeof r.json.by_country.ZY.price_usdc, "number");
  });
});

describe("validateOpBody cookie hydration", () => {
  it("lets the OWNER drive an account by id with cookies omitted", async () => {
    // A sold account owned by BUYER, session stored server-side.
    seedPool({ id: `xd_owned_${SUFFIX}`, country: "ZY", status: "sold", owner: BUYER });
    // No cookies, no text: if hydration works, we get PAST validateOpBody to the
    // text check (400 "text is required") — proving the session was resolved by id,
    // without launching a browser.
    const r = await post("/social/twitter/post", BUYER, { account_id: `xd_owned_${SUFFIX}` });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /text is required/, "owner got past the session gate via hydration");
  });

  it("still refuses a non-owner (no cookies, not their account)", async () => {
    seedPool({ id: `xd_owned2_${SUFFIX}`, country: "ZY", status: "sold", owner: BUYER });
    const r = await post("/social/twitter/post", OTHER, { account_id: `xd_owned2_${SUFFIX}` });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /Missing session fields/, "a non-owner cannot hydrate someone else's session");
  });
});
