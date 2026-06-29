/**
 * Regression tests for agent-escrow:
 *  - amount_usdc must be a positive finite number (negative/zero/NaN rejected).
 *  - responses are honestly non-custodial (custodial:false + note), since the
 *    endpoint holds no funds — create/release/dispute are advisory bookkeeping.
 *  - a disputed escrow is NOT a dead end: the payer, payee, or a configured
 *    platform arbiter can resolve it to a terminal outcome (#77).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";

import { db } from "../db";
import escrowRouter from "../routes/agent-escrow";

function request(
  port: number,
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(buf); } catch {}
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("agent-escrow validation + non-custodial honesty", () => {
  let server: http.Server;
  let port: number;
  const s = Date.now().toString(36);
  const payer = `escrow-payer-${s}`;
  const payerWallet = `WALLETESC${s}`;
  const token = "agt_esc_" + crypto.randomBytes(6).toString("hex");
  const auth = { authorization: "Bearer " + token };

  // A second agent that is neither payer nor payee — used to prove a stranger
  // cannot resolve someone else's disputed escrow.
  const stranger = `escrow-stranger-${s}`;
  const strangerWallet = `WALLETSTR${s}`;
  const strangerToken = "agt_str_" + crypto.randomBytes(6).toString("hex");
  const strangerAuth = { authorization: "Bearer " + strangerToken };

  // An arbiter whose wallet is whitelisted in POOL_ADMIN_WALLETS.
  const arbiter = `escrow-arbiter-${s}`;
  const arbiterWallet = `WALLETARB${s}`;
  const arbiterToken = "agt_arb_" + crypto.randomBytes(6).toString("hex");
  const arbiterAuth = { authorization: "Bearer " + arbiterToken };
  let savedPoolAdmin: string | undefined;

  // Create a fresh escrow and move it to 'disputed'; returns the escrow_id.
  async function createDisputed(): Promise<string> {
    const c = await request(port, "POST", "/api/agent-escrow", { payee_agent: "payee-x", amount_usdc: 7 }, auth);
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const d = await request(port, "POST", `/api/agent-escrow/${c.json.escrow_id}/dispute`, { reason: "stuck" }, auth);
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.status, "disputed");
    return c.json.escrow_id;
  }

  before(async () => {
    delete process.env.PALMYR_SELF_HOSTED;
    savedPoolAdmin = process.env.POOL_ADMIN_WALLETS;
    process.env.POOL_ADMIN_WALLETS = arbiterWallet;
    const ins = db.prepare(
      "INSERT INTO agents (id, name, wallet_address, token, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    );
    ins.run(payer, payer, payerWallet, token);
    ins.run(stranger, stranger, strangerWallet, strangerToken);
    ins.run(arbiter, arbiter, arbiterWallet, arbiterToken);
    const app = express();
    app.use(express.json());
    app.use("/api/agent-escrow", escrowRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => { port = (server.address() as any).port; resolve(); });
    });
  });

  after(async () => {
    db.prepare("DELETE FROM agents WHERE id IN (?, ?, ?)").run(payer, stranger, arbiter);
    db.prepare("DELETE FROM escrows WHERE payer_agent = ?").run(payerWallet);
    if (savedPoolAdmin === undefined) delete process.env.POOL_ADMIN_WALLETS;
    else process.env.POOL_ADMIN_WALLETS = savedPoolAdmin;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("rejects a negative amount with 400", async () => {
    const { status } = await request(port, "POST", "/api/agent-escrow", { payee_agent: "x", amount_usdc: -5 }, auth);
    assert.equal(status, 400);
  });

  it("rejects a zero amount with 400", async () => {
    const { status } = await request(port, "POST", "/api/agent-escrow", { payee_agent: "x", amount_usdc: 0 }, auth);
    assert.equal(status, 400);
  });

  it("rejects a non-numeric amount with 400", async () => {
    const { status } = await request(port, "POST", "/api/agent-escrow", { payee_agent: "x", amount_usdc: "lots" }, auth);
    assert.equal(status, 400);
  });

  it("accepts a valid amount and is honestly non-custodial", async () => {
    const { status, json } = await request(port, "POST", "/api/agent-escrow", { payee_agent: "payee-x", amount_usdc: 12.5 }, auth);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.amount_usdc, 12.5);
    assert.equal(json.custodial, false);
    assert.ok(typeof json.note === "string" && /no funds|advisory/i.test(json.note));
    // release also advertises non-custody and never claims funds moved.
    const rel = await request(port, "POST", `/api/agent-escrow/${json.escrow_id}/release`, {}, auth);
    assert.equal(rel.status, 200);
    assert.equal(rel.json.custodial, false);
    assert.doesNotMatch(String(rel.json.message), /Funds released to payee$/);
  });

  // ── Dispute resolution (#77) ──

  it("a party (payer) can resolve a disputed escrow to a terminal outcome", async () => {
    const escrowId = await createDisputed();
    const r = await request(port, "POST", `/api/agent-escrow/${escrowId}/resolve`, { outcome: "cancelled", note: "called off" }, auth);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, "cancelled");
    assert.equal(r.json.resolved_by, "payer");
    assert.equal(r.json.custodial, false, "resolution moves no funds — must stay non-custodial");
  });

  it("rejects an invalid resolve outcome with 400", async () => {
    const escrowId = await createDisputed();
    const r = await request(port, "POST", `/api/agent-escrow/${escrowId}/resolve`, { outcome: "bogus" }, auth);
    assert.equal(r.status, 400);
  });

  it("a stranger (neither party nor arbiter) cannot resolve — 403", async () => {
    const escrowId = await createDisputed();
    const r = await request(port, "POST", `/api/agent-escrow/${escrowId}/resolve`, { outcome: "refunded" }, strangerAuth);
    assert.equal(r.status, 403);
  });

  it("a whitelisted platform arbiter can resolve a disputed escrow", async () => {
    const escrowId = await createDisputed();
    const r = await request(port, "POST", `/api/agent-escrow/${escrowId}/resolve`, { outcome: "released" }, arbiterAuth);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, "released");
    assert.equal(r.json.resolved_by, "arbiter");
  });

  it("cannot resolve an escrow that is not disputed (still pending) — 400", async () => {
    const c = await request(port, "POST", "/api/agent-escrow", { payee_agent: "payee-x", amount_usdc: 4 }, auth);
    assert.equal(c.status, 200);
    const r = await request(port, "POST", `/api/agent-escrow/${c.json.escrow_id}/resolve`, { outcome: "cancelled" }, auth);
    assert.equal(r.status, 400);
  });
});
