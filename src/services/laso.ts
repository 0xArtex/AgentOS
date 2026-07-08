/**
 * Laso Finance provider client — upstream for the /cards feature.
 *
 * Laso (laso.finance, FinCEN-registered MSB) issues USA prepaid Visa cards
 * through an x402-gated API: `GET /get-card?amount=X` charges exactly $X USDC
 * (0% upstream fee, $5–$1000) and returns a card_id whose PAN/CVV/expiry
 * become available on `GET /get-card-data` ~7-10s later. Docs:
 * https://laso.finance/llms.txt · https://laso.finance/SKILL.md
 *
 * Identity model: the Laso account IS the paying wallet. We pay from one
 * dedicated server-held payer wallet (LASO_PAYER_EVM_PRIVATE_KEY — deliberately
 * NOT the treasury key, so a compromise here can't drain refund float), which
 * makes all cards live under one upstream account; per-agent ownership is
 * OUR bookkeeping (card_purchases.owner).
 *
 * Auth tokens: every PAID Laso response already includes {id_token,
 * refresh_token} — we cache them (encrypted at rest) and refresh via
 * `POST /auth {grant_type: refresh_token}`. SIWX (CAIP-122 wallet sign-in via
 * @x402/extensions/sign-in-with-x) is the from-scratch fallback so crash
 * reconciliation can ALWAYS list the account's cards even if the token cache
 * was never populated.
 */
import { db } from "../db";
import { config } from "../config";
import { sealSecret, openSecret } from "./secret-box";
import { paidFetch, baseUsdcBalance, PaidFetchResult } from "./x402-client";

const PAYER_KEY_ENV = "LASO_PAYER_EVM_PRIVATE_KEY";
const FETCH_TIMEOUT_MS = 25_000;
// id_token lifetime is 3600s; treat as stale well before that so a token
// can't expire mid-poll-loop.
const TOKEN_STALE_MS = 45 * 60 * 1000;

// ─── Token cache (singleton row, ciphertext at rest) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS laso_account_tokens (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    tokens_ciphertext TEXT NOT NULL,
    obtained_at TEXT NOT NULL
  );
`);

export interface LasoTokens {
  id_token: string;
  refresh_token: string;
  obtained_at_ms: number;
}

export class LasoDisabledError extends Error {
  constructor() {
    super(`Laso cards are not configured on this deployment (${PAYER_KEY_ENV} unset).`);
    this.name = "LasoDisabledError";
  }
}

// ─── Payer wallet (lazy, refund.ts pattern) ───
let _payerWallet: any = null;
let _payerDisabledReason: string | null = null;

export function lasoEnabled(): boolean {
  return !!process.env[PAYER_KEY_ENV];
}

export function loadLasoPayer(): any {
  if (_payerWallet) return _payerWallet;
  const raw = process.env[PAYER_KEY_ENV];
  if (!raw) {
    _payerDisabledReason = `${PAYER_KEY_ENV} not configured`;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ethers } = require("ethers");
    // No provider attached: EIP-3009 + SIWX signing are fully offline. Reads
    // (float checks, authorizationState) construct their own provider.
    _payerWallet = new ethers.Wallet(raw);
    _payerDisabledReason = null;
    console.log(`[laso] payer wallet loaded: ${_payerWallet.address}`);
    return _payerWallet;
  } catch (e: any) {
    _payerDisabledReason = `${PAYER_KEY_ENV} failed to parse: ${e.message}`;
    console.error(`[laso] ${_payerDisabledReason}`);
    return null;
  }
}

export function lasoDisabledReason(): string | null {
  return _payerDisabledReason;
}

/** Test hook: clear cached wallet/balance so env changes take effect. */
export function _resetLasoCachesForTest(): void {
  _payerWallet = null;
  _payerDisabledReason = null;
  _floatCache = null;
}

function lasoBase(): string {
  return config.lasoApiBase.replace(/\/+$/, "");
}

// ─── Token persistence ───

export function readCachedTokens(): LasoTokens | null {
  const row = db.prepare("SELECT tokens_ciphertext, obtained_at FROM laso_account_tokens WHERE id = 1").get() as
    | { tokens_ciphertext: string; obtained_at: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(openSecret(row.tokens_ciphertext));
    return {
      id_token: parsed.id_token,
      refresh_token: parsed.refresh_token,
      obtained_at_ms: new Date(row.obtained_at).getTime(),
    };
  } catch (e: any) {
    console.error("[laso] token cache unreadable (master key changed?) — will re-auth:", e?.message || e);
    return null;
  }
}

export function persistTokens(idToken: string, refreshToken: string): void {
  if (!idToken || !refreshToken) return;
  const ciphertext = sealSecret(JSON.stringify({ id_token: idToken, refresh_token: refreshToken }));
  db.prepare(
    `INSERT INTO laso_account_tokens (id, tokens_ciphertext, obtained_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET tokens_ciphertext = excluded.tokens_ciphertext, obtained_at = excluded.obtained_at`
  ).run(ciphertext, new Date().toISOString());
}

/** Persist tokens carried on any Laso response body (paid responses include them). */
export function persistTokensFromResponse(data: any): void {
  const auth = data?.auth;
  if (auth?.id_token && auth?.refresh_token) persistTokens(auth.id_token, auth.refresh_token);
}

// ─── Auth ───

async function refreshViaRefreshToken(refreshToken: string, fetchImpl: typeof fetch): Promise<LasoTokens | null> {
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
    persistTokens(idToken, newRefresh);
    return { id_token: idToken, refresh_token: newRefresh, obtained_at_ms: Date.now() };
  } catch {
    return null;
  }
}

/**
 * From-scratch auth: CAIP-122 Sign-In-With-X against GET /auth. Laso replies
 * 402 with a SIWX challenge in the PAYMENT-REQUIRED header; the extension
 * helper signs it with the payer wallet and retries automatically.
 */
async function authViaSiwx(fetchImpl: typeof fetch): Promise<LasoTokens> {
  const wallet = loadLasoPayer();
  if (!wallet) throw new LasoDisabledError();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { wrapFetchWithSIWx } = require("@x402/extensions/sign-in-with-x");
  const signer = {
    address: wallet.address,
    signMessage: ({ message }: { message: string }) => wallet.signMessage(message),
  };
  const wrapped = wrapFetchWithSIWx(fetchImpl, signer);
  const res = await wrapped(`${lasoBase()}/auth`);
  const data: any = await res.json().catch(() => null);
  const idToken = data?.auth?.id_token;
  const refreshToken = data?.auth?.refresh_token;
  if (!res.ok || !idToken || !refreshToken) {
    throw new Error(
      `Laso SIWX auth failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`
    );
  }
  persistTokens(idToken, refreshToken);
  return { id_token: idToken, refresh_token: refreshToken, obtained_at_ms: Date.now() };
}

/**
 * Resolve a usable id_token: fresh cache → refresh-token grant → SIWX.
 * Every path persists what it obtained, so the next caller hits the cache.
 */
export async function getLasoIdToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  const cached = readCachedTokens();
  if (cached && Date.now() - cached.obtained_at_ms < TOKEN_STALE_MS) return cached.id_token;
  if (cached?.refresh_token) {
    const refreshed = await refreshViaRefreshToken(cached.refresh_token, fetchImpl);
    if (refreshed) return refreshed.id_token;
  }
  const fresh = await authViaSiwx(fetchImpl);
  return fresh.id_token;
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
 * Order a USA prepaid card with exactly `amountUsd` loaded. The x402 price IS
 * the amount (verified on-wire: ?amount=20 → 402 asking 20.000000 USDC), so
 * the spend ceiling is amount + a cent of headroom — any upstream asking for
 * more aborts before signing.
 *
 * Throws:
 *   LasoDeclinedError — upstream 4xx AFTER payment (definitive; caller refunds)
 *   error with .ambiguous — network death after signing (caller must reconcile
 *     via the nonce persisted by onBeforePay, never blind-refund/re-buy)
 */
export async function lasoBuyUsCard(
  amountUsd: number,
  onBeforePay: (info: { nonce: string; validBefore: number; amountUsdc: number; payTo: string; payer: string }) => void | Promise<void>,
  fetchImpl: typeof fetch = fetch
): Promise<LasoBuyResult> {
  const wallet = loadLasoPayer();
  if (!wallet) throw new LasoDisabledError();

  const url = `${lasoBase()}/get-card?amount=${encodeURIComponent(String(amountUsd))}&format=json`;
  const result: PaidFetchResult = await paidFetch(url, {
    method: "GET",
    wallet,
    maxUsdc: amountUsd + 0.01,
    timeoutMs: FETCH_TIMEOUT_MS,
    onBeforePay,
    fetchImpl,
  });

  if (!result.ok) {
    const detail = JSON.stringify(result.data).slice(0, 300);
    if (result.paid && result.status === 402) {
      // Our payment header was rejected outright — normally the authorization
      // was NOT settled, but only the on-chain oracle can say for sure.
      const err: any = new Error(`Laso rejected the payment (402 after X-PAYMENT): ${detail}`);
      err.ambiguous = true;
      err.nonce = result.nonce;
      err.validBefore = result.validBefore;
      throw err;
    }
    throw new LasoDeclinedError(result.status, detail);
  }

  persistTokensFromResponse(result.data);
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

export interface LasoCardDetails {
  card_number: string;
  exp_month: string;
  exp_year: string;
  cvv: string;
  available_balance?: number;
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

/** List every card on the account (reconciliation: find orphans after a crash). */
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

/** Withdraw stranded account balance back to the payer wallet. */
export async function lasoWithdraw(
  amountUsd: number,
  idToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; data: any }> {
  return bearerFetch(`/withdraw`, idToken, { method: "POST", body: JSON.stringify({ amount: amountUsd }) }, fetchImpl);
}

// ─── Operator float ───

let _floatCache: { value: number; at: number } | null = null;

/**
 * Payer wallet's USDC float on Base, cached 30s. Preflight uses this to 503
 * (wallet NOT charged) before accepting an order the payer can't fund.
 */
export async function lasoPayerFloat(): Promise<number | null> {
  const wallet = loadLasoPayer();
  if (!wallet) return null;
  if (_floatCache && Date.now() - _floatCache.at < 30_000) return _floatCache.value;
  try {
    const value = await baseUsdcBalance(wallet.address);
    _floatCache = { value, at: Date.now() };
    return value;
  } catch (e: any) {
    console.warn("[laso] float check failed (RPC):", e?.message || e);
    return null; // unknown — callers proceed rather than block on an RPC blip
  }
}
