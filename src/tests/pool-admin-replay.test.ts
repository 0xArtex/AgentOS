/**
 * Regression test for pool-admin signature replay.
 *
 * A captured admin request (valid Ed25519 signature over <method>:<path>:<ts>)
 * could previously be replayed verbatim any number of times within the 60s skew
 * window. The middleware now records each accepted signature and rejects a
 * second use, while still accepting a fresh signature.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { requirePoolAdmin } from "../middleware/pool-admin";

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("pool-admin replay protection", () => {
  let server: http.Server;
  let port: number;
  let savedWallets: string | undefined;

  const kp = nacl.sign.keyPair();
  const pubkey = bs58.encode(Buffer.from(kp.publicKey));
  const ROUTE = "/admin/pool/test";

  function signedHeaders(ts: number): Record<string, string> {
    const message = `GET:${ROUTE}:${ts}`;
    const sig = nacl.sign.detached(Buffer.from(message, "utf8"), kp.secretKey);
    return {
      "x-admin-pubkey": pubkey,
      "x-admin-timestamp": String(ts),
      "x-admin-signature": Buffer.from(sig).toString("hex"),
    };
  }

  before(async () => {
    savedWallets = process.env.POOL_ADMIN_WALLETS;
    process.env.POOL_ADMIN_WALLETS = pubkey;
    const app = express();
    app.get(ROUTE, requirePoolAdmin, (_req, res) => res.json({ ok: true }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  after(async () => {
    if (savedWallets === undefined) delete process.env.POOL_ADMIN_WALLETS;
    else process.env.POOL_ADMIN_WALLETS = savedWallets;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("accepts a valid signature once, then rejects the replay", async () => {
    const headers = signedHeaders(Date.now());

    const first = await request(port, "GET", ROUTE, headers);
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, true);

    const replay = await request(port, "GET", ROUTE, headers);
    assert.equal(replay.status, 401);
    assert.match(replay.json.error, /replay/i);
  });

  it("still accepts a fresh signature (new timestamp)", async () => {
    const fresh = await request(port, "GET", ROUTE, signedHeaders(Date.now() + 1));
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.ok, true);
  });
});
