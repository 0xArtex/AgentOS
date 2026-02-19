import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest, ProvisionNumberRequest, SendSmsRequest } from "../types";
import * as phoneService from "../services/phone";
import { trackHackathonUsage } from "../middleware/hackathon";
import { config } from "../config";


const router = Router({ mergeParams: true });

/**
 * GET /phone/numbers/search — Search available numbers (free, no auth)
 */
router.get("/numbers/search", async (req: Request, res: Response) => {
  try {
    const country = String(req.query.country || "US");
    const areaCode = req.query.areaCode ? String(req.query.areaCode) : undefined;
    const limit = Math.min(parseInt(String(req.query.limit || "5"), 10), 20);

    const numbers = await phoneService.searchNumbers(country, { areaCode, limit });
    res.json({ numbers, country });
  } catch (err: any) {
    console.error("[phone] Search error:", err);
    res.status(500).json({
      error: "Search Failed",
      message: err.message || "Failed to search for phone numbers",
      hint: "Check your country code (e.g., 'US', 'CA', 'GB') and try again",
    });
  }
});

/**
 * POST /phone/numbers — Provision a new phone number
 * Cost: 2.00 USDC (or free during hackathon with agent limits)
 */
router.post("/numbers", requireAuth(2.0, "phone"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { country, areaCode } = req.body as ProvisionNumberRequest;

    if (!country) {
      res.status(400).json({
        error: "Missing Required Field",
        message: "The 'country' field is required",
        hint: "Include 'country' in your request body (e.g., 'US', 'CA', 'GB')",
      });
      return;
    }

    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;

    const number = await phoneService.provisionNumber(country, owner, areaCode);

    if (req.isHackathonMode && req.agentId) {
      trackHackathonUsage(req.agentId, "phone", number.id);
    }

    res.status(201).json(number);
  } catch (err: any) {
    console.error("[phone] Provision error:", err);
    res.status(500).json({
      error: "Provision Failed",
      message: err.message || "Failed to provision phone number",
      hint: "Check your country code and try again",
    });
  }
});

/**
 * GET /phone/numbers/:id/messages — Get all messages for a number
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.get("/numbers/:id/messages", requireAuth(0.01, "phone"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const phoneNumberId = req.params.id as string;
    const msgs = phoneService.getMessages(phoneNumberId);
    res.json({ messages: msgs });
  } catch (err: any) {
    res.status(404).json({
      error: "Phone Number Not Found",
      message: err.message || "Could not find messages for this phone number",
      hint: "Check the phone number ID and ensure you own this number",
    });
  }
});

/**
 * POST /phone/numbers/:id/send — Send an SMS
 * Cost: 0.05 USDC (or free during hackathon)
 */
router.post("/numbers/:id/send", requireAuth(0.05, "phone"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, body } = req.body as SendSmsRequest;
    const phoneNumberId = req.params.id as string;

    if (!to || !body) {
      res.status(400).json({
        error: "Missing Required Fields",
        message: "Both 'to' and 'body' fields are required",
        hint: "Include 'to' (E.164 phone number like +15551234567) and 'body' (message text)",
      });
      return;
    }

    const msg = await phoneService.sendSms(phoneNumberId, to, body);
    res.status(201).json(msg);
  } catch (err: any) {
    console.error("[phone] Send error:", err);
    res.status(500).json({
      error: "SMS Send Failed",
      message: err.message || "Failed to send SMS message",
      hint: "Check the phone number format (E.164: +15551234567) and try again",
    });
  }
});

/**
 * DELETE /phone/numbers/:id — Release a phone number
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.delete("/numbers/:id", requireAuth(0.01, "phone"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await phoneService.deleteNumber(req.params.id as string);
    res.json({ success: true, message: "Phone number released" });
  } catch (err: any) {
    res.status(404).json({
      error: "Delete Failed",
      message: err.message,
    });
  }
});

/**
 * POST /phone/webhooks/telnyx — Inbound SMS webhook from Telnyx
 * No auth required — verified by webhook signature
 */
router.post("/webhooks/telnyx", (req: Request, res: Response) => {
  try {
    // Optional: verify Telnyx webhook signature
    if (config.telnyxWebhookSecret) {
      const signature = req.headers["telnyx-signature-ed25519"] as string;
      const timestamp = req.headers["telnyx-timestamp"] as string;
      if (!signature || !timestamp) {
        res.status(401).json({ error: "Missing webhook signature" });
        return;
      }
      // Basic timestamp check (reject >5 min old)
      const ts = parseInt(timestamp);
      if (Math.abs(Date.now() / 1000 - ts) > 300) {
        res.status(401).json({ error: "Webhook timestamp too old" });
        return;
      }
    }

    const event = req.body?.data;
    if (!event) {
      res.status(400).json({ error: "Invalid webhook payload" });
      return;
    }

    const eventType = event.event_type;

    if (eventType === "message.received") {
      const payload = event.payload;
      const from = payload?.from?.phone_number;
      const to = payload?.to?.[0]?.phone_number || payload?.to;
      const text = payload?.text;

      if (from && to && text) {
        phoneService.handleInboundSms(from, to, text);
      }
    }

    // Always respond 200 to Telnyx
    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("[phone] Webhook error:", err);
    res.status(200).json({ received: true }); // Don't retry on errors
  }
});

export default router;
