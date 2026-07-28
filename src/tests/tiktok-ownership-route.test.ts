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
 * shim injects req.payment so each request can act as a chosen wallet.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, initDatabase } from "../db";
import socialRouter from "../routes/social";
import { registerAccount } from "../services/tiktok-accounts";

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ALICE = `0xALICE_route_${SUFFIX}`;
const BOB = `0xBOB_route_${SUFFIX}`;
const ACCT = `acct_route_${SUFFIX}`;
const UNREGISTERED = `acct_unreg_${SUFFIX}`;

let server: any;
let port: number;
let savedSelfHosted: string | undefined;
let savedSelfHostedForce: string | undefined;

async function post(path: string, payer: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-payer": payer },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

before(async () => {
  initDatabase();
  savedSelfHosted = process.env.PALMYR_SELF_HOSTED;
  savedSelfHostedForce = process.env.PALMYR_SELF_HOSTED_FORCE;
  process.env.PALMYR_SELF_HOSTED = "1";
  process.env.PALMYR_SELF_HOSTED_FORCE = "1";

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const payer = req.headers["x-test-payer"];
    if (payer) (req as any).payment = { payer: String(payer) };
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
  db.prepare("DELETE FROM tiktok_accounts WHERE id IN (?, ?)").run(ACCT, UNREGISTERED);
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
    // operation we refuse to run. The refunding path is what produces this
    // message — a plain res.status(403) never mentions a refund.
    const r = await post("/social/tiktok/follow", BOB, { account_id: ACCT, user: "@nasa", cookies: [] });
    assert.equal(r.status, 403);
    assert.match(
      JSON.stringify(r.json),
      /refund/i,
      "an ownership rejection must go through the refund path, not a bare 403",
    );
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

  it("gates the stored history too, so reading is not a way around the binding", async () => {
    // The series is account data. If reads were ungated, anyone could pull a
    // competitor's per-video engagement by guessing an account id — the write
    // ops would be bound and the interesting data would be public anyway.
    const res = await fetch(`http://127.0.0.1:${port}/social/tiktok/series?account_id=${ACCT}`, {
      headers: { "x-test-payer": BOB },
    });
    const body = await res.text();
    assert.equal(res.status, 403, "history must be owner-only");
    assert.match(body, /NOT_YOUR_ACCOUNT/);
    assert.match(body, /refund/i, "a paid read refused after settlement must refund, same as the ops");
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
