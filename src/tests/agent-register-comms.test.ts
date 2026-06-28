/**
 * Regression tests for the two endpoints that were hanging because their
 * route files defined a different schema for the same SQLite tables than
 * db.ts (which runs first at import, so the routes' CREATE TABLE no-op'd and
 * their INSERTs threw against the real columns).
 *
 * What this covers:
 *  - POST /agents/register inserts a valid row into the REAL `agents` table
 *    and returns an `aos_` token that middleware/auth.ts can resolve via
 *    `SELECT * FROM agents WHERE token = ?` (the auth on-ramp must work).
 *  - POST /agents/register validates name/walletAddress and 400s cleanly.
 *  - POST /api/agent-comms/send + GET /api/agent-comms/inbox round-trip
 *    through the real `agent_messages` schema (body column, no priority
 *    column) without throwing or hanging.
 *
 * Style mirrors i402-chat-route.test.ts: boot the real routers on an
 * ephemeral port and drive them over HTTP.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import nacl from "tweetnacl";
import bs58 from "bs58";

import { db, initDatabase } from "../db";
import agentRoutes from "../routes/agents";
import agentCommsRoutes from "../routes/agent-comms";

// -------------------- Setup --------------------

initDatabase();

// Unique suffix so repeated runs against a persistent dev DB never collide on
// the UNIQUE(name)/UNIQUE(wallet_address) constraints.
const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// Build syntactically valid base58 Solana addresses (the register route
// validates walletAddress against ^[1-9A-HJ-NP-Za-km-z]{32,44}$). base36
// output can contain 0/l which base58 forbids, so strip to the safe alphabet
// and pad to a fixed length with a safe filler.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58Wallet(seed: string): string {
  const cleaned = seed.split("").filter(c => B58.includes(c)).join("");
  return (cleaned + "1".repeat(44)).slice(0, 44);
}

// Registration now requires proof of wallet control: the caller signs
// `palmyr-register:<wallet>:<timestamp>` with the wallet's key. Use a REAL
// Ed25519 keypair so the base58 pubkey is a valid Solana address AND we can
// produce a verifying signature.
const KP = nacl.sign.keyPair();
const WALLET = bs58.encode(Buffer.from(KP.publicKey));
const AGENT_NAME = "regtest-agent-" + SUFFIX;

// Build a signed registration body for our keypair (fresh timestamp each call).
function signedRegistration(name: string, extra: Record<string, unknown> = {}) {
  const signatureTimestamp = Date.now();
  const message = `palmyr-register:${WALLET}:${signatureTimestamp}`;
  const signature = bs58.encode(
    Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), KP.secretKey)),
  );
  return { name, walletAddress: WALLET, signature, signatureTimestamp, ...extra };
}

async function launchTestServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use("/agents", agentRoutes);
  app.use("/api/agent-comms", agentCommsRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind failed");
      resolve({
        port: addr.port,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

async function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path, headers: { Accept: "application/json", ...headers } }, res => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", chunk => (buf += chunk));
        res.on("end", () => {
          let body: any = buf;
          try { body = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
      })
      .on("error", reject);
  });
}

async function httpPostJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      res => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", c => (buf += c));
        res.on("end", () => {
          let parsed: any = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// The exact lookup middleware/auth.ts performs to authenticate a token
// (Method 1: registered agent token). Proving register's token resolves here
// proves the on-ramp works without spinning up the full auth middleware.
function authResolve(token: string): any {
  return db.prepare("SELECT * FROM agents WHERE token = ?").get(token);
}

// -------------------- POST /agents/register --------------------

describe("POST /agents/register", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => { ctx = await launchTestServer(); });
  after(async () => { await ctx.close(); });

  it("registers an agent and returns an aos_ token auth can resolve", async () => {
    const res = await httpPostJson(
      ctx.port,
      "/agents/register",
      signedRegistration(AGENT_NAME, { description: "regression test agent" }),
    );

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.token, "response must include a token");
    assert.ok(
      res.body.token.startsWith("aos_") || res.body.token.startsWith("agt_"),
      `token must use a prefix auth.ts accepts, got: ${res.body.token}`
    );
    assert.ok(res.body.agent && res.body.agent.id, "response must include agent.id");
    assert.equal(res.body.agent.walletAddress, WALLET);

    // The on-ramp guarantee: the issued token resolves via the EXACT query
    // middleware/auth.ts runs to authenticate a registered agent.
    const row = authResolve(res.body.token);
    assert.ok(row, "auth's SELECT * FROM agents WHERE token = ? must find the new row");
    assert.equal(row.id, res.body.agent.id);
    assert.equal(row.wallet_address, WALLET);
    assert.equal(row.name, AGENT_NAME);
  });

  it("rejects a missing/invalid wallet address with 400 (no hang)", async () => {
    const res = await httpPostJson(ctx.port, "/agents/register", {
      name: "noeq-wallet-" + SUFFIX,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Wallet Address Required/i);
  });

  it("rejects a too-short name with 400", async () => {
    const res = await httpPostJson(ctx.port, "/agents/register", {
      name: "x",
      walletAddress: b58Wallet("Nm" + SUFFIX),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid Agent Name/i);
  });

  it("rejects a duplicate wallet with 409", async () => {
    // WALLET was already registered in the first test. Sign a fresh proof so we
    // pass the wallet-control check and reach the duplicate check.
    const res = await httpPostJson(ctx.port, "/agents/register", signedRegistration("dup-" + SUFFIX));
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Wallet Already Registered/i);
  });

  it("rejects binding a wallet with NO signature (401)", async () => {
    // The core of the registration-takeover fix: a wallet can't be bound without
    // proof of control, so an attacker can't register a victim's wallet.
    const res = await httpPostJson(ctx.port, "/agents/register", {
      name: "unsigned-" + SUFFIX,
      walletAddress: bs58.encode(Buffer.from(nacl.sign.keyPair().publicKey)),
    });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.match(res.body.error, /Wallet Proof Required/i);
  });

  it("rejects a signature from a DIFFERENT wallet (401)", async () => {
    // Victim's address, but signed by the attacker's key → must not verify.
    const victim = bs58.encode(Buffer.from(nacl.sign.keyPair().publicKey));
    const attacker = nacl.sign.keyPair();
    const signatureTimestamp = Date.now();
    const message = `palmyr-register:${victim}:${signatureTimestamp}`;
    const signature = bs58.encode(
      Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), attacker.secretKey)),
    );
    const res = await httpPostJson(ctx.port, "/agents/register", {
      name: "spoof-" + SUFFIX,
      walletAddress: victim,
      signature,
      signatureTimestamp,
    });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.match(res.body.error, /Invalid Wallet Signature/i);
  });
});

// -------------------- agent-comms send + inbox round-trip --------------------

describe("POST /api/agent-comms/send + GET /inbox", () => {
  let ctx: { port: number; close: () => Promise<void> };
  // Use real agent ids so the round-trip is valid regardless of FK pragma state.
  const FROM_ID = "agent_from_" + SUFFIX;
  const TO_ID = "agent_to_" + SUFFIX;

  before(async () => {
    ctx = await launchTestServer();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agents (id, name, description, wallet_address, webhook_url, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(FROM_ID, "comms-from-" + SUFFIX, null, b58Wallet("CF" + SUFFIX), null, "aos_" + FROM_ID, now);
    db.prepare(
      `INSERT INTO agents (id, name, description, wallet_address, webhook_url, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(TO_ID, "comms-to-" + SUFFIX, null, b58Wallet("CT" + SUFFIX), null, "aos_" + TO_ID, now);
  });
  after(async () => { await ctx.close(); });

  it("delivers a message and reads it back through the real schema", async () => {
    const sendRes = await httpPostJson(
      ctx.port,
      "/api/agent-comms/send",
      { toAgent: TO_ID, subject: "hello", message: "round-trip body", priority: "high" },
      { "X-Agent-Id": FROM_ID }
    );

    assert.equal(sendRes.status, 200, JSON.stringify(sendRes.body));
    assert.equal(sendRes.body.status, "delivered");
    assert.equal(sendRes.body.to, TO_ID);
    assert.equal(sendRes.body.priority, "high"); // echoed, not persisted
    assert.ok(sendRes.body.id);

    // Confirm it actually landed in the real `agent_messages` table with the
    // text in the `body` column (the schema messages.ts also uses).
    const stored = db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(sendRes.body.id) as any;
    assert.ok(stored, "row must exist in agent_messages");
    assert.equal(stored.body, "round-trip body");
    assert.equal(stored.from_agent, FROM_ID);
    assert.equal(stored.to_agent, TO_ID);

    // Inbox lists it back without throwing.
    const inboxRes = await httpGet(ctx.port, "/api/agent-comms/inbox", { "X-Agent-Id": TO_ID });
    assert.equal(inboxRes.status, 200);
    assert.ok(Array.isArray(inboxRes.body.messages));
    const found = inboxRes.body.messages.find((m: any) => m.id === sendRes.body.id);
    assert.ok(found, "sent message must appear in recipient inbox");
    assert.equal(found.body, "round-trip body");
    assert.ok(inboxRes.body.unread >= 1);
  });

  it("400s when toAgent or message is missing (no hang)", async () => {
    const res = await httpPostJson(
      ctx.port,
      "/api/agent-comms/send",
      { subject: "incomplete" },
      { "X-Agent-Id": FROM_ID }
    );
    assert.equal(res.status, 400);
    assert.match(res.body.error, /required/i);
  });
});
