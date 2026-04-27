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
  solanaPublicKey: string,
  domain?: string
): EmailInbox & { decryptionGuide: object } {
  const localPart = name.toLowerCase().replace(/[^a-z0-9\-_.]/g, "");
  if (!localPart) throw new Error("Invalid inbox name");

  const targetDomain = (domain && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain))
    ? domain.toLowerCase()
    : config.emailDomain;
  const address = `${localPart}@${targetDomain}`;

  if (storage.hasEmailAddress(address)) {
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

  await sendOutboundEmail(inbox.address, to, subject, body, html);

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

/**
 * Outbound email backend. Resend is primary; if RESEND_API_KEY is unset and
 * MAIL_WORKER_URL is set, fall back to the legacy Cloudflare-Worker proxy.
 * No more direct MailChannels API calls — that path was deprecated for
 * non-Worker traffic mid-2024.
 */
async function sendOutboundEmail(
  from: string,
  to: string,
  subject: string,
  body: string,
  html?: string
): Promise<void> {
  const { isResendConfigured, sendEmailViaResend } = await import("./resend");
  if (isResendConfigured()) {
    await sendEmailViaResend({ from, to, subject, body, html });
    return;
  }

  // Legacy fallback: a Cloudflare Worker that proxies to MailChannels.
  // Only used when RESEND_API_KEY is unset AND a worker URL is configured.
  const workerUrl = config.mailWorkerUrl;
  if (workerUrl) {
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: "AgentOS" },
      subject,
      content: [
        { type: "text/plain", value: body },
        ...(html ? [{ type: "text/html", value: html }] : []),
      ],
    };
    const resp = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) return;
    const text = await resp.text();
    throw new Error(`Email worker send failed: ${resp.status} — ${text.slice(0, 200)}`);
  }

  throw new Error("Email send unavailable: set RESEND_API_KEY in env (or MAIL_WORKER_URL for the legacy CF-Worker fallback)");
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
// Block any IP in these ranges — covers loopback, private networks,
// link-local (cloud metadata at 169.254.169.254), CGNAT, and benchmarks.
function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // 127.0.0.0/8 loopback
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 169 && b === 254) return true;         // 169.254.0.0/16 link-local (incl. AWS IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarks
  if (a >= 224) return true;                       // multicast + reserved
  return false;
}

function parseIPv4(s: string): number[] | null {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return null;
  const parts = s.split(".").map(p => parseInt(p, 10));
  if (parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return parts;
}

function isPrivateIPv6(s: string): boolean {
  const lower = s.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::" || lower === "::1") return true;                 // unspecified + loopback
  if (lower.startsWith("fe80")) return true;                           // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;   // unique local
  if (lower.startsWith("ff")) return true;                             // multicast
  // IPv4-mapped: ::ffff:127.0.0.1 — check the embedded v4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
  if (mapped) {
    const parts = parseIPv4(mapped[1]);
    return parts ? isPrivateIPv4(parts) : true;
  }
  return false;
}

/**
 * Quick synchronous check against the URL itself. Rejects numeric-IP forms,
 * literal loopback hosts, and any hostname that's already an IP in a private
 * range. Use together with `fetchSsrfSafe()` (below) which re-checks after
 * DNS resolution and on every redirect.
 */
export function isSsrfSafe(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.toLowerCase();

    // Block obvious hostname forms that map to localhost.
    if (hostname === 'localhost' || hostname === 'localhost.localdomain') return false;
    if (hostname.endsWith('.localhost')) return false;

    // Numeric-IP encodings that bypass naive string checks (decimal, octal, hex).
    // If it parses as a non-negative finite number, it's an IP in disguise.
    if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname) || /^0[0-7]+$/.test(hostname)) {
      return false;
    }

    // IPv4 literal?
    const v4 = parseIPv4(hostname);
    if (v4) return !isPrivateIPv4(v4);

    // IPv6 literal (URL strips brackets; allow both)
    const v6Candidate = hostname.includes(':') ? hostname : null;
    if (v6Candidate) return !isPrivateIPv6(v6Candidate);

    return true; // hostname — caller must still re-check after DNS resolve
  } catch { return false; }
}

/**
 * Perform an HTTPS GET with full SSRF protection:
 *   1. Reject the URL if it's already a private IP / numeric-IP / non-HTTPS.
 *   2. Resolve the hostname and re-check all returned IPs against private ranges.
 *   3. Manually follow redirects, re-applying the same checks at each hop.
 *   4. Enforce a hard response-size ceiling and abort timeout.
 *
 * Use this instead of bare `fetch()` whenever the URL comes from a user.
 */
export async function fetchSsrfSafe(
  urlStr: string,
  opts: { timeoutMs?: number; maxRedirects?: number; maxBytes?: number } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024; // 20 MB

  const { promises: dns } = await import('dns');

  let current = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isSsrfSafe(current)) {
      throw new Error(`SSRF guard: URL rejected (${current})`);
    }

    const parsed = new URL(current);

    // Only re-resolve when the host is a name (not an already-validated IP literal).
    if (!parseIPv4(parsed.hostname) && !parsed.hostname.includes(':')) {
      const records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
      for (const rec of records) {
        if (rec.family === 4) {
          const v4 = parseIPv4(rec.address);
          if (!v4 || isPrivateIPv4(v4)) {
            throw new Error(`SSRF guard: ${parsed.hostname} resolves to private IP ${rec.address}`);
          }
        } else if (rec.family === 6) {
          if (isPrivateIPv6(rec.address)) {
            throw new Error(`SSRF guard: ${parsed.hostname} resolves to private IP ${rec.address}`);
          }
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(current, { signal: controller.signal, redirect: 'manual' });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) throw new Error('SSRF guard: redirect without Location header');
      // Resolve relative Location against the current URL
      current = new URL(location, current).toString();
      continue;
    }

    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > maxBytes) {
      throw new Error(`SSRF guard: response too large (${contentLength} > ${maxBytes})`);
    }
    return resp;
  }
  throw new Error(`SSRF guard: too many redirects (> ${maxRedirects})`);
}
