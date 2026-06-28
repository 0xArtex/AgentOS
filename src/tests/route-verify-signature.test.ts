/**
 * Regression tests for /api/agents/verify — it previously issued a
 * WALLET_VERIFIED badge for ANY signature. It must now actually verify the
 * signature over the issued challenge against the agent's registered wallet:
 *   • Solana wallet (base58) → Ed25519
 *   • EVM wallet (0x…)       → secp256k1 / EIP-191 personal_sign
 * Invalid, forged, wrong-wallet, or missing signatures are rejected.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { db } from "../db";
import verifyRouter from "../routes/verify";

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

// Mirror the route's EIP-191 digest so the test can sign as a real EVM wallet.
const ETH_PREFIX = "Ethereum Signed Message:" + String.fromCharCode(10);
function eip191Hash(message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  const head = new TextEncoder().encode(ETH_PREFIX + msg.length);
  const full = new Uint8Array(1 + head.length + msg.length);
  full[0] = 0x19;
  full.set(head, 1);
  full.set(msg, 1 + head.length);
  return keccak_256(full);
}
function evmAddress(pubUncompressed: Uint8Array): string {
  const h = keccak_256(pubUncompressed.subarray(1));
  return "0x" + Buffer.from(h.subarray(h.length - 20)).toString("hex");
}
function signEvm(message: string, priv: Uint8Array): string {
  const h = eip191Hash(message);
  const sig64 = secp256k1.sign(h, priv, { prehash: false });
  let rec = 0;
  const addr = evmAddress(secp256k1.getPublicKey(priv, false)).toLowerCase();
  for (const r of [0, 1]) {
    const p = secp256k1.Signature.fromBytes(sig64, "compact").addRecoveryBit(r).recoverPublicKey(h).toBytes(false);
    if (evmAddress(p).toLowerCase() === addr) rec = r;
  }
  const rsv = new Uint8Array(65);
  rsv.set(sig64, 0);
  rsv[64] = 27 + rec;
  return "0x" + Buffer.from(rsv).toString("hex");
}

function insertAgent(name: string, wallet: string | null): void {
  db.prepare(
    "INSERT INTO agents (id, name, wallet_address, token, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(name, name, wallet, "agt_" + crypto.randomBytes(8).toString("hex"));
}

describe("verify route signature verification", () => {
  let server: http.Server;
  let port: number;
  const suffix = Date.now().toString(36);

  // Solana agent
  const solKp = nacl.sign.keyPair();
  const solWallet = bs58.encode(Buffer.from(solKp.publicKey));
  const solAgent = `sol-agent-${suffix}`;

  // EVM agent
  const evmPriv = secp256k1.utils.randomSecretKey();
  const evmWallet = evmAddress(secp256k1.getPublicKey(evmPriv, false));
  const evmAgent = `evm-agent-${suffix}`;

  // Wallet-less agent
  const noWalletAgent = `now-agent-${suffix}`;

  before(async () => {
    insertAgent(solAgent, solWallet);
    insertAgent(evmAgent, evmWallet);
    insertAgent(noWalletAgent, null);

    const app = express();
    app.use(express.json());
    app.use("/api/agents/verify", verifyRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  after(async () => {
    db.prepare("DELETE FROM agents WHERE name IN (?, ?, ?)").run(solAgent, evmAgent, noWalletAgent);
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function getChallenge(agent: string): Promise<{ token: string; challenge: string }> {
    const { status, json } = await request(port, "POST", "/api/agents/verify/challenge", {}, { "x-agent-id": agent });
    assert.equal(status, 200, JSON.stringify(json));
    return { token: json.challengeToken, challenge: json.challenge };
  }

  it("verifies a valid Solana Ed25519 signature", async () => {
    const { token, challenge } = await getChallenge(solAgent);
    const sig = bs58.encode(Buffer.from(nacl.sign.detached(new TextEncoder().encode(challenge), solKp.secretKey)));
    const { status, json } = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: token, signature: sig });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.verified, true);
    assert.equal(json.badge, "WALLET_VERIFIED");
    assert.equal(json.walletAddress, solWallet);
  });

  it("verifies a valid EVM EIP-191 signature", async () => {
    const { token, challenge } = await getChallenge(evmAgent);
    const sig = signEvm(challenge, evmPriv);
    const { status, json } = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: token, signature: sig });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.verified, true);
    assert.equal(json.walletAddress.toLowerCase(), evmWallet.toLowerCase());
  });

  it("rejects a forged/garbage Solana signature", async () => {
    const { token } = await getChallenge(solAgent);
    const sig = bs58.encode(Buffer.from(new Uint8Array(64))); // all-zero signature
    const { status, json } = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: token, signature: sig });
    assert.equal(status, 401, JSON.stringify(json));
    assert.equal(json.verified, undefined);
  });

  it("rejects a signature over a different message", async () => {
    const { token } = await getChallenge(evmAgent);
    const sig = signEvm("not-the-challenge", evmPriv);
    const { status } = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: token, signature: sig });
    assert.equal(status, 401);
  });

  it("rejects a valid signature from the WRONG wallet", async () => {
    // Sign the sol agent's challenge with a different keypair.
    const { token, challenge } = await getChallenge(solAgent);
    const otherKp = nacl.sign.keyPair();
    const sig = bs58.encode(Buffer.from(nacl.sign.detached(new TextEncoder().encode(challenge), otherKp.secretKey)));
    const { status } = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: token, signature: sig });
    assert.equal(status, 401);
  });

  it("rejects when the agent has no linked wallet", async () => {
    const { token } = await getChallenge(noWalletAgent);
    const { status, json } = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: token, signature: "anything" });
    assert.equal(status, 400);
    assert.match(String(json.error), /no wallet/i);
  });

  it("rejects a missing signature", async () => {
    const { token } = await getChallenge(solAgent);
    const { status } = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: token });
    assert.equal(status, 400);
  });

  it("rejects an unknown challenge token", async () => {
    const { status } = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: "deadbeef", signature: "x" });
    assert.equal(status, 404);
  });

  it("consumes the challenge on success (single-use)", async () => {
    const { token, challenge } = await getChallenge(solAgent);
    const sig = bs58.encode(Buffer.from(nacl.sign.detached(new TextEncoder().encode(challenge), solKp.secretKey)));
    const first = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: token, signature: sig });
    assert.equal(first.status, 200);
    const second = await request(port, "POST", "/api/agents/verify/respond", { challengeToken: token, signature: sig });
    assert.equal(second.status, 404);
  });
});
