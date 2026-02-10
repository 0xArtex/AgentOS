import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { EmailInbox, EmailMessage } from "../types";
import { storage } from "./storage";

// ── Crypto helpers ──────────────────────────────────────────

/**
 * Generate an X25519 keypair for a new inbox.
 * The private key is returned to the agent and NEVER stored.
 */
function generateKeypair(): { publicKey: string; privateKey: string } {
  const kp = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(kp.publicKey),
    privateKey: encodeBase64(kp.secretKey),
  };
}

/**
 * Encrypt plaintext using the inbox's public key (NaCl box, sealed).
 * Uses an ephemeral keypair so only the private key holder can decrypt.
 */
function encryptForInbox(plaintext: string, publicKeyB64: string): string {
  const publicKey = decodeBase64(publicKeyB64);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);

  const encrypted = nacl.box(messageBytes, nonce, publicKey, ephemeral.secretKey);
  if (!encrypted) throw new Error("Encryption failed");

  // Pack: ephemeralPublicKey (32) + nonce (24) + ciphertext
  const packed = new Uint8Array(32 + 24 + encrypted.length);
  packed.set(ephemeral.publicKey, 0);
  packed.set(nonce, 32);
  packed.set(encrypted, 56);

  return encodeBase64(packed);
}

/**
 * Decrypt a message using the agent's private key.
 * Called client-side or via API with the agent's key.
 */
export function decryptMessage(encryptedB64: string, privateKeyB64: string): string {
  const packed = decodeBase64(encryptedB64);
  const privateKey = decodeBase64(privateKeyB64);

  const ephemeralPublicKey = packed.slice(0, 32);
  const nonce = packed.slice(32, 56);
  const ciphertext = packed.slice(56);

  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, privateKey);
  if (!decrypted) throw new Error("Decryption failed — invalid key or corrupted data");

  return new TextDecoder().decode(decrypted);
}

// ── Email Service ───────────────────────────────────────────

/**
 * Create a new E2E encrypted email inbox for an agent.
 * Returns the inbox info + the private key (shown once, never stored).
 */
export function createInbox(
  name: string,
  owner: string
): EmailInbox & { privateKey: string } {
  const localPart = name.toLowerCase().replace(/[^a-z0-9\-_.]/g, "");
  if (!localPart) throw new Error("Invalid inbox name");

  const address = `${localPart}@${config.emailDomain}`;

  if (storage.hasEmailLocalPart(localPart)) {
    throw new Error(`Inbox ${address} already exists`);
  }

  const { publicKey, privateKey } = generateKeypair();

  const inbox: EmailInbox = {
    id: uuid(),
    address,
    localPart,
    owner,
    publicKey,
    createdAt: new Date().toISOString(),
    active: true,
  };

  storage.setEmailInbox(inbox.id, inbox);
  storage.initEmailMessages(inbox.id);

  // Return inbox + private key (private key is NOT stored)
  return { ...inbox, privateKey };
}

/**
 * Get encrypted messages for an inbox.
 * Messages are encrypted — agent must decrypt with their private key.
 */
export function getMessages(inboxId: string): EmailMessage[] {
  const msgs = storage.getEmailMessages(inboxId);
  if (!msgs) throw new Error(`Inbox ${inboxId} not found`);
  return msgs;
}

/**
 * Decrypt messages using agent's private key.
 * Agent sends their key, we decrypt on-the-fly and return plaintext.
 * Key is never stored or logged.
 */
export function getDecryptedMessages(
  inboxId: string,
  privateKey: string
): Array<EmailMessage & { decryptedBody: string; decryptedSubject: string }> {
  const msgs = getMessages(inboxId);
  return msgs.map((msg) => {
    try {
      return {
        ...msg,
        decryptedSubject: msg.subject ? decryptMessage(msg.subject, privateKey) : "",
        decryptedBody: msg.body ? decryptMessage(msg.body, privateKey) : "",
      };
    } catch {
      return { ...msg, decryptedSubject: "[decrypt failed]", decryptedBody: "[decrypt failed]" };
    }
  });
}

/**
 * Send an email from an inbox.
 * Agent must prove ownership by providing their private key.
 * The sent content is encrypted before storage.
 */
export async function sendEmail(
  inboxId: string,
  privateKey: string,
  to: string,
  subject: string,
  body: string,
  html?: string
): Promise<EmailMessage> {
  const inbox = storage.getEmailInbox(inboxId);
  if (!inbox) throw new Error(`Inbox ${inboxId} not found`);
  if (!inbox.active) throw new Error("Inbox is deactivated");

  // Verify ownership: try to decrypt a test message
  try {
    const testEncrypted = encryptForInbox("verify", inbox.publicKey);
    const testDecrypted = decryptMessage(testEncrypted, privateKey);
    if (testDecrypted !== "verify") throw new Error("Key mismatch");
  } catch {
    throw new Error("Invalid private key — you don't own this inbox");
  }

  // Send via Cloudflare MailChannels Worker (or fallback)
  await sendViaMailChannels(inbox.address, to, subject, body, html);

  // Encrypt sent content before storing
  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    direction: "outbound",
    from: inbox.address,
    to,
    subject: encryptForInbox(subject, inbox.publicKey),
    body: encryptForInbox(body, inbox.publicKey),
    html: html ? encryptForInbox(html, inbox.publicKey) : undefined,
    encrypted: true,
    timestamp: new Date().toISOString(),
  };

  storage.pushEmailMessage(inboxId, msg);
  return msg;
}

/**
 * Handle inbound email (from Cloudflare Email Worker webhook).
 * Encrypts content immediately, plaintext is never stored.
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

  // Encrypt everything before storage — plaintext never touches disk
  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    direction: "inbound",
    from, // sender address is metadata, not encrypted (needed for filtering)
    to,
    subject: encryptForInbox(subject, inbox.publicKey),
    body: encryptForInbox(body, inbox.publicKey),
    html: html ? encryptForInbox(html, inbox.publicKey) : undefined,
    encrypted: true,
    timestamp: new Date().toISOString(),
  };

  storage.pushEmailMessage(inboxId, msg);
  console.log(`[email] Inbound from ${from} to ${to} — encrypted and stored`);
  return msg;
}

/**
 * Send email via Cloudflare MailChannels API (free via Workers).
 * Fallback: direct MailChannels API (works from whitelisted IPs).
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

  // Try Cloudflare Worker endpoint first
  const workerUrl = config.mailWorkerUrl;
  if (workerUrl) {
    const resp = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) return;
    console.warn(`[email] Worker send failed: ${resp.status}, falling back to MailChannels direct`);
  }

  // Direct MailChannels API
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

/**
 * Get an inbox by ID.
 */
export function getInbox(id: string): EmailInbox | undefined {
  return storage.getEmailInbox(id);
}

/**
 * List all inboxes for an owner.
 */
export function listInboxes(owner: string): EmailInbox[] {
  return storage.getEmailInboxesByOwner(owner);
}
