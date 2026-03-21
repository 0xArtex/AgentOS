import { Router, Request, Response } from "express";
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
 * POST /phone/numbers — Provision a new phone number
 * Cost: 2.00 USDC (or free during hackathon with agent limits)
 */
router.post("/numbers", requireAuth(3.0, "phone"), async (req: AuthenticatedRequest, res: Response) => {
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
router.get("/numbers/:id/messages", requireAuth(0.02, "general"), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/numbers/:id/send", requireAuth(0.05, "general"), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/numbers/:id/call", requireAuth(0.10, "general"), async (req: AuthenticatedRequest, res: Response) => {
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
