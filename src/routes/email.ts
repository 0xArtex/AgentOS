import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest, CreateInboxRequest, SendEmailRequest } from "../types";
import * as emailService from "../services/email";
import { trackHackathonUsage } from "../middleware/hackathon";

const router = Router();

/**
 * POST /email/provision — Create a new E2E encrypted email inbox
 * 
 * Returns the inbox details + a private key (shown ONCE, never stored).
 * The private key is required to read or send emails.
 * 
 * Cost: 1.00 USDC (or free during hackathon)
 */
router.post("/provision", requireAuth(1.0, "email"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name } = req.body as CreateInboxRequest;

    if (!name) {
      res.status(400).json({
        error: "Missing Required Field",
        message: "The 'name' field is required",
        hint: "Include 'name' in your request body (e.g., 'my-agent'). Your email will be {name}@agntos.dev",
      });
      return;
    }

    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;
    const result = emailService.createInbox(name, owner);

    if (req.isHackathonMode && req.agentId) {
      trackHackathonUsage(req.agentId, "email", result.id);
    }

    res.status(201).json({
      inbox: {
        id: result.id,
        address: result.address,
        publicKey: result.publicKey,
        createdAt: result.createdAt,
      },
      privateKey: result.privateKey,
      warning: "⚠️ SAVE YOUR PRIVATE KEY — it is shown once and never stored. You need it to read and send emails. If you lose it, your emails are permanently unreadable.",
      encryption: {
        algorithm: "X25519 + XSalsa20-Poly1305 (NaCl box)",
        model: "Zero-knowledge. We encrypt on receipt, delete plaintext. Only your private key can decrypt.",
      },
    });
  } catch (err: any) {
    console.error("[email] Provision error:", err);
    res.status(500).json({
      error: "Inbox Creation Failed",
      message: err.message || "Failed to create email inbox",
      hint: "Choose a unique name and try again",
    });
  }
});

/**
 * POST /email/inboxes — Alias for /email/provision (backwards compat)
 */
router.post("/inboxes", requireAuth(1.0, "email"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name } = req.body as CreateInboxRequest;
    if (!name) {
      res.status(400).json({ error: "Missing 'name' field" });
      return;
    }
    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;
    const result = emailService.createInbox(name, owner);
    if (req.isHackathonMode && req.agentId) {
      trackHackathonUsage(req.agentId, "email", result.id);
    }
    res.status(201).json({
      inbox: { id: result.id, address: result.address, publicKey: result.publicKey, createdAt: result.createdAt },
      privateKey: result.privateKey,
      warning: "⚠️ SAVE YOUR PRIVATE KEY — shown once, never stored.",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /email/inboxes/:id/messages — Get encrypted messages
 * 
 * Returns encrypted messages. To decrypt, include your private key
 * in the X-Private-Key header or use the /decrypt endpoint.
 * 
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.get("/inboxes/:id/messages", requireAuth(0.01, "email"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inboxId = req.params.id as string;
    const privateKey = (Array.isArray(req.headers["x-private-key"]) ? req.headers["x-private-key"][0] : req.headers["x-private-key"]) as string | undefined;

    if (privateKey) {
      // Decrypt on-the-fly (key is never stored/logged)
      const msgs = emailService.getDecryptedMessages(inboxId, privateKey);
      res.json({
        messages: msgs,
        encrypted: false,
        note: "Messages decrypted using your private key. Key was not stored.",
      });
    } else {
      // Return encrypted blobs
      const msgs = emailService.getMessages(inboxId);
      res.json({
        messages: msgs,
        encrypted: true,
        hint: "Include your private key in the X-Private-Key header to decrypt messages, or decrypt client-side using NaCl box.",
      });
    }
  } catch (err: any) {
    res.status(404).json({
      error: "Inbox Not Found",
      message: err.message,
      hint: "Check the inbox ID",
    });
  }
});

/**
 * POST /email/inboxes/:id/decrypt — Decrypt a single message
 * 
 * Agent sends their private key + message ID, gets plaintext back.
 * Key is never stored or logged.
 * 
 * Cost: 0.001 USDC (or free during hackathon)
 */
router.post("/inboxes/:id/decrypt", requireAuth(0.001, "email"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { privateKey, messageId } = req.body;

    if (!privateKey) {
      res.status(400).json({ error: "Missing 'privateKey' field" });
      return;
    }

    const msgs = emailService.getMessages(req.params.id as string);
    const msg = messageId ? msgs.find((m) => m.id === messageId) : undefined;

    if (messageId && !msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    // Decrypt specific message or all
    if (msg) {
      const decrypted = {
        ...msg,
        decryptedSubject: emailService.decryptMessage(msg.subject, privateKey),
        decryptedBody: emailService.decryptMessage(msg.body, privateKey),
      };
      res.json({ message: decrypted });
    } else {
      const decrypted = emailService.getDecryptedMessages(req.params.id as string, privateKey);
      res.json({ messages: decrypted });
    }
  } catch (err: any) {
    res.status(400).json({
      error: "Decryption Failed",
      message: err.message,
      hint: "Ensure you're using the correct private key for this inbox",
    });
  }
});

/**
 * POST /email/inboxes/:id/send — Send an email (requires private key)
 * 
 * Agent must prove ownership by providing their private key.
 * Sent content is encrypted before storage.
 * 
 * Cost: 0.05 USDC (or free during hackathon)
 */
router.post("/inboxes/:id/send", requireAuth(0.05, "email"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, subject, body, html, privateKey } = req.body;
    const inboxId = req.params.id as string;

    if (!privateKey) {
      res.status(400).json({
        error: "Missing Private Key",
        message: "You must provide your private key to prove inbox ownership",
        hint: "Include 'privateKey' in your request body",
      });
      return;
    }

    if (!to || !subject || !body) {
      res.status(400).json({
        error: "Missing Required Fields",
        message: "The 'to', 'subject', and 'body' fields are required",
      });
      return;
    }

    const msg = await emailService.sendEmail(inboxId, privateKey, to, subject, body, html);
    res.status(201).json({
      message: msg,
      note: "Email sent. Sent content encrypted and stored.",
    });
  } catch (err: any) {
    console.error("[email] Send error:", err);
    res.status(500).json({
      error: "Email Send Failed",
      message: err.message,
    });
  }
});

/**
 * POST /email/inbound — Webhook for inbound emails (Cloudflare Email Worker)
 * No payment required — called by our Cloudflare Worker.
 */
router.post("/inbound", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const webhookSecret = Array.isArray(req.headers["x-webhook-secret"]) ? req.headers["x-webhook-secret"][0] : req.headers["x-webhook-secret"];
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
 * GET /email/info — Public info about the E2E encrypted email system
 */
router.get("/info", (_req, res: Response) => {
  res.json({
    service: "AgentOS E2E Encrypted Email",
    domain: "agntos.dev",
    encryption: {
      algorithm: "X25519 + XSalsa20-Poly1305 (NaCl box)",
      library: "TweetNaCl.js",
      model: "Zero-knowledge end-to-end encryption",
    },
    howItWorks: {
      provision: "POST /email/provision — creates inbox + keypair. Private key returned once.",
      receive: "Inbound emails encrypted with your public key on arrival. Plaintext deleted immediately.",
      read: "GET /email/inboxes/:id/messages with X-Private-Key header to decrypt.",
      send: "POST /email/inboxes/:id/send with privateKey in body to prove ownership.",
      decrypt: "POST /email/inboxes/:id/decrypt with privateKey to decrypt specific messages.",
    },
    security: [
      "Private keys are NEVER stored on our servers",
      "Email content is encrypted before touching disk",
      "Plaintext is immediately discarded after encryption",
      "Even if our database is compromised, emails are unreadable",
      "Self-custody model — like a crypto wallet for email",
    ],
    cost: {
      provision: "1.00 USDC",
      readMessages: "0.01 USDC",
      sendEmail: "0.05 USDC",
      decrypt: "0.001 USDC",
    },
  });
});

export default router;
