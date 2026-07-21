import Telnyx from "telnyx";
import { Worker } from "worker_threads";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { PhoneNumber, SmsMessage } from "../types";
import { storage } from "./storage";

let _client: InstanceType<typeof Telnyx> | null = null;

function getClient(): InstanceType<typeof Telnyx> {
  if (!config.telnyxApiKey) {
    throw new Error("Telnyx API key not configured — set TELNYX_API_KEY");
  }
  if (!_client) {
    _client = new Telnyx({ apiKey: config.telnyxApiKey });
  }
  return _client;
}

/**
 * Search for available phone numbers.
 */
export async function searchNumbers(
  country: string,
  opts?: { areaCode?: string; limit?: number }
): Promise<Array<{ phoneNumber: string; region: string; type: string }>> {
  const client = getClient();
  const params: any = {
    "filter[country_code]": country,
    "filter[limit]": opts?.limit ?? 5,
  };
  if (opts?.areaCode) {
    params["filter[national_destination_code]"] = opts.areaCode;
  }

  const res = await client.availablePhoneNumbers.list(params);
  const numbers = (res as any).data || [];
  return numbers.map((n: any) => ({
    phoneNumber: n.phone_number,
    region: n.region_information?.[0]?.region_name || country,
    type: n.phone_number_type || "local",
  }));
}

/**
 * Provision (purchase) a phone number for an agent.
 */
export async function provisionNumber(
  country: string,
  owner: string,
  areaCode?: string
): Promise<PhoneNumber> {
  const client = getClient();

  // 1. Search for available numbers — prefer local over toll_free to avoid
  //    Telnyx's "freemail account" restriction on toll-free orders.
  const available = await searchNumbers(country, { areaCode, limit: 10 });
  if (available.length === 0) {
    throw new Error(
      `No available numbers in ${country}${areaCode ? ` (area code ${areaCode})` : ""}`
    );
  }

  // Prefer local numbers; fall back to whatever's available
  const local = available.find(n => n.type !== "toll_free" && n.type !== "tollfree");
  const chosen = (local || available[0]).phoneNumber;

  // 2. Create a number order to purchase
  const order = await client.numberOrders.create({
    phone_numbers: [{ phone_number: chosen }],
    messaging_profile_id: config.telnyxMessagingProfileId || undefined,
  } as any);

  const orderData = (order as any).data || order;
  const status = orderData.status;

  if (status !== "success" && status !== "pending") {
    throw new Error(`Number order failed with status: ${status}`);
  }

  // 3. If we have a messaging profile, assign it
  if (config.telnyxMessagingProfileId) {
    try {
      await client.phoneNumbers.update(chosen, {
        messaging_profile_id: config.telnyxMessagingProfileId,
      } as any);
    } catch (e: any) {
      console.warn("[phone] Could not assign messaging profile:", e.message);
    }
  }

  // 4. Store locally
  const record: PhoneNumber = {
    id: uuid(),
    phoneNumber: chosen,
    country,
    owner,
    provisionedAt: new Date().toISOString(),
    active: true,
  };

  storage.setPhoneNumber(record.id, record);
  storage.initSmsMessages(record.id);

  return record;
}

/**
 * True when `wallet` may use this number — the owner or a wallet the owner
 * shared it with. Owner-only actions (release, transfer, share) must check
 * `number.owner` directly instead.
 */
export function hasNumberAccess(number: PhoneNumber, wallet: string): boolean {
  return number.owner === wallet || (number.sharedWith || []).includes(wallet);
}

// ── Disposable temp-number leases ───────────────────────────
// A cheap, instant, receive-only US number leased from a pre-owned pool. The
// phone analogue of the disposable temp email inbox.

/** Lease pricing/TTL (LOCKED): $0.20 for 30min, extend +30min, hard cap 24h. */
export const TEMP_LEASE_PRICE_USDC = 0.20;
export const TEMP_LEASE_DEFAULT_TTL_S = 1800;
export const TEMP_LEASE_MIN_TTL_S = 300;
export const TEMP_LEASE_MAX_TTL_S = 1800;
export const TEMP_LEASE_EXTEND_S = 1800;
export const TEMP_LEASE_MAX_TOTAL_S = 24 * 3600;
/** Inter-lease quarantine + sweep grace: a number rests this long after its
 *  lease expires before it can be re-leased (also when the sweep hard-deletes
 *  the dead row). 1h shrinks the window in which a straggler code for the prior
 *  lessee could reach a new lessee — see TEMP_PHONE_NOTE for the recycling caveat. */
export const TEMP_LEASE_GRACE_S = 3600;
/** Per-wallet abuse caps. */
export const TEMP_LEASE_MAX_CONCURRENT = 3;
export const TEMP_LEASE_MAX_PER_DAY = 12;
/** AIT circuit-breaker: stop storing once a number crosses this many inbound/hour. */
export const TEMP_INBOUND_HOURLY_CAP = 100;

/** The VoIP-reality caveat surfaced on every temp-number surface (lease note, docs, MCP, skill). */
export const TEMP_PHONE_NOTE =
  "Receive-only US number for verification codes. Works with most major services (confirmed: Google, X/Twitter, Discord). " +
  "Some services block VoIP numbers as anti-fraud (e.g. Telegram, WhatsApp, OpenAI) — if a service rejects this number, " +
  "release it and lease another, or use a dedicated number (POST /phone/numbers). Codes usually arrive within seconds; call wait-otp to receive. " +
  "IMPORTANT: this is a RECYCLED pool number — use it only for one-time codes. Do NOT permanently bind it to an account you want to keep (2FA, recovery): " +
  "after your lease ends it returns to the pool and a later user could receive that account's codes. For a number nobody else will hold, buy a dedicated one via POST /phone/numbers.";

/**
 * A temp lease is functionally gone once `expiresAt` passes: reads/wait 410 and
 * inbound SMS is dropped, well before the sweep hard-deletes the row. A
 * permanent (bought) number has no `expiresAt` and never expires.
 */
export function isNumberExpired(number: Pick<PhoneNumber, "expiresAt">): boolean {
  if (!number.expiresAt) return false;
  const t = Date.parse(number.expiresAt);
  return Number.isFinite(t) && t <= Date.now();
}

/** True when the number is a disposable temp lease (has a TTL), vs a bought number. */
export function isTempLease(number: Pick<PhoneNumber, "expiresAt" | "poolNumber">): boolean {
  return !!number.expiresAt || !!number.poolNumber;
}

/** How many pool numbers are free to lease right now (pre-paywall exhaustion check). */
export function countFreePoolNumbers(): number {
  return storage.countFreePoolNumbers(TEMP_LEASE_GRACE_S);
}

/**
 * Per-wallet lease caps: at most 3 concurrent live leases AND 12 leases per
 * rolling 24h. Returns { ok:false, code } to 429 (pre-paywall where the owner
 * is derivable, else post-payment with refund).
 */
export function checkTempLeaseLimits(owner: string): { ok: true } | { ok: false; code: "concurrent" | "daily" } {
  if (storage.countActiveTempLeases(owner) >= TEMP_LEASE_MAX_CONCURRENT) return { ok: false, code: "concurrent" };
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  if (storage.countTempLeasesSince(owner, since) >= TEMP_LEASE_MAX_PER_DAY) return { ok: false, code: "daily" };
  return { ok: true };
}

/**
 * Lease a free pool number to `owner`. Returns the lease record, or null when
 * the pool raced empty between the preflight and here (caller refunds).
 */
export function leaseTempNumber(owner: string, ttlSeconds: number): PhoneNumber | undefined {
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? Math.min(Math.max(Math.floor(ttlSeconds), TEMP_LEASE_MIN_TTL_S), TEMP_LEASE_MAX_TTL_S)
    : TEMP_LEASE_DEFAULT_TTL_S;
  return storage.leaseTempNumber(owner, ttl, TEMP_LEASE_GRACE_S);
}

/**
 * Early-release a temp lease back to the pool: set expiry to now and — crucially
 * — do NOT release at Telnyx (the pooled number stays on our account for the
 * next lessee). The quarantine + sweep reclaim the row. No-op-safe.
 */
export function releaseTempLease(phoneNumberId: string): void {
  storage.updatePhoneNumberExpiry(phoneNumberId, new Date().toISOString());
}

/**
 * Push a temp lease's expiry (rent extension). Scoped in storage to temp leases
 * only. Returns false when the row is missing / not a temp lease / changed
 * underneath (caller refunds).
 */
export function updatePhoneNumberExpiry(phoneNumberId: string, expiresAt: string): boolean {
  return storage.updatePhoneNumberExpiry(phoneNumberId, expiresAt);
}

/**
 * Get all messages for a phone number. Access scope is enforced — callers
 * must present their identity; we refuse to return messages for a number
 * they neither own nor have shared access to.
 */
export function getMessages(phoneNumberId: string, owner?: string): SmsMessage[] {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  if (owner && number.owner && !hasNumberAccess(number, owner)) {
    const err = new Error(`You do not have access to phone number ${phoneNumberId}`);
    (err as any).statusCode = 403;
    throw err;
  }
  const msgs = storage.getSmsMessages(phoneNumberId);
  if (!msgs) throw new Error(`Phone number ${phoneNumberId} not found`);
  // MESSAGE ISOLATION: on a temp lease, clamp visibility to messages that
  // arrived at/after this lease began. Belt-and-braces alongside fresh lease
  // rows (a recycled number gets a new row id, so a raw phone_number_id query
  // already can't reach the prior lessee's rows) — the clamp defends any path
  // that might reuse a row id.
  if (number.leaseStart) {
    const start = Date.parse(number.leaseStart);
    if (Number.isFinite(start)) {
      return msgs.filter(m => {
        const ts = Date.parse(m.timestamp);
        return !Number.isFinite(ts) || ts >= start;
      });
    }
  }
  return msgs;
}


/**
 * Send an SMS from a provisioned number.
 *
 * Hard 25s ceiling on the Telnyx call. Without this, an unresponsive Telnyx
 * leaves the request hanging until Cloudflare's edge times out and returns
 * 502 HTML to the client — at which point the CLI shows
 * "Payment was submitted but server returned 502 ... with non-JSON body" and
 * the user has no idea whether they were charged. With the timeout we surface
 * a JSON error fast, which triggers the route's `refundAndRespond` path.
 */
const TELNYX_SMS_TIMEOUT_MS = 25_000;

export async function sendSms(
  phoneNumberId: string,
  to: string,
  body: string
): Promise<SmsMessage> {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  if (!number.active) throw new Error("Phone number is deactivated");

  const client = getClient();

  const sendPromise = client.messages.send({
    from: number.phoneNumber,
    to,
    text: body,
    messaging_profile_id: config.telnyxMessagingProfileId || undefined,
  } as any);

  const res = await Promise.race([
    sendPromise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Telnyx SMS send timed out after ${TELNYX_SMS_TIMEOUT_MS / 1000}s`)),
        TELNYX_SMS_TIMEOUT_MS,
      ),
    ),
  ]);

  const msgData = (res as any).data || res;

  const msg: SmsMessage = {
    id: msgData.id || uuid(),
    phoneNumberId,
    direction: "outbound",
    from: number.phoneNumber,
    to,
    body,
    timestamp: new Date().toISOString(),
  };

  storage.pushSmsMessage(phoneNumberId, msg);
  return msg;
}

/**
 * Get a single SMS message by id (regardless of which phone number owns it).
 * Returns undefined when not found.
 */
export function getMessage(id: string): SmsMessage | undefined {
  return storage.getSmsMessage(id);
}

// ── OTP extraction / wait ───────────────────────────────────

/** How often the wait-otp loop re-checks the message store. */
export const OTP_POLL_INTERVAL_MS = 2_000;

/** Caller-supplied patterns are rejected above this length (pre-payment). */
export const OTP_PATTERN_MAX_LENGTH = 256;

/** Hard budget for ONE custom-pattern match, enforced by worker termination. */
const OTP_PATTERN_MATCH_TIMEOUT_MS = 100;

/**
 * Extract a verification code from an SMS body. With a custom `pattern`, the
 * first capture group wins (else the full match). Default formats, in order:
 *   1. standalone 4–8 digit code        — "Your code is 482913"
 *   2. "code is" / "code:" + token      — "code: X7K2P9"
 *   3. G-XXXXXX (Google-style)          — "G-482913" (returned with the G-)
 * Returns null when nothing matches (or the custom pattern doesn't compile).
 */
export function extractOtp(text: string, pattern?: string): string | null {
  if (pattern !== undefined) {
    let re: RegExp;
    try { re = new RegExp(pattern); } catch { return null; }
    const m = text.match(re);
    return m ? (m[1] ?? m[0]) : null;
  }
  // 1. Standalone digits: not glued to letters/digits/hyphen/slash or a
  //    currency symbol on the left (so "G-482913", the tail of "+15551234567",
  //    "07/16/2026" and "$2026" don't half-match) and not followed by a
  //    digit/hyphen/slash (so date-ish "2026-07-16" / "2026/07/16" is skipped).
  const standalone = text.match(/(?<![A-Za-z0-9/$€£¥-])(\d{4,8})(?![\d/-])/);
  if (standalone) return standalone[1];
  // 2. "code is <token>" / "code: <token>" — alphanumeric token, 4–12 chars.
  //    The separator must be "is" and/or ":" so prose like "no code here"
  //    never yields a bogus token.
  const labeled = text.match(/\bcode(?:\s+is\b\s*:?\s*|\s*:\s*)"?([A-Za-z0-9][A-Za-z0-9-]{3,11})/i);
  if (labeled) return labeled[1];
  // 3. Google-style G-XXXXXX. Returned whole — message_text lets callers strip.
  const google = text.match(/\bG-\d{4,8}\b/i);
  if (google) return google[0];
  return null;
}

/**
 * Run a CALLER-SUPPLIED regex against an SMS body inside a worker thread with
 * a hard time budget. A catastrophic pattern ((a+)+$ etc.) would otherwise
 * pin the single-threaded event loop for the whole process — timers can't
 * even fire while a synchronous match spins, so no in-thread guard can help.
 * The worker is plain JS (eval'd, empty execArgv so ts-node isn't dragged in)
 * and is force-terminated on overrun. The default extraction regexes are
 * trusted and stay on the main thread (see extractOtp).
 */
function matchPatternInWorker(
  text: string,
  pattern: string,
  budgetMs: number = OTP_PATTERN_MATCH_TIMEOUT_MS,
): Promise<{ code: string | null; timedOut: boolean }> {
  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = new Worker(
        `const { parentPort, workerData } = require("worker_threads");
         let out = null;
         try {
           const m = workerData.text.match(new RegExp(workerData.pattern));
           if (m) out = m[1] !== undefined ? m[1] : m[0];
         } catch { out = null; }
         parentPort.postMessage(out);`,
        { eval: true, workerData: { text, pattern }, execArgv: [] },
      );
    } catch {
      resolve({ code: null, timedOut: false });
      return;
    }
    // Never let a (possibly regex-stuck) worker hold the process open — the
    // event loop must be able to exit even if V8 takes a while to act on the
    // termination interrupt.
    worker.unref();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (code: string | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      void worker.terminate();
      resolve({ code, timedOut });
    };
    // Start the budget once the worker is actually running so spawn latency
    // (tens of ms) doesn't eat into the match budget.
    worker.once("online", () => { timer = setTimeout(() => done(null, true), budgetMs); });
    worker.once("message", msg => done(typeof msg === "string" ? msg : null, false));
    worker.once("error", () => done(null, false));
    worker.once("exit", () => done(null, false));
  });
}

/**
 * Block until an inbound message on `phoneNumberId` yields a verification
 * code, or `timeoutMs` elapses. Checks immediately, then every
 * OTP_POLL_INTERVAL_MS. Messages received up to `lookbackMs` BEFORE the call
 * also match (catches the race where the OTP landed just before the agent
 * asked). Newest message wins when several are in the window.
 *
 * `shouldAbort` is checked every iteration — return true when the client is
 * gone (disconnect / upstream timeout) and the loop stops polling instead of
 * burning the box behind a dead request.
 *
 * A custom `pattern` runs in a worker thread with a hard per-match budget.
 * The FIRST overrun (catastrophic backtracking) drops the pattern for the
 * rest of the wait — matching degrades to the default extraction — and
 * `patternTimedOut` is reported so the caller knows their regex was abandoned.
 */
export async function waitForOtp(
  phoneNumberId: string,
  opts: {
    timeoutMs: number;
    lookbackMs: number;
    pattern?: string;
    shouldAbort?: () => boolean;
  },
): Promise<{ hit: { code: string; message: SmsMessage } | null; patternTimedOut: boolean }> {
  const start = Date.now();
  // MESSAGE ISOLATION: never look back past this lease's start. Without the
  // clamp, a large lookback on a recycled number could surface a PRIOR lessee's
  // code. `windowStart = max(now - lookback, lease_start)`.
  const leaseStartMs = (() => {
    const n = storage.getPhoneNumber(phoneNumberId);
    const t = n?.leaseStart ? Date.parse(n.leaseStart) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  })();
  const windowStart = Math.max(start - opts.lookbackMs, leaseStartMs);
  const deadline = start + opts.timeoutMs;

  let activePattern = opts.pattern;
  let patternTimedOut = false;

  for (;;) {
    if (opts.shouldAbort?.()) return { hit: null, patternTimedOut };
    // Newest-first (storage orders by timestamp DESC) → latest OTP wins.
    const msgs = storage.getSmsMessages(phoneNumberId) || [];
    for (const m of msgs) {
      if (m.direction !== "inbound") continue;
      const ts = Date.parse(m.timestamp);
      if (!Number.isFinite(ts) || ts < windowStart) continue;
      let code: string | null;
      if (activePattern !== undefined) {
        const res = await matchPatternInWorker(m.body, activePattern);
        if (res.timedOut) {
          activePattern = undefined;
          patternTimedOut = true;
          code = extractOtp(m.body);
        } else {
          code = res.code;
        }
      } else {
        code = extractOtp(m.body);
      }
      if (code) return { hit: { code, message: m }, patternTimedOut };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { hit: null, patternTimedOut };
    await new Promise(r => setTimeout(r, Math.min(OTP_POLL_INTERVAL_MS, remaining)));
  }
}

/**
 * Apply a Telnyx-supplied delivery status update to an outbound SMS. No-op
 * if the id doesn't match (row purged before the webhook arrived, or the
 * message isn't ours).
 */
export function updateOutboundDeliveryStatus(
  id: string,
  status: NonNullable<SmsMessage["deliveryStatus"]>,
  providerError?: string,
): void {
  storage.updateSmsDeliveryStatus(id, status, providerError);
}

/**
 * Handle inbound SMS webhook from Telnyx.
 * Telnyx sends webhooks as { data: { event_type, payload } }
 */
export function handleInboundSms(from: string, to: string, body: string): void {
  // Route to the LIVE lease/row only. A recycled pool number whose prior lease
  // expired (or is in its quarantine window) has no live row, so a stray code
  // for the previous lessee is dropped instead of stored where a new lessee
  // could read it. This is the security-critical inbound half of message
  // isolation (findLivePhoneByNumber replaces the active-blind findPhoneByNumber).
  const found = storage.findLivePhoneByNumber(to);
  if (!found) {
    console.warn(`[phone] Inbound SMS to number with no live lease: ${to} — dropped`);
    return;
  }
  const [id] = found;

  // AIT (artificially-inflated-traffic) circuit-breaker: an attacker pumping a
  // number with junk inbound to burn stored rows / trigger costs is capped. Once
  // a number crosses the hourly threshold we log and stop storing for the rest
  // of the window (real OTP volume is a handful of messages).
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  if (storage.countRecentInboundToNumber(to, hourAgo) >= TEMP_INBOUND_HOURLY_CAP) {
    console.warn(`[phone] Inbound SMS circuit-breaker tripped for ${to} (>${TEMP_INBOUND_HOURLY_CAP}/hr) — dropping`);
    return;
  }

  const msg: SmsMessage = {
    id: uuid(),
    phoneNumberId: id,
    direction: "inbound",
    from,
    to,
    body,
    timestamp: new Date().toISOString(),
  };
  storage.pushSmsMessage(id, msg);
  console.log(`[phone] Inbound SMS stored: ${from} → ${to}`);
}

/**
 * Get a phone number by ID.
 */
export function getNumber(id: string): PhoneNumber | undefined {
  return storage.getPhoneNumber(id);
}

/**
 * List all phone numbers a wallet owns or has shared access to.
 */
export function listNumbers(wallet: string): PhoneNumber[] {
  return storage.getPhoneNumbersByWallet(wallet);
}

/**
 * Move a number to a new owner. Clears sharedWith — the previous owner's
 * collaborators don't travel with the number.
 */
export function transferNumber(phoneNumberId: string, newOwner: string): PhoneNumber {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  number.owner = newOwner;
  number.sharedWith = [];
  storage.setPhoneNumber(phoneNumberId, number);
  return number;
}

/** Grant a wallet shared use of a number (idempotent). Returns the updated list. */
export function shareNumber(phoneNumberId: string, wallet: string): string[] {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  const current = number.sharedWith || [];
  number.sharedWith = current.includes(wallet) ? current : [...current, wallet];
  storage.setPhoneNumber(phoneNumberId, number);
  return number.sharedWith;
}

/** Revoke a wallet's shared use of a number. Returns the updated list. */
export function unshareNumber(phoneNumberId: string, wallet: string): string[] {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  number.sharedWith = (number.sharedWith || []).filter(w => w !== wallet);
  storage.setPhoneNumber(phoneNumberId, number);
  return number.sharedWith;
}

/**
 * Delete/release a phone number.
 */
export async function deleteNumber(phoneNumberId: string): Promise<void> {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);

  // Temp lease: early release returns the pooled number to the pool — it is
  // NOT released at Telnyx (we keep the number on our account for the next
  // lessee). Just expire the lease; the quarantine + sweep reclaim the row.
  if (isTempLease(number)) {
    releaseTempLease(phoneNumberId);
    return;
  }

  const client = getClient();

  try {
    await client.phoneNumbers.delete(number.phoneNumber);
  } catch (e: any) {
    console.warn("[phone] Could not release number from Telnyx:", e.message);
  }

  // Mark inactive locally
  number.active = false;
  storage.setPhoneNumber(phoneNumberId, number);
}
