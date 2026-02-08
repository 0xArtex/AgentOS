import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest, CreateInboxRequest, SendEmailRequest } from "../types";
import * as emailService from "../services/email";
import { trackHackathonUsage } from "../middleware/hackathon";

const router = Router();

/**
 * POST /email/inboxes — Create a new email inbox
 * Cost: 1.00 USDC (or free during hackathon with agent limits)
 */
router.post("/inboxes", requireAuth(1.0, 'email'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name } = req.body as CreateInboxRequest;

    if (!name) {
      res.status(400).json({ 
        error: "Missing Required Field",
        message: "The 'name' field is required for the email inbox",
        hint: "Include 'name' in your request body (e.g., 'my-agent-inbox')"
      });
      return;
    }

    // Get owner - either from payment or hackathon mode
    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;

    const inbox = emailService.createInbox(name, owner);

    // Track hackathon usage if applicable
    if (req.isHackathonMode && req.agentId) {
      trackHackathonUsage(req.agentId, 'email', inbox.id);
    }

    res.status(201).json(inbox);
  } catch (err: any) {
    console.error("[email] Create inbox error:", err);
    res.status(500).json({ 
      error: "Inbox Creation Failed",
      message: err.message || "Failed to create email inbox",
      hint: "Choose a unique name and try again"
    });
  }
});

/**
 * GET /email/inboxes/:id/messages — Get all messages for an inbox
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.get("/inboxes/:id/messages", requireAuth(0.01, 'email'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const inboxId = req.params.id as string;
    
    if (!inboxId) {
      res.status(400).json({
        error: "Missing Inbox ID", 
        message: "Inbox ID is required in the URL path",
        hint: "Use format: GET /email/inboxes/{id}/messages"
      });
      return;
    }

    const msgs = emailService.getMessages(inboxId);
    res.json({ messages: msgs });
  } catch (err: any) {
    res.status(404).json({ 
      error: "Inbox Not Found",
      message: err.message || "Could not find messages for this inbox",
      hint: "Check the inbox ID and ensure you own this inbox"
    });
  }
});

/**
 * POST /email/inboxes/:id/send — Send an email
 * Cost: 0.05 USDC (or free during hackathon)
 */
router.post("/inboxes/:id/send", requireAuth(0.05, 'email'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, subject, body, html } = req.body as SendEmailRequest;
    const inboxId = req.params.id as string;

    if (!inboxId) {
      res.status(400).json({
        error: "Missing Inbox ID",
        message: "Inbox ID is required in the URL path", 
        hint: "Use format: POST /email/inboxes/{id}/send"
      });
      return;
    }

    if (!to || !subject || !body) {
      res.status(400).json({ 
        error: "Missing Required Fields",
        message: "The 'to', 'subject', and 'body' fields are required",
        hint: "Include 'to' (email address), 'subject', and 'body' in your request"
      });
      return;
    }

    const msg = await emailService.sendEmail(inboxId, to, subject, body, html);
    res.status(201).json(msg);
  } catch (err: any) {
    console.error("[email] Send error:", err);
    res.status(500).json({ 
      error: "Email Send Failed",
      message: err.message || "Failed to send email message",
      hint: "Check the recipient email address and try again"
    });
  }
});

/**
 * POST /email/inbound — Webhook for inbound emails (Mailgun/SendGrid)
 * No payment required — this is called by the email provider.
 */
router.post("/inbound", async (req: AuthenticatedRequest, res: Response) => {
  try {
    // TODO: Verify webhook signature from email provider
    const { to, from, subject, body, html } = req.body;
    const msg = emailService.handleInboundEmail(to, from, subject, body, html);

    if (msg) {
      res.json({ received: true, messageId: msg.id });
    } else {
      res.status(404).json({ received: false, error: "No matching inbox" });
    }
  } catch (err: any) {
    console.error("[email] Inbound webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
