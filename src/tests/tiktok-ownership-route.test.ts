/**
 * Ownership enforcement on the live TikTok op routes.
 *
 * The registry's unit tests prove `checkOwnership` returns the right verdict.
 * They do NOT prove the routes consult it — and an attempt to verify this
 * against production came back 402, because the payment gate runs first and
 * answers before the ownership check is ever reached. So the 403 path was
 * unproven end-to-end. This closes that gap.
 *
 * It also pins the money behaviour. `requireAuth` settles payment BEFORE the
 * handler runs, so refusing a request here means the caller has already been
 * charged. Rejecting without refunding would bill someone for an operation we
 * then decline to perform. (The balance rail was always safe — it refunds any
 * 4xx via a res.on('finish') hook — but the x402/USDC rail had no such net.)
 *
 * Harness: self-hosted mode bypasses requireAuth and the IPROYAL gate, and a
 * shim injects req.payment — a whole settlement, not just a payer — so each
 * request can act as a chosen wallet AND be refunded like a real one.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, initDatabase } from "../db";
import socialRouter from "../routes/social";
import { registerAccount } from "../services/tiktok-accounts";
import { PaymentProof } from "../types";

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ALICE = `0xALICE_route_${SUFFIX}`;
const BOB = `0xBOB_route_${SUFFIX}`;
const ACCT = `acct_route_${SUFFIX}`;
const UNREGISTERED = `acct_unreg_${SUFFIX}`;
/** What the shim pretends requireAuth settled before handing the handler over. */
const SETTLED_USDC = 0.01;
/** Unset for the duration: the refund path here is the real one. */
const TREASURY_ENV = ["TREASURY_SOL_PRIVATE_KEY", "SVM_PRIVATE_KEY", "TREASURY_EVM_PRIVATE_KEY"];

let server: any;
let port: number;
let savedSelfHosted: string | undefined;
let savedSelfHostedForce: string | undefined;
const savedTreasury: Record<string, string | undefined> = {};
let paymentSeq = 0;

// Every request settles its own signature. The refunds ledger is UNIQUE on it,
// so a shared one would make the second refund an idempotent replay of the
// first instead of a new attempt.
function nextSignature(): string {
  return `sig_${SUFFIX}_${++paymentSeq}`;
}

async function post(path: string, payer: string, body: unknown): Promise<{ status: number; json: any; signature: string }> {
  const signature = nextSignature();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-payer": payer, "x-test-signature": signature },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, signature };
}

async function get(path: string, payer: string): Promise<{ status: number; text: string; json: any; signature: string }> {
  const signature = nextSignature();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "x-test-payer": payer, "x-test-signature": signature },
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, text, json, signature };
}

/**
 * The refund actually happened — not just the word "refund" in a response.
 *
 * refundUsdcToPayer writes the ledger row BEFORE it touches the chain, so the
 * row is the proof of intent that survives in a unit test: the on-chain send
 * cannot succeed here (no treasury key, no network) but nothing reaches the
 * send at all unless the handler asked for a refund of this exact settlement.
 * Delete the refundAndRespond call from a route and there is no row to find.
 */
function assertRefunded(r: { json: any; signature: string }, payer: string, endpoint: string): void {
  assert.equal(r.json.refund?.chain, "solana", `${endpoint} must report the refund back to the caller`);
  assert.equal(r.json.refund?.amount_usdc, SETTLED_USDC, "the whole settled amount goes back");
  const row = db.prepare(
    "SELECT payer, chain, amount_usdc, endpoint FROM refunds WHERE original_payment_signature = ?"
  ).get(r.signature) as any;
  assert.ok(row, `${endpoint} must go through the refund path, not answer with a bare rejection`);
  assert.equal(row.payer, payer, "the refund is owed to whoever paid");
  assert.equal(row.chain, "solana", "the refund returns on the chain that settled");
  assert.equal(row.amount_usdc, SETTLED_USDC);
  assert.equal(row.endpoint, endpoint);
}

before(async () => {
  initDatabase();
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1";
  // The refunds these routes issue are real from here down. Unset the treasury
  // keys so a developer with a funded .env cannot make this file move money:
  // the send fails at the key check, before any RPC, and the ledger row — the
  // thing actually under test — is written either way.
  for (const k of TREASURY_ENV) {
    savedTreasury[k] = process.env[k];
    delete process.env[k];
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const payer = req.headers["x-test-payer"];
    // A full PaymentProof, because refundAndRespond reads chain / amount /
    // signature off it and answers with "contact ops" — without ever reaching
    // the ledger — if any of them is missing. A payer-only shim would let a
    // route that refunds nothing still say the word "refund".
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
  if (savedSelfHosted === undefined) delete process.env.PALMYR_SELF_HOSTED;
  else process.env.PALMYR_SELF_HOSTED = savedSelfHosted;
  if (savedSelfHostedForce === undefined) delete process.env.PALMYR_SELF_HOSTED_FORCE;
  else process.env.PALMYR_SELF_HOSTED_FORCE = savedSelfHostedForce;
  for (const k of TREASURY_ENV) {
    if (savedTreasury[k] === undefined) delete process.env[k];
    else process.env[k] = savedTreasury[k];
  }
  db.prepare("DELETE FROM tiktok_accounts WHERE id IN (?, ?)").run(ACCT, UNREGISTERED);
  db.prepare("DELETE FROM refunds WHERE original_payment_signature LIKE ?").run(`sig_${SUFFIX}_%`);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  db.prepare("DELETE FROM tiktok_accounts WHERE id IN (?, ?)").run(ACCT, UNREGISTERED);
  registerAccount({ id: ACCT, owner: ALICE, country: "ae" });
});

describe("TikTok op routes enforce account ownership", () => {
  it("refuses a wallet that does not own the account", async () => {
    const r = await post("/social/tiktok/follow", BOB, { account_id: ACCT, user: "@nasa", cookies: [] });
    assert.equal(r.status, 403, "another wallet must not be able to act on a registered account");
    assert.equal(r.json.error_code, "NOT_YOUR_ACCOUNT");
  });

  it("refunds the rejected caller rather than keeping their money", async () => {
    // Payment settles before the handler, so a bare 403 would charge for an
    // operation we refuse to run. Checked against the refunds ledger rather
    // than the response text: the "contact ops" answer refundAndRespond gives
    // when it cannot identify the settlement also contains the word refund.
    const r = await post("/social/tiktok/follow", BOB, { account_id: ACCT, user: "@nasa", cookies: [] });
    assert.equal(r.status, 403);
    assertRefunded(r, BOB, "POST /social/tiktok/follow");
  });

  it("does not lock out the legitimate owner", async () => {
    // The owner must get PAST ownership. Sending no cookies stops them at the
    // next check (missing session) instead of launching a real browser — so a
    // non-403 here is exactly the proof we want, with no side effects.
    const r = await post("/social/tiktok/follow", ALICE, { account_id: ACCT, user: "@nasa", cookies: [] });
    assert.notEqual(r.status, 403, "the owner must never be refused their own account");
    assert.equal(r.json.error_code, undefined);
  });

  it("leaves the older unregistered flow working for anyone", async () => {
    // Nobody registered this id, so possession of a live cookie jar is the
    // proof. Enforcing ownership on unregistered ids would break every
    // pre-existing account without making anything safer.
    const r = await post("/social/tiktok/follow", BOB, { account_id: UNREGISTERED, user: "@nasa", cookies: [] });
    assert.notEqual(r.status, 403, "an unregistered account id must not be owner-gated");
  });

  it("rejects a schedule outside TikTok's window before spending a job on it", async () => {
    // postVideo checks the same bounds, but only once a job exists and the
    // caller has paid — so asking for a post three weeks out cost a full round
    // trip to learn a limit that is knowable instantly.
    const far = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
    const r = await post("/social/tiktok/post", ALICE, {
      account_id: ACCT, caption: "too far out", video_url: "https://example.invalid/v.mp4", schedule_at: far, cookies: [],
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error_code, "INVALID_INPUT");
    assert.match(JSON.stringify(r.json), /10 days/, "the actual limit must be stated, not just 'invalid'");
    // Payment settled before the handler, so a refusal must refund.
    assertRefunded(r, ALICE, "POST /social/tiktok/post");
    // The window is machine-readable, so an agent can plan against it rather
    // than discovering it by failing.
    assert.deepEqual(r.json.schedule_window, { min_minutes: 15, max_days: 10 });
  });

  it("rejects a schedule that is too soon, for the same reason", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const r = await post("/social/tiktok/post", ALICE, {
      account_id: ACCT, caption: "too soon", video_url: "https://example.invalid/v.mp4", schedule_at: soon, cookies: [],
    });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /15 minutes/);
  });

  it("lets a schedule inside the window through to the normal path", async () => {
    // Must NOT be caught by the window check — a valid schedule proceeds to the
    // usual session/ownership handling like any other post.
    const ok = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const r = await post("/social/tiktok/post", ALICE, {
      account_id: ACCT, caption: "fine", video_url: "https://example.invalid/v.mp4", schedule_at: ok, cookies: [],
    });
    assert.notEqual(r.json.error_code, "INVALID_INPUT", "a valid window must not be rejected");
  });

  it("gates the stored history too, so reading is not a way around the binding", async () => {
    // The series is account data. If reads were ungated, anyone could pull a
    // competitor's per-video engagement by guessing an account id — the write
    // ops would be bound and the interesting data would be public anyway.
    const r = await get(`/social/tiktok/series?account_id=${ACCT}`, BOB);
    assert.equal(r.status, 403, "history must be owner-only");
    assert.match(r.text, /NOT_YOUR_ACCOUNT/);
    // A paid read refused after settlement must refund, same as the ops.
    assertRefunded(r, BOB, "GET /social/tiktok/series");
  });

  it("gates the hook report, and serves the owner a real one", async () => {
    // Hook performance is derived from the same account data, so it inherits
    // the same binding — otherwise the numbers we refuse to serve directly
    // would leak through the analysis of them.
    const denied = await get(`/social/tiktok/hooks?account_id=${ACCT}`, BOB);
    assert.equal(denied.status, 403);
    assert.match(denied.text, /NOT_YOUR_ACCOUNT/);
    assertRefunded(denied, BOB, "GET /social/tiktok/hooks");

    // The owner gets a real report, with an empty account stated as such
    // rather than dressed up as a finding.
    const ok = await get(`/social/tiktok/hooks?account_id=${ACCT}`, ALICE);
    assert.equal(ok.status, 200);
    const report = ok.json;
    assert.equal(report.baseline.mature_posts, 0);
    assert.deepEqual(report.patterns, []);
    assert.match(JSON.stringify(report.notes), /No posts old enough/);
  });

  it("classifies a draft caption through the route, with no history needed", async () => {
    const q = new URLSearchParams({ account_id: ACCT, caption: "Stop doing crunches. Do this instead #gym" });
    const res = await get(`/social/tiktok/hooks?${q}`, ALICE);
    assert.equal(res.status, 200);
    const check = res.json;
    assert.equal(check.hook, "Stop doing crunches.", "hashtags are not the hook");
    assert.ok(check.patterns.some((p: any) => p.pattern === "contrarian"));
    // No data yet, so it must say so rather than produce a verdict.
    assert.deepEqual(check.evidence, []);
    assert.match(JSON.stringify(check.notes), /no mature posts/i);
  });

  it("enforces ownership on every op, not just follow", async () => {
    // A gate on one route is not a gate. Each paid op resolves the account the
    // same way and must reach the same verdict.
    for (const op of ["like", "delete", "profile", "avatar", "analytics"]) {
      const r = await post(`/social/tiktok/${op}`, BOB, { account_id: ACCT, cookies: [], url: "https://x", video_url: "https://x" });
      assert.equal(r.status, 403, `/social/tiktok/${op} must enforce ownership`);
      assert.equal(r.json.error_code, "NOT_YOUR_ACCOUNT", `/social/tiktok/${op} must report NOT_YOUR_ACCOUNT`);
    }
  });
});
