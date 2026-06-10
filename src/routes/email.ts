import { Router, Request, Response, NextFunction, urlencoded } from "express";
import { requireAuth } from "../middleware/auth";
import { x402 } from "../middleware/x402";
import { AuthenticatedRequest } from "../types";
import * as emailService from "../services/email";
import { storage } from "../services/storage";
import { db } from "../db";
import { setDomainDnsRecords, type DnsHostRecord } from "../services/namecheap";
import { config } from "../config";
import { extractClaimedSvmPayer } from "../middleware/x402-svm-verify";

const router = Router();

/**
 * POST /email/provision — Create an email inbox
 * Cost: 1.00 USDC (or free during hackathon)
 */
router.post("/provision", validateInboxInputs, requireAuth(2.0, "email", {
  description: "Create an end-to-end encrypted email inbox at {name}@palmyr.ai, keyed to your Solana wallet.",
  category: "communications",
  tags: ["email", "inbox", "e2e", "encryption", "provision"],
  discoverable: false, // legacy alias of POST /email/inboxes
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, walletAddress } = req.body;

    if (!name) {
      res.status(400).json({
        error: "Missing 'name' field",
        hint: "Your email will be {name}@palmyr.ai",
      });
      return;
    }

    const solanaPublicKey = walletAddress || req.body.solanaPublicKey;
    if (!solanaPublicKey) {
      res.status(400).json({
        error: "Missing wallet address",
        message: "Provide 'walletAddress' (Solana base58 public key)",
      });
      return;
    }

    const owner = req.agentId || req.payment?.payer || "unknown";
    const result = emailService.createInbox(name, owner, solanaPublicKey);

    res.status(201).json({
      inbox: {
        id: result.id,
        address: result.address,
        walletAddress: result.solanaPublicKey,
        createdAt: result.createdAt,
      },
      encryption: {
        algorithm: "NaCl box (E2E) or AES-256-GCM (legacy)",
        model: "Messages encrypted at rest with per-inbox server key. Decrypted on read after x402 payment proves wallet ownership.",
      },
    });
  } catch (err: any) {
    console.error("[email] Provision error:", err);
    res.status(500).json({ error: "Inbox Creation Failed", message: err.message });
  }
});

/**
 * POST /email/inboxes — Alias for /email/provision
 */
/**
 * Validate inbox inputs BEFORE the paywall. Email uses Ed25519 → X25519 E2E encryption,
 * so the wallet must be a valid Solana pubkey. EVM addresses won't work here (different curve).
 * Validating upfront prevents users from paying and then getting rejected.
 */
function validateInboxInputs(req: Request, res: Response, next: NextFunction): void {
  // Skip when request has no payment header so x402 discovery probes (CDP Bazaar
  // crawler) receive 402, not 400. Anyone without a payment header can't be charged
  // yet, so there's nothing to protect against here.
  const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined;
  if (!paymentHeader) { next(); return; }

  const { name, walletAddress, solanaPublicKey: spk, domain } = req.body || {};
  const key = walletAddress || spk;
  if (!name) {
    res.status(400).json({ error: "Missing 'name'" });
    return;
  }
  if (!/^[a-z0-9\-_.]+$/i.test(String(name).toLowerCase().replace(/[^a-z0-9\-_.]/g, ''))) {
    res.status(400).json({ error: "Invalid inbox name" });
    return;
  }
  // walletAddress is optional — defaults to the x402 payer in the route handler.
  // Only validate if explicitly provided (to catch EVM addresses before taking payment).
  if (key) {
    try {
      const bs58 = require('bs58');
      const decoded = bs58.decode(String(key));
      if (decoded.length !== 32) throw new Error();
    } catch {
      res.status(400).json({
        error: "Invalid walletAddress",
        message: "Email inboxes require a Solana public key (base58, 32 bytes). EVM addresses are not supported for this endpoint because the E2E encryption uses Ed25519→X25519.",
        hint: "Omit walletAddress to default to your paying wallet, or pass a Solana base58 address.",
      });
      return;
    }
  } else {
    // No explicit walletAddress: the route would fall back to req.payment.payer
    // as the inbox owner / encryption key. That's a Solana pubkey when the
    // payer is on Solana, but an EVM 0x address when the payer is on Base —
    // which then 500s deep inside createInbox. Detect EVM-network payments
    // here so the user gets a clear 400 BEFORE the paywall settles, instead
    // of paying $2 to find out their pay chain doesn't match the email
    // crypto.
    try {
      const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
      const network: string | undefined = decoded?.accepted?.network || decoded?.network;
      if (typeof network === "string" && network.startsWith("eip155:")) {
        res.status(400).json({
          error: "Invalid walletAddress",
          message: "Pass --wallet <vault_id|name|sol_pubkey> when paying on Base — email inboxes are owned by a Solana pubkey (E2E uses Ed25519). The CLI auto-fills this from your paying wallet's Solana address if you use the latest version. Your wallet has NOT been charged.",
          hint: "Solana-paid calls work without --wallet (the payer is already a Solana pubkey).",
        });
        return;
      }
    } catch {
      // Header isn't structured x402 — fall through and let requireAuth
      // surface the format error.
    }
  }

  // Pre-payment domain ownership check: if the caller is requesting a custom
  // domain, verify the *claimed* payer in their unsigned payment header owns
  // it. This rejects typos / wrong-wallet attempts BEFORE charging. If the
  // claim is spoofed, the full x402 verifier in requireAuth still catches it
  // and refuses settlement, so spoofing gains nothing.
  if (domain) {
    const normalized = String(domain).toLowerCase().trim();
    if (normalized && normalized !== config.emailDomain) {
      const claimedPayer = extractClaimedSvmPayer(String(paymentHeader));
      if (!claimedPayer) {
        res.status(400).json({
          error: "Could not parse payment header",
          message: "Domain ownership cannot be verified before charging — refusing to proceed. Your wallet has NOT been charged.",
        });
        return;
      }
      const owns = db
        .prepare("SELECT 1 FROM domains WHERE domain = ? AND owner = ? AND status != ?")
        .get(normalized, claimedPayer, "expired");
      if (!owns) {
        res.status(403).json({
          error: "Domain not owned by this wallet",
          message: `Wallet ${claimedPayer} does not own '${normalized}'. Register it first via POST /domains/register, or omit 'domain' to default to ${config.emailDomain}.`,
          hint: "Your wallet has NOT been charged — this check ran before payment.",
        });
        return;
      }
    }
  }

  next();
}

router.get("/inboxes", requireAuth(0.01, "general", {
  description: "List all email inboxes owned by the calling wallet.",
  category: "communications",
  tags: ["email", "inbox", "list"],
}), async (req: AuthenticatedRequest, res: Response) => {
  const owner = req.agentId || req.payment?.payer;
  if (!owner) return res.status(401).json({ error: "Unauthenticated" });
  const inboxes = emailService.listInboxes(owner);
  res.json({ inboxes: inboxes.map(i => ({ id: i.id, address: i.address, walletAddress: i.solanaPublicKey })) });
});

router.post("/inboxes", validateInboxInputs, requireAuth(2.0, "email", {
  description: "Create an end-to-end encrypted email inbox keyed to your Solana wallet. Defaults to {name}@palmyr.ai; pass `domain` to provision on a Namecheap-registered domain you own (auto-sets MX/SPF/DKIM records).",
  category: "communications",
  tags: ["email", "inbox", "e2e", "encryption", "provision"],
}), async (req: AuthenticatedRequest, res: Response) => {
  const { name, walletAddress, solanaPublicKey: spk, domain } = req.body as {
    name: string;
    walletAddress?: string;
    solanaPublicKey?: string;
    domain?: string;
  };
  const owner = req.agentId || req.payment?.payer || "unknown";
  // Encryption key defaults to the paying wallet — agent owns its own inbox
  // in 99% of cases. Explicit walletAddress is only needed for delegation.
  const encryptionKey = walletAddress || spk || req.payment?.payer;
  if (!encryptionKey) {
    res.status(401).json({ error: "Could not determine encryption key (no walletAddress provided and no x402 payer)" });
    return;
  }

  // If a custom domain is requested, verify the calling wallet owns it. The
  // ownership row lives in the `domains` table populated by register_domain.
  let resolvedDomain: string | undefined;
  if (domain) {
    const normalized = String(domain).toLowerCase().trim();
    if (normalized && normalized !== config.emailDomain) {
      const ownerKey = req.payment?.payer || req.agentId;
      const row = ownerKey
        ? db.prepare('SELECT 1 FROM domains WHERE domain = ? AND owner = ? AND status != ?').get(normalized, ownerKey, 'expired')
        : undefined;
      if (!row) {
        res.status(403).json({
          error: "Forbidden",
          message: `Domain '${normalized}' is not registered to this wallet. Register it first via POST /domains/register, or omit 'domain' to default to ${config.emailDomain}.`,
        });
        return;
      }
      resolvedDomain = normalized;
    }
  }

  try {
    const result = emailService.createInbox(name, owner, encryptionKey, resolvedDomain);

    // For custom domains, register the domain with our email backend (Mailgun)
    // and write the DKIM + SPF records it asks for to the user's Namecheap
    // DNS, plus inbound MX so receive lands at Mailgun. Mailgun auto-verifies
    // once DNS propagates (typically a few minutes).
    let dnsApplied = false;
    let mailgunStatus: string | undefined;
    let mailgunIdentity: string | undefined;
    let mailgunRegistered = false;
    let mailgunError: string | undefined;
    if (resolvedDomain) {
      try {
        const { registerDomainWithMailgun, isMailgunConfigured } = await import("../services/mailgun");
        let records: DnsHostRecord[] = [];
        if (isMailgunConfigured()) {
          try {
            const reg = await registerDomainWithMailgun(resolvedDomain);
            records = reg.records;
            mailgunStatus = reg.status;
            mailgunIdentity = reg.id;
            mailgunRegistered = true;
            console.log(`[email] mailgun registered ${resolvedDomain} (status=${reg.status}, ${reg.records.length} dns records)`);
          } catch (mgErr: any) {
            mailgunError = mgErr?.message || String(mgErr);
            console.error(`[email] mailgun register ${resolvedDomain} failed:`, mailgunError);
          }
        } else {
          console.warn(`[email] Mailgun not configured (MAILGUN_API_KEY missing) - skipping domain registration for ${resolvedDomain}`);
        }
        // Inbound MX records — Mailgun receives mail at mxa/mxb.mailgun.org
        // (or mxa/mxb.eu.mailgun.org for the EU region).
        const mxSuffix = (process.env.MAILGUN_REGION || 'us').toLowerCase() === 'eu' ? '.eu.mailgun.org' : '.mailgun.org';
        records.push({ type: 'MX', name: '@', value: `mxa${mxSuffix}`, ttl: 1800, mxPref: 10 });
        records.push({ type: 'MX', name: '@', value: `mxb${mxSuffix}`, ttl: 1800, mxPref: 10 });
        await setDomainDnsRecords(resolvedDomain, records);
        dnsApplied = true;

        // Tell Mailgun to re-poll DNS now. Without this, the provision
        // response and subsequent `palmyr email status` calls return
        // Mailgun's pre-write cached state for several minutes.
        if (mailgunRegistered) {
          try {
            const { forceVerifyMailgunDomain } = await import("../services/mailgun");
            const verified = await forceVerifyMailgunDomain(resolvedDomain);
            mailgunStatus = verified.status;
          } catch (vErr: any) {
            console.warn(`[email] mailgun verify ${resolvedDomain} failed (non-fatal):`, vErr?.message || vErr);
          }
        }
      } catch (dnsErr: any) {
        console.error(`[email] auto-DNS for ${resolvedDomain} failed:`, dnsErr?.message || dnsErr);
      }
    }

    res.status(201).json({
      inbox: {
        id: result.id,
        address: result.address,
        walletAddress: result.solanaPublicKey,
      },
      dnsApplied: resolvedDomain ? dnsApplied : undefined,
      mailgunRegistered: resolvedDomain ? mailgunRegistered : undefined,
      mailgunIdentity,
      mailgunStatus,
      mailgunError,
      sendingStatus: resolvedDomain
        ? (mailgunStatus === 'verified'
          ? 'ready'
          : mailgunRegistered
            ? 'pending_verification - DNS propagating; sending will work once Mailgun verifies the domain (typically a few minutes). Poll with: palmyr email status <domain>'
            : 'unverified - Mailgun not configured on server; outbound send unavailable until MAILGUN_API_KEY is set')
        : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /email/domains/:domain/register - explicitly register a wallet-owned
 * domain with Mailgun and write the required DKIM/SPF/MX DNS records via Namecheap.
 *
 * Use case: recover from a failed auto-registration during provision_email_inbox
 * (e.g. transient Mailgun error) without paying $2 to provision another inbox
 * just to retry.
 *
 * Idempotent - Mailgun re-registration on an existing domain returns the
 * existing DKIM records; DNS setHosts is also idempotent (replaces all).
 */
router.post("/domains/:domain/register", requireAuth(0.05, "email", {
  description: "Register a wallet-owned domain with Mailgun and write its DKIM/SPF/MX DNS records. Idempotent - safe to retry.",
  category: "communications",
  tags: ["email", "domain", "mailgun", "register"],
  discoverable: false, // recovery path; auto-runs inside POST /email/inboxes
}), async (req: AuthenticatedRequest, res: Response) => {
  const owner = req.agentId || req.payment?.payer;
  if (!owner) return res.status(401).json({ error: "Unauthenticated" });
  const domain = String(req.params.domain || "").toLowerCase().trim();
  if (!domain) return res.status(400).json({ error: "domain path param required" });

  const owns = db
    .prepare("SELECT 1 FROM domains WHERE domain = ? AND owner = ? AND status != ?")
    .get(domain, owner, "expired");
  if (!owns) {
    return res.status(403).json({ error: `Domain '${domain}' is not registered to this wallet` });
  }

  try {
    const { registerDomainWithMailgun, isMailgunConfigured } = await import("../services/mailgun");
    if (!isMailgunConfigured()) {
      return res.status(503).json({ error: "Mailgun not configured on server (MAILGUN_API_KEY missing)" });
    }
    const reg = await registerDomainWithMailgun(domain);
    const records: DnsHostRecord[] = [...reg.records];
    const mxSuffix = (process.env.MAILGUN_REGION || 'us').toLowerCase() === 'eu' ? '.eu.mailgun.org' : '.mailgun.org';
    records.push({ type: 'MX', name: '@', value: `mxa${mxSuffix}`, ttl: 1800, mxPref: 10 });
    records.push({ type: 'MX', name: '@', value: `mxb${mxSuffix}`, ttl: 1800, mxPref: 10 });
    await setDomainDnsRecords(domain, records);

    // Force a Mailgun re-poll so the response reflects post-write state.
    let postWriteStatus = reg.status;
    try {
      const { forceVerifyMailgunDomain } = await import("../services/mailgun");
      const verified = await forceVerifyMailgunDomain(domain);
      postWriteStatus = verified.status;
    } catch (vErr: any) {
      console.warn(`[email] mailgun verify ${domain} failed (non-fatal):`, vErr?.message || vErr);
    }

    res.json({
      domain,
      mailgunIdentity: reg.id,
      status: postWriteStatus,
      records: reg.records,
      dnsApplied: true,
      message: postWriteStatus === 'verified'
        ? 'Domain is verified and ready to send from.'
        : 'Domain registered with Mailgun. DNS records set on Namecheap. Mailgun will auto-verify within a few minutes - poll with: palmyr email status ' + domain,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /email/domains/:domain/status - verification status of a wallet-owned
 * domain in Mailgun. Used to poll after inbox provisioning while DNS
 * propagates. Wallet must own the domain.
 */
router.get("/domains/:domain/status", requireAuth(0.01, "general", {
  description: "Get the Mailgun verification status of a wallet-owned domain (use to poll while DNS propagates).",
  category: "communications",
  tags: ["email", "domain", "mailgun", "verification"],
  discoverable: false, // poll endpoint; auto-verify now runs inline on provision
}), async (req: AuthenticatedRequest, res: Response) => {
  const owner = req.agentId || req.payment?.payer;
  if (!owner) return res.status(401).json({ error: "Unauthenticated" });
  const domain = String(req.params.domain || "").toLowerCase().trim();
  if (!domain) return res.status(400).json({ error: "domain path param required" });

  const owns = db
    .prepare("SELECT 1 FROM domains WHERE domain = ? AND owner = ? AND status != ?")
    .get(domain, owner, "expired");
  if (!owns) {
    return res.status(403).json({ error: `Domain '${domain}' is not registered to this wallet` });
  }

  try {
    const { getMailgunDomainStatus, isMailgunConfigured } = await import("../services/mailgun");
    if (!isMailgunConfigured()) {
      return res.json({ domain, status: "mailgun_not_configured", message: "MAILGUN_API_KEY not set on server" });
    }
    const result = await getMailgunDomainStatus(domain);
    if (!result.found) {
      return res.json({
        domain,
        status: "not_registered",
        message: "Domain has not been registered with Mailgun yet - re-run provision_email_inbox to trigger auto-registration.",
      });
    }
    res.json({
      domain,
      mailgunIdentity: result.id,
      status: result.status,
      records: result.records,
      ready: result.status === "verified",
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});


/**
 * GET /email/inboxes/:id/messages — Read inbox (decrypted)
 * 
 * x402 paywall: $0.02 USDC per read.
 * Payment from the inbox's wallet proves ownership.
 * Server decrypts messages and returns plaintext over TLS.
 * 
 * Messages are encrypted at rest — only decrypted in-flight during this request.
 */
router.get("/inboxes/:id/messages", x402(0.02, {
  description: "Read decrypted messages from an inbox you own. Payment wallet must match the inbox wallet.",
  category: "communications",
  tags: ["email", "inbox", "read", "messages"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inboxId = req.params.id as string;
    const inbox = emailService.getInbox(inboxId);
    
    if (!inbox) {
      res.status(404).json({ error: "Inbox not found" });
      return;
    }

    // Verify the payer is the inbox owner (wallet that registered it)
    const payer = req.payment?.payer;
    if (!payer) {
      res.status(403).json({ error: "Payment required to read inbox" });
      return;
    }

    // The x402 payer must match the inbox's wallet address
    // This is the core security: paying from the right wallet = proof of ownership
    if (payer !== inbox.solanaPublicKey && payer !== inbox.owner) {
      res.status(403).json({ 
        error: "Wallet mismatch",
        message: "The wallet that paid does not own this inbox. Pay from the wallet that created it.",
      });
      return;
    }

    // Get messages and handle decryption based on type
    const encryptedMsgs = emailService.getMessages(inboxId);
    const isE2E = inbox.e2eEnabled;

    const messages = encryptedMsgs.map(msg => {
      if (!msg.encrypted) {
        return { id: msg.id, direction: msg.direction, from: msg.from, to: msg.to, subject: msg.subject, body: msg.body, html: msg.html, timestamp: msg.timestamp };
      }

      // Check if message is wallet-encrypted (E2E) — starts with "w:"
      const isWalletEncrypted = msg.subject?.startsWith("w:") || msg.body?.startsWith("w:");
      
      if (isWalletEncrypted) {
        // E2E: return ciphertext — only the agent can decrypt with its private key
        return {
          id: msg.id, direction: msg.direction, from: msg.from, to: msg.to,
          subject: msg.subject, body: msg.body, html: msg.html,
          timestamp: msg.timestamp,
          encrypted: true,
          e2e: true,
          decryptionNote: "E2E encrypted with your wallet's public key. Strip the 'w:' prefix, base64-decode, then split bytes: ephemeralPub=[0:32], nonce=[32:56], ciphertext=[56:]. Convert your Ed25519 secret key to X25519 and call nacl.box.open(ciphertext, nonce, ephemeralPub, yourX25519SecretKey).",
        };
      }

      // Server-encrypted: decrypt server-side (we hold the key)
      try {
        return {
          id: msg.id, direction: msg.direction, from: msg.from, to: msg.to,
          subject: emailService.serverDecrypt(inboxId, msg.subject),
          body: emailService.serverDecrypt(inboxId, msg.body),
          html: msg.html ? emailService.serverDecrypt(inboxId, msg.html) : undefined,
          timestamp: msg.timestamp,
          e2e: false,
        };
      } catch {
        return {
          id: msg.id, direction: msg.direction, from: msg.from, to: msg.to,
          subject: msg.subject, body: msg.body, html: msg.html,
          timestamp: msg.timestamp, encrypted: true,
          decryptionNote: "Could not decrypt. May require client-side decryption.",
        };
      }
    });
    
    res.json({
      inbox: inbox.address,
      messages,
      totalMessages: messages.length,
      paidBy: payer,
      e2eEnabled: isE2E,
      security: isE2E
        ? "E2E encrypted — messages encrypted with your wallet's public key. Only you can decrypt. We cannot read your emails."
        : "Encrypted at rest (AES-256-GCM). Decrypted in-flight after x402 payment proved wallet ownership.",
    });
  } catch (err: any) {
    res.status(err.message?.includes("not found") ? 404 : 500).json({ error: err.message });
  }
});

/**
 * POST /email/inboxes/:id/send — Send email
 * Cost: 0.05 USDC
 */
router.post("/inboxes/:id/send", x402(0.08, {
  description: "Send an email from an inbox you own. Body: { to, subject, body, html? }",
  category: "communications",
  tags: ["email", "send", "outbound"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inboxId = req.params.id as string;
    const inbox = emailService.getInbox(inboxId);
    
    if (!inbox) {
      res.status(404).json({ error: "Inbox not found" });
      return;
    }

    // Verify payer owns the inbox
    const payer = req.payment?.payer;
    if (payer && payer !== inbox.solanaPublicKey && payer !== inbox.owner) {
      res.status(403).json({ error: "Wallet mismatch — you don't own this inbox" });
      return;
    }

    const { to, subject, body, html } = req.body;
    if (!to || !subject || !body) {
      res.status(400).json({ error: "Missing required fields: to, subject, body" });
      return;
    }

    const msg = await emailService.sendEmail(inboxId, to, subject, body, html);
    res.status(201).json({ message: { id: msg.id, to, subject, sentAt: msg.timestamp } });
  } catch (err: any) {
    console.error("[email] Send error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /email/inbound — Webhook for inbound emails (Mailgun Routes target).
 *
 * Mailgun POSTs as multipart form-data (or url-encoded) containing the parsed
 * message fields plus a signature triple (timestamp + token + signature).
 * We HMAC-verify with MAILGUN_WEBHOOK_SIGNING_KEY before doing anything.
 *
 * Field map (Mailgun → Palmyr):
 *   recipient         → to
 *   sender            → from
 *   subject           → subject
 *   body-plain        → body
 *   body-html         → html
 *   Message-Id header → messageId
 *   In-Reply-To       → inReplyTo
 *   Cc                → cc
 *
 * Set up the route in Mailgun → Receiving → Routes:
 *   Match: catch_all()    Action: forward("https://palmyr.ai/email/inbound")
 */
router.post("/inbound", urlencoded({ extended: true, limit: '25mb' }), async (req, res: Response) => {
  try {
    const { verifyMailgunWebhook } = await import("../services/mailgun");
    const body = (req.body || {}) as Record<string, any>;

    const timestamp = body.timestamp as string | undefined;
    const token = body.token as string | undefined;
    const signature = body.signature as string | undefined;

    if (!verifyMailgunWebhook(timestamp, token, signature)) {
      res.status(401).json({ error: "Unauthorized — invalid Mailgun signature" });
      return;
    }

    // Parse Message-Id / In-Reply-To from the message-headers JSON when present.
    let messageId: string | undefined;
    let inReplyTo: string | undefined;
    try {
      const headers = body['message-headers'] ? JSON.parse(String(body['message-headers'])) : [];
      for (const [name, val] of headers) {
        const lower = String(name).toLowerCase();
        if (lower === 'message-id' && !messageId) messageId = String(val);
        if (lower === 'in-reply-to' && !inReplyTo) inReplyTo = String(val);
      }
    } catch { /* best-effort */ }

    const to = String(body.recipient || body.to || '');
    const from = String(body.sender || body.from || '');
    const subject = String(body.subject || '');
    const text = String(body['body-plain'] || body['stripped-text'] || '');
    const html = body['body-html'] ? String(body['body-html']) : undefined;
    const cc = body.Cc ? String(body.Cc) : undefined;

    // Mailgun "stored" mode delivers attachments as fields attachment-1, attachment-2...
    // We don't currently fetch them server-side; if you need attachments, switch to
    // the "store and notify" route action and fetch via the message URL.
    const attachments = undefined;

    const msg = emailService.handleInboundEmail(to, from, subject, text, html, attachments, {
      messageId,
      inReplyTo,
      cc,
    });

    if (msg) {
      res.json({ received: true, messageId: msg.id, encrypted: true });
    } else {
      // Always 200 so Mailgun doesn't retry the webhook for unknown inboxes.
      res.json({ received: false, reason: "No matching inbox" });
    }
  } catch (err: any) {
    console.error("[email] Inbound webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /email/inboxes/:id/threads — List threads in an inbox
 */
router.get("/inboxes/:id/threads", x402(0.02), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inboxId = req.params.id as string;
    const inbox = emailService.getInbox(inboxId);
    if (!inbox) { res.status(404).json({ error: "Inbox not found" }); return; }

    const payer = req.payment?.payer;
    if (payer !== inbox.solanaPublicKey && payer !== inbox.owner) {
      res.status(403).json({ error: "Wallet mismatch" }); return;
    }

    const threads = storage.getEmailThreads?.(inboxId) || [];
    res.json({ threads, totalThreads: threads.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /email/threads/:threadId/messages — Get messages in a thread
 */
router.get("/threads/:threadId/messages", x402(0.02, {
  description: "Read all messages in an email thread on an inbox you own.",
  category: "communications",
  tags: ["email", "thread", "messages", "read"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const threadId = req.params.threadId as string;
    const thread = storage.getEmailThread?.(threadId);
    if (!thread) { res.status(404).json({ error: "Thread not found" }); return; }

    const inbox = emailService.getInbox(thread.inbox_id);
    if (!inbox) { res.status(404).json({ error: "Inbox not found" }); return; }

    const payer = req.payment?.payer;
    if (payer !== inbox.solanaPublicKey && payer !== inbox.owner) {
      res.status(403).json({ error: "Wallet mismatch" }); return;
    }

    const allMsgs = emailService.getMessages(thread.inbox_id);
    const threadMsgs = allMsgs.filter(m => m.threadId === threadId);
    res.json({ thread, messages: threadMsgs, totalMessages: threadMsgs.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /email/attachments/:attachmentId — Download an attachment
 */
router.get("/attachments/:attachmentId", x402(0.02), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const att = storage.getEmailAttachment?.(req.params.attachmentId as string);
    if (!att) { res.status(404).json({ error: "Attachment not found" }); return; }

    res.json({
      id: att.id,
      filename: att.filename,
      contentType: att.content_type,
      size: att.size,
      content: att.content, // E2E encrypted if inbox has e2eEnabled
      note: att.content?.startsWith('w:') ? 'E2E encrypted — decrypt with your private key' : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /email/webhooks — Register a webhook for inbox events
 */
router.post("/webhooks", x402(0.02, { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { inboxId, url, events } = req.body;
    if (!inboxId || !url) { res.status(400).json({ error: "inboxId and url required" }); return; }
    if (!emailService.isSsrfSafe(url)) { res.status(400).json({ error: "Invalid webhook URL. Must be HTTPS and not target private/internal networks." }); return; }

    const inbox = emailService.getInbox(inboxId);
    if (!inbox) { res.status(404).json({ error: "Inbox not found" }); return; }

    const payer = req.payment?.payer;
    if (payer !== inbox.solanaPublicKey && payer !== inbox.owner) {
      res.status(403).json({ error: "Wallet mismatch" }); return;
    }

    const webhookId = require('uuid').v4();
    storage.setEmailWebhook?.(webhookId, {
      id: webhookId,
      inboxId,
      url,
      events: events || ['message.received'],
      createdAt: new Date().toISOString(),
    });

    res.json({ id: webhookId, url, events: events || ['message.received'], message: "Webhook registered. We'll POST to your URL when events occur." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /email/info — Public info
 */
router.get("/info", (_req, res: Response) => {
  res.json({
    service: "Palmyr Email",
    domain: "palmyr.ai",
    pricing: {
      provision: "2.00 USDC",
      read: "0.02 USDC",
      send: "0.08 USDC",
      threads: "0.02 USDC",
      attachments: "0.02 USDC",
      webhooks: "0.02 USDC",
    },
    features: ["E2E encryption", "threads", "attachments", "webhooks", "custom domains (coming)"],
    security: {
      encryption: "E2E — NaCl box (X25519 + XSalsa20-Poly1305). Server cannot read emails.",
      authentication: "x402 USDC payment — your wallet address = your identity",
      transport: "TLS (HTTPS)",
      model: "Encrypted with wallet public key → server stores ciphertext → agent decrypts with private key",
    },
    howItWorks: [
      "1. POST /email/inboxes — provision inbox (1 USDC)",
      "2. Receive emails at {name}@palmyr.ai — stored encrypted",
      "3. GET /email/inboxes/:id/messages — pay $0.02 via x402, get decrypted messages",
      "4. POST /email/inboxes/:id/send — send email ($0.05 via x402)",
    ],
  });
});

export default router;
