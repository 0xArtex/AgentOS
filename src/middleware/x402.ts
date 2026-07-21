import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { config } from "../config";
import { AuthenticatedRequest } from "../types";
import { verifySvmPayment, settleSvmPayment } from "./x402-svm-verify";
import { db } from "../db";
import { isSelfHosted, selfHostedIdentity } from "../services/self-hosted";

const { encodePaymentRequiredHeader, decodePaymentSignatureHeader } = require("@x402/core/http");
const { HTTPFacilitatorClient } = require("@x402/core/server");

/**
 * Defence-in-depth: track every x402 payment header we've already consumed,
 * keyed by sha256(header + endpoint). Solana rejects duplicate transactions
 * at the chain level, but we want to reject replays before spending an RPC
 * round-trip, and to catch cross-endpoint reuse that hasn't yet settled.
 *
 * Persisted in the `used_payments` table so it survives restarts.
 */
const PAYMENT_REPLAY_TTL_MS = 15 * 60 * 1000; // 15 minutes

function paymentFingerprint(paymentHeader: string, method: string, path: string): string {
  return createHash("sha256")
    .update(method + "\n" + path + "\n" + paymentHeader)
    .digest("hex");
}

function checkAndClaimFingerprint(fp: string, payer: string, amountLamports: bigint, endpoint: string): "ok" | "replay" {
  const claim = db.transaction((fingerprint: string) => {
    const existing = db.prepare("SELECT signature FROM used_payments WHERE signature = ?").get(fingerprint) as any;
    if (existing) return "replay";
    db.prepare(
      "INSERT INTO used_payments (signature, payer, amount_lamports, verified_at, endpoint) VALUES (?, ?, ?, ?, ?)"
    ).run(fingerprint, payer, amountLamports.toString(), new Date().toISOString(), endpoint);
    return "ok";
  });
  return claim(fp) as "ok" | "replay";
}

// Opportunistic cleanup of old replay entries on each request (cheap, indexed).
function pruneOldPayments(): void {
  try {
    const cutoff = new Date(Date.now() - PAYMENT_REPLAY_TTL_MS).toISOString();
    db.prepare("DELETE FROM used_payments WHERE verified_at < ?").run(cutoff);
  } catch {}
}

// --- Idempotent response replay -------------------------------------------
// Goal: if a client resubmits the SAME signed payment (e.g. its response was
// lost to a dropped connection / CDN error and it retried with the same
// payment header), replay the original success response instead of returning a
// bare 402 the agent can't recover from. The agent already paid; don't make it
// pay again, and don't leak a fresh challenge that could induce a second pay.
//
// The `used_payments` table is created in db.ts (owned by another agent this
// wave), so we additively widen it from here with guarded ALTER TABLE at module
// init. SQLite has no `ADD COLUMN IF NOT EXISTS`, so we swallow the
// "duplicate column name" error that fires on every run after the first.
const REPLAY_BODY_MAX_BYTES = 64 * 1024; // don't buffer huge/stream bodies

function ensureReplayColumns(): void {
  const cols = [
    "ADD COLUMN response_status INTEGER",
    "ADD COLUMN response_body TEXT",
    "ADD COLUMN response_content_type TEXT",
  ];
  for (const col of cols) {
    try {
      db.exec("ALTER TABLE used_payments " + col);
    } catch (e: any) {
      // Ignore "duplicate column name: ..." (column already added on a prior
      // boot). Re-throw anything genuinely unexpected so we don't silently run
      // without the replay store.
      if (!/duplicate column name/i.test(e?.message || "")) {
        console.warn("[x402] ensureReplayColumns:", e?.message);
      }
    }
  }
}
ensureReplayColumns();

type StoredReplay = {
  status: number;
  body: string;
  contentType: string | null;
  verifiedAt: string;
};

// Persist a success response against an already-claimed fingerprint. Best
// effort: a write failure here only costs us the replay convenience, never
// correctness (the payment is still recorded as consumed).
function storeReplayResponse(fp: string, status: number, body: string, contentType: string | null): void {
  try {
    db.prepare(
      "UPDATE used_payments SET response_status = ?, response_body = ?, response_content_type = ? WHERE signature = ?"
    ).run(status, body, contentType, fp);
  } catch (e: any) {
    console.warn("[x402] storeReplayResponse failed:", e?.message);
  }
}

// Fetch a previously-stored success response for a seen fingerprint, but only
// if it's still inside the replay TTL window (mirrors pruneOldPayments — a row
// older than the window is logically gone even if prune hasn't swept it yet).
function getStoredReplay(fp: string): StoredReplay | null {
  try {
    const row = db.prepare(
      "SELECT response_status, response_body, response_content_type, verified_at FROM used_payments WHERE signature = ?"
    ).get(fp) as any;
    if (!row || row.response_status == null || row.response_body == null) return null;
    const verifiedAtMs = Date.parse(row.verified_at);
    if (!Number.isNaN(verifiedAtMs) && Date.now() - verifiedAtMs > PAYMENT_REPLAY_TTL_MS) {
      return null; // outside the replay window
    }
    return {
      status: row.response_status,
      body: row.response_body,
      contentType: row.response_content_type ?? null,
      verifiedAt: row.verified_at,
    };
  } catch (e: any) {
    console.warn("[x402] getStoredReplay failed:", e?.message);
    return null;
  }
}

// Wrap res.json/res.send so that when a paid handler finishes with a success
// status (< 400) we capture (status, body, content-type) and persist it against
// the fingerprint. Only JSON and string/Buffer bodies are captured; streaming
// responses (res.write/res.end/sendFile/pipe) never call these, so they're
// simply not stored and replay falls back to the 402-with-code path. Bodies
// over REPLAY_BODY_MAX_BYTES are skipped to avoid buffering large payloads.
function captureSuccessResponse(res: Response, fp: string): void {
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);
  let stored = false;

  const persist = (body: any, isJson: boolean): void => {
    if (stored) return;
    stored = true; // guard against json()→send() double-fire and multiple sends
    try {
      const status = res.statusCode;
      if (status >= 400) return; // only replay successful responses
      let serialized: string;
      if (isJson) {
        serialized = safeStringify(body);
      } else if (typeof body === "string") {
        serialized = body;
      } else if (Buffer.isBuffer(body)) {
        serialized = body.toString("utf8");
      } else if (body == null) {
        return; // nothing meaningful to replay
      } else {
        // Non-string/Buffer object passed to res.send() — Express will JSON it.
        serialized = safeStringify(body);
      }
      if (serialized == null) return;
      if (Buffer.byteLength(serialized, "utf8") > REPLAY_BODY_MAX_BYTES) return; // too big to buffer
      const contentType = res.getHeader("Content-Type");
      const ctStr = typeof contentType === "string"
        ? contentType
        : (isJson ? "application/json; charset=utf-8" : null);
      storeReplayResponse(fp, status, serialized, ctStr);
    } catch (e: any) {
      console.warn("[x402] captureSuccessResponse persist failed:", e?.message);
    }
  };

  res.json = ((body: any) => {
    persist(body, true);
    return origJson(body);
  }) as any;

  res.send = ((body?: any) => {
    // Express routes objects through send()→json() internally; let that path
    // (isJson=true) win and avoid double-serializing here.
    if (body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
      return origSend(body);
    }
    persist(body, false);
    return origSend(body);
  }) as any;
}

// Write a stored success response back to the client verbatim, tagged as a
// replay (header + a JSON marker field when the body is a JSON object). Shared
// by both replay paths (pre-settlement seen, and post-settlement claim-race).
function sendReplay(res: Response, replay: StoredReplay): void {
  res.setHeader("X-Idempotent-Replay", "true");
  if (replay.contentType) res.setHeader("Content-Type", replay.contentType);
  res.status(replay.status);
  const ct = (replay.contentType || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const parsed = JSON.parse(replay.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        res.json({ ...parsed, idempotent_replay: true });
        return;
      }
    } catch { /* fall through to raw send */ }
  }
  res.send(replay.body);
}

const payToEvm = config.treasuryEvmWallet;
const payToSolana = config.treasuryWallet;

// Self-hosted x402 facilitator (for EVM)
// Internal: used for server-side verify/settle
const FACILITATOR_URL_INTERNAL = process.env.X402_FACILITATOR_URL_INTERNAL || "http://localhost:8090";
// External: shown in 402 response for clients that need it
const SELF_FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://palmyr.ai/x402";
const FACILITATOR_BEARER = process.env.X402_FACILITATOR_BEARER;

// Optional CDP facilitator — when enabled, EVM verify/settle goes through
// Coinbase so endpoints become indexable in the x402 Bazaar.
// Enable by setting CDP_API_KEY_ID and CDP_API_KEY_SECRET.
let cdpClient: any = null;
let cdpFacilitatorUrl: string | null = null;
if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
  try {
    const { facilitator } = require("@coinbase/x402");
    cdpClient = new HTTPFacilitatorClient(facilitator);
    cdpFacilitatorUrl = facilitator.url || "https://api.cdp.coinbase.com/platform/v2/x402";
    console.log("[x402] CDP facilitator enabled — EVM payments route through Coinbase");
  } catch (e: any) {
    console.warn("[x402] CDP env vars set but @coinbase/x402 failed to load:", e.message);
  }
}
const USE_CDP = !!cdpClient;

// What we advertise to clients in the 402 response. CDP URL when enabled so
// Bazaar crawlers can attribute this endpoint to a CDP-registered seller.
const FACILITATOR_URL = USE_CDP ? cdpFacilitatorUrl! : SELF_FACILITATOR_URL;

if (!FACILITATOR_BEARER && !USE_CDP && process.env.NODE_ENV === "production") {
  throw new Error("Either X402_FACILITATOR_BEARER (self-hosted) or CDP_API_KEY_ID+CDP_API_KEY_SECRET (Coinbase) must be set in production");
}

// Fee payer for Solana (must match the key in x402-svm-verify)
const SOLANA_FEE_PAYER = "4R67MWivvc52g9BSzQRvQyD8GshttW1QLbnj46usBrcQ";

export type X402Metadata = {
  description?: string;
  category?: string;
  tags?: string[];
  /**
   * If false, the route is hidden from /.well-known/x402 and /openapi.json
   * (still callable, still returns 402, just not advertised). Set on
   * internal/admin/auxiliary routes so the discoverable surface stays under
   * the agent-token-budget threshold (x402scan flags >50 routes as
   * L2_ROUTE_COUNT_HIGH). Default = true.
   */
  discoverable?: boolean;
};

// Absolute brand icon for Bazaar/Agentic.Market listing cards. Fixed to the
// canonical palmyr.ai host (NOT req.host) so it's never an IP literal/loopback
// URL — the Bazaar spec rejects those. Must be a real ≥256px square: CDP
// re-hosts the icon to a 256×256 Cloudinary asset and SILENTLY DROPS the field
// if the source is too small (a 32px favicon.png was dropped — this is a
// 512×512 brand mark on the teal background). Served by express.static.
export const BAZAAR_ICON_URL = "https://palmyr.ai/assets/bazaar-icon.png";

// Strip to printable ASCII (U+0020–U+007E), trim, cap at `max` chars. Used for
// Bazaar resource fields (serviceName/tags) which the spec limits to ≤32
// printable-ASCII chars; anything out of range is soft-dropped by the crawler.
function bazaarAscii(s: string, max = 32): string {
  return String(s).replace(/[^\x20-\x7E]/g, "").trim().slice(0, max);
}

// Resource-level `serviceName`: "Palmyr <Capability>" when a category is present
// and fits the 32-char cap, else just "Palmyr". Deterministic per category so
// the value is stable across a route's lifetime.
export function bazaarServiceName(category?: string): string {
  if (category) {
    const cap = category.charAt(0).toUpperCase() + category.slice(1);
    const candidate = bazaarAscii("Palmyr " + cap, 32);
    if (candidate.length > "Palmyr".length) return candidate;
  }
  return "Palmyr";
}

// Resource-level `tags`: category first, then metadata.tags; deduped
// (case-insensitively), each sanitized to ≤32 printable ASCII, capped at 5.
export function bazaarTags(metadata?: X402Metadata): string[] {
  const raw: string[] = [];
  if (metadata?.category) raw.push(metadata.category);
  if (metadata?.tags) raw.push(...metadata.tags);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const clean = bazaarAscii(t, 32);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 5) break;
  }
  return out;
}

// Spec-shaped Bazaar discovery `info` block. Real CDP-indexed services surface
// this at `extensions.bazaar.info.{input,output}`; `input` is an HTTP envelope
// (type/method/bodyType/body|queryParams — NOT a bare schema) and `output`
// carries an `example`. We keep permissive `{}` examples (honest: every paid
// Palmyr route accepts/returns a JSON object) plus an `inputSchema` hint.
export function bazaarInfo(method: string, isBodyMethod: boolean) {
  const permissiveJsonSchema = { type: "object", additionalProperties: true };
  return {
    input: isBodyMethod
      ? { type: "http", method, bodyType: "json", body: {} }
      : { type: "http", method, queryParams: {} },
    inputSchema: {
      properties: isBodyMethod
        ? { body: permissiveJsonSchema }
        : { queryParams: permissiveJsonSchema },
      required: [] as string[],
    },
    output: { example: {} },
  };
}

function buildPaymentRequired(req: Request, minUsdc: number, metadata?: X402Metadata) {
  const resource = "https://" + (req.get("host") || "palmyr.ai") + req.originalUrl;
  // CDP's x402 facilitator schema caps resource.description at 500 chars, and
  // v2 clients echo the challenge's resource back into their payment payload —
  // so an over-long description poisons the payload and the CDP verify 400s
  // ("requires 'scheme'"). Clamp defensively so no route can regress into that.
  const description = (metadata?.description || "Palmyr: " + req.method + " " + req.originalUrl).slice(0, 500);
  const amount = String(Math.round(minUsdc * 1e6));

  // The SETTLEMENT channel registers the CONCRETE resource URL
  // (req.originalUrl — real ids included) in the Bazaar on every settled Base
  // payment. For per-id routes (GET /cards/:id, POST /phone/numbers/:id/send,
  // DELETE /compute/servers/:id, …) that publishes each caller's actual
  // resource id as its own explorer entry — spam at best, a capability-URL
  // leak at worst (this bit the compute delete route, then nearly the card
  // detail route). Two suppressions compose here:
  //   1. metadata.discoverable === false — explicit per-route opt-out;
  //   2. AUTOMATIC: any parameterized route (the matched Express route path
  //      contains ':' or '*') — a per-id route has no stable URL, so the only
  //      possible Bazaar entries are leaky one-per-caller ones. Zero entries
  //      is always correct, including for routes added later.
  // Our own /.well-known + /openapi.json listings are unaffected (they read
  // the route TEMPLATE from the router, never this flag), so parameterized
  // routes stay documented — they just never index their settles.
  const routePath = String((req as any).route?.path ?? "");
  const parameterized = routePath.includes(":") || routePath.includes("*");
  const bazaar: Record<string, any> = { discoverable: metadata?.discoverable !== false && !parameterized };
  if (metadata?.category) bazaar.category = metadata.category;
  if (metadata?.tags && metadata.tags.length > 0) bazaar.tags = metadata.tags;
  // Bazaar schema declaration. The x402scan validator's `extractSchemas2`
  // (in @agentcash/discovery) walks this exact path:
  //   extensions.bazaar.schema.properties.input.properties.{body|queryParams}
  //   extensions.bazaar.schema.properties.output.properties.example
  // Anything shallower or differently-shaped trips SCHEMA_INPUT_MISSING /
  // SCHEMA_OUTPUT_MISSING. Permissive `{type: "object"}` is honest — every
  // paid Palmyr route accepts/returns a JSON object — and resolves the
  // errors without committing to per-field shapes. KEEP this for x402scan
  // compat; the newer spec `info` shape is added alongside (below).
  const permissiveJsonSchema = { type: "object", additionalProperties: true };
  const isBodyMethod = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
  bazaar.schema = {
    properties: {
      input: {
        properties: isBodyMethod
          ? { body: permissiveJsonSchema }
          : { queryParams: permissiveJsonSchema },
      },
      output: {
        properties: { example: permissiveJsonSchema },
      },
    },
  };
  // Spec-compliant discovery extension (x402-foundation/x402 docs/extensions/
  // bazaar.mdx). Surfaces in Bazaar listing responses at
  // `extensions.bazaar.info.{input,output}`. Added ALONGSIDE the legacy
  // `schema` shape above. Because `bazaar` is one object shared by reference
  // across the top-level `extensions` AND both `accepts[]` entries, setting
  // `.info` here populates all three spots at once (zod strips unknown
  // per-accepts keys, never rejects — safe to duplicate; see report).
  bazaar.info = bazaarInfo(req.method, isBodyMethod);

  return {
    x402Version: 2,
    resource: {
      url: resource,
      description,
      mimeType: "application/json",
      // Resource-level Bazaar metadata (spec: serviceName ≤32 ASCII, tags ≤5
      // each ≤32 ASCII, iconUrl absolute https). Soft-dropped by the crawler if
      // malformed, so emitting is upside-only.
      serviceName: bazaarServiceName(metadata?.category),
      tags: bazaarTags(metadata),
      iconUrl: BAZAAR_ICON_URL,
    },
    accepts: [
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount,
        payTo: payToSolana,
        maxTimeoutSeconds: 60,
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        extra: {
          name: "Palmyr",
          // Solana still uses our self-hosted fee-payer path, even when CDP is on
          facilitator: SELF_FACILITATOR_URL,
          feePayer: SOLANA_FEE_PAYER,
        },
        extensions: { bazaar },
      },
      {
        scheme: "exact",
        network: "eip155:8453",
        amount,
        payTo: payToEvm,
        maxTimeoutSeconds: 60,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        // EIP-712 domain values for the Base USDC contract — facilitator needs these
        // to reconstruct the signed domain and verify the client's signature.
        extra: {
          name: "USD Coin",
          version: "2",
          // EVM routes through CDP when enabled — this is what makes the endpoint
          // discoverable in the x402 Bazaar.
          facilitator: FACILITATOR_URL,
        },
        extensions: { bazaar },
      },
    ],
    // Top-level + per-network bazaar extension. The CDP Bazaar crawler reads
    // the top-level form; some downstream facilitators read from accepts[].
    // Populate both so neither path misses us.
    extensions: {
      bazaar,
    },
    description,
    mimeType: "application/json",
  };
}

export function send402Response(res: Response, req: Request, minUsdc: number, message: string, metadata?: X402Metadata) {
  const paymentRequired = buildPaymentRequired(req, minUsdc, metadata);
  const encoded = encodePaymentRequiredHeader(paymentRequired);

  // Strip non-ASCII from the JSON header value: HTTP header values must be
  // RFC 7230-conformant (printable ASCII, 0x20-0x7E) and Node throws
  // ERR_INVALID_CHAR on setHeader otherwise. Route descriptions sometimes
  // contain em dashes / curly quotes / other Unicode that would crash the
  // server. The full payload is still in the JSON response body and in the
  // base64-encoded PAYMENT-REQUIRED header above.
  const headerJson = JSON.stringify(paymentRequired).replace(/[^\x20-\x7E]/g, "");

  res.setHeader("PAYMENT-REQUIRED", encoded);
  res.setHeader("X-Payment-Required", headerJson);
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, X-Payment-Required, Payment-Response, PAYMENT-RESPONSE");

  res.status(402).json({
    error: "Payment Required",
    message,
    note: "Your wallet address becomes the owner. Use the same wallet to access your resources.",
    ...paymentRequired,
  });
}

function toJsonSafe(obj: any): any {
  return JSON.parse(JSON.stringify(obj, (_, v) => typeof v === "bigint" ? v.toString() : v));
}

// BigInt-safe JSON.stringify → string. The SVM verify path threads the parsed
// on-chain amount through as a `bigint` (result.amountPaid), so a plain
// JSON.stringify of that object throws "Do not know how to serialize a BigInt"
// — which, on the `[x402] Result:` log line, crashed the request AFTER
// settlement (payer charged, no resource, fingerprint unclaimed). Always
// serialize payment/response objects through this.
function safeStringify(obj: any): string {
  return JSON.stringify(obj, (_, v) => typeof v === "bigint" ? v.toString() : v);
}

async function handleSvmPayment(
  paymentPayload: any,
  matchedRequirement: any,
): Promise<{ verified: boolean; settled: boolean; reason?: string; signature?: string; payer?: string; amountPaid?: bigint }> {
  const svmPayload = paymentPayload.payload;
  if (!svmPayload?.transaction) {
    return { verified: false, settled: false, reason: "missing_transaction_in_payload" };
  }

  const amount = BigInt(matchedRequirement.amount);
  const verifyResult = await verifySvmPayment(
    svmPayload.transaction,
    matchedRequirement.payTo,
    amount,
    matchedRequirement.asset,
    matchedRequirement.extra?.feePayer || SOLANA_FEE_PAYER,
  );

  if (!verifyResult.isValid) {
    return { verified: false, settled: false, reason: verifyResult.invalidReason, payer: verifyResult.payer };
  }

  // Settle: co-sign and submit. Forward signature on failure too — if the tx
  // was submitted but confirmation timed out, USDC may already have moved and
  // the signature is needed for on-chain reconciliation.
  const settleResult = await settleSvmPayment(svmPayload.transaction);
  if (!settleResult.success) {
    return {
      verified: true,
      settled: false,
      reason: settleResult.error,
      signature: settleResult.signature,
      payer: verifyResult.payer,
    };
  }

  return { verified: true, settled: true, signature: settleResult.signature, payer: verifyResult.payer, amountPaid: verifyResult.amount };
}

async function handleEvmPayment(
  paymentPayload: any,
  matchedRequirement: any,
): Promise<{ verified: boolean; settled: boolean; reason?: string; signature?: string; payer?: string }> {
  // CDP facilitator path: signed-request verify/settle through Coinbase so the
  // Bazaar can index this endpoint.
  if (USE_CDP && cdpClient) {
    try {
      const verifyResult: any = await cdpClient.verify(paymentPayload, matchedRequirement);
      if (!verifyResult?.isValid) {
        return {
          verified: false,
          settled: false,
          reason: verifyResult?.invalidReason || verifyResult?.invalidMessage || "cdp_verify_failed",
          payer: verifyResult?.payer,
        };
      }
      const settleResult: any = await cdpClient.settle(paymentPayload, matchedRequirement);
      if (settleResult?.success === false) {
        console.error("[x402] CDP settlement failed:", JSON.stringify(settleResult));
        return {
          verified: true,
          settled: false,
          reason: settleResult?.errorReason || settleResult?.errorMessage || "cdp_settle_failed",
          payer: verifyResult?.payer,
        };
      }
      return {
        verified: true,
        settled: true,
        signature: settleResult?.transaction || settleResult?.txHash,
        payer: verifyResult?.payer,
      };
    } catch (e: any) {
      // @x402/core wraps the facilitator response in a VerifyError whose
      // `.message` is just `invalidReason`. Surface the rest (invalidMessage,
      // statusCode, network/amount we sent) so future "invalid_payload" hits
      // don't require code-spelunking to diagnose.
      console.error(
        "[x402] CDP facilitator error:",
        e?.message,
        "invalidMessage=", e?.invalidMessage,
        "statusCode=", e?.statusCode,
        "network=", matchedRequirement?.network,
        "amount=", matchedRequirement?.amount,
      );
      const detail = e?.invalidMessage ? e.message + ": " + e.invalidMessage : (e?.message || "unknown");
      return { verified: false, settled: false, reason: "cdp_error: " + detail };
    }
  }

  // Self-hosted facilitator (bearer-authed local service)
  const verifyResp = await fetch(FACILITATOR_URL_INTERNAL + "/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + FACILITATOR_BEARER },
    body: JSON.stringify({
      x402Version: paymentPayload.x402Version || 2,
      paymentPayload: toJsonSafe(paymentPayload),
      paymentRequirements: toJsonSafe(matchedRequirement),
    }),
  });

  const result = await verifyResp.json() as any;
  if (!verifyResp.ok || !result.isValid) {
    const reason = result.invalidReason || result.invalidMessage || result.error || "Verification failed";
    return { verified: false, settled: false, reason };
  }

  // Settle
  try {
    const settleResp = await fetch(FACILITATOR_URL_INTERNAL + "/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + FACILITATOR_BEARER },
      body: JSON.stringify({
        x402Version: paymentPayload.x402Version || 2,
        paymentPayload: toJsonSafe(paymentPayload),
        paymentRequirements: toJsonSafe(matchedRequirement),
      }),
    });
    const settleResult = await settleResp.json() as any;
    if (settleResult.success === false) {
      // Log full facilitator response so we can see the actual on-chain revert reason
      console.error("[x402] EVM settlement failed. Facilitator response:", JSON.stringify(settleResult));
      const reason = settleResult.error || settleResult.errorReason || settleResult.errorMessage || settleResult.message || "transaction_failed";
      return { verified: true, settled: false, reason };
    }
    return { verified: true, settled: true, signature: settleResult.transaction || settleResult.txHash || settleResult.transactionHash };
  } catch (e: any) {
    console.error("[x402] EVM settlement exception:", e?.message);
    return { verified: true, settled: false, reason: "settlement_error: " + (e?.message || "unknown") };
  }
}

export function x402(minUsdc: number = 0.01, metadata?: X402Metadata) {
  const handler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    // Self-hosted single-operator instance: the operator owns the box, so there
    // is no paywall — mirror the same bypass requireAuth uses (auth.ts). Bare
    // x402() routes (the email read/send/threads/attachment/webhook endpoints)
    // don't go through requireAuth, so without this a self-hoster 402s on their
    // OWN mail — they literally can't read their inbox. Hard-gated by
    // isSelfHosted(), which fails closed on any hosted/multi-tenant signal
    // (NODE_ENV=production, a configured treasury wallet, PALMYR_MULTI_TENANT),
    // so this can never engage on the hosted deployment. Identity is any
    // already-established one (a token agentId, or an upstream-set payer) else
    // the operator wallet, so ownership checks (payer === inbox.owner) resolve.
    if (isSelfHosted()) {
      const id = req.agentId || req.payment?.payer || selfHostedIdentity();
      req.agentId = id;
      req.payment = {
        signature: req.payment?.signature ?? "self-hosted",
        payer: req.payment?.payer ?? id,
        amountLamports: req.payment?.amountLamports ?? BigInt(0),
        verifiedAt: req.payment?.verifiedAt ?? Date.now(),
        chain: req.payment?.chain ?? "base",
      };
      next();
      return;
    }

    const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined;

    if (!paymentHeader) {
      send402Response(res, req, minUsdc, "Payment required. Use x402 protocol.", metadata);
      return;
    }

    // Replay guard (defence in depth): reject any payment header we've
    // already consumed for this method+path before hitting the chain.
    pruneOldPayments();
    const fingerprint = paymentFingerprint(paymentHeader, req.method, req.originalUrl.split("?")[0]);
    const alreadySeen = db.prepare("SELECT signature FROM used_payments WHERE signature = ?").get(fingerprint);
    if (alreadySeen) {
      // This exact payment was already consumed for this method+path. Two cases:
      //  (a) we stored the original success response → replay it verbatim so a
      //      client that lost the first response (dropped connection / CDN) can
      //      recover the resource it already paid for, instead of a bare 402.
      //  (b) no stored response yet (original still in-flight, or it failed) →
      //      still a 402, but with a stable `code` so the agent can tell this
      //      "you already paid" case from a fresh "pay now" challenge. We do NOT
      //      emit another payment challenge here (no headers/accepts) — doing so
      //      could induce a second payment for an already-paid request.
      const replay = getStoredReplay(fingerprint);
      if (replay) {
        sendReplay(res, replay);
        return;
      }
      res.status(402).json({
        error: "Payment Required",
        code: "payment_replay",
        message: "This payment was already consumed for this endpoint and its result is not available to replay. If you are retrying, wait for the original request to complete; otherwise build a fresh x402 payment.",
      });
      return;
    }

    try {
      let paymentPayload: any;
      try {
        paymentPayload = decodePaymentSignatureHeader(paymentHeader);
      } catch {
        try { paymentPayload = JSON.parse(paymentHeader); } catch {
          try { paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString()); } catch {
            paymentPayload = { signature: paymentHeader };
          }
        }
      }

      console.log("[x402] Payment received, keys:", Object.keys(paymentPayload));

      const paymentRequired = buildPaymentRequired(req, minUsdc);

      // Match requirement based on accepted field
      let matchedRequirement = paymentRequired.accepts[0];
      const network = paymentPayload.accepted?.network || paymentPayload.network;
      if (network) {
        const match = paymentRequired.accepts.find((a: any) => a.network === network);
        if (match) matchedRequirement = match;
      }

      console.log("[x402] Matched network:", matchedRequirement.network);

      let result: { verified: boolean; settled: boolean; reason?: string; signature?: string; payer?: string; amountPaid?: bigint };

      if (matchedRequirement.network.startsWith("solana:")) {
        console.log("[x402] Using direct SVM verification");
        result = await handleSvmPayment(paymentPayload, matchedRequirement);
      } else {
        console.log("[x402] Using facilitator for EVM verification");
        result = await handleEvmPayment(paymentPayload, matchedRequirement);
      }

      console.log("[x402] Result:", safeStringify(result));

      if (!result.verified) {
        send402Response(res, req, minUsdc, "Payment verification failed: " + (result.reason || "unknown"), metadata);
        return;
      }

      // Settlement must succeed — don't hand out resources for unpaid-on-chain requests
      if (!result.settled) {
        console.warn("[x402] Settlement failed:", result.reason);
        send402Response(res, req, minUsdc, "Payment settlement failed: " + (result.reason || "unknown"), metadata);
        return;
      }

      // Claim the fingerprint AFTER successful settlement to block replays.
      // A race where two parallel requests slip past the initial pre-settle
      // check will lose the INSERT UNIQUE race — only the first wins.
      const claim = checkAndClaimFingerprint(
        fingerprint,
        result.payer || "unknown",
        BigInt(Math.round(minUsdc * 1e6)),
        req.method + " " + req.originalUrl.split("?")[0],
      );
      if (claim === "replay") {
        // Lost the post-settlement INSERT race to a parallel request carrying
        // the same payment. Same recovery semantics as the pre-settlement path:
        // replay the stored success response if the winner already produced one,
        // else a 402 with the stable `payment_replay` code (no fresh challenge).
        const replay = getStoredReplay(fingerprint);
        if (replay) {
          sendReplay(res, replay);
          return;
        }
        res.status(402).json({
          error: "Payment Required",
          code: "payment_replay",
          message: "Payment already consumed (concurrent replay detected). If retrying, wait for the original request to complete; otherwise submit a fresh x402 payment.",
        });
        return;
      }

      // Fingerprint is freshly claimed and the payment settled. Capture this
      // request's success response so a later resubmission of the SAME payment
      // can replay it (idempotency) rather than getting a bare 402.
      captureSuccessResponse(res, fingerprint);

      req.payment = {
        signature: result.signature || "x402-verified",
        payer: result.payer || "unknown",
        // Record what was actually transferred on-chain (SVM threads the parsed
        // amount through) so a refund returns the full amount an overpayer sent,
        // not just the route minimum. EVM has no parsed amount → falls back.
        amountLamports: result.amountPaid ?? BigInt(Math.round(minUsdc * 1e6)),
        verifiedAt: Date.now(),
        chain: matchedRequirement.network.startsWith("solana:") ? "solana" : "base",
      };

      // x402 v2 settlement receipt (SettleResponse). Emitted for EVERY settled
      // payment — both HTTP x402 clients (already in the CORS expose list) and
      // the MCP proxy (services/mcp-tools.ts decodes this into the tool result's
      // _meta["x402/payment-response"]). All paid routes reach here: routes using
      // x402() directly AND those going through requireAuth → requireX402Payment
      // (which IS this same handler), so one setHeader covers the whole surface.
      const settleResponse = {
        success: true,
        transaction: req.payment.signature,
        network: matchedRequirement.network,
        payer: req.payment.payer,
      };
      res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settleResponse)).toString("base64"));

      next();
    } catch (err) {
      console.error("[x402] Error:", err);
      res.status(500).json({
        error: "Payment verification failed",
        message: "Internal error: " + (err instanceof Error ? err.message : String(err)),
      });
    }
  };
  // Discovery markers — see auth.ts:requireAuth for context.
  (handler as any)._x402PaidMin = minUsdc;
  (handler as any)._x402Metadata = metadata;
  return handler;
}

export const requireX402Payment = x402;
