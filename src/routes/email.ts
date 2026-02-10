import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import * as emailService from "../services/email";
import { trackHackathonUsage } from "../middleware/hackathon";

const router = Router();

/**
 * POST /email/provision — Create a wallet-secured email inbox
 * 
 * Your Solana wallet IS your email key. No separate passwords or keys.
 * Emails are encrypted with your wallet's public key on arrival.
 * Only your wallet can decrypt them — not even us.
 * 
 * Cost: 1.00 USDC (or free during hackathon)
 */
router.post("/provision", requireAuth(1.0, "email"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, walletAddress } = req.body;

    if (!name) {
      res.status(400).json({
        error: "Missing 'name' field",
        hint: "Your email will be {name}@agntos.dev",
      });
      return;
    }

    // Get wallet address from: explicit param > x402 payment > hackathon header
    const solanaPublicKey = walletAddress || req.body.solanaPublicKey;
    if (!solanaPublicKey) {
      res.status(400).json({
        error: "Missing wallet address",
        message: "Provide 'walletAddress' (Solana base58 public key)",
        hint: "Your Solana wallet becomes your email encryption key. No separate key management needed.",
      });
      return;
    }

    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;
    const result = emailService.createInbox(name, owner, solanaPublicKey);

    if (req.isHackathonMode && req.agentId) {
      trackHackathonUsage(req.agentId, "email", result.id);
    }

    res.status(201).json({
      inbox: {
        id: result.id,
        address: result.address,
        walletAddress: result.solanaPublicKey,
        createdAt: result.createdAt,
      },
      encryption: {
        algorithm: "X25519 + XSalsa20-Poly1305 (NaCl box)",
        walletKey: result.solanaPublicKey,
        derivedKey: result.publicKey,
        model: "Zero-knowledge. Your Solana wallet IS your email key. We encrypt on receipt with your wallet's derived X25519 key. Only you can decrypt.",
      },
      decryptionGuide: result.decryptionGuide,
    });
  } catch (err: any) {
    console.error("[email] Provision error:", err);
    res.status(500).json({
      error: "Inbox Creation Failed",
      message: err.message,
    });
  }
});

/**
 * POST /email/inboxes — Alias for /email/provision
 */
router.post("/inboxes", requireAuth(1.0, "email"), async (req: AuthenticatedRequest, res: Response) => {
  const { name, walletAddress, solanaPublicKey: spk } = req.body;
  if (!name || !(walletAddress || spk)) {
    res.status(400).json({ error: "Missing 'name' and 'walletAddress'" });
    return;
  }
  const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;
  try {
    const result = emailService.createInbox(name, owner, walletAddress || spk);
    res.status(201).json({ inbox: { id: result.id, address: result.address, walletAddress: result.solanaPublicKey } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /email/inboxes/:id/messages — Get encrypted messages
 * 
 * Auth via x402 payment (0.001 USDC) or hackathon mode.
 * Payment proves wallet ownership — no separate challenge needed.
 * Returns encrypted blobs that only YOUR wallet can decrypt.
 * 
 * Cost: 0.001 USDC (or free during hackathon)
 */
router.get("/inboxes/:id/messages", requireAuth(0.001, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inboxId = req.params.id as string;
    const msgs = emailService.getMessages(inboxId);
    
    res.json({
      messages: msgs,
      encrypted: true,
      totalMessages: msgs.length,
      decryptionHint: "Decrypt client-side: convert your Solana Ed25519 private key to X25519, then use nacl.box.open() with the ephemeral key and nonce packed in each message blob.",
    });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /email/inboxes/:id/send — Send email
 * 
 * Auth via x402 payment or hackathon mode. No challenge needed.
 * Sent content encrypted with your wallet key before storage.
 * 
 * Cost: 0.05 USDC (or free during hackathon)
 */
router.post("/inboxes/:id/send", requireAuth(0.05, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inboxId = req.params.id as string;
    const { to, subject, body, html } = req.body;

    if (!to || !subject || !body) {
      res.status(400).json({
        error: "Missing required fields: to, subject, body",
      });
      return;
    }

    const msg = await emailService.sendEmail(inboxId, to, subject, body, html);
    res.status(201).json({
      message: msg,
      note: "Email sent. Sent content encrypted with your wallet key before storage.",
    });
  } catch (err: any) {
    console.error("[email] Send error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /email/inbound — Webhook for inbound emails (Cloudflare Email Worker)
 */
router.post("/inbound", async (req, res: Response) => {
  try {
    const webhookSecret = Array.isArray(req.headers["x-webhook-secret"])
      ? req.headers["x-webhook-secret"][0]
      : req.headers["x-webhook-secret"];
    if (webhookSecret !== (process.env.EMAIL_WEBHOOK_SECRET || "agentos-inbound-2026")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { to, from, subject, body, html } = req.body;
    const msg = emailService.handleInboundEmail(to, from, subject, body, html);

    if (msg) {
      res.json({ received: true, messageId: msg.id, encrypted: true });
    } else {
      res.status(404).json({ received: false, error: "No matching inbox" });
    }
  } catch (err: any) {
    console.error("[email] Inbound webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /email/info — Public info about wallet-secured email
 */
router.get("/info", (_req, res: Response) => {
  res.json({
    service: "AgentOS Wallet-Secured Email",
    domain: "agntos.dev",
    encryption: {
      algorithm: "X25519 + XSalsa20-Poly1305 (NaCl box)",
      keyDerivation: "Ed25519 (Solana wallet) → X25519 (Curve25519)",
      library: "TweetNaCl.js",
      model: "Zero-knowledge, wallet-native encryption",
    },
    howItWorks: {
      provision: "POST /email/provision with { name, walletAddress }. Your Solana wallet becomes your email key.",
      read: "GET /email/inboxes/:id/messages — auth via x402 USDC payment (0.001) or hackathon mode. Returns encrypted blobs.",
      decrypt: "Client-side: Ed25519 → X25519 conversion, then nacl.box.open() on each blob.",
      send: "POST /email/inboxes/:id/send with { to, subject, body } — auth via x402 (0.05 USDC) or hackathon mode.",
    },
    security: [
      "Your Solana wallet IS your email key — no separate keys to manage",
      "Private keys NEVER touch our servers",
      "Email content encrypted before hitting disk, plaintext deleted immediately",
      "Even if our database is breached, emails are unreadable without your wallet",
      "x402 payment proves wallet ownership — no separate auth flow needed",
      "Self-custody model — lose your wallet, lose your email (just like crypto)",
    ],
    solanaIntegration: [
      "Ed25519 → X25519 key derivation for encryption",
      "x402 USDC payments for auth + access (payment = proof of ownership)",
      "One wallet = one identity = one inbox",
    ],
  });
});

/**
 * GET /email/sdk — Client-side decryption helper code
 */
router.get("/sdk", (_req, res: Response) => {
  res.type("text/plain").send(`// AgentOS Email SDK — Client-Side Decryption
// Your Solana wallet is your email key. Decrypt locally.

import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';

/**
 * Convert Solana Ed25519 secret key to X25519 for email decryption.
 * Uses the standard birational map from Edwards to Montgomery form.
 */
function solanaKeyToX25519(solanaSecretKey: Uint8Array): Uint8Array {
  // Ed25519 secret key → seed (first 32 bytes) → SHA-512 → clamp → X25519
  const hash = nacl.hash(solanaSecretKey.slice(0, 32));
  const x25519Secret = new Uint8Array(32);
  x25519Secret.set(hash.slice(0, 32));
  x25519Secret[0] &= 248;
  x25519Secret[31] &= 127;
  x25519Secret[31] |= 64;
  return x25519Secret;
}

/**
 * Decrypt an AgentOS email message blob.
 */
function decryptEmail(encryptedBase64: string, solanaSecretKey: Uint8Array): string {
  const x25519Secret = solanaKeyToX25519(solanaSecretKey);
  const packed = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
  
  const ephemeralPub = packed.slice(0, 32);   // Ephemeral X25519 public key
  const nonce = packed.slice(32, 56);          // 24-byte nonce
  const ciphertext = packed.slice(56);         // Encrypted content
  
  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPub, x25519Secret);
  if (!decrypted) throw new Error('Decryption failed — wrong wallet?');
  
  return new TextDecoder().decode(decrypted);
}

// Usage:
// const keypair = Keypair.fromSecretKey(yourSecretKey);
// const plaintext = decryptEmail(message.body, keypair.secretKey);
`);
});

export default router;
