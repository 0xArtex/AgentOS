import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest, PhoneNumber, ProvisionNumberRequest, SendSmsRequest } from "../types";
import * as phoneService from "../services/phone";
import * as voiceService from "../services/voice";
import { config } from "../config";
import { checkTelnyxCredit } from "../services/telnyx-balance";
import { refundAndRespond } from "../services/refund";


const router = Router({ mergeParams: true });

// Owners are wallet addresses on either chain x402 settles on:
//   Solana: base58, 32–44 chars
//   EVM (Base): 0x + 40 hex chars
const SOL_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const isWalletAddress = (s: string) => SOL_PUBKEY.test(s) || EVM_ADDR.test(s);

// Symbolic fee proving the signing wallet controls the resource — same
// "ownership proof" tier as domains and X accounts.
const OWNERSHIP_PROOF_USDC = 0.01;

/**
 * Returns true (and sends a 403) when `phoneNumberId` is owned by a wallet
 * other than the caller and not shared with the caller. A missing
 * number/owner is NOT a mismatch — the provider call stays the final
 * authority, so we never lock out legitimate control of an inbound call
 * whose local record isn't there yet.
 */
function denyIfNotNumberAccess(req: AuthenticatedRequest, res: Response, phoneNumberId: string | undefined): boolean {
  if (!phoneNumberId) return false;
  const number = phoneService.getNumber(phoneNumberId);
  const caller = req.payment?.payer || req.agentId;
  if (number?.owner && caller && !phoneService.hasNumberAccess(number, caller)) {
    res.status(403).json({ error: "Forbidden", message: "This resource belongs to a phone number you do not own or have shared access to" });
    return true;
  }
  return false;
}

/** Access gate for call-control routes keyed on a Telnyx callControlId. */
function denyIfNotCallAccess(req: AuthenticatedRequest, res: Response, callControlId: string): boolean {
  const call = voiceService.getCallByControlId(callControlId);
  if (!call) return false; // unknown call — let the provider be the authority
  return denyIfNotNumberAccess(req, res, call.phoneNumberId);
}

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
 * charging users when provisioning will fail (no numbers available, bad country code,
 * OUR Telnyx account out of credit).
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
  // Block paid requests when OUR Telnyx account can't actually buy a number.
  // Catches "Insufficient Funds: User has no credit available: -6.88" before
  // the x402 settlement drains the caller's USDC. Fails-open if the balance
  // API itself is unreachable (reactive refund layer is the safety net).
  // First-month local US is typically $1–2 — gate on $2 here, the helper
  // multiplies by 2x and clamps to a $5 floor so the effective check is ≥ $5.
  const credit = await checkTelnyxCredit(2);
  if (!credit.ok) {
    res.status(503).json({
      error: "Service temporarily unavailable",
      message: credit.reason || "Phone provider account balance too low — no payment was taken.",
      hint: "Try again later. You have NOT been charged.",
    });
    return;
  }
  try {
    // Confirm at least one number is available for this country/areaCode before charging
    const available = await phoneService.searchNumbers(country, { areaCode, limit: 10 });
    if (available.length === 0) {
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
  description: "List all phone numbers owned by or shared with the calling wallet.",
  category: "communications",
  tags: ["phone", "list"],
}), async (req: AuthenticatedRequest, res: Response) => {
  const caller = req.agentId || req.payment?.payer;
  if (!caller) return res.status(401).json({ error: "Unauthenticated" });
  // Tag each row owner/shared; only owners see who else has access.
  const numbers = phoneService.listNumbers(caller).map(n => ({
    ...n,
    access: n.owner === caller ? "owner" : "shared",
    sharedWith: n.owner === caller ? (n.sharedWith || []) : undefined,
  }));
  res.json({ numbers });
});

router.post("/numbers", preflightProvisionNumber, requireAuth(3.0, "phone", {
  description: "Provision a real phone number (SMS + voice) for your agent. Body: { country: ISO-2, areaCode? }",
  category: "communications",
  tags: ["phone", "sms", "voice", "telnyx", "provision"],
}), async (req: AuthenticatedRequest, res: Response) => {
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

  try {
    const number = await phoneService.provisionNumber(country, owner, areaCode);
    res.status(201).json(number);
  } catch (err: any) {
    // Any upstream (Telnyx) failure here = user's USDC is already in
    // treasury but they got no number. Refund automatically and respond
    // with the refund tx so the agent can verify. The preflight Telnyx
    // balance check catches the common case (our account out of credit);
    // this catches everything else — rate limits, API outages, the rare
    // race where balance changed between preflight and order.
    console.error("[phone] Provision error:", err);
    await refundAndRespond(req, res, {
      reason: `Telnyx provision failed: ${err?.message || String(err)}`,
      userMessage: "Could not provision phone number — your payment is being refunded.",
    });
  }
});

/**
 * GET /phone/numbers/:id/messages — Get all messages for a number
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.get("/numbers/:id/messages", requireAuth(0.02, "general", {
  description: "Read all SMS messages received on a phone number you own or have shared access to.",
  category: "communications",
  tags: ["phone", "sms", "inbox", "read"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const phoneNumberId = req.params.id as string;
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      return res.status(401).json({ error: "No caller identity — cannot verify ownership" });
    }
    const msgs = phoneService.getMessages(phoneNumberId, caller);
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
 * deactivated number, destination country Telnyx won't accept on our
 * messaging profile, or our Telnyx account out of credit).
 *
 * Skipped when the request has no payment header so x402 handles discovery probes.
 */
async function preflightSendSms(req: Request, res: Response, next: NextFunction): Promise<void> {
  const hasPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);
  if (!hasPayment) { next(); return; }

  // Same OUR-balance gate as provision. SMS is cheap upstream (~$0.004 per
  // outbound), but if our balance is hovering near zero a $5 floor still
  // bounces correctly — keeps the foot-gun closed across all paid Telnyx
  // routes without per-route thresholds.
  const credit = await checkTelnyxCredit(0.05);
  if (!credit.ok) {
    res.status(503).json({
      error: "Service temporarily unavailable",
      message: credit.reason || "SMS provider account balance too low — no payment was taken.",
      hint: "Try again later. You have NOT been charged.",
    });
    return;
  }

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
  description: "Send an SMS message from a phone number you own or have shared access to. Body: { to: E.164, body: string }",
  category: "communications",
  tags: ["phone", "sms", "send", "outbound"],
}), async (req: AuthenticatedRequest, res: Response) => {
  const { to, body } = req.body as SendSmsRequest;
  const phoneNumberId = req.params.id as string;
  if (denyIfNotNumberAccess(req, res, phoneNumberId)) return;

  try {
    const msg = await phoneService.sendSms(phoneNumberId, to, body);
    res.status(201).json(msg);
  } catch (err: any) {
    // Same auto-refund pattern as `provision`. Settlement already happened
    // by the time we're here; whatever Telnyx rejected, the user shouldn't
    // eat the cost on our behalf.
    console.error("[phone] Send error:", err);
    const upstreamMsg = err?.raw?.errors?.[0]?.title || err?.message || "Failed to send SMS message";
    await refundAndRespond(req, res, {
      reason: `Telnyx SMS send failed: ${upstreamMsg}`,
      userMessage: "Could not send SMS — your payment is being refunded.",
    });
  }
});

/**
 * DELETE /phone/numbers/:id — Release a phone number
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.delete("/numbers/:id", requireAuth(0.01, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const number = phoneService.getNumber(String(req.params.id));
    if (!number) {
      res.status(404).json({ error: "Phone Number Not Found", message: `No phone number with ID ${req.params.id}` });
      return;
    }
    // Releasing a number is destructive and irreversible — only the owner may.
    const caller = req.payment?.payer || req.agentId;
    if (number.owner && caller && number.owner !== caller) {
      res.status(403).json({ error: "Forbidden", message: "You do not own this phone number" });
      return;
    }
    await phoneService.deleteNumber(String(req.params.id));
    res.json({ success: true, message: "Phone number released" });
  } catch (err: any) {
    res.status(404).json({
      error: "Delete Failed",
      message: err.message,
    });
  }
});

// ── Ownership: transfer / share / unshare ───────────────────
// Mirrors /domains: the $0.01 charge is an ownership proof — the x402
// payer signature identifies the current owner. Number stays on our
// Telnyx account; only the DB owner / shared_with rows change.

/** Loads the number and 404s/403s unless the caller is the owner. */
function getNumberAsOwner(req: AuthenticatedRequest, res: Response): PhoneNumber | undefined {
  const number = phoneService.getNumber(String(req.params.id));
  if (!number) {
    res.status(404).json({ error: "Phone Number Not Found", message: `No phone number with ID ${req.params.id}` });
    return undefined;
  }
  const caller = req.payment?.payer || req.agentId;
  if (!caller || number.owner !== caller) {
    res.status(403).json({ error: "Forbidden", message: "Only the owner can do this" });
    return undefined;
  }
  return number;
}

/**
 * POST /phone/numbers/:id/transfer-ownership — hand the number to another wallet.
 * Body: { new_owner: "<wallet>" }
 */
router.post("/numbers/:id/transfer-ownership", requireAuth(OWNERSHIP_PROOF_USDC, "general", { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { new_owner } = req.body || {};
    if (!new_owner || typeof new_owner !== "string" || !isWalletAddress(new_owner)) {
      return res.status(400).json({ error: "new_owner must be a Solana (base58) or EVM (0x…) wallet address" });
    }
    const number = getNumberAsOwner(req, res);
    if (!number) return;
    if (new_owner === number.owner) {
      return res.status(400).json({ error: "new_owner is already the current owner" });
    }

    // Clear shared_with on transfer — the previous owner's collaborators
    // don't travel with the number. New owner can re-share if desired.
    phoneService.transferNumber(number.id, new_owner);

    res.json({
      message: "Ownership transferred",
      id: number.id,
      phone_number: number.phoneNumber,
      previous_owner: req.payment?.payer || req.agentId,
      new_owner,
    });
  } catch (err: any) {
    console.error("[phone] Transfer ownership error:", err);
    res.status(500).json({ error: "Transfer Failed", message: err.message });
  }
});

/**
 * POST /phone/numbers/:id/share — grant another wallet shared use
 * (send SMS, place calls, read messages and call history). Owner-only.
 * Body: { with: "<wallet>" }
 */
router.post("/numbers/:id/share", requireAuth(OWNERSHIP_PROOF_USDC, "general", { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const withWallet = (req.body || {}).with;
    if (!withWallet || typeof withWallet !== "string" || !isWalletAddress(withWallet)) {
      return res.status(400).json({ error: "`with` must be a Solana (base58) or EVM (0x…) wallet address" });
    }
    const number = getNumberAsOwner(req, res);
    if (!number) return;
    if (withWallet === number.owner) {
      return res.status(400).json({ error: "Cannot share with the current owner" });
    }

    const sharedWith = phoneService.shareNumber(number.id, withWallet);

    res.json({
      message: `${number.phoneNumber} shared with ${withWallet}`,
      id: number.id,
      phone_number: number.phoneNumber,
      shared_with: sharedWith,
    });
  } catch (err: any) {
    console.error("[phone] Share error:", err);
    res.status(500).json({ error: "Share Failed", message: err.message });
  }
});

/**
 * POST /phone/numbers/:id/unshare — revoke a wallet's shared use. Owner-only.
 * Body: { wallet: "<wallet>" }
 */
router.post("/numbers/:id/unshare", requireAuth(OWNERSHIP_PROOF_USDC, "general", { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const targetWallet = (req.body || {}).wallet;
    if (!targetWallet || typeof targetWallet !== "string" || !isWalletAddress(targetWallet)) {
      return res.status(400).json({ error: "`wallet` must be a Solana (base58) or EVM (0x…) wallet address" });
    }
    const number = getNumberAsOwner(req, res);
    if (!number) return;

    const sharedWith = phoneService.unshareNumber(number.id, targetWallet);

    res.json({
      message: `${targetWallet} no longer has shared access to ${number.phoneNumber}`,
      id: number.id,
      phone_number: number.phoneNumber,
      shared_with: sharedWith,
    });
  } catch (err: any) {
    console.error("[phone] Unshare error:", err);
    res.status(500).json({ error: "Unshare Failed", message: err.message });
  }
});

// ── Voice / Calling ─────────────────────────────────────────

/**
 * POST /phone/numbers/:id/call — Place an outbound call
 * Cost: 0.10 USDC
 */
router.post("/numbers/:id/call", requireAuth(0.10, "general", {
  description: "Place an outbound phone call from a number you own or have shared access to, with optional TTS or audio playback.",
  category: "communications",
  tags: ["phone", "voice", "call", "dial", "outbound"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (denyIfNotNumberAccess(req, res, String(req.params.id))) return;
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
    if (denyIfNotNumberAccess(req, res, String(req.params.id))) return;
    const calls = voiceService.listCalls(String(req.params.id));
    res.json({ calls, count: calls.length });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list calls", message: err.message });
  }
});

/**
 * GET /phone/messages/:id — Single SMS message readback (incl. delivery status).
 * Parallels /phone/calls/:id so agents can poll an outbound SMS through to
 * `delivered` / `*_failed`. Cheap by design — agents may poll it.
 */
router.get("/messages/:id", requireAuth(0.005, "general", {
  description: "Get one SMS message by id, including delivery_status updated from Telnyx webhooks (queued → sent → delivered, or *_failed).",
  category: "communications",
  tags: ["phone", "sms", "message", "delivery", "status"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const msg = phoneService.getMessage(String(req.params.id));
    if (!msg) {
      res.status(404).json({ error: "Message Not Found", message: `No SMS message with id ${req.params.id}` });
      return;
    }
    // Access gate: only wallets with use of the underlying number can read.
    // Without this, anyone with a wallet could enumerate message ids.
    if (denyIfNotNumberAccess(req, res, msg.phoneNumberId)) return;
    res.json(msg);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get message", message: err.message });
  }
});

/**
 * GET /phone/calls/:id — Get call details
 * Cost: 0.01 USDC
 */
router.get("/calls/:id", requireAuth(0.02, "general", { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const call = voiceService.getCall(String(req.params.id));
    if (!call) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    if (denyIfNotNumberAccess(req, res, call.phoneNumberId)) return;
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
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
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
router.post("/calls/:callControlId/play", requireAuth(0.08, "general", { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
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
router.post("/calls/:callControlId/dtmf", requireAuth(0.02, "general", { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
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
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
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
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
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
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
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
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
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
router.post("/calls/:callControlId/answer", requireAuth(0.02, "general", { discoverable: false }), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
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
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
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

    // Outbound-SMS lifecycle. Telnyx fires these per recipient:
    //   message.sent          → handed off to the carrier
    //   message.finalized     → terminal state (carrier ACK or final error)
    // The recipient sub-status (`to[i].status`) carries the actual delivery
    // outcome (delivered / delivery_failed / sending_failed). Map them onto
    // our SmsMessage.deliveryStatus so `GET /phone/messages/:id` can show it.
    if (eventType === "message.sent" || eventType === "message.finalized") {
      const payload = event.payload;
      const id = payload?.id;
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      const providerErr = errors[0]?.detail || errors[0]?.title;
      const recipients = Array.isArray(payload?.to) ? payload.to : [];
      const recipientStatus: string | undefined = recipients[0]?.status;
      const status =
        (recipientStatus === "delivered" && "delivered") ||
        (recipientStatus === "delivery_failed" && "delivery_failed") ||
        (recipientStatus === "sending_failed" && "sending_failed") ||
        (recipientStatus === "sent" && "sent") ||
        (eventType === "message.sent" ? "sent" : (providerErr ? "delivery_failed" : "delivered"));
      if (id) {
        phoneService.updateOutboundDeliveryStatus(id, status as any, providerErr);
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
