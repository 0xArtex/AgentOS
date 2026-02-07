import { Router, Response } from "express";
import { x402 } from "../middleware/x402";
import { AuthenticatedRequest, CreateInboxRequest, SendEmailRequest } from "../types";
import * as emailService from "../services/email";

const router = Router();

/**
 * POST /email/inboxes — Create a new email inbox
 * Cost: 1.00 USDC
 */
router.post("/inboxes", x402(1.0), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name } = req.body as CreateInboxRequest;

    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const inbox = emailService.createInbox(name, req.payment!.payer);
    res.status(201).json(inbox);
  } catch (err: any) {
    console.error("[email] Create inbox error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /email/inboxes/:id/messages — Get all messages for an inbox
 * Cost: 0.01 USDC
 */
router.get("/inboxes/:id/messages", x402(0.01), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const msgs = emailService.getMessages(req.params.id as string);
    res.json({ messages: msgs });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /email/inboxes/:id/send — Send an email
 * Cost: 0.05 USDC
 */
router.post("/inboxes/:id/send", x402(0.05), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, subject, body, html } = req.body as SendEmailRequest;

    if (!to || !subject || !body) {
      res.status(400).json({ error: "to, subject, and body are required" });
      return;
    }

    const msg = await emailService.sendEmail(req.params.id as string, to, subject, body, html);
    res.status(201).json(msg);
  } catch (err: any) {
    console.error("[email] Send error:", err);
    res.status(500).json({ error: err.message });
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
