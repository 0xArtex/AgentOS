import express, { Router, Request, Response, NextFunction } from "express";
import nacl from "tweetnacl";
// Side-effect import: loads the express Request augmentation (req.timedOut /
// req.timeoutSignal) declared by the timeout middleware. The wait-otp abort
// check reads req.timedOut, and ts-node's per-file compilation only sees the
// augmentation when the declaring module is in the import graph.
import "../middleware/timeout";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest, PhoneNumber, ProvisionNumberRequest, SendSmsRequest } from "../types";
import * as phoneService from "../services/phone";
import * as voiceService from "../services/voice";
import { config } from "../config";
import { checkTelnyxCredit } from "../services/telnyx-balance";
import { refundAndRespond } from "../services/refund";
import { extractClaimedSvmPayer } from "../middleware/x402-svm-verify";


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

// E.164: leading '+', first digit 1-9, total 8-15 digits. Shared by the SMS
// pre-flight and the outbound-voice destination guard so both reject the same
// malformed numbers.
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

// ── Outbound-voice toll-fraud guard ─────────────────────────
// Telnyx bills voice per-minute and international / premium-rate destinations
// can cost several USD/min, while we charge a flat ~$0.10 per call. An
// unvalidated `to` is therefore an account-draining foot-gun (and the classic
// International Revenue Share Fraud sink). Mirror ALPHA_SENDER_REQUIRED: a
// conservative deny-list of E.164 prefixes (country code or NANP premium area
// code, no leading '+'). Standard US/CA/EU calling is unaffected.
const BLOCKED_VOICE_PREFIXES = new Set<string>([
  // Satellite / global-mobile networks — the classic IRSF revenue-share sinks.
  "870", "871", "872", "873", "874", "878", "881", "882", "883",
  // High-cost island / small-nation country codes repeatedly used as IRSF
  // termination points.
  "239", "247", "248", "252", "257", "262", "269",
  "677", "678", "679", "681", "682", "683", "685", "688", "690",
  // NANP premium-rate / known one-ring (Wangiri) abused ranges.
  "1900", "1976",
]);

function isBlockedVoiceDestination(to: string): boolean {
  const digits = to.replace(/^\+/, "");
  return (
    BLOCKED_VOICE_PREFIXES.has(digits.slice(0, 2)) ||
    BLOCKED_VOICE_PREFIXES.has(digits.slice(0, 3)) ||
    BLOCKED_VOICE_PREFIXES.has(digits.slice(0, 4))
  );
}

/**
 * Validate an outbound voice destination: must be a well-formed E.164 number
 * and must not hit a high-cost / premium-rate prefix. Returns a structured
 * verdict so both the (pre-charge) preflight and the in-handler safety net can
 * reuse the same policy.
 */
function validateOutboundDestination(to: unknown):
  | { ok: true; to: string }
  | { ok: false; status: number; body: { error: string; message: string; hint: string } } {
  if (!to || typeof to !== "string") {
    return { ok: false, status: 400, body: {
      error: "Missing 'to' field",
      message: "Provide the destination phone number in E.164 format",
      hint: "Example: +15551234567.",
    } };
  }
  if (!E164_REGEX.test(to)) {
    return { ok: false, status: 400, body: {
      error: "Invalid 'to' format",
      message: "Destination number must be in E.164 format (e.g. +15551234567)",
      hint: "Include country code, no spaces or dashes.",
    } };
  }
  if (isBlockedVoiceDestination(to)) {
    return { ok: false, status: 403, body: {
      error: "Destination not allowed",
      message: `Calls to ${to} are blocked: high-cost / premium-rate destination commonly abused for toll fraud.`,
      hint: "Voice calling is limited to standard-rate destinations. Contact support to enable a specific country.",
    } };
  }
  return { ok: true, to };
}

/**
 * Pre-flight (runs BEFORE the paywall) for routes that place/transfer a call.
 * Rejects malformed or high-cost destinations so the caller keeps their USDC.
 * Skipped without a payment header so x402 still answers discovery probes.
 */
function preflightOutboundDestination(req: Request, res: Response, next: NextFunction): void {
  const hasPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);
  if (!hasPayment) { next(); return; }
  const verdict = validateOutboundDestination((req.body || {}).to);
  if (!verdict.ok) {
    res.status(verdict.status).json({ ...verdict.body, hint: `${verdict.body.hint} You have NOT been charged.` });
    return;
  }
  next();
}

// ── Telnyx webhook signature verification ───────────────────
// Telnyx signs every webhook with Ed25519 over `${timestamp}|${rawBody}`. The
// base64 signature arrives in `telnyx-signature-ed25519`, the unix-seconds
// timestamp in `telnyx-timestamp`, and the base64 Ed25519 public key is
// configured as TELNYX_WEBHOOK_SECRET. Without this check anyone who knows a
// victim's number can forge `message.received` (fake inbound OTP), flip
// delivery status, or drive `voiceService.handleCallEvent` (mark answered/
// ended, inject a recordingUrl / DTMF).
const TELNYX_REPLAY_WINDOW_SECS = 300;

/**
 * Resolve the exact bytes Telnyx signed. Preference order:
 *   1. `req.body` is a Buffer  → captured by this route's `express.raw`
 *      (the webhook stream was not pre-parsed). Verify the exact bytes.
 *   2. `req.rawBody` is a Buffer → captured by an upstream `express.json`
 *      `verify` hook. Preferred when the global parser already produced an
 *      object.
 *   3. Re-serialize the parsed body. Telnyx emits compact JSON, which
 *      round-trips here. A byte mismatch can only ever *reject* (the signature
 *      then fails closed) — it can never turn a forgery into an accepted event
 *      — so this fallback stays safe.
 */
function readTelnyxWebhook(req: Request): { rawBody: Buffer; body: any } {
  const anyReq = req as any;
  const current = req.body;
  if (Buffer.isBuffer(current)) {
    let parsed: any;
    try { parsed = JSON.parse(current.toString("utf8")); } catch { parsed = undefined; }
    return { rawBody: current, body: parsed };
  }
  if (Buffer.isBuffer(anyReq.rawBody)) {
    return { rawBody: anyReq.rawBody, body: current };
  }
  let rawBody: Buffer;
  try { rawBody = Buffer.from(JSON.stringify(current ?? {}), "utf8"); } catch { rawBody = Buffer.from(""); }
  return { rawBody, body: current };
}

/**
 * Verify a Telnyx webhook signature. FAILS CLOSED: a missing public key,
 * missing headers, an invalid signature, or a stale timestamp all reject. The
 * replay window is only consulted AFTER the signature is proven valid.
 */
function verifyTelnyxWebhook(
  req: Request,
  rawBody: Buffer,
): { ok: true } | { ok: false; status: number; error: string } {
  const publicKeyB64 = config.telnyxWebhookSecret;
  if (!publicKeyB64) {
    // No key configured → we cannot prove the event came from Telnyx. Refusing
    // every event is strictly safer than trusting forged ones.
    return { ok: false, status: 503, error: "Webhook verification not configured" };
  }

  const signature = req.headers["telnyx-signature-ed25519"];
  const timestamp = req.headers["telnyx-timestamp"];
  if (typeof signature !== "string" || typeof timestamp !== "string" || !signature || !timestamp) {
    return { ok: false, status: 401, error: "Missing webhook signature" };
  }

  let valid = false;
  try {
    const signed = Buffer.concat([Buffer.from(`${timestamp}|`, "utf8"), rawBody]);
    const sig = Buffer.from(signature, "base64");
    const key = Buffer.from(publicKeyB64, "base64");
    if (sig.length === 64 && key.length === 32) {
      valid = nacl.sign.detached.verify(
        new Uint8Array(signed),
        new Uint8Array(sig),
        new Uint8Array(key),
      );
    }
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, status: 401, error: "Invalid webhook signature" };
  }

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TELNYX_REPLAY_WINDOW_SECS) {
    return { ok: false, status: 401, error: "Webhook timestamp outside replay window" };
  }
  return { ok: true };
}

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

/**
 * Access gate for call-control routes keyed on a Telnyx callControlId.
 * FAILS CLOSED: if we can't resolve the call locally we cannot establish
 * ownership, so we deny. (Call-control IDs are high-value capabilities —
 * speak/play/DTMF/record/hangup/transfer — and every call we place is tracked,
 * so an untracked ID is not a call this wallet may drive.)
 */
function denyIfNotCallAccess(req: AuthenticatedRequest, res: Response, callControlId: string): boolean {
  const call = voiceService.getCallByControlId(callControlId);
  if (!call) {
    res.status(403).json({ error: "Forbidden", message: "Unknown or untracked call — cannot verify ownership" });
    return true;
  }
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
 * Priced via x402 — see /pricing for the live amount.
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

// ── Disposable temp numbers (pooled, receive-only) ──────────
// The phone analogue of the shipped disposable temp EMAIL inbox: lease a cheap,
// instant, receive-only US number from a pre-owned pool to catch one SMS code.

/** Wallet identity a temp caller would own the lease as (verified, post-auth). */
function tempOwner(req: AuthenticatedRequest): string {
  return req.agentId || req.payment?.payer || "unknown";
}

/** 429 body tailored to which cap was hit — "release one" is wrong advice for
 *  a daily-cap breach (nothing active to release), so distinguish the two. */
function tempLimitBody(code: "concurrent" | "daily") {
  return {
    error: "Temp-number limit reached",
    message: code === "concurrent"
      ? `You already hold the max ${phoneService.TEMP_LEASE_MAX_CONCURRENT} active temp numbers. Release one (DELETE /phone/numbers/:id) or let a lease expire, then retry.`
      : `You've hit the daily temp-number limit (${phoneService.TEMP_LEASE_MAX_PER_DAY} per wallet per 24h). Wait for earlier leases to age out, or use POST /phone/numbers for a dedicated number.`,
  };
}

/** 503 body for pool exhaustion. */
const TEMP_EXHAUSTED_BODY = {
  error: "No temp numbers available",
  message: "All temp numbers are currently in use. Try again in a minute, or use POST /phone/numbers for a dedicated number.",
};

/**
 * Pre-flight for POST /phone/temp. Runs BEFORE the paywall so we NEVER charge
 * when we can't fulfill: pool exhausted → 503, per-wallet cap → 429. Pool
 * availability is identity-free; the cap pre-check is best-effort (the claimed
 * Solana payer only — a Base payer is invisible pre-settlement and a token
 * caller pays from a wallet that may differ from the owner, so both are
 * re-checked post-payment with refund). Skipped without a payment header so x402
 * answers discovery probes with a 402.
 */
function preflightLeaseTempNumber(req: Request, res: Response, next: NextFunction): void {
  const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined;
  if (!paymentHeader) { next(); return; }

  if (phoneService.countFreePoolNumbers() === 0) {
    res.status(503).json({ ...TEMP_EXHAUSTED_BODY, hint: "Your wallet has NOT been charged." });
    return;
  }

  // Best-effort cap pre-check — skip for token callers (their owner is the
  // registered wallet, not the claimed payer) so the handler enforces it.
  const tokenHeader = String(
    req.headers["authorization"] || req.headers["x-api-key"] || req.headers["x-agent-token"] || ""
  ).replace(/^Bearer\s+/i, "");
  if (!/^(aos_|agt_)/.test(tokenHeader)) {
    const claimed = extractClaimedSvmPayer(String(paymentHeader));
    if (claimed) {
      const lim = phoneService.checkTempLeaseLimits(claimed);
      if (!lim.ok) {
        res.status(429).json({ ...tempLimitBody(lim.code), hint: "Your wallet has NOT been charged." });
        return;
      }
    }
  }
  next();
}

/**
 * POST /phone/temp — lease a disposable, receive-only US number from the pool.
 *
 * $0.20 for 30min (ttl_seconds default 1800, clamp [300, 1800]). Owned by the
 * paying wallet with the same owner/read-auth model as a bought number;
 * "disposable" is the lifecycle. Receive-only (send/call/transfer/share hard-
 * 403). Returns to the pool at expiry. Pool numbers are OPS-seeded (never bought
 * in the request path — cost control); when the pool is dry we 503 pre-charge.
 */
router.post("/temp", preflightLeaseTempNumber, requireAuth(phoneService.TEMP_LEASE_PRICE_USDC, "phone", {
  // Keep this UNDER 500 chars — CDP's x402 facilitator schema caps
  // resource.description at 500, and v2 clients echo it back into their payment
  // payload, so a longer one fails verification. The full VoIP/recycling caveat
  // (TEMP_PHONE_NOTE) reaches agents via the lease response body, the MCP tool
  // description, and the skill doc.
  description:
    "Lease a cheap, instant, receive-only US phone number from a pool to receive one SMS verification code — the phone analogue of a disposable temp email inbox. $0.20 for 30 min (ttl_seconds, clamp 300–1800). Receive-only; call wait-otp to catch the code. Works with most services (Google/X/Discord); some block VoIP. Recycled pool — one-time codes only.",
  category: "communications",
  tags: ["phone", "sms", "temp", "disposable", "otp", "verification", "receive-only"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rawTtl = Number(req.body?.ttl_seconds);
    const ttlSeconds = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : phoneService.TEMP_LEASE_DEFAULT_TTL_S;
    const owner = tempOwner(req);

    // Re-check caps with the VERIFIED owner (the free pre-check couldn't see a
    // Base payer or a token caller's registered wallet). A charged cap-breach
    // must refund, never keep the charge.
    const lim = phoneService.checkTempLeaseLimits(owner);
    if (!lim.ok) {
      await refundAndRespond(req, res, {
        reason: `Temp lease cap reached for ${owner}`,
        userMessage: `${tempLimitBody(lim.code).message} Your payment is being refunded.`,
        errorLabel: "Temp-number limit reached",
        httpStatus: 429,
      });
      return;
    }

    const lease = phoneService.leaseTempNumber(owner, ttlSeconds);
    if (!lease) {
      // Residual race: the pool emptied between the free preflight and here.
      await refundAndRespond(req, res, {
        reason: "Temp pool raced empty post-payment",
        userMessage: `${TEMP_EXHAUSTED_BODY.message} Your payment is being refunded.`,
        errorLabel: TEMP_EXHAUSTED_BODY.error,
        httpStatus: 503,
      });
      return;
    }

    res.status(201).json({
      id: lease.id,
      phone_number: lease.phoneNumber,
      expires_at: lease.expiresAt,
      note: phoneService.TEMP_PHONE_NOTE,
    });
  } catch (err: any) {
    console.error("[phone] Temp lease error:", err);
    // An unexpected throw after the $0.20 settled (e.g. SQLITE_BUSY) must refund,
    // never keep a charge for a lease we couldn't deliver.
    await refundAndRespond(req, res, {
      reason: `Temp lease failed unexpectedly: ${err?.message || String(err)}`,
      userMessage: "Could not lease a temp number — your payment is being refunded.",
      errorLabel: "Temp Lease Failed",
      httpStatus: 500,
    });
  }
});

/**
 * Validate a temp-extend target BEFORE the paywall (mirrors email's
 * validateExtendTarget). Unknown/expired → 404, non-temp (a bought number) →
 * 400, wrong-owner → 403 — all FREE. The Base-payer / TOCTOU cases can't be
 * seen here (claimed payer is Solana-only; the lease can expire mid-settle), so
 * the handler refunds those post-charge. Skipped without a payment header so
 * x402 answers discovery probes.
 */
function validatePhoneExtendTarget(req: Request, res: Response, next: NextFunction): void {
  const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined;
  if (!paymentHeader) { next(); return; }

  const number = phoneService.getNumber(String(req.params.id));
  if (!number || !number.active || phoneService.isNumberExpired(number)) {
    res.status(404).json({
      error: "Phone Number Not Found",
      message: "No live temp number with this id. Expired temp leases cannot be revived — lease a fresh one via POST /phone/temp.",
      hint: "Your wallet has NOT been charged — this check ran before payment.",
    });
    return;
  }
  if (!phoneService.isTempLease(number)) {
    res.status(400).json({
      error: "Not a temp number",
      message: "This is a permanent number — permanent numbers never expire, so there is nothing to extend. Only disposable temp numbers (POST /phone/temp) have a TTL.",
      hint: "Your wallet has NOT been charged — this check ran before payment.",
    });
    return;
  }
  if (Date.parse(number.expiresAt!) - Date.parse(number.leaseStart || number.provisionedAt) + phoneService.TEMP_LEASE_EXTEND_S * 1000 > phoneService.TEMP_LEASE_MAX_TOTAL_S * 1000) {
    res.status(400).json({
      error: "Temp lease cap reached",
      message: "Temp numbers can be extended up to 24h total; this lease has reached the cap. Lease a fresh one or use POST /phone/numbers for a permanent number.",
      hint: "Your wallet has NOT been charged — this check ran before payment.",
    });
    return;
  }

  // Registered-agent (token) callers legitimately pay from a wallet that isn't
  // the lease owner — skip the claimed-payer pre-check for them (the handler
  // re-checks ownership with verified identities and refunds a mismatch).
  const tokenHeader = String(
    req.headers["authorization"] || req.headers["x-api-key"] || req.headers["x-agent-token"] || ""
  ).replace(/^Bearer\s+/i, "");
  if (/^(aos_|agt_)/.test(tokenHeader)) { next(); return; }

  const claimedPayer = extractClaimedSvmPayer(String(paymentHeader));
  if (claimedPayer && !phoneService.hasNumberAccess(number, claimedPayer) && claimedPayer !== number.owner) {
    res.status(403).json({
      error: "Wallet mismatch",
      message: "Only the wallet that leased this number can use it.",
      hint: "Your wallet has NOT been charged — this check ran before payment.",
    });
    return;
  }
  next();
}

/**
 * POST /phone/temp/:id/extend — rent another 30 min on a live temp lease.
 *
 * $0.20 per call, stacks on the CURRENT expiry, hard cap 24h total lease
 * duration (expires_at − lease_start). Owner-only, live-only. Free rejections
 * via validatePhoneExtendTarget; the Base-payer / TOCTOU cases refund post-charge.
 */
router.post("/temp/:id/extend", validatePhoneExtendTarget, requireAuth(phoneService.TEMP_LEASE_PRICE_USDC, "phone", {
  description:
    "Rent another 30 minutes on a live disposable temp number — each $0.20 call pushes expires_at 30 min further. Stackable up to 24h total; owner-only; expired temp leases cannot be revived (lease a fresh one).",
  category: "communications",
  tags: ["phone", "sms", "temp", "disposable", "extend"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const number = phoneService.getNumber(id);
    // Re-run the guard's checks with verified auth (the guard is skipped without
    // a payment header, and the lease can expire during settlement). Every
    // charged rejection refunds — a charged failure without a refund is never OK.
    if (!number || !number.active || phoneService.isNumberExpired(number)) {
      await refundAndRespond(req, res, {
        reason: `Temp extend target gone/expired post-payment: ${id}`,
        userMessage: "No live temp number with this id — it may have expired while the payment settled. Expired temp leases cannot be revived; your payment is being refunded. Lease a fresh one via POST /phone/temp.",
        errorLabel: "Phone Number Not Found",
        httpStatus: 404,
      });
      return;
    }
    if (!phoneService.isTempLease(number)) {
      await refundAndRespond(req, res, {
        reason: `Temp extend on permanent number: ${id}`,
        userMessage: "This is a permanent number — it has no TTL to extend. Your payment is being refunded.",
        errorLabel: "Not a temp number",
        httpStatus: 400,
      });
      return;
    }

    const identities = [req.payment?.payer, req.agentId].filter(Boolean) as string[];
    const isOwner = identities.some(w => phoneService.hasNumberAccess(number, w) || w === number.owner);
    if (!isOwner) {
      await refundAndRespond(req, res, {
        reason: `Temp extend wallet mismatch: ${id}`,
        userMessage: "Only the wallet that leased this number can use it. Your payment is being refunded.",
        errorLabel: "Wallet mismatch",
        httpStatus: 403,
      });
      return;
    }

    const newExpiresAt = new Date(Date.parse(number.expiresAt!) + phoneService.TEMP_LEASE_EXTEND_S * 1000).toISOString();
    const totalLeaseMs = Date.parse(newExpiresAt) - Date.parse(number.leaseStart || number.provisionedAt);
    if (totalLeaseMs > phoneService.TEMP_LEASE_MAX_TOTAL_S * 1000) {
      await refundAndRespond(req, res, {
        reason: `Temp extend past 24h cap: ${id}`,
        userMessage: "Temp numbers can be extended up to 24h total; this lease has reached the cap. Your payment is being refunded — lease a fresh one or use POST /phone/numbers for a permanent number.",
        errorLabel: "Temp lease cap reached",
        httpStatus: 400,
      });
      return;
    }

    if (!phoneService.updatePhoneNumberExpiry(id, newExpiresAt)) {
      await refundAndRespond(req, res, {
        reason: `Temp extend UPDATE no-op (row changed during request): ${id}`,
        userMessage: "Could not extend — the lease changed state while the payment settled. Your payment is being refunded.",
        errorLabel: "Extension Failed",
        httpStatus: 409,
      });
      return;
    }

    res.json({ id: number.id, phone_number: number.phoneNumber, expires_at: newExpiresAt, note: phoneService.TEMP_PHONE_NOTE });
  } catch (err: any) {
    console.error("[phone] Temp extend error:", err);
    // Unexpected throw after the $0.20 settled → refund, never keep the charge.
    await refundAndRespond(req, res, {
      reason: `Temp extend failed unexpectedly: ${err?.message || String(err)}`,
      userMessage: "Could not extend the lease — your payment is being refunded.",
      errorLabel: "Temp Extend Failed",
      httpStatus: 500,
    });
  }
});

/**
 * Reject send / call / transfer-ownership / share / unshare on a disposable
 * temp lease BEFORE the paywall — a $0.20 receive-only number must never
 * originate SMS/voice or change hands (mirrors email's blockTempSend). Running
 * before x402 means the caller is never charged only to be blocked. Permanent
 * numbers (and unknown ids, which fall through to the handler's own 404) pass.
 */
function blockTempPhoneActions(req: Request, res: Response, next: NextFunction): void {
  const number = phoneService.getNumber(String(req.params.id));
  if (number && phoneService.isTempLease(number)) {
    res.status(403).json({
      error: "Temp numbers are receive-only",
      message: "Temp numbers are receive-only. Use POST /phone/numbers for a number that can send SMS or make calls.",
      hint: "Your wallet has NOT been charged.",
    });
    return;
  }
  next();
}

/**
 * GET /phone/numbers/:id/messages — Get all messages for a number
 * Priced via x402 — see /pricing for the live amount.
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
    // An expired temp lease reads as gone (410), never a stale message dump —
    // consistent with wait-otp and with the message-window isolation.
    const number = phoneService.getNumber(phoneNumberId);
    if (number && phoneService.isTempLease(number) && phoneService.isNumberExpired(number)) {
      return res.status(410).json({
        error: "Temp lease expired",
        message: "This temp number's lease has expired. Lease a fresh one via POST /phone/temp.",
      });
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

// ── wait-otp: blocking wait for an SMS verification code ────

// Hard ceiling on the blocking wait. Prod sits behind a Cloudflare Tunnel with
// a ~100s edge limit — never let a request hold longer than 90s. The route is
// exempted from the global 30s request timeout (see isTimeoutExempt in
// middleware/timeout.ts) — without that, the 408 would fire mid-wait AFTER
// x402 settlement and drop a code the payer already paid for.
const WAIT_OTP_MAX_TIMEOUT_S = 90;
const WAIT_OTP_DEFAULT_TIMEOUT_S = 60;
// Lookback defaults LOW: a number reused for a second signup shortly after a
// first would otherwise instantly re-serve the FIRST signup's stale code.
// Callers reusing a number across signups should pass lookback_s=0.
const WAIT_OTP_DEFAULT_LOOKBACK_S = 10;
const WAIT_OTP_MAX_LOOKBACK_S = 300;

/** Coerce an optional body/query param to a clamped integer. */
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Validate a caller-supplied extraction pattern: bounded length (it's a raw
 * regex from an untrusted wallet) and compilable. Returns the 400 body on
 * failure, undefined when acceptable. Shared by the pre-charge preflight and
 * the in-handler defense-in-depth check.
 */
function validateWaitOtpPattern(pattern: string | undefined):
  | { error: string; message: string; hint: string }
  | undefined {
  if (pattern === undefined) return undefined;
  if (pattern.length > phoneService.OTP_PATTERN_MAX_LENGTH) {
    return {
      error: "Pattern too long",
      message: `The custom extraction pattern must be at most ${phoneService.OTP_PATTERN_MAX_LENGTH} characters (got ${pattern.length})`,
      hint: "OTP formats are short — a real extraction regex fits well under the cap.",
    };
  }
  try { new RegExp(pattern); } catch {
    return {
      error: "Invalid 'pattern'",
      message: "The custom extraction pattern is not a valid regular expression",
      hint: "Fix the regex (JS syntax, no flags) or omit it to use the default OTP formats.",
    };
  }
  return undefined;
}

/** Read wait-otp params — body first, query as fallback (all optional). */
function readWaitOtpParams(req: Request): { timeoutS: number; lookbackS: number; pattern?: string } {
  const body = (req.body || {}) as Record<string, unknown>;
  const pick = (key: string) => body[key] ?? req.query[key];
  const rawPattern = pick("pattern");
  return {
    timeoutS: clampInt(pick("timeout_s"), WAIT_OTP_DEFAULT_TIMEOUT_S, 1, WAIT_OTP_MAX_TIMEOUT_S),
    lookbackS: clampInt(pick("lookback_s"), WAIT_OTP_DEFAULT_LOOKBACK_S, 0, WAIT_OTP_MAX_LOOKBACK_S),
    pattern: typeof rawPattern === "string" && rawPattern !== "" ? rawPattern : undefined,
  };
}

/**
 * Pre-flight for wait-otp. Runs BEFORE the paywall so callers keep their USDC
 * when the wait is obviously going to fail (bad regex, unknown/released
 * number). Skipped without a payment header so x402 answers discovery probes.
 */
function preflightWaitOtp(req: Request, res: Response, next: NextFunction): void {
  const hasPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);
  if (!hasPayment) { next(); return; }

  const { pattern } = readWaitOtpParams(req);
  const patternError = validateWaitOtpPattern(pattern);
  if (patternError) {
    res.status(400).json({ ...patternError, hint: `${patternError.hint} You have NOT been charged.` });
    return;
  }

  const number = phoneService.getNumber(String(req.params.id));
  if (!number) {
    res.status(404).json({
      error: "Phone Number Not Found",
      message: `No phone number with ID ${req.params.id}`,
      hint: "Check the ID. You have NOT been charged.",
    });
    return;
  }
  if (!number.active) {
    res.status(410).json({
      error: "Phone Number Deactivated",
      message: "This number has been released — no new SMS will arrive on it",
      hint: "Provision a new number. You have NOT been charged.",
    });
    return;
  }
  // Expired temp lease → 410 (no new SMS route to a dead lease). Free — pre-paywall.
  if (phoneService.isTempLease(number) && phoneService.isNumberExpired(number)) {
    res.status(410).json({
      error: "Temp lease expired",
      message: "This temp number's lease has expired. Lease a fresh one via POST /phone/temp.",
      hint: "You have NOT been charged.",
    });
    return;
  }
  next();
}

/**
 * POST /phone/numbers/:id/wait-otp — Blocking wait for an SMS verification code
 * Cost: 0.02 USDC — same tier as reading the inbox. One paid call replaces a
 * hand-rolled poll of GET /numbers/:id/messages during account signups.
 *
 * Body/query (all optional): timeout_s (default 60, max 90), lookback_s
 * (default 10 — also match messages that arrived up to this many seconds
 * BEFORE the request; pass 0 when reusing a number across signups so a stale
 * code can't be re-served), pattern (custom extraction regex, ≤256 chars;
 * first capture group wins, else the full match — runs in a worker thread
 * with a hard per-match budget; on overrun it's dropped for the rest of the
 * wait, extraction degrades to the defaults, and pattern_timeout: true is
 * reported).
 *
 * 200 { found: true, code, message_text, message_id, received_at } on a hit;
 * 200 { found: false, waited_s } on timeout — not an error, just call again.
 */
router.post("/numbers/:id/wait-otp", preflightWaitOtp, requireAuth(0.02, "general", {
  description:
    "Wait (blocking, up to 90s) for an SMS verification code / OTP to arrive on a phone number you own, and return the parsed code. Body (all optional): { timeout_s (default 60, max 90), lookback_s (default 10; pass 0 for reused numbers), pattern (custom regex, max 256 chars) }",
  category: "communications",
  tags: ["phone", "sms", "otp", "verification", "code", "wait", "2fa"],
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const phoneNumberId = String(req.params.id);
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      return res.status(401).json({ error: "No caller identity — cannot verify ownership" });
    }
    const number = phoneService.getNumber(phoneNumberId);
    if (!number) {
      return res.status(404).json({ error: "Phone Number Not Found", message: `No phone number with ID ${phoneNumberId}` });
    }
    // Defense-in-depth for a direct token-auth hit that skipped the preflight:
    // an expired temp lease 410s (no new SMS routes to a dead lease).
    if (phoneService.isTempLease(number) && phoneService.isNumberExpired(number)) {
      return res.status(410).json({
        error: "Temp lease expired",
        message: "This temp number's lease has expired. Lease a fresh one via POST /phone/temp.",
      });
    }
    if (denyIfNotNumberAccess(req, res, phoneNumberId)) return;

    const { timeoutS, lookbackS, pattern } = readWaitOtpParams(req);
    // Defense-in-depth: the preflight already rejected bad patterns pre-charge,
    // but re-validate so a direct token-auth hit can't start a wait with an
    // oversized or uncompilable regex.
    const patternError = validateWaitOtpPattern(pattern);
    if (patternError) {
      return res.status(400).json(patternError);
    }

    // Stop polling the moment the client is gone: connection closed, or an
    // upstream timeout layer already answered. Never write after that.
    // NOTE: deliberately NOT req.destroyed — Node destroys the fully-consumed
    // request stream on a perfectly healthy connection, so that flag is true
    // mid-wait for every request. The response side is the truth: res 'close'
    // before we've written means the connection died under us.
    let clientClosed = false;
    res.once("close", () => { clientClosed = true; });
    const aborted = () =>
      clientClosed || Boolean(req.timedOut) || res.destroyed || res.writableEnded;

    const started = Date.now();
    const result = await phoneService.waitForOtp(phoneNumberId, {
      timeoutMs: timeoutS * 1000,
      lookbackMs: lookbackS * 1000,
      pattern,
      shouldAbort: aborted,
    });

    if (aborted() || res.headersSent) return; // client gone — nothing to write to

    const patternFlag = result.patternTimedOut ? { pattern_timeout: true } : {};
    if (result.hit) {
      res.json({
        found: true,
        code: result.hit.code,
        message_text: result.hit.message.body,
        message_id: result.hit.message.id,
        received_at: result.hit.message.timestamp,
        ...patternFlag,
      });
    } else {
      // Timeout is a normal outcome, not an error — agents just call again.
      res.json({ found: false, waited_s: Math.round((Date.now() - started) / 1000), ...patternFlag });
    }
  } catch (err: any) {
    console.error("[phone] wait-otp error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Wait Failed", message: err.message });
    }
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
  if (!E164_REGEX.test(String(to))) {
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
 * Priced via x402 — see /pricing for the live amount.
 */
router.post("/numbers/:id/send", blockTempPhoneActions, preflightSendSms, requireAuth(0.05, "general", {
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
 * Priced via x402 — see /pricing for the live amount.
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
    // A temp lease early-releases back to the POOL (no Telnyx release call);
    // a bought number is released at Telnyx. deleteNumber branches internally.
    const wasTemp = phoneService.isTempLease(number);
    await phoneService.deleteNumber(String(req.params.id));
    res.json({
      success: true,
      message: wasTemp ? "Temp number released back to the pool" : "Phone number released",
      ...(wasTemp ? { returned_to_pool: true } : {}),
    });
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
router.post("/numbers/:id/transfer-ownership", blockTempPhoneActions, requireAuth(OWNERSHIP_PROOF_USDC, "general", {
  description: "Transfer a phone number you own to another wallet. Clears shared access. Body: { new_owner: wallet }",
  category: "communications",
  tags: ["phone", "transfer", "ownership"],
}), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/numbers/:id/share", blockTempPhoneActions, requireAuth(OWNERSHIP_PROOF_USDC, "general", {
  description: "Grant another wallet shared use of a phone number you own (send/read SMS, place calls). Owner-only. Body: { with: wallet }",
  category: "communications",
  tags: ["phone", "share"],
}), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/numbers/:id/unshare", blockTempPhoneActions, requireAuth(OWNERSHIP_PROOF_USDC, "general", {
  description: "Revoke a wallet's shared use of a phone number you own. Owner-only. Body: { wallet }",
  category: "communications",
  tags: ["phone", "unshare"],
}), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/numbers/:id/call", blockTempPhoneActions, preflightOutboundDestination, requireAuth(0.10, "general", {
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

    // Defense-in-depth: the preflight already rejected bad/high-cost
    // destinations pre-charge, but re-validate so a direct hit can never place
    // an unvalidated (potentially toll-fraud) call.
    const verdict = validateOutboundDestination(to);
    if (!verdict.ok) {
      res.status(verdict.status).json(verdict.body);
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
router.get("/calls/:id", requireAuth(0.02, "general", {
  description: "Get details of a call on a phone number you own or have shared access to.",
  category: "communications",
  tags: ["phone", "voice", "call", "status"],
}), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/calls/:callControlId/play", requireAuth(0.08, "general", {
  description: "Play an audio URL into a live call on a number you control.",
  category: "communications",
  tags: ["phone", "voice", "call", "play", "audio"],
}), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/calls/:callControlId/dtmf", requireAuth(0.02, "general", {
  description: "Send DTMF tones into a live call on a number you control.",
  category: "communications",
  tags: ["phone", "voice", "call", "dtmf"],
}), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/calls/:callControlId/answer", requireAuth(0.02, "general", {
  description: "Answer an inbound call on a number you control.",
  category: "communications",
  tags: ["phone", "voice", "call", "answer", "inbound"],
}), async (req: AuthenticatedRequest, res: Response) => {
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
router.post("/calls/:callControlId/transfer", preflightOutboundDestination, requireAuth(0.10, "general"), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (denyIfNotCallAccess(req, res, String(req.params.callControlId))) return;
    const { to } = req.body as { to: string };
    // Same E.164 + toll-fraud policy as outbound dial — a transfer terminates
    // a new per-minute leg to `to`, so an unvalidated destination is the same
    // account-draining foot-gun.
    const verdict = validateOutboundDestination(to);
    if (!verdict.ok) {
      res.status(verdict.status).json(verdict.body);
      return;
    }
    await voiceService.transfer(String(req.params.callControlId), to);
    res.json({ success: true, message: `Transferring call to ${to}` });
  } catch (err: any) {
    res.status(500).json({ error: "Transfer Failed", message: err.message });
  }
});

/**
 * POST /phone/webhooks/telnyx — Inbound SMS / voice webhook from Telnyx
 * No paywall — authenticated by the Telnyx Ed25519 webhook signature instead.
 *
 * `express.raw` captures the exact request bytes for byte-faithful signature
 * verification when the webhook stream isn't pre-parsed; verifyTelnyxWebhook
 * falls back to a captured `rawBody` / a safe re-serialization otherwise.
 */
router.post("/webhooks/telnyx", express.raw({ type: () => true, limit: "1mb" }), (req: Request, res: Response) => {
  // Verify the Telnyx signature BEFORE processing — fail closed on a missing
  // key, missing headers, an invalid signature, or a stale timestamp.
  const { rawBody, body } = readTelnyxWebhook(req);
  const verdict = verifyTelnyxWebhook(req, rawBody);
  if (!verdict.ok) {
    res.status(verdict.status).json({ error: verdict.error });
    return;
  }

  try {
    const event = body?.data;
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
 * Same Ed25519 signature gate as /webhooks/telnyx — without it anyone could
 * forge call.* events into voiceService.handleCallEvent (flip call state,
 * inject a recordingUrl / DTMF).
 */
router.post("/webhooks/voice", express.raw({ type: () => true, limit: "1mb" }), async (req: Request, res: Response) => {
  const { rawBody, body } = readTelnyxWebhook(req);
  const verdict = verifyTelnyxWebhook(req, rawBody);
  if (!verdict.ok) {
    res.status(verdict.status).json({ error: verdict.error });
    return;
  }
  try {
    const event = body?.data;
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
