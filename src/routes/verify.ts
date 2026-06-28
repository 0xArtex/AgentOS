import { Router, Request, Response } from "express";
import crypto from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { db } from "../db";

const router = Router({ mergeParams: true });

// ─── Signature verification ───────────────────────────────────────────────
// Previously /respond accepted ANY signature and issued a WALLET_VERIFIED badge.
// We now cryptographically verify the signature over the issued challenge against
// the agent's registered wallet before granting any verified status:
//   • Solana (base58 address) → Ed25519 via tweetnacl
//   • EVM    (0x… address)    → secp256k1 / EIP-191 personal_sign via @noble

// EIP-191 "personal_sign" digest. The 0x19 prefix byte and the trailing newline
// are emitted as numeric bytes so no control characters live in this source file.
const ETH_PREFIX_TEXT = "Ethereum Signed Message:" + String.fromCharCode(10);
function eip191Hash(message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  const head = new TextEncoder().encode(ETH_PREFIX_TEXT + msg.length);
  const full = new Uint8Array(1 + head.length + msg.length);
  full[0] = 0x19;
  full.set(head, 1);
  full.set(msg, 1 + head.length);
  return keccak_256(full);
}

function evmAddressFromPubkey(pubUncompressed: Uint8Array): string {
  // Drop the 0x04 prefix, keccak256, take the last 20 bytes.
  const hash = keccak_256(pubUncompressed.subarray(1));
  return "0x" + Buffer.from(hash.subarray(hash.length - 20)).toString("hex");
}

function isEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function verifyEvmSignature(message: string, signature: string, walletAddress: string): boolean {
  try {
    const hex = signature.startsWith("0x") ? signature.slice(2) : signature;
    if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
    const raw = Buffer.from(hex, "hex");
    if (raw.length !== 65) return false; // r(32) + s(32) + v(1)
    let v = raw[64];
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return false;
    const sig = secp256k1.Signature.fromBytes(raw.subarray(0, 64), "compact").addRecoveryBit(v);
    const recovered = sig.recoverPublicKey(eip191Hash(message)).toBytes(false);
    return evmAddressFromPubkey(recovered).toLowerCase() === walletAddress.toLowerCase();
  } catch {
    return false;
  }
}

function verifySolanaSignature(message: string, signature: string, walletAddress: string): boolean {
  try {
    const msg = new TextEncoder().encode(message);
    const sig = bs58.decode(signature);
    const pub = bs58.decode(walletAddress);
    if (pub.length !== 32 || sig.length !== 64) return false;
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}

function verifyWalletSignature(message: string, signature: string, walletAddress: string): boolean {
  if (!message || !signature || !walletAddress) return false;
  return isEvmAddress(walletAddress)
    ? verifyEvmSignature(message, signature, walletAddress)
    : verifySolanaSignature(message, signature, walletAddress);
}

// In-memory challenge store (TTL 5 min)
const challenges = new Map<string, { agentId: string; walletAddress: string | null; challenge: string; expiresAt: number }>();

/**
 * POST /agents/verify/challenge — Request a verification challenge
 */
router.post("/challenge", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) {
    res.status(401).json({ error: "Missing X-Agent-Id header" });
    return;
  }

  const agent = db.prepare("SELECT id, name, wallet_address FROM agents WHERE id = ? OR name = ?").get(agentId, agentId) as any;
  if (!agent) {
    res.status(404).json({ error: "Agent not found", hint: "Register first via POST /api/agents/register" });
    return;
  }

  const challenge = crypto.randomBytes(32).toString("hex");
  const token = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 5 * 60 * 1000;

  challenges.set(token, {
    agentId: agent.id.toString(),
    walletAddress: agent.wallet_address || null,
    challenge,
    expiresAt,
  });

  // Cleanup expired
  for (const [k, v] of challenges) {
    if (v.expiresAt < Date.now()) challenges.delete(k);
  }

  res.json({
    challengeToken: token,
    challenge,
    expiresIn: "5 minutes",
    instructions: {
      step1: "Sign the EXACT challenge string with your wallet key (Ed25519 for Solana, EIP-191 personal_sign for EVM)",
      step2: "POST /api/agents/verify/respond with { challengeToken, signature }",
      step3: "On a valid signature you receive a verified badge",
    },
    agent: { id: agent.id, name: agent.name, walletAddress: agent.wallet_address || null },
  });
});

/**
 * POST /agents/verify/respond — Submit signed challenge for verification
 */
router.post("/respond", (req: Request, res: Response) => {
  const { challengeToken, signature } = req.body || {};

  if (!challengeToken || !signature) {
    res.status(400).json({
      error: "Missing fields",
      required: ["challengeToken", "signature"],
      hint: "Sign the challenge from /challenge and submit here",
    });
    return;
  }

  const entry = challenges.get(challengeToken);
  if (!entry) {
    res.status(404).json({ error: "Challenge not found or expired", hint: "Request a new challenge via POST /api/agents/verify/challenge" });
    return;
  }

  if (entry.expiresAt < Date.now()) {
    challenges.delete(challengeToken);
    res.status(410).json({ error: "Challenge expired", hint: "Request a new one" });
    return;
  }

  if (!entry.walletAddress) {
    res.status(400).json({
      error: "No wallet linked to this agent",
      hint: "Link a wallet_address to the agent before requesting a WALLET_VERIFIED badge",
    });
    return;
  }

  // Actually verify the signature over the issued challenge against the agent's
  // registered wallet. Invalid/forged signatures are rejected here.
  const ok = verifyWalletSignature(entry.challenge, String(signature), entry.walletAddress);
  if (!ok) {
    res.status(401).json({
      error: "Signature verification failed",
      hint: "Signature must be over the exact challenge string and produced by the agent's registered wallet key",
    });
    return;
  }

  // Single-use: consume the challenge only after a successful verification.
  challenges.delete(challengeToken);

  const verificationId = crypto.randomBytes(8).toString("hex");

  res.json({
    verified: true,
    verificationId,
    agentId: entry.agentId,
    walletAddress: entry.walletAddress,
    badge: "WALLET_VERIFIED",
    message: "Agent wallet ownership verified via cryptographic challenge-response",
  });
});

/**
 * GET /agents/verify/status/:agentId — Check verification status
 */
router.get("/status/:agentId", (req: Request, res: Response) => {
  const { agentId } = req.params;

  const agent = db.prepare("SELECT id, name, wallet_address, created_at FROM agents WHERE id = ? OR name = ?").get(agentId, agentId) as any;
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json({
    agentId: agent.id,
    name: agent.name,
    walletLinked: !!agent.wallet_address,
    walletAddress: agent.wallet_address || null,
    verificationMethods: [
      { method: "wallet_challenge", available: !!agent.wallet_address },
      { method: "api_key_auth", available: true },
    ],
    registeredAt: agent.created_at,
  });
});

export default router;
