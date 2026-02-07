import { Router, Response } from "express";
import { x402 } from "../middleware/x402";
import { AuthenticatedRequest, ProvisionNumberRequest, SendSmsRequest } from "../types";
import * as phoneService from "../services/phone";

const router = Router({ mergeParams: true });

/**
 * POST /phone/numbers — Provision a new phone number
 * Cost: 2.00 USDC
 */
router.post("/numbers", x402(2.0), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { country, areaCode } = req.body as ProvisionNumberRequest;

    if (!country) {
      res.status(400).json({ error: "country is required" });
      return;
    }

    const number = await phoneService.provisionNumber(
      country,
      req.payment!.payer,
      areaCode
    );

    res.status(201).json(number);
  } catch (err: any) {
    console.error("[phone] Provision error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /phone/numbers/:id/messages — Get all messages for a number
 * Cost: 0.01 USDC
 */
router.get("/numbers/:id/messages", x402(0.01), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const msgs = phoneService.getMessages(req.params.id as string);
    res.json({ messages: msgs });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /phone/numbers/:id/send — Send an SMS
 * Cost: 0.05 USDC
 */
router.post("/numbers/:id/send", x402(0.05), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, body } = req.body as SendSmsRequest;

    if (!to || !body) {
      res.status(400).json({ error: "to and body are required" });
      return;
    }

    const msg = await phoneService.sendSms(req.params.id as string, to, body);
    res.status(201).json(msg);
  } catch (err: any) {
    console.error("[phone] Send error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
