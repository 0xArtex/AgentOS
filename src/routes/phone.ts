import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest, ProvisionNumberRequest, SendSmsRequest } from "../types";
import * as phoneService from "../services/phone";
import * as voiceService from "../services/voice";
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
 * Pre-flight validation for phone provisioning. Runs BEFORE the paywall to prevent
 * charging users when provisioning will fail (no numbers available, bad country code).
 *
 * Skipped when the request has no payment header — defers to x402 so the CDP Bazaar
 * crawler's empty-body probe gets a 402 (not a 400) and the endpoint is indexable.
 */
async function preflightProvisionNumber(req: Request, res: Response, next: NextFunction): Promise<void> {
  const hasPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);
  if (!hasPayment) { next(); return; }

  const { country, areaCode } = (req.body || {}) as ProvisionNumberRequest;
  if (!country || typeof country !== "string" || country.length !== 2) {
    res.status(400).json({ error: "Missing Required Field", message: "The 'country' field is required (ISO-2 code, e.g. 'US')" });
    return;
  }
  try {
    // Confirm at least one number is available for this country/areaCode before charging
    const available = await phoneService.searchNumbers(country, { areaCode, limit: 10 });
    const usable = available.filter(n => n.type !== "toll_free" && n.type !== "tollfree");
    if (usable.length === 0 && available.length === 0) {
      res.status(404).json({
        error: "No numbers available",
        message: `No numbers available in ${country}${areaCode ? ` (area code ${areaCode})` : ""}`,
      });
      return;
    }
    next();
  } catch (err: any) {
    res.status(502).json({
      error: "Provider unavailable",
      message: err.message || "Could not reach phone provider to check availability",
      hint: "Try again in a moment. You have NOT been charged.",
    });
  }
}

/**
 * POST /phone/numbers — Provision a new phone number
 * Cost: 3.00 USDC (or free during hackathon with agent limits)
 */
router.get("/numbers", requireAuth(0.01, "general", {
  description: "List all phone numbers owned by the calling wallet.",
  category: "communications",
  tags: ["phone", "list"],
}), async (req: AuthenticatedRequest, res: Response) => {
  const owner = req.agentId || req.payment?.payer;
  if (!owner) return res.status(401).json({ error: "Unauthenticated" });
  const numbers = phoneService.listNumbers(owner);
  res.json({ numbers });
});

router.post("/numbers", preflightProvisionNumber, requireAuth(3.0, "phone", {
  description: "Provision a real phone number (SMS + voice) for your agent. Body: { country: ISO-2, areaCode? }",
  category: "communications",
  tags: ["phone", "sms", "voice", "telnyx", "provision"],
}), async (req: AuthenticatedRequest, res: Response) => {
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

    const owner = req.agentId || req.payment?.payer || "unknown";

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
router.get("/numbers/:id/messages", requireAuth(0.02, "general", {
  description: "Read all SMS messages received on a phone number you own.",
  category: "communications",
  tags: ["phone", "sms", "inbox", "read"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const phoneNumberId = req.params.id as string;
    const owner = req.payment?.payer || req.agentId;
    if (!owner) {
      return res.status(401).json({ error: "No caller identity — cannot verify ownership" });
    }
    const msgs = phoneService.getMessages(phoneNumberId, owner);
    res.json({ messages: msgs });
  } catch (err: any) {
    const status = err?.statusCode === 403 ? 403 : 404;
    res.status(status).json({
      error: status === 403 ? "Forbidden" : "Phone Number Not Found",
      message: err.message || "Could not find messages for this phone number",
      hint: "Check the phone number ID and ensure you own this number",
    });
  }
});

/**
 * Pre-flight validation for SMS send. Runs BEFORE the paywall so users aren't
 * charged when the send is obviously going to fail (bad inputs, unknown number,
 * deactivated number, or destination country that Telnyx won't accept on our
 * messaging profile).
 *
 * Skipped when the request has no payment header so x402 handles discovery probes.
 */
function preflightSendSms(req: Request, res: Response, next: NextFunction): void {
  const hasPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);
  if (!hasPayment) { next(); return; }

  const { to, body } = (req.body || {}) as SendSmsRequest;
  const phoneNumberId = req.params.id as string;

  if (!to || !body) {
    res.status(400).json({
      error: "Missing Required Fields",
      message: "Both 'to' and 'body' fields are required",
      hint: "Include 'to' (E.164 phone number like +15551234567) and 'body' (message text)",
    });
    return;
  }

  // E.164: leading '+', 8–15 digits
  if (!/^\+[1-9]\d{7,14}$/.test(String(to))) {
    res.status(400).json({
      error: "Invalid 'to' format",
      message: "Destination number must be in E.164 format (e.g. +15551234567)",
      hint: "Include country code, no spaces or dashes. You have NOT been charged.",
    });
    return;
  }

  if (String(body).length === 0 || String(body).length > 1600) {
    res.status(400).json({
      error: "Invalid 'body'",
      message: "Message body must be 1–1600 characters",
      hint: "You have NOT been charged.",
    });
    return;
  }

  const number = phoneService.getNumber(phoneNumberId);
  if (!number) {
    res.status(404).json({
      error: "Phone Number Not Found",
      message: `No phone number with ID ${phoneNumberId}`,
      hint: "Check the ID. You have NOT been charged.",
    });
    return;
  }
  if (!number.active) {
    res.status(410).json({
      error: "Phone Number Deactivated",
      message: "This number has been released and can no longer send SMS",
      hint: "Provision a new number. You have NOT been charged.",
    });
    return;
  }

  // Telnyx refuses SMS to some destinations on messaging profiles that don't
  // have an alphanumeric sender ID (error 40306). This typically affects GCC
  // and a handful of other countries that require alpha senders. Reject
  // pre-flight so the caller keeps their USDC.
  const ALPHA_SENDER_REQUIRED = new Set([
    "971", // UAE
    "966", // Saudi Arabia
    "974", // Qatar
    "965", // Kuwait
    "973", // Bahrain
    "968", // Oman
    "962", // Jordan
    "20",  // Egypt
  ]);
  const digits = String(to).slice(1);
  const cc1 = digits.slice(0, 1);
  const cc2 = digits.slice(0, 2);
  const cc3 = digits.slice(0, 3);
  if (ALPHA_SENDER_REQUIRED.has(cc2) || ALPHA_SENDER_REQUIRED.has(cc3) || ALPHA_SENDER_REQUIRED.has(cc1)) {
    res.status(400).json({
      error: "Destination not supported",
      message: `SMS to ${to} requires an alphanumeric sender ID, which is not configured on this messaging profile.`,
      hint: "Try a destination in a country that accepts numeric sender IDs (US, CA, GB, most of EU). You have NOT been charged.",
    });
    return;
  }

  next();
}

/**
 * POST /phone/numbers/:id/send — Send an SMS
 * Cost: 0.05 USDC (or free during hackathon)
 */
router.post("/numbers/:id/send", preflightSendSms, requireAuth(0.05, "general", {
  description: "Send an SMS message from a phone number you own. Body: { to: E.164, body: string }",
  category: "communications",
  tags: ["phone", "sms", "send", "outbound"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, body } = req.body as SendSmsRequest;
    const phoneNumberId = req.params.id as string;

    const msg = await phoneService.sendSms(phoneNumberId, to, body);
    res.status(201).json(msg);
  } catch (err: any) {
    console.error("[phone] Send error:", err);
    // Surface upstream (Telnyx) failures as 502 so the client knows it's not
    // their fault — but the payment has already settled at this point.
    const upstreamMsg = err?.raw?.errors?.[0]?.title || err?.message || "Failed to send SMS message";
    res.status(502).json({
      error: "SMS Send Failed",
      message: upstreamMsg,
      hint: "The carrier rejected this message. Payment has already settled — contact support if this was unexpected.",
    });
  }
});

/**
 * DELETE /phone/numbers/:id — Release a phone number
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.delete("/numbers/:id", requireAuth(0.01, "general"), async (req: AuthenticatedRequest, res: Response) => {
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

// ── Voice / Calling ─────────────────────────────────────────

/**
 * POST /phone/numbers/:id/call — Place an outbound call
 * Cost: 0.10 USDC
 */
router.post("/numbers/:id/call", requireAuth(0.10, "general", {
  description: "Place an outbound phone call from a number you own, with optional TTS or audio playback.",
  category: "communications",
  tags: ["phone", "voice", "call", "dial", "outbound"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to, tts, ttsVoice, audioUrl, record, timeoutSecs } = req.body as {
      to: string;
      tts?: string;
      ttsVoice?: string;
      audioUrl?: string;
      record?: boolean;
      timeoutSecs?: number;
    };

    if (!to) {
      res.status(400).json({
        error: "Missing 'to' field",
        message: "Provide the phone number to call in E.164 format",
        hint: "Example: +15551234567",
      });
      return;
    }

    const call = await voiceService.dial(String(req.params.id), to, {
      tts,
      ttsVoice,
      audioUrl,
      record,
      timeoutSecs,
    });

    res.status(201).json({
      ...call,
      message: `Calling ${to} from ${call.from}`,
      hint: tts ? "TTS will play when the call is answered" : "Call initiated. Use /actions to control it.",
    });
  } catch (err: any) {
    console.error("[voice] Call error:", err);
    res.status(500).json({ error: "Call Failed", message: err.message });
  }
});

/**
 * GET /phone/numbers/:id/calls — List calls for a number
 * Cost: 0.01 USDC
 */
router.get("/numbers/:id/calls", requireAuth(0.02, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const calls = voiceService.listCalls(String(req.params.id));
    res.json({ calls, count: calls.length });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list calls", message: err.message });
  }
});

/**
 * GET /phone/calls/:id — Get call details
 * Cost: 0.01 USDC
 */
router.get("/calls/:id", requireAuth(0.02, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const call = voiceService.getCall(String(req.params.id));
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json(call);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get call", message: err.message });
  }
});

/**
 * POST /phone/calls/:callControlId/speak — TTS on active call
 * Cost: 0.05 USDC
 */
router.post("/calls/:callControlId/speak", requireAuth(0.08, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { text, voice, language } = req.body as { text: string; voice?: string; language?: string };
    if (!text) {
      res.status(400).json({ error: "Missing 'text' field" });
      return;
    }
    await voiceService.speakText(String(req.params.callControlId), text, voice, language);
    res.json({ success: true, message: "Speaking text on call" });
  } catch (err: any) {
    res.status(500).json({ error: "Speak Failed", message: err.message });
  }
});

/**
 * POST /phone/calls/:callControlId/play — Play audio URL on active call
 * Cost: 0.05 USDC
 */
router.post("/calls/:callControlId/play", requireAuth(0.08, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { audioUrl } = req.body as { audioUrl: string };
    if (!audioUrl) {
      res.status(400).json({ error: "Missing 'audioUrl' field" });
      return;
    }
    await voiceService.playAudio(String(req.params.callControlId), audioUrl);
    res.json({ success: true, message: "Playing audio on call" });
  } catch (err: any) {
    res.status(500).json({ error: "Play Failed", message: err.message });
  }
});

/**
 * POST /phone/calls/:callControlId/dtmf — Send DTMF tones
 * Cost: 0.02 USDC
 */
router.post("/calls/:callControlId/dtmf", requireAuth(0.02, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { digits } = req.body as { digits: string };
    if (!digits) {
      res.status(400).json({ error: "Missing 'digits' field", hint: "e.g. '1234#'" });
      return;
    }
    await voiceService.sendDtmf(String(req.params.callControlId), digits);
    res.json({ success: true, message: `Sent DTMF: ${digits}` });
  } catch (err: any) {
    res.status(500).json({ error: "DTMF Failed", message: err.message });
  }
});

/**
 * POST /phone/calls/:callControlId/gather — Collect DTMF input from caller
 * Cost: 0.05 USDC
 */
router.post("/calls/:callControlId/gather", requireAuth(0.08, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { minDigits, maxDigits, timeoutMillis, terminatingDigit, prompt, promptVoice } = req.body as any;
    await voiceService.gatherDtmf(String(req.params.callControlId), {
      minDigits, maxDigits, timeoutMillis, terminatingDigit, prompt, promptVoice,
    });
    res.json({ success: true, message: "Gathering DTMF input" });
  } catch (err: any) {
    res.status(500).json({ error: "Gather Failed", message: err.message });
  }
});

/**
 * POST /phone/calls/:callControlId/record — Start recording
 * Cost: 0.05 USDC
 */
router.post("/calls/:callControlId/record", requireAuth(0.10, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { format } = req.body as { format?: string };
    await voiceService.startRecording(String(req.params.callControlId), format);
    res.json({ success: true, message: "Recording started" });
  } catch (err: any) {
    res.status(500).json({ error: "Record Failed", message: err.message });
  }
});

/**
 * POST /phone/calls/:callControlId/record/stop — Stop recording
 * Cost: free
 */
router.post("/calls/:callControlId/record/stop", requireAuth(0.02, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await voiceService.stopRecording(String(req.params.callControlId));
    res.json({ success: true, message: "Recording stopped" });
  } catch (err: any) {
    res.status(500).json({ error: "Stop Record Failed", message: err.message });
  }
});

/**
 * POST /phone/calls/:callControlId/hangup — End a call
 * Cost: free
 */
router.post("/calls/:callControlId/hangup", requireAuth(0.02, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await voiceService.hangup(String(req.params.callControlId));
    res.json({ success: true, message: "Call ended" });
  } catch (err: any) {
    res.status(500).json({ error: "Hangup Failed", message: err.message });
  }
});

/**
 * POST /phone/calls/:callControlId/answer — Answer an inbound call
 * Cost: free
 */
router.post("/calls/:callControlId/answer", requireAuth(0.02, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await voiceService.answer(String(req.params.callControlId));
    res.json({ success: true, message: "Call answered" });
  } catch (err: any) {
    res.status(500).json({ error: "Answer Failed", message: err.message });
  }
});

/**
 * POST /phone/calls/:callControlId/transfer — Transfer call to another number
 * Cost: 0.10 USDC
 */
router.post("/calls/:callControlId/transfer", requireAuth(0.10, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { to } = req.body as { to: string };
    if (!to) {
      res.status(400).json({ error: "Missing 'to' field" });
      return;
    }
    await voiceService.transfer(String(req.params.callControlId), to);
    res.json({ success: true, message: `Transferring call to ${to}` });
  } catch (err: any) {
    res.status(500).json({ error: "Transfer Failed", message: err.message });
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

    // Handle voice/call events
    if (eventType?.startsWith("call.")) {
      voiceService.handleCallEvent(event).catch((e: any) =>
        console.error("[voice] Webhook handler error:", e.message)
      );
    }

    // Always respond 200 to Telnyx
    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("[phone] Webhook error:", err);
    res.status(200).json({ received: true }); // Don't retry on errors
  }
});

/**
 * POST /phone/webhooks/voice — Voice-specific webhook from Telnyx
 */
router.post("/webhooks/voice", async (req: Request, res: Response) => {
  try {
    const event = req.body?.data;
    if (event) {
      await voiceService.handleCallEvent(event);
    }
    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("[voice] Webhook error:", err);
    res.status(200).json({ received: true });
  }
});

export default router;
