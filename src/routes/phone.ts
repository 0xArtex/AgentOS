import { validate, PHONE_PATTERN, COUNTRY_PATTERN } from "../middleware/validate";
import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest, ProvisionNumberRequest, SendSmsRequest } from "../types";
import * as phoneService from "../services/phone";
import { trackHackathonUsage } from "../middleware/hackathon";

const router = Router({ mergeParams: true });

/**
 * POST /phone/numbers — Provision a new phone number
 * Cost: 2.00 USDC (or free during hackathon with agent limits)
 */
router.post("/numbers", requireAuth(2.0, 'phone'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { country, areaCode } = req.body as ProvisionNumberRequest;

    if (!country) {
      res.status(400).json({ 
        error: "Missing Required Field",
        message: "The 'country' field is required",
        hint: "Include 'country' in your request body (e.g., 'US', 'CA', 'GB')"
      });
      return;
    }

    // Get owner - either from payment or hackathon mode
    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;

    const number = await phoneService.provisionNumber(
      country,
      owner,
      areaCode
    );

    // Track hackathon usage if applicable
    if (req.isHackathonMode && req.agentId) {
      trackHackathonUsage(req.agentId, 'phone', number.id);
    }

    res.status(201).json(number);
  } catch (err: any) {
    console.error("[phone] Provision error:", err);
    res.status(500).json({ 
      error: "Provision Failed",
      message: err.message || "Failed to provision phone number",
      hint: "Check your country code and try again"
    });
  }
});

/**
 * GET /phone/numbers/:id/messages — Get all messages for a number
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.get("/numbers/:id/messages", requireAuth(0.01, 'phone'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const phoneNumberId = req.params.id as string;
    
    if (!phoneNumberId) {
      res.status(400).json({
        error: "Missing Phone Number ID",
        message: "Phone number ID is required in the URL path",
        hint: "Use format: GET /phone/numbers/{id}/messages"
      });
      return;
    }

    const msgs = phoneService.getMessages(phoneNumberId);
    res.json({ messages: msgs });
  } catch (err: any) {
    res.status(404).json({ 
      error: "Phone Number Not Found",
      message: err.message || "Could not find messages for this phone number",
      hint: "Check the phone number ID and ensure you own this number"
    });
  }
});

/**
 * POST /phone/numbers/:id/send — Send an SMS
 * Cost: 0.05 USDC (or free during hackathon)
 */
router.post("/numbers/:id/send", requireAuth(0.05, 'phone'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, body } = req.body as SendSmsRequest;
    const phoneNumberId = req.params.id as string;

    if (!phoneNumberId) {
      res.status(400).json({
        error: "Missing Phone Number ID", 
        message: "Phone number ID is required in the URL path",
        hint: "Use format: POST /phone/numbers/{id}/send"
      });
      return;
    }

    if (!to || !body) {
      res.status(400).json({ 
        error: "Missing Required Fields",
        message: "Both 'to' and 'body' fields are required",
        hint: "Include both 'to' (phone number) and 'body' (message text) in your request"
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
      hint: "Check the phone number format and try again"
    });
  }
});

export default router;
