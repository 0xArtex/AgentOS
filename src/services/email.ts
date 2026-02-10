import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";
import { ed25519 } from "@noble/curves/ed25519";

import bs58 from "bs58";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { EmailInbox, EmailMessage } from "../types";
import { storage } from "./storage";

// ── Ed25519 → X25519 conversion ────────────────────────────

/**
 * Convert an Ed25519 public key to X25519 (Curve25519) public key.
 * This allows encrypting messages to a Solana wallet holder.
 */
function ed25519PubToX25519(ed25519Pub: Uint8Array): Uint8Array {
  // Use TweetNaCl's built-in conversion if available,
  // otherwise use the standard birational map
  // nacl.sign has the conversion: nacl internally uses this
  // We use the montgomery form conversion from ed25519
  
  // The standard conversion from ed25519 point to curve25519 point:
  // Given ed25519 point (x, y), curve25519 u = (1 + y) / (1 - y) mod p
  const p = BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819949");
  
  // Extract y coordinate from ed25519 public key (it's encoded as y with sign bit)
  let y = BigInt(0);
  for (let i = 0; i < 32; i++) {
    y += BigInt(ed25519Pub[i]) << BigInt(8 * i);
  }
  // Clear the sign bit
  y &= (BigInt(1) << BigInt(255)) - BigInt(1);
  
  // u = (1 + y) * inverse(1 - y) mod p
  const one = BigInt(1);
  const numerator = (one + y) % p;
  const denominator = (p + one - (y % p)) % p;
  
  // Modular inverse using Fermat's little theorem: a^(p-2) mod p
  function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = BigInt(1);
    base = base % mod;
    while (exp > BigInt(0)) {
      if (exp % BigInt(2) === BigInt(1)) {
        result = (result * base) % mod;
      }
      exp = exp >> BigInt(1);
      base = (base * base) % mod;
    }
    return result;
  }
  
  const inverse = modPow(denominator, p - BigInt(2), p);
  const u = (numerator * inverse) % p;
  
  // Convert back to bytes (little-endian)
  const result = new Uint8Array(32);
  let val = u;
  for (let i = 0; i < 32; i++) {
    result[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  
  return result;
}

/**
 * Verify an Ed25519 signature (Solana wallet signature).
 */
function verifySignature(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  return nacl.sign.detached.verify(message, signature, publicKey);
}

// ── Encryption helpers ──────────────────────────────────────

/**
 * Encrypt plaintext using the inbox's X25519 public key (derived from Solana wallet).
 * Uses an ephemeral keypair — only the wallet holder can decrypt.
 */
function encryptForWallet(plaintext: string, x25519PubKey: Uint8Array): string {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);

  const encrypted = nacl.box(messageBytes, nonce, x25519PubKey, ephemeral.secretKey);
  if (!encrypted) throw new Error("Encryption failed");

  // Pack: ephemeralPublicKey (32) + nonce (24) + ciphertext
  const packed = new Uint8Array(32 + 24 + encrypted.length);
  packed.set(ephemeral.publicKey, 0);
  packed.set(nonce, 32);
  packed.set(encrypted, 56);

  return encodeBase64(packed);
}

// ── Email Service ───────────────────────────────────────────

/**
 * Create an E2E encrypted inbox tied to a Solana wallet.
 * The wallet's Ed25519 public key is converted to X25519 for encryption.
 * No private key is generated or stored — the agent's Solana wallet IS the key.
 */
export function createInbox(
  name: string,
  owner: string,
  solanaPublicKey: string
): EmailInbox & { decryptionGuide: object } {
  const localPart = name.toLowerCase().replace(/[^a-z0-9\-_.]/g, "");
  if (!localPart) throw new Error("Invalid inbox name");

  const address = `${localPart}@${config.emailDomain}`;

  if (storage.hasEmailLocalPart(localPart)) {
    throw new Error(`Inbox ${address} already exists`);
  }

  // Decode Solana public key (base58) and convert to X25519
  let ed25519Pub: Uint8Array;
  try {
    ed25519Pub = bs58.decode(solanaPublicKey);
    if (ed25519Pub.length !== 32) throw new Error("Invalid key length");
  } catch {
    throw new Error("Invalid Solana public key (expected base58-encoded Ed25519 key)");
  }

  const x25519Pub = ed25519PubToX25519(ed25519Pub);
  const publicKeyB64 = encodeBase64(x25519Pub);

  const inbox: EmailInbox = {
    id: uuid(),
    address,
    localPart,
    owner,
    publicKey: publicKeyB64,
    solanaPublicKey,
    createdAt: new Date().toISOString(),
    active: true,
  };

  storage.setEmailInbox(inbox.id, inbox);
  storage.initEmailMessages(inbox.id);

  return {
    ...inbox,
    decryptionGuide: {
      note: "Your Solana wallet IS your email key. No separate key needed.",
      steps: [
        "1. GET /email/inboxes/:id/messages (auth via x402 or hackathon header)",
        "2. Receive encrypted email blobs",
        "3. Decrypt client-side: ed25519PrivateKey → X25519 → nacl.box.open()",
      ],
      algorithm: "X25519 + XSalsa20-Poly1305 (NaCl box)",
      sdkExample: `import nacl from 'tweetnacl'; 
// Convert your Solana keypair's secret key (first 32 bytes) to X25519
// Then use nacl.box.open() to decrypt each message`,
    },
  };
}

/**
 * Generate a challenge for wallet authentication.
 * Agent signs this with their Solana wallet to prove ownership.
 */
export function generateChallenge(inboxId: string): { challenge: string; expiresAt: string } {
  const timestamp = Date.now();
  const nonce = encodeBase64(nacl.randomBytes(16));
  const challenge = `agentos-email:${inboxId}:${timestamp}:${nonce}`;
  const expiresAt = new Date(timestamp + 5 * 60 * 1000).toISOString(); // 5 min expiry

  // Store challenge temporarily
  storage.setEmailChallenge(inboxId, challenge, timestamp + 5 * 60 * 1000);

  return { challenge, expiresAt };
}

/**
 * Verify a wallet signature against a challenge.
 * Returns true if the signature is valid and the challenge hasn't expired.
 */
export function verifyWalletAuth(
  inboxId: string,
  challenge: string,
  signatureB58: string
): boolean {
  const inbox = storage.getEmailInbox(inboxId);
  if (!inbox || !inbox.solanaPublicKey) throw new Error("Inbox not found");

  // Verify challenge exists and hasn't expired
  const stored = storage.getEmailChallenge(inboxId);
  if (!stored || stored.challenge !== challenge) throw new Error("Invalid or expired challenge");
  if (Date.now() > stored.expiresAt) {
    storage.deleteEmailChallenge(inboxId);
    throw new Error("Challenge expired");
  }

  // Verify Ed25519 signature
  const pubKey = bs58.decode(inbox.solanaPublicKey);
  const message = new TextEncoder().encode(challenge);
  let signature: Uint8Array;
  try {
    signature = bs58.decode(signatureB58);
  } catch {
    // Try base64
    signature = decodeBase64(signatureB58);
  }

  const valid = verifySignature(message, signature, pubKey);
  if (!valid) throw new Error("Invalid signature — wallet does not match inbox owner");

  // Delete used challenge (one-time use)
  storage.deleteEmailChallenge(inboxId);
  return true;
}

/**
 * Get encrypted messages for an inbox.
 */
export function getMessages(inboxId: string): EmailMessage[] {
  const msgs = storage.getEmailMessages(inboxId);
  if (!msgs) throw new Error(`Inbox ${inboxId} not found`);
  return msgs;
}

/**
 * Handle inbound email — encrypt with wallet's public key immediately.
 */
export function handleInboundEmail(
  to: string,
  from: string,
  subject: string,
  body: string,
  html?: string
): EmailMessage | null {
  const match = to.match(/^([^@]+)@/);
  if (!match) return null;

  const localPart = match[1].toLowerCase();
  const inboxId = storage.getEmailInboxByLocalPart(localPart);
  if (!inboxId) {
    console.warn(`[email] Inbound email to unknown address: ${to}`);
    return null;
  }

  const inbox = storage.getEmailInbox(inboxId);
  if (!inbox || !inbox.publicKey) {
    console.warn(`[email] Inbox ${inboxId} has no public key`);
    return null;
  }

  // Decrypt the X25519 public key
  const x25519Pub = decodeBase64(inbox.publicKey);

  // Encrypt everything before storage — plaintext NEVER touches disk
  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    direction: "inbound",
    from, // sender address is metadata (needed for filtering)
    to,
    subject: encryptForWallet(subject, x25519Pub),
    body: encryptForWallet(body, x25519Pub),
    html: html ? encryptForWallet(html, x25519Pub) : undefined,
    encrypted: true,
    timestamp: new Date().toISOString(),
  };

  storage.pushEmailMessage(inboxId, msg);
  console.log(`[email] Inbound from ${from} to ${to} — encrypted with wallet key and stored`);
  return msg;
}

/**
 * Send email — verify wallet ownership via signature first.
 */
export async function sendEmail(
  inboxId: string,
  to: string,
  subject: string,
  body: string,
  html?: string
): Promise<EmailMessage> {
  const inbox = storage.getEmailInbox(inboxId);
  if (!inbox) throw new Error(`Inbox ${inboxId} not found`);
  if (!inbox.active) throw new Error("Inbox is deactivated");

  // Send via MailChannels
  await sendViaMailChannels(inbox.address, to, subject, body, html);

  // Encrypt sent content before storing
  const x25519Pub = decodeBase64(inbox.publicKey);
  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    direction: "outbound",
    from: inbox.address,
    to,
    subject: encryptForWallet(subject, x25519Pub),
    body: encryptForWallet(body, x25519Pub),
    html: html ? encryptForWallet(html, x25519Pub) : undefined,
    encrypted: true,
    timestamp: new Date().toISOString(),
  };

  storage.pushEmailMessage(inboxId, msg);
  return msg;
}

/**
 * Send via Cloudflare MailChannels API.
 */
async function sendViaMailChannels(
  from: string,
  to: string,
  subject: string,
  body: string,
  html?: string
): Promise<void> {
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from, name: "AgentOS" },
    subject,
    content: [
      { type: "text/plain", value: body },
      ...(html ? [{ type: "text/html", value: html }] : []),
    ],
  };

  const workerUrl = config.mailWorkerUrl;
  if (workerUrl) {
    const resp = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) return;
  }

  const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MailChannels send failed: ${resp.status} — ${text}`);
  }
}

export function getInbox(id: string): EmailInbox | undefined {
  return storage.getEmailInbox(id);
}

export function listInboxes(owner: string): EmailInbox[] {
  return storage.getEmailInboxesByOwner(owner);
}

// Re-export for route usage
export { encryptForWallet, verifySignature };
