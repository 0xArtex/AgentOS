/**
 * Regression tests for agent-escrow:
 *  - amount_usdc must be a positive finite number (negative/zero/NaN rejected).
 *  - responses are honestly non-custodial (custodial:false + note), since the
 *    endpoint holds no funds — create/release/dispute are advisory bookkeeping.
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

  before(async () => {
    delete process.env.PALMYR_SELF_HOSTED;
    db.prepare(
      "INSERT INTO agents (id, name, wallet_address, token, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(payer, payer, payerWallet, token);
    const app = express();
    app.use(express.json());
    app.use("/api/agent-escrow", escrowRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => { port = (server.address() as any).port; resolve(); });
    });
  });

  after(async () => {
    db.prepare("DELETE FROM agents WHERE id = ?").run(payer);
    db.prepare("DELETE FROM escrows WHERE payer_agent = ?").run(payerWallet);
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
});
