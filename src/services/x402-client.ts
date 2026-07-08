/**
 * Outbound x402 client — Palmyr as the PAYER.
 *
 * Everything else in src/ is the inbound side (we charge agents). This module
 * is the outbound counterpart: pay an external x402-gated API from a
 * server-held wallet. First consumer: Laso Finance prepaid cards
 * (services/laso.ts). Ported from the battle-tested CLI client (cli/pay.ts),
 * with two deliberate differences:
 *
 *   - Base/EVM only. The EIP-3009 TransferWithAuthorization flow is fully
 *     offline (sign typed data, the upstream's facilitator settles and pays
 *     gas) — no RPC, no SOL/ETH float, no blockhash races. Solana outbound
 *     can be added when an upstream requires it.
 *   - v2 header challenges. Upstreams like Laso return the challenge
 *     base64-encoded in the `PAYMENT-REQUIRED` response header with an empty
 *     JSON body (x402 v2), while our own server puts it in the body. Both are
 *     parsed here.
 *
 * Money-safety invariants:
 *   - `maxUsdc` is REQUIRED on every paid call and enforced BEFORE signing —
 *     a compromised upstream advertising an inflated amount aborts the call.
 *   - `onBeforePay` fires after signing but before the paid request is sent,
 *     so callers can persist the EIP-3009 nonce first. `authorizationConsumed`
 *     (the on-chain oracle) later resolves "did that payment actually move
 *     money" for crash reconciliation — the same role getInfo plays for
 *     domain registrations.
 *   - Transient-failure retry resubmits the SAME header. EIP-3009 nonces are
 *     single-use on-chain, so replaying an authorization can never double-pay.
 */
import { randomBytes } from "crypto";

// Base mainnet constants (mirror cli/pay.ts + middleware/x402.ts)
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_CHAIN_ID = 8453;
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";

// Lazy ethers (house pattern — refund.ts). Keeps import-time light and
// sidesteps node10 moduleResolution limits for subpath type lookups.
function getEthers(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("ethers").ethers ?? require("ethers");
}

/** One entry of the challenge's `accepts[]`, kept verbatim for echo-back. */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string; // atomic units (USDC 6dp)
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, any>;
  [k: string]: any;
}

export interface Parsed402 {
  x402Version?: number;
  accepts: PaymentRequirement[];
  resource?: any;
  extensions?: any;
  raw: any;
}

/**
 * Decode a 402 challenge from a response. Prefers the x402 v2
 * `PAYMENT-REQUIRED` header (base64 JSON); falls back to a JSON body carrying
 * `accepts[]` (our own server's style). Returns null when neither is present.
 */
export function parse402(headers: { get(name: string): string | null }, bodyJson: any): Parsed402 | null {
  const headerVal = headers.get("payment-required");
  if (headerVal) {
    try {
      const decoded = JSON.parse(Buffer.from(headerVal, "base64").toString("utf8"));
      if (Array.isArray(decoded?.accepts)) {
        return {
          x402Version: decoded.x402Version,
          accepts: decoded.accepts,
          resource: decoded.resource,
          extensions: decoded.extensions,
          raw: decoded,
        };
      }
    } catch {
      /* fall through to body */
    }
  }
  if (Array.isArray(bodyJson?.accepts)) {
    return {
      x402Version: bodyJson.x402Version,
      accepts: bodyJson.accepts,
      resource: bodyJson.resource,
      extensions: bodyJson.extensions,
      raw: bodyJson,
    };
  }
  return null;
}

/** Pick the Base/EVM `exact` requirement out of a parsed challenge. */
export function pickEvmRequirement(parsed: Parsed402): PaymentRequirement | null {
  return (
    parsed.accepts.find(
      (a) => typeof a?.network === "string" && a.network.startsWith("eip155:") && a.scheme === "exact"
    ) || null
  );
}

export interface EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface SignedEvmPayment {
  signature: string;
  authorization: EvmAuthorization;
  payer: string;
  nonce: string;
  validBefore: number;
}

/**
 * Sign an EIP-3009 TransferWithAuthorization for the given requirement.
 * Fully offline — the wallet needs no provider and no gas. Domain params come
 * from the requirement (`extra.name`/`extra.version`, `asset`, `network`) with
 * Circle-USDC-on-Base fallbacks, matching what cli/pay.ts sends and what the
 * CDP facilitator validates.
 *
 * `validForSeconds` bounds how long the authorization stays redeemable. Keep
 * it short (default 10 min — comfortably above Laso's 300s settle window):
 * reconciliation can only declare an unredeemed payment dead once the window
 * has provably passed, so a shorter window means faster auto-refunds after a
 * crash.
 */
export async function buildEvmAuthorization(
  wallet: { address: string; signTypedData(domain: any, types: any, value: any): Promise<string> },
  requirement: PaymentRequirement,
  validForSeconds = 600
): Promise<SignedEvmPayment> {
  const ethers = getEthers();
  const chainId = parseInt(requirement.network.split(":")[1] || "", 10) || BASE_CHAIN_ID;
  const nonce = "0x" + randomBytes(32).toString("hex");
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + validForSeconds;

  const domain = {
    name: requirement.extra?.name || "USD Coin",
    version: requirement.extra?.version || "2",
    chainId,
    verifyingContract: requirement.asset || BASE_USDC,
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const authorization: EvmAuthorization = {
    from: wallet.address,
    to: ethers.getAddress(requirement.payTo),
    value: BigInt(requirement.amount).toString(),
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce,
  };
  const signature = await wallet.signTypedData(domain, types, authorization);
  return { signature, authorization, payer: wallet.address, nonce, validBefore };
}

/**
 * Wrap the signed payment in a spec-compliant x402 v2 PaymentPayload and
 * base64-encode it for the X-PAYMENT header. The FULL requirement object is
 * echoed as `accepted` — facilitators (CDP included) zod-validate it and
 * reject stubbed `{scheme, network}` payloads (see cli/pay.ts:344).
 */
export function encodeXPayment(
  signed: SignedEvmPayment,
  requirement: PaymentRequirement,
  resource?: any,
  extensions?: any
): string {
  const payload: Record<string, any> = {
    x402Version: 2,
    accepted: requirement,
    payload: { signature: signed.signature, authorization: signed.authorization },
  };
  if (resource !== undefined) payload.resource = resource;
  if (extensions !== undefined) payload.extensions = extensions;
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export class SpendCeilingError extends Error {
  constructor(public askedUsdc: number, public ceilingUsdc: number, public url: string) {
    super(
      `Refusing to pay ${askedUsdc} USDC for ${url} — exceeds the ceiling of ${ceilingUsdc} USDC. ` +
        `The upstream 402 advertised more than this call is allowed to spend (misconfigured or malicious upstream).`
    );
    this.name = "SpendCeilingError";
  }
}

export interface PaidFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Server-held payer wallet (ethers.Wallet or compatible signer). */
  wallet: { address: string; signTypedData(domain: any, types: any, value: any): Promise<string> };
  /** HARD per-call spend ceiling in whole USDC. Required — no unbounded auto-pay. */
  maxUsdc: number;
  /** Per-request timeout (both the probe and the paid call). */
  timeoutMs?: number;
  /** EIP-3009 validity window (see buildEvmAuthorization). */
  validForSeconds?: number;
  /**
   * Called after signing, BEFORE the paid request goes out. Persist the nonce
   * here: it is the crash-reconciliation handle (authorizationConsumed tells
   * you later whether this exact payment moved money).
   */
  onBeforePay?: (info: {
    nonce: string;
    validBefore: number;
    amountUsdc: number;
    payTo: string;
    payer: string;
  }) => void | Promise<void>;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface PaidFetchResult {
  status: number;
  ok: boolean;
  data: any;
  paid: boolean;
  paidUsdc: number;
  payer?: string;
  nonce?: string;
  validBefore?: number;
  requirement?: PaymentRequirement;
  /** Decoded PAYMENT-RESPONSE settle receipt when the upstream returned one. */
  receipt?: any;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; headers: Headers; data: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const contentType = res.headers.get("content-type") || "";
    let data: any = null;
    if (contentType.includes("application/json")) {
      data = await res.json().catch(() => null);
    } else {
      // Non-JSON (edge error pages, html format responses). Keep a snippet so
      // errors are diagnosable without dumping whole pages into the DB.
      const text = await res.text().catch(() => "");
      data = { _nonJson: true, snippet: text.slice(0, 300) };
    }
    return { status: res.status, headers: res.headers, data };
  } finally {
    clearTimeout(timer);
  }
}

function decodeReceipt(headers: Headers): any {
  const raw = headers.get("payment-response");
  if (!raw) return undefined;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * GET/POST an x402-gated URL, paying on Base when challenged.
 *
 * probe (no payment) → 402? → ceiling check → sign EIP-3009 → onBeforePay →
 * paid request (same URL + X-PAYMENT). One transient-failure retry resubmits
 * the SAME header (nonce-bound → idempotent, never double-pays).
 *
 * A non-402 probe response is returned as-is with `paid: false` — callers can
 * hit free endpoints through the same function.
 */
export async function paidFetch(url: string, opts: PaidFetchOptions): Promise<PaidFetchResult> {
  const fetchImpl = opts.fetchImpl || fetch;
  const method = opts.method || "GET";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const baseHeaders = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const init: RequestInit = { method, headers: baseHeaders };
  if (opts.body && method !== "GET" && method !== "HEAD") init.body = opts.body;

  const probe = await fetchJson(fetchImpl, url, init, timeoutMs);
  if (probe.status !== 402) {
    return {
      status: probe.status,
      ok: probe.status >= 200 && probe.status < 300,
      data: probe.data,
      paid: false,
      paidUsdc: 0,
    };
  }

  const parsed = parse402(probe.headers, probe.data);
  const requirement = parsed && pickEvmRequirement(parsed);
  if (!requirement) {
    throw new Error(
      `Upstream 402 at ${url} did not offer a Base (eip155) exact payment option — cannot pay. ` +
        `Challenge: ${JSON.stringify(probe.data).slice(0, 200)}`
    );
  }

  const amountUsdc = Number(BigInt(requirement.amount)) / 1e6;
  if (!(amountUsdc <= opts.maxUsdc)) {
    throw new SpendCeilingError(amountUsdc, opts.maxUsdc, url);
  }

  const signed = await buildEvmAuthorization(opts.wallet, requirement, opts.validForSeconds);
  if (opts.onBeforePay) {
    await opts.onBeforePay({
      nonce: signed.nonce,
      validBefore: signed.validBefore,
      amountUsdc,
      payTo: requirement.payTo,
      payer: signed.payer,
    });
  }
  const encoded = encodeXPayment(signed, requirement, parsed!.resource, parsed!.extensions);
  const paidInit: RequestInit = {
    method,
    // x402 v2 servers (@x402/core readers — Laso included) look ONLY at
    // PAYMENT-SIGNATURE; X-PAYMENT is the v1 name. Send both so either
    // generation of upstream sees the payment. (Live-confirmed 2026-07-09:
    // X-PAYMENT alone gets a fresh 402 re-challenge from Laso.)
    headers: { ...baseHeaders, "PAYMENT-SIGNATURE": encoded, "X-PAYMENT": encoded },
  };
  if (opts.body && method !== "GET" && method !== "HEAD") paidInit.body = opts.body;

  let lastErr: any;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const paidRes = await fetchJson(fetchImpl, url, paidInit, timeoutMs);
      return {
        status: paidRes.status,
        ok: paidRes.status >= 200 && paidRes.status < 300,
        data: paidRes.data,
        paid: true,
        paidUsdc: amountUsdc,
        payer: signed.payer,
        nonce: signed.nonce,
        validBefore: signed.validBefore,
        requirement,
        receipt: decodeReceipt(paidRes.headers),
      };
    } catch (e: any) {
      // Network-level failure AFTER the payment header may have reached the
      // upstream. Resubmitting the identical header is safe (single-use
      // nonce); minting a fresh one is the double-pay bug.
      lastErr = e;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 750));
    }
  }
  const err: any = new Error(
    `Paid request to ${url} failed after payment was signed (nonce ${signed.nonce.slice(0, 10)}…): ` +
      `${lastErr?.message || lastErr}. The authorization may or may not have been redeemed — ` +
      `reconcile with authorizationConsumed() before treating this as unpaid.`
  );
  err.nonce = signed.nonce;
  err.validBefore = signed.validBefore;
  err.payer = signed.payer;
  err.ambiguous = true;
  throw err;
}

/**
 * On-chain oracle: has this EIP-3009 authorization been redeemed?
 * `authorizationState(authorizer, nonce)` on the USDC contract flips to true
 * exactly when transferWithAuthorization executes — i.e. when the upstream's
 * facilitator actually took the money. Combined with `validBefore` expiry this
 * fully classifies a crashed payment:
 *   consumed              → money moved (go find what it bought)
 *   unused + window passed → money can never move (safe to refund our caller)
 *   unused + window open   → still redeemable (wait; check again later)
 */
export async function authorizationConsumed(
  payer: string,
  nonce: string,
  providerOverride?: { call(tx: { to: string; data: string }): Promise<string> }
): Promise<boolean> {
  const ethers = getEthers();
  const iface = new ethers.Interface([
    "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  ]);
  const data = iface.encodeFunctionData("authorizationState", [payer, nonce]);
  const provider = providerOverride || new ethers.JsonRpcProvider(BASE_RPC);
  const raw = await provider.call({ to: BASE_USDC, data });
  const [state] = iface.decodeFunctionResult("authorizationState", raw);
  return Boolean(state);
}

/** USDC balance of an address on Base, in whole USDC. */
export async function baseUsdcBalance(
  address: string,
  providerOverride?: { call(tx: { to: string; data: string }): Promise<string> }
): Promise<number> {
  const ethers = getEthers();
  const iface = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  const data = iface.encodeFunctionData("balanceOf", [address]);
  const provider = providerOverride || new ethers.JsonRpcProvider(BASE_RPC);
  const raw = await provider.call({ to: BASE_USDC, data });
  const [bal] = iface.decodeFunctionResult("balanceOf", raw);
  return Number(bal) / 1e6;
}
