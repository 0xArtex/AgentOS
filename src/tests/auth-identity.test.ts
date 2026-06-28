/**
 * Regression tests for the identity/access-control fixes in
 * src/middleware/auth.ts and src/routes/agents.ts.
 *
 * Invariant under test (the heart of the fix):
 *   A caller with NO secret token AND NO on-chain payment can NEVER obtain
 *   another wallet's identity. A raw `X-Agent-Id` header is not proof — only a
 *   token, an on-chain payment, or a wallet-control SIGNATURE establishes
 *   req.agentId.
 *
 * Also covers:
 *   - registration requires proof of wallet control (Solana + EVM),
 *   - GET /agents/:id and /:id/resources hide sensitive fields from non-owners,
 *   - the verifyWalletControl primitive (Ed25519 + secp256k1/EIP-191).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { db, initDatabase } from "../db";
import {
  requireAuth,
  verifyWalletControl,
  agentIdAuthMessage,
  registerAuthMessage,
} from "../middleware/auth";
import agentRoutes from "../routes/agents";

initDatabase();

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── crypto helpers ──────────────────────────────────────────────────────────
function solSign(secretKey: Uint8Array, message: string): string {
  return bs58.encode(Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), secretKey)));
}
function evmAddress(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false); // uncompressed
  return "0x" + Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString("hex");
}
function evmPersonalSign(priv: Uint8Array, message: string): string {
  const msg = Buffer.from(message, "utf8");
  const prefix = Buffer.from("\x19Ethereum Signed Message:\n" + msg.length, "utf8");
  const hash = keccak_256(Buffer.concat([prefix, msg]));
  const rec = secp256k1.sign(hash, priv, { prehash: false, format: "recovered" }); // [v, r, s]
  const v = rec[0];
  const rs = Buffer.from(rec.subarray(1));
  return "0x" + Buffer.concat([rs, Buffer.from([27 + v])]).toString("hex");
}

// ── tiny HTTP harness ─────────────────────────────────────────────────────────
async function launch(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  // A free, identity-only route — exactly the shape of agent-secrets/agent-inbox.
  app.get("/whoami", requireAuth(0), (req: any, res) => res.json({ agentId: req.agentId ?? null }));
  app.use("/agents", agentRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind failed");
      resolve({ port: addr.port, close: () => new Promise<void>(r => server.close(() => r())) });
    });
  });
}

function req(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
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
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── a registered "victim" agent we never want anyone to impersonate ──────────
const VICTIM_KP = nacl.sign.keyPair();
const VICTIM_WALLET = bs58.encode(Buffer.from(VICTIM_KP.publicKey));
const VICTIM_NAME = "victim-" + SUFFIX;
const VICTIM_ID = "agent_victim_" + SUFFIX;
const VICTIM_TOKEN = "aos_" + Buffer.from(nacl.randomBytes(24)).toString("hex");

function seedVictim(): void {
  db.prepare(
    `INSERT INTO agents (id, name, description, wallet_address, webhook_url, token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(VICTIM_ID, VICTIM_NAME, "do not impersonate", VICTIM_WALLET, "https://victim.example/hook", VICTIM_TOKEN, new Date().toISOString());
  // Give the victim a resource so /resources has an identifier to (not) leak.
  db.prepare(
    `INSERT INTO email_inboxes (id, address, local_part, owner, created_at, active) VALUES (?, ?, ?, ?, ?, 1)`
  ).run("em_victim_" + SUFFIX, `secret-${SUFFIX}@agent.palmyr.dev`, "secret-" + SUFFIX, VICTIM_ID, new Date().toISOString());
}

// ──────────────────────────────────────────────────────────────────────────────
describe("requireAuth X-Agent-Id can never grant a victim's identity for free", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => { seedVictim(); ctx = await launch(); });
  after(async () => { await ctx.close(); });

  it("bare X-Agent-Id (wallet) with no token/sig/payment is rejected (402), NOT granted", async () => {
    const res = await req(ctx.port, "GET", "/whoami", { "X-Agent-Id": VICTIM_WALLET });
    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.notEqual(res.body.agentId, VICTIM_WALLET);
  });

  it("bare X-Agent-Id (name) is likewise rejected (402)", async () => {
    const res = await req(ctx.port, "GET", "/whoami", { "X-Agent-Id": VICTIM_NAME });
    assert.equal(res.status, 402);
    assert.notEqual(res.body.agentId, VICTIM_WALLET);
  });

  it("a valid agent token DOES resolve identity to the wallet (200)", async () => {
    const res = await req(ctx.port, "GET", "/whoami", { Authorization: `Bearer ${VICTIM_TOKEN}` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.agentId, VICTIM_WALLET);
  });

  it("a FRESH wallet-control signature on X-Agent-Id resolves identity (200)", async () => {
    const ts = String(Date.now());
    const sig = solSign(VICTIM_KP.secretKey, agentIdAuthMessage(VICTIM_WALLET, ts));
    const res = await req(ctx.port, "GET", "/whoami", {
      "X-Agent-Id": VICTIM_WALLET,
      "X-Agent-Signature": sig,
      "X-Agent-Timestamp": ts,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.agentId, VICTIM_WALLET);
  });

  it("a signature from the WRONG key is rejected (402)", async () => {
    const attacker = nacl.sign.keyPair();
    const ts = String(Date.now());
    const sig = solSign(attacker.secretKey, agentIdAuthMessage(VICTIM_WALLET, ts));
    const res = await req(ctx.port, "GET", "/whoami", {
      "X-Agent-Id": VICTIM_WALLET,
      "X-Agent-Signature": sig,
      "X-Agent-Timestamp": ts,
    });
    assert.equal(res.status, 402);
    assert.notEqual(res.body.agentId, VICTIM_WALLET);
  });

  it("a STALE signature (outside the freshness window) is rejected (402)", async () => {
    const ts = String(Date.now() - 10 * 60 * 1000); // 10 min old
    const sig = solSign(VICTIM_KP.secretKey, agentIdAuthMessage(VICTIM_WALLET, ts));
    const res = await req(ctx.port, "GET", "/whoami", {
      "X-Agent-Id": VICTIM_WALLET,
      "X-Agent-Signature": sig,
      "X-Agent-Timestamp": ts,
    });
    assert.equal(res.status, 402);
  });
});

describe("GET /agents/:id hides sensitive fields from non-owners (enumeration fix)", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => { ctx = await launch(); }); // victim already seeded above
  after(async () => { await ctx.close(); });

  it("anonymous profile omits walletAddress + webhookUrl", async () => {
    const res = await req(ctx.port, "GET", `/agents/${VICTIM_ID}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.agent.name, VICTIM_NAME);
    assert.equal(res.body.agent.walletAddress, undefined, "wallet must NOT leak to anon");
    assert.equal(res.body.agent.webhookUrl, undefined, "webhook must NOT leak to anon");
  });

  it("owner (token) profile includes walletAddress + webhookUrl", async () => {
    const res = await req(ctx.port, "GET", `/agents/${VICTIM_ID}`, { Authorization: `Bearer ${VICTIM_TOKEN}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.agent.walletAddress, VICTIM_WALLET);
    assert.equal(res.body.agent.webhookUrl, "https://victim.example/hook");
  });

  it("anonymous /resources returns totals only, no identifiers", async () => {
    const res = await req(ctx.port, "GET", `/agents/${VICTIM_ID}/resources`);
    assert.equal(res.status, 200);
    assert.equal(res.body.resources, undefined, "identifier arrays must NOT leak to anon");
    assert.equal(res.body.totals.emailInboxes, 1);
  });

  it("owner /resources includes the identifier arrays", async () => {
    const res = await req(ctx.port, "GET", `/agents/${VICTIM_ID}/resources`, { Authorization: `Bearer ${VICTIM_TOKEN}` });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.resources.emailInboxes));
    assert.equal(res.body.resources.emailInboxes[0].address, `secret-${SUFFIX}@agent.palmyr.dev`);
  });
});

describe("registration accepts a signed EVM (0x) wallet and rejects a bad one", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => { ctx = await launch(); });
  after(async () => { await ctx.close(); });

  it("registers an EVM wallet with a valid EIP-191 signature (201)", async () => {
    const priv = secp256k1.utils.randomSecretKey();
    const wallet = evmAddress(priv);
    const signatureTimestamp = Date.now();
    const signature = evmPersonalSign(priv, registerAuthMessage(wallet, signatureTimestamp));
    const res = await req(ctx.port, "POST", "/agents/register", {}, {
      name: "evm-" + SUFFIX,
      walletAddress: wallet,
      signature,
      signatureTimestamp,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.agent.walletAddress, wallet);
  });

  it("rejects an EVM wallet with a tampered signature (401)", async () => {
    const priv = secp256k1.utils.randomSecretKey();
    const wallet = evmAddress(priv);
    const signatureTimestamp = Date.now();
    // Sign a DIFFERENT message than the server will reconstruct.
    const signature = evmPersonalSign(priv, registerAuthMessage(wallet, signatureTimestamp + 1));
    const res = await req(ctx.port, "POST", "/agents/register", {}, {
      name: "evm-bad-" + SUFFIX,
      walletAddress: wallet,
      signature,
      signatureTimestamp,
    });
    assert.equal(res.status, 401, JSON.stringify(res.body));
  });
});

describe("verifyWalletControl primitive", () => {
  it("verifies a valid Ed25519 (Solana) signature and rejects a forgery", () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(Buffer.from(kp.publicKey));
    const msg = "palmyr-proof:" + Date.now();
    assert.equal(verifyWalletControl(wallet, msg, solSign(kp.secretKey, msg)), true);
    assert.equal(verifyWalletControl(wallet, msg + "x", solSign(kp.secretKey, msg)), false);
    const other = nacl.sign.keyPair();
    assert.equal(verifyWalletControl(wallet, msg, solSign(other.secretKey, msg)), false);
  });

  it("verifies a valid secp256k1/EIP-191 (EVM) signature and rejects a forgery", () => {
    const priv = secp256k1.utils.randomSecretKey();
    const wallet = evmAddress(priv);
    const msg = "palmyr-proof:" + Date.now();
    assert.equal(verifyWalletControl(wallet, msg, evmPersonalSign(priv, msg)), true);
    assert.equal(verifyWalletControl(wallet, msg + "x", evmPersonalSign(priv, msg)), false);
    const other = secp256k1.utils.randomSecretKey();
    assert.equal(verifyWalletControl(wallet, msg, evmPersonalSign(other, msg)), false);
  });
});
