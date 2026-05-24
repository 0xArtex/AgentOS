/**
 * Telnyx balance preflight — checks that OUR Telnyx account has enough credit
 * to fulfill an operation BEFORE the x402 paywall settles the user's payment.
 *
 * Stops the foot-gun where a Telnyx "Insufficient Funds: User has no credit
 * available: -6.88" rejection happens AFTER we've already taken the user's
 * USDC. (See src/routes/phone.ts and src/services/refund.ts for the
 * reactive layer that handles failures that slip past this.)
 *
 * Reads via Telnyx's standard `GET /v2/balance` REST endpoint with the same
 * API key configured in `src/services/phone.ts` (Telnyx SDK uses it too).
 *
 * Cached briefly (60s) — checking balance on every paid request would burn
 * an extra round-trip for the cost of stale-by-up-to-a-minute. If a real
 * operation later drains the balance, the reactive refund layer catches it.
 */
import { config } from "../config";

interface TelnyxBalanceResponse {
  available_credit?: string;
  balance?: string;
  currency?: string;
  credit_limit?: string;
}

interface CachedBalance {
  availableUsd: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
let _cache: CachedBalance | null = null;

/**
 * Hit Telnyx /v2/balance and parse the available credit in USD.
 * Returns null on any error — caller decides whether to fail-open or fail-closed.
 */
async function fetchTelnyxBalance(): Promise<number | null> {
  if (!config.telnyxApiKey) {
    // No key = we'd never have provisioned anyway; don't block here, let the
    // SDK call surface the missing-key error with its existing message.
    return null;
  }
  try {
    const res = await fetch("https://api.telnyx.com/v2/balance", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${config.telnyxApiKey}`,
        "Accept": "application/json",
      },
      // 5s — slow Telnyx response shouldn't block a paid request indefinitely.
      // If it times out, we fail-open (let the operation try), and the reactive
      // refund layer catches actual rejections.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[telnyx-balance] /v2/balance returned ${res.status}`);
      return null;
    }
    const payload = (await res.json()) as { data?: TelnyxBalanceResponse };
    const data = payload?.data;
    if (!data) return null;
    // `available_credit` = current balance + any credit line. That's the
    // figure Telnyx uses to gate purchases, so it's what we check against.
    // Fall back to `balance` when available_credit is absent.
    const raw = data.available_credit ?? data.balance;
    if (raw === undefined) return null;
    const num = parseFloat(String(raw));
    if (!Number.isFinite(num)) return null;
    return num;
  } catch (e: any) {
    if (e?.name !== "AbortError") {
      console.warn(`[telnyx-balance] fetch failed: ${e?.message || e}`);
    }
    return null;
  }
}

async function getCachedBalance(): Promise<number | null> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.availableUsd;
  }
  const fresh = await fetchTelnyxBalance();
  if (fresh !== null) {
    _cache = { availableUsd: fresh, fetchedAt: Date.now() };
  }
  return fresh;
}

export interface TelnyxCreditCheck {
  /** True if Telnyx looks healthy enough to attempt this operation. */
  ok: boolean;
  /** Available credit in USD (Telnyx native unit), if we could read it. */
  availableUsd: number | null;
  /** Required USD floor we checked against. */
  requiredUsd: number;
  /** Set when ok=false to surface to the user. */
  reason?: string;
  /** True when the balance read itself failed — caller may fail-open. */
  unknown: boolean;
}

/**
 * Check that Telnyx has at least `requiredUsd` of available credit, with a
 * small safety buffer. Returns ok:true when balance is healthy, ok:false
 * when it's known to be insufficient, and ok:true + unknown:true when we
 * couldn't read the balance (fail-open — let the operation try and rely on
 * the reactive refund layer if it ultimately fails).
 *
 * Buffer rationale: Telnyx charges include the per-number fee + first-month
 * service. The advertised `available_credit` is computed at request time but
 * sub-cent rounding plus pending in-flight orders can shave a dollar off.
 * Demand 2x the operation cost or $5 (whichever is larger) to leave headroom.
 */
export async function checkTelnyxCredit(requiredUsd: number): Promise<TelnyxCreditCheck> {
  const buffer = Math.max(requiredUsd * 2, 5);
  const balance = await getCachedBalance();
  if (balance === null) {
    // Fail-open. The reactive refund layer is the safety net here — telling
    // every legitimate caller "we couldn't check Telnyx, please retry" would
    // outage the service whenever Telnyx's balance API blips.
    return { ok: true, availableUsd: null, requiredUsd, unknown: true };
  }
  if (balance < buffer) {
    return {
      ok: false,
      availableUsd: balance,
      requiredUsd,
      unknown: false,
      reason: `Telnyx account balance is $${balance.toFixed(2)} — below the $${buffer.toFixed(2)} safety floor for this operation. Service temporarily unavailable; no payment was taken. Try again later.`,
    };
  }
  return { ok: true, availableUsd: balance, requiredUsd, unknown: false };
}

/** Force-clear the cache (test/admin use). */
export function clearTelnyxBalanceCache(): void {
  _cache = null;
}
