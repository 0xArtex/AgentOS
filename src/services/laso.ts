/**
 * Laso Finance provider client — upstream for the /cards feature.
 *
 * Laso (laso.finance, FinCEN-registered MSB) issues USA prepaid Visa cards
 * through an x402-gated API: `GET /get-card?amount=X` charges exactly $X USDC
 * (0% upstream fee, $5–$1000) and returns a card_id whose PAN/CVV/expiry
 * become available on `GET /get-card-data` ~7-10s later. Docs:
 * https://laso.finance/llms.txt · https://laso.finance/SKILL.md
 *
 * Identity model: the Laso account IS the paying wallet — and per Laso's own
 * guidance (2026-07-09) we shard one wallet PER AGENT rather than aggregating
 * everyone through a single account. Wallet custody, funding, and per-owner
 * token storage live in services/card-payer-wallets.ts; this module is pure
 * API mechanics and takes an explicit auth context (wallet + token cache)
 * everywhere.
 *
 * Auth ladder per account: cached id_token → `POST /auth {grant_type:
 * refresh_token}` → CAIP-122 SIWX wallet sign-in (@x402/extensions), all
 * validated live against production Laso on 2026-07-08. Every PAID response
 * also carries fresh tokens, which we persist opportunistically.
 */
import { config } from "../config";
import { paidFetch, PaidFetchResult } from "./x402-client";
import type { LasoAuthCtx } from "./card-payer-wallets";

const FETCH_TIMEOUT_MS = 25_000;
// id_token lifetime is 3600s; treat as stale well before that so a token
// can't expire mid-poll-loop.
const TOKEN_STALE_MS = 45 * 60 * 1000;

function lasoBase(): string {
  return config.lasoApiBase.replace(/\/+$/, "");
}

// ─── Auth ───

async function refreshViaRefreshToken(
  ctx: LasoAuthCtx,
  refreshToken: string,
  fetchImpl: typeof fetch
): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetchImpl(`${lasoBase()}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const idToken = data?.auth?.id_token ?? data?.id_token;
    const newRefresh = data?.auth?.refresh_token ?? data?.refresh_token ?? refreshToken;
    if (!idToken) return null;
    ctx.persistTokens(idToken, newRefresh);
    return idToken;
  } catch {
    return null;
  }
}

/**
 * From-scratch auth: CAIP-122 Sign-In-With-X against GET /auth. Laso replies
 * 402 with a SIWX challenge in the PAYMENT-REQUIRED header; the extension
 * helper signs it with the account's wallet and retries automatically.
 */
async function authViaSiwx(ctx: LasoAuthCtx, fetchImpl: typeof fetch): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { wrapFetchWithSIWx } = require("@x402/extensions/sign-in-with-x");
  const signer = {
    address: ctx.wallet.address,
    signMessage: ({ message }: { message: string }) => ctx.wallet.signMessage(message),
  };
  const wrapped = wrapFetchWithSIWx(fetchImpl, signer);
  const res = await wrapped(`${lasoBase()}/auth`);
  const data: any = await res.json().catch(() => null);
  const idToken = data?.auth?.id_token;
  const refreshToken = data?.auth?.refresh_token;
  if (!res.ok || !idToken || !refreshToken) {
    throw new Error(`Laso SIWX auth failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  }
  ctx.persistTokens(idToken, refreshToken);
  return idToken;
}

/**
 * Resolve a usable id_token for one account: fresh cache → refresh-token
 * grant → SIWX. Every path persists what it obtained via the context.
 */
export async function getLasoIdToken(ctx: LasoAuthCtx, fetchImpl: typeof fetch = fetch): Promise<string> {
  const cached = ctx.readTokens();
  if (cached && Date.now() - cached.obtained_at_ms < TOKEN_STALE_MS) return cached.id_token;
  if (cached?.refresh_token) {
    const refreshed = await refreshViaRefreshToken(ctx, cached.refresh_token, fetchImpl);
    if (refreshed) return refreshed;
  }
  return authViaSiwx(ctx, fetchImpl);
}

// ─── Paid: buy a USA prepaid card ───

export interface LasoBuyResult {
  cardId: string;
  status: string;
  usdAmount: number;
  lasoUserId: string | null;
  paidUsdc: number;
  nonce?: string;
  validBefore?: number;
  receipt?: any;
  raw: any;
}

export class LasoDeclinedError extends Error {
  constructor(public httpStatus: number, public detail: string) {
    super(`Laso declined the card order (${httpStatus}): ${detail}`);
    this.name = "LasoDeclinedError";
  }
}

/**
 * Order a USA prepaid card with exactly `amountUsd` loaded, paid by the
 * account's own wallet. The x402 price IS the amount (verified on-wire:
 * ?amount=20 → 402 asking 20.000000 USDC), so the spend ceiling is amount +
 * a cent of headroom — any upstream asking for more aborts before signing.
 *
 * Throws:
 *   LasoDeclinedError — probe-level 4xx (nothing signed; definitive)
 *   error with .ambiguous — any failure after the payment header went out
 *     (caller must reconcile via the nonce persisted by onBeforePay — never
 *     blind-refund/re-buy)
 */
export async function lasoBuyUsCard(
  ctx: LasoAuthCtx,
  amountUsd: number,
  onBeforePay: (info: { nonce: string; validBefore: number; amountUsdc: number; payTo: string; payer: string }) => void | Promise<void>,
  fetchImpl: typeof fetch = fetch
): Promise<LasoBuyResult> {
  const url = `${lasoBase()}/get-card?amount=${encodeURIComponent(String(amountUsd))}&format=json`;
  const result: PaidFetchResult = await paidFetch(url, {
    method: "GET",
    wallet: ctx.wallet,
    maxUsdc: amountUsd + 0.01,
    timeoutMs: FETCH_TIMEOUT_MS,
    onBeforePay,
    fetchImpl,
  });

  if (!result.ok) {
    const detail = JSON.stringify(result.data).slice(0, 300);
    if (result.paid) {
      // ANY non-2xx after the payment header went out is AMBIGUOUS — a 402
      // usually means the authorization was rejected unsettled, and a 5xx may
      // have crashed after settling, but only the on-chain oracle
      // (authorizationConsumed) can say which. Never classify as definitive.
      const err: any = new Error(`Laso errored after X-PAYMENT was sent (${result.status}): ${detail}`);
      err.ambiguous = true;
      err.nonce = result.nonce;
      err.validBefore = result.validBefore;
      throw err;
    }
    // Probe-level failure: no payment was ever signed — definitive decline.
    throw new LasoDeclinedError(result.status, detail);
  }

  const auth = result.data?.auth;
  if (auth?.id_token && auth?.refresh_token) ctx.persistTokens(auth.id_token, auth.refresh_token);

  const card = result.data?.card;
  if (!card?.card_id) {
    // Paid, 2xx, but no card handle — treat as ambiguous, reconcile decides.
    const err: any = new Error(
      `Laso returned success without a card_id: ${JSON.stringify(result.data).slice(0, 300)}`
    );
    err.ambiguous = true;
    err.nonce = result.nonce;
    err.validBefore = result.validBefore;
    throw err;
  }
  return {
    cardId: String(card.card_id),
    status: String(card.status || "pending"),
    usdAmount: Number(card.usd_amount ?? amountUsd),
    lasoUserId: result.data?.user_id ?? null,
    paidUsdc: result.paidUsdc,
    nonce: result.nonce,
    validBefore: result.validBefore,
    receipt: result.receipt,
    raw: result.data,
  };
}

// ─── Free (Bearer) endpoints ───

async function bearerFetch(
  path: string,
  idToken: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<{ status: number; data: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${lasoBase()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        ...(init.headers || {}),
      },
      signal: ctrl.signal,
    });
    const data: any = await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The address a merchant's billing/AVS form wants. Laso issues cards against
 * its OWN address (name is always "Laso Finance") — there is no endpoint to
 * register a cardholder address, so this is the only correct answer at a
 * checkout. `required: false` on U.S. cards means AVS is not pinned to it and
 * any valid U.S. address also works; international cards pin AVS to exactly
 * this address.
 */
export interface LasoBillingAddress {
  name: string;
  line_1: string;
  line_2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  required?: boolean;
  note?: string;
}

export interface LasoCardDetails {
  card_number: string;
  exp_month: string;
  exp_year: string;
  cvv: string;
  available_balance?: number;
  billing_address?: LasoBillingAddress;
}

export interface LasoCardData {
  card_id: string;
  status: string;
  usd_amount?: number;
  card_details?: LasoCardDetails;
  transactions?: any[];
  last_updated_timestamp?: number;
}

/** Fetch one card (by id) — status flips pending→ready ~7-10s after purchase. */
export async function lasoGetCardData(
  cardId: string,
  idToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<LasoCardData> {
  const { status, data } = await bearerFetch(
    `/get-card-data?card_id=${encodeURIComponent(cardId)}`,
    idToken,
    { method: "GET" },
    fetchImpl
  );
  if (status === 401 || status === 403) throw new Error(`laso_auth_rejected:${status}`);
  if (status < 200 || status >= 300) {
    throw new Error(`Laso get-card-data failed (${status}): ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data as LasoCardData;
}

/** List every card on ONE account (reconciliation: find that owner's orphans). */
export async function lasoListCards(idToken: string, fetchImpl: typeof fetch = fetch): Promise<LasoCardData[]> {
  const { status, data } = await bearerFetch(`/get-card-data`, idToken, { method: "GET" }, fetchImpl);
  if (status === 401 || status === 403) throw new Error(`laso_auth_rejected:${status}`);
  if (status < 200 || status >= 300) {
    throw new Error(`Laso list cards failed (${status}): ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (Array.isArray(data?.cards)) return data.cards as LasoCardData[];
  if (data?.card_id) return [data as LasoCardData];
  return [];
}

/** Ask Laso to re-scrape a card's balance (upstream-limited: 1/5min per card). */
export async function lasoRefreshCardData(
  cardId: string,
  idToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; data: any }> {
  return bearerFetch(
    `/refresh-card-data`,
    idToken,
    { method: "POST", body: JSON.stringify({ card_id: cardId, card_type: "Non-Reloadable U.S." }) },
    fetchImpl
  );
}

/** Account balance — failed/unfulfilled charges credit here (recoverable). */
export async function lasoAccountBalance(idToken: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const { status, data } = await bearerFetch(`/get-account-balance`, idToken, { method: "GET" }, fetchImpl);
  if (status < 200 || status >= 300) {
    throw new Error(`Laso get-account-balance failed (${status})`);
  }
  return Number(data?.balance ?? 0);
}

/** Withdraw stranded account balance back to that account's payer wallet. */
export async function lasoWithdraw(
  amountUsd: number,
  idToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; data: any }> {
  return bearerFetch(`/withdraw`, idToken, { method: "POST", body: JSON.stringify({ amount: amountUsd }) }, fetchImpl);
}
