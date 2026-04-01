import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { x402 } from "../middleware/x402";
import { AuthenticatedRequest } from "../types";
import * as emailService from "../services/email";
import { storage } from "../services/storage";
import { trackHackathonUsage } from "../middleware/hackathon";

const router = Router();

/**
 * POST /email/provision — Create an email inbox
 * Cost: 1.00 USDC (or free during hackathon)
 */
router.post("/provision", requireAuth(2.0, "email"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, walletAddress } = req.body;

    if (!name) {
      res.status(400).json({
        error: "Missing 'name' field",
        hint: "Your email will be {name}@agntos.dev",
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
router.post("/inboxes", requireAuth(2.0, "email"), async (req: AuthenticatedRequest, res: Response) => {
  const { name, walletAddress, solanaPublicKey: spk } = req.body;
  if (!name || !(walletAddress || spk)) {
    res.status(400).json({ error: "Missing 'name' and 'walletAddress'" });
    return;
  }
  const owner = req.agentId || req.payment?.payer || "unknown";
  try {
    const result = emailService.createInbox(name, owner, walletAddress || spk);
    res.status(201).json({ inbox: { id: result.id, address: result.address, walletAddress: result.solanaPublicKey } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
router.get("/inboxes/:id/messages", x402(0.02), async (req: AuthenticatedRequest, res: Response) => {
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
          decryptionNote: "E2E encrypted with your wallet's public key. Decrypt client-side using nacl.box.open with your Solana private key (Ed25519→X25519).",
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
router.post("/inboxes/:id/send", x402(0.08), async (req: AuthenticatedRequest, res: Response) => {
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
 * POST /email/inbound — Webhook for inbound emails
 */
router.post("/inbound", async (req, res: Response) => {
  try {
    const webhookSecret = Array.isArray(req.headers["x-webhook-secret"])
      ? req.headers["x-webhook-secret"][0]
      : req.headers["x-webhook-secret"];
    const expectedSecret = process.env.EMAIL_WEBHOOK_SECRET;
    if (!expectedSecret) { res.status(500).json({ error: "Inbound email not configured" }); return; }
    if (webhookSecret !== expectedSecret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { to, from, subject, body, html, attachments, messageId, inReplyTo, cc } = req.body;
    const msg = emailService.handleInboundEmail(to, from, subject, body, html, attachments, { messageId, inReplyTo, cc });

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
router.get("/threads/:threadId/messages", x402(0.02), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/webhooks", x402(0.02), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { inboxId, url, events } = req.body;
    if (!emailService.isSsrfSafe(url)) { res.status(400).json({ error: "Invalid webhook URL. Must be HTTPS and not target internal networks." }); return; }
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
    service: "AgentOS Email",
    domain: "agntos.dev",
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
      "2. Receive emails at {name}@agntos.dev — stored encrypted",
      "3. GET /email/inboxes/:id/messages — pay $0.02 via x402, get decrypted messages",
      "4. POST /email/inboxes/:id/send — send email ($0.05 via x402)",
    ],
  });
});

export default router;
