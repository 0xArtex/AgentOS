import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

import bs58 from "bs58";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { EmailInbox, EmailMessage } from "../types";
import { storage } from "./storage";

// ── Server-side encryption (AES-256-GCM) ────────────────────

/**
 * Master secret for deriving per-inbox encryption keys.
 * In production, this should come from a KMS or HSM.
 * If not set, falls back to a deterministic key (less secure but functional).
 */
const MASTER_SECRET = process.env.EMAIL_MASTER_SECRET || "agentos-email-master-secret-2026";

/**
 * Derive a per-inbox AES-256 key from the master secret + inbox ID.
 * Each inbox gets a unique encryption key.
 */
function deriveInboxKey(inboxId: string): Buffer {
  return createHash("sha256")
    .update(MASTER_SECRET + ":" + inboxId)
    .digest();
}

/**
 * Encrypt plaintext with AES-256-GCM (server-managed key).
 * Returns: base64(iv:12 + authTag:16 + ciphertext)
 */
function serverEncrypt(inboxId: string, plaintext: string): string {
  const key = deriveInboxKey(inboxId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  
  // Pack: iv (12) + authTag (16) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return "s:" + packed.toString("base64"); // "s:" prefix = server-encrypted
}

/**
 * Decrypt server-encrypted message.
 * Handles both server-encrypted ("s:" prefix) and legacy wallet-encrypted messages.
 */
export function serverDecrypt(inboxId: string, encrypted: string): string {
  if (!encrypted) return "";
  
  // Server-encrypted messages have "s:" prefix
  if (encrypted.startsWith("s:")) {
    const key = deriveInboxKey(inboxId);
    const packed = Buffer.from(encrypted.slice(2), "base64");
    
    if (packed.length < 28) throw new Error("Invalid encrypted data");
    
    const iv = packed.subarray(0, 12);
    const authTag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }
  
  // Legacy wallet-encrypted — can't decrypt server-side
  throw new Error("wallet_encrypted");
}

// ── Ed25519 → X25519 conversion (kept for legacy compatibility) ──

function ed25519PubToX25519(ed25519Pub: Uint8Array): Uint8Array {
  const p = BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819949");
  
  let y = BigInt(0);
  for (let i = 0; i < 32; i++) {
    y += BigInt(ed25519Pub[i]) << BigInt(8 * i);
  }
  y &= (BigInt(1) << BigInt(255)) - BigInt(1);
  
  const one = BigInt(1);
  const numerator = (one + y) % p;
  const denominator = (p + one - (y % p)) % p;
  
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
  
  const result = new Uint8Array(32);
  let val = u;
  for (let i = 0; i < 32; i++) {
    result[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  
  return result;
}

// ── Wallet-based encryption (legacy, kept for old messages) ──

function encryptForWallet(plaintext: string, x25519PubKey: Uint8Array): string {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);

  const encrypted = nacl.box(messageBytes, nonce, x25519PubKey, ephemeral.secretKey);
  if (!encrypted) throw new Error("Encryption failed");

  const packed = new Uint8Array(32 + 24 + encrypted.length);
  packed.set(ephemeral.publicKey, 0);
  packed.set(nonce, 32);
  packed.set(encrypted, 56);

  return encodeBase64(packed);
}

// ── Email Service ───────────────────────────────────────────

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
      note: "Messages are encrypted at rest. Read them by paying $0.01 via x402 from your wallet.",
      steps: [
        "1. GET /email/inboxes/:id/messages (x402 payment of $0.01 from your wallet)",
        "2. Payment proves you own the inbox — server decrypts and returns messages",
        "3. Messages served over TLS, never stored in plaintext",
      ],
    },
  };
}

export function getMessages(inboxId: string): EmailMessage[] {
  const msgs = storage.getEmailMessages(inboxId);
  if (!msgs) throw new Error(`Inbox ${inboxId} not found`);
  return msgs;
}

/**
 * Handle inbound email — encrypt with server-managed key.
 * Uses AES-256-GCM with per-inbox derived key.
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
  if (!inbox) {
    console.warn(`[email] Inbox ${inboxId} not found`);
    return null;
  }

  // Encrypt with server-managed key (AES-256-GCM)
  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    direction: "inbound",
    from,
    to,
    subject: serverEncrypt(inboxId, subject),
    body: serverEncrypt(inboxId, body),
    html: html ? serverEncrypt(inboxId, html) : undefined,
    encrypted: true,
    timestamp: new Date().toISOString(),
  };

  storage.pushEmailMessage(inboxId, msg);
  console.log(`[email] Inbound from ${from} to ${to} — encrypted at rest and stored`);
  return msg;
}

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

  await sendViaMailChannels(inbox.address, to, subject, body, html);

  // Encrypt sent content at rest
  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    direction: "outbound",
    from: inbox.address,
    to,
    subject: serverEncrypt(inboxId, subject),
    body: serverEncrypt(inboxId, body),
    html: html ? serverEncrypt(inboxId, html) : undefined,
    encrypted: true,
    timestamp: new Date().toISOString(),
  };

  storage.pushEmailMessage(inboxId, msg);
  return msg;
}

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

export function generateChallenge(inboxId: string): { challenge: string; expiresAt: string } {
  const timestamp = Date.now();
  const nonce = encodeBase64(nacl.randomBytes(16));
  const challenge = `agentos-email:${inboxId}:${timestamp}:${nonce}`;
  const expiresAt = new Date(timestamp + 5 * 60 * 1000).toISOString();
  storage.setEmailChallenge(inboxId, challenge, timestamp + 5 * 60 * 1000);
  return { challenge, expiresAt };
}

export function verifyWalletAuth(
  inboxId: string,
  challenge: string,
  signatureB58: string
): boolean {
  const inbox = storage.getEmailInbox(inboxId);
  if (!inbox || !inbox.solanaPublicKey) throw new Error("Inbox not found");
  const stored = storage.getEmailChallenge(inboxId);
  if (!stored || stored.challenge !== challenge) throw new Error("Invalid or expired challenge");
  if (Date.now() > stored.expiresAt) {
    storage.deleteEmailChallenge(inboxId);
    throw new Error("Challenge expired");
  }
  const pubKey = bs58.decode(inbox.solanaPublicKey);
  const message = new TextEncoder().encode(challenge);
  let signature: Uint8Array;
  try { signature = bs58.decode(signatureB58); } catch { signature = decodeBase64(signatureB58); }
  const valid = nacl.sign.detached.verify(message, signature, pubKey);
  if (!valid) throw new Error("Invalid signature");
  storage.deleteEmailChallenge(inboxId);
  return true;
}

export { encryptForWallet };
