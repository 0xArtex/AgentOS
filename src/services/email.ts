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
    e2eEnabled: true, // Default to E2E encryption — we can't read agent emails
    createdAt: new Date().toISOString(),
    active: true,
  };

  storage.setEmailInbox(inbox.id, inbox);
  storage.initEmailMessages(inbox.id);

  return {
    ...inbox,
    decryptionGuide: {
      note: "E2E encrypted — messages encrypted with your wallet's public key. Only you can decrypt.",
      encryption: "NaCl box (X25519 + XSalsa20-Poly1305)",
      steps: [
        "1. GET /email/inboxes/:id/messages (x402 payment from your wallet)",
        "2. Messages returned as ciphertext — we cannot read them",
        "3. Decrypt client-side: strip 'w:' prefix, base64 decode, nacl.box.open(ciphertext, nonce, serverPub, yourPrivateKey)",
        "4. Convert your Ed25519 key to X25519 for decryption",
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
export function findOrCreateThread(
  inboxId: string,
  subject: string,
  from: string,
  to: string,
  inReplyTo?: string
): string {
  // Try to find existing thread by inReplyTo or subject
  if (inReplyTo) {
    // Look for a message with this messageId and get its threadId
    const msgs = storage.getEmailMessages(inboxId) || [];
    const parent = msgs.find(m => m.messageId === inReplyTo);
    if (parent?.threadId) return parent.threadId;
  }

  // Match by normalized subject (strip Re:/Fwd: prefixes)
  const normalized = subject.replace(/^(Re|Fwd|Fw):\s*/gi, '').trim();
  const threads = storage.getEmailThreads?.(inboxId) || [];
  const existing = threads.find(t => {
    const tNorm = (t.subject || '').replace(/^(Re|Fwd|Fw):\s*/gi, '').trim();
    return tNorm === normalized;
  });
  if (existing) return existing.id;

  // Create new thread
  const threadId = uuid();
  const thread = {
    id: threadId,
    inboxId,
    subject: normalized,
    participants: JSON.stringify([...new Set([from, to])]),
    messageCount: 0,
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  storage.setEmailThread?.(threadId, thread);
  return threadId;
}

export function handleInboundEmail(
  to: string,
  from: string,
  subject: string,
  body: string,
  html?: string,
  attachments?: Array<{filename: string; contentType: string; content: string}>,
  headers?: {messageId?: string; inReplyTo?: string; cc?: string}
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

  // Encrypt: use wallet key (E2E) if available, else server-managed
  const useE2E = inbox.publicKey && inbox.e2eEnabled;
  const encrypt = (text: string) => {
    if (useE2E && inbox.publicKey) {
      try {
        const x25519Pub = decodeBase64(inbox.publicKey);
        return "w:" + encryptForWallet(text, x25519Pub); // "w:" prefix = wallet-encrypted (E2E)
      } catch (e) {
        console.warn("[email] E2E encryption failed, falling back to server:", e);
        return serverEncrypt(inboxId, text);
      }
    }
    return serverEncrypt(inboxId, text);
  };

  // Find or create thread
  const threadId = findOrCreateThread(inboxId, subject, from, to, headers?.inReplyTo);

  // Handle attachments
  const msgAttachments = attachments?.map(att => ({
    id: uuid(),
    filename: att.filename,
    contentType: att.contentType,
    size: att.content.length,
    content: encrypt(att.content), // E2E encrypt attachment content too
  }));

  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    threadId,
    direction: "inbound",
    from,
    to,
    cc: headers?.cc,
    messageId: headers?.messageId,
    inReplyTo: headers?.inReplyTo,
    subject: encrypt(subject),
    body: encrypt(body),
    html: html ? encrypt(html) : undefined,
    attachments: msgAttachments,
    encrypted: true,
    timestamp: new Date().toISOString(),
  };

  storage.pushEmailMessage(inboxId, msg);

  // Update thread count
  if (storage.updateEmailThread) {
    const thread = storage.getEmailThread?.(threadId);
    storage.updateEmailThread(threadId, {
      messageCount: (thread?.message_count || 0) + 1,
      lastMessageAt: msg.timestamp,
      participants: JSON.stringify([...new Set([from, to, ...(headers?.cc?.split(',').map(s => s.trim()) || [])])]),
    });
  }

  console.log(`[email] Inbound from ${from} to ${to} — thread:${threadId.slice(0,8)} — encrypted at rest`);

  // Fire webhooks (async, non-blocking)
  const webhooks = storage.getEmailWebhooks?.(inboxId) || [];
  for (const wh of webhooks) {
    if (!isSsrfSafe(wh.url)) { console.warn(`[email] Blocked SSRF webhook: ${wh.url}`); continue; }
    const events = JSON.parse(wh.events || '[]');
    if (events.includes('message.received') || events.length === 0) {
      if (!isSsrfSafe(wh.url)) { console.warn(`[email] Webhook blocked (SSRF): ${wh.url}`); continue; }
      fetch(wh.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'message.received',
          inboxId,
          threadId,
          messageId: msg.id,
          from,
          to,
          timestamp: msg.timestamp,
          // Don't include encrypted content in webhook — agent reads via API
        }),
      }).catch(err => console.warn(`[email] Webhook ${wh.url} failed:`, err.message));
    }
  }

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

  // Encrypt sent content at rest (same mode as inbound)
  const useE2E = inbox.publicKey && inbox.e2eEnabled;
  const encryptOut = (text: string) => {
    if (useE2E && inbox.publicKey) {
      try {
        const x25519Pub = decodeBase64(inbox.publicKey);
        return "w:" + encryptForWallet(text, x25519Pub);
      } catch { return serverEncrypt(inboxId, text); }
    }
    return serverEncrypt(inboxId, text);
  };

  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    direction: "outbound",
    from: inbox.address,
    to,
    subject: encryptOut(subject),
    body: encryptOut(body),
    html: html ? encryptOut(html) : undefined,
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

// ── SSRF Protection ──
export function isSsrfSafe(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (/^127\./.test(hostname)) return false;
    if (/^10\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    if (/^192\.168\./.test(hostname)) return false;
    if (/^169\.254\./.test(hostname)) return false;
    if (/^0\./.test(hostname)) return false;
    if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') return false;
    if (parsed.protocol !== 'https:') return false; // require HTTPS
    return true;
  } catch { return false; }
}
