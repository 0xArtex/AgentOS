import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { config } from "../config";
import { AuthenticatedRequest } from "../types";
import { verifySvmPayment, settleSvmPayment } from "./x402-svm-verify";
import { db } from "../db";

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

const payToEvm = config.treasuryEvmWallet;
const payToSolana = config.treasuryWallet;

// Self-hosted x402 facilitator (for EVM)
// Internal: used for server-side verify/settle
const FACILITATOR_URL_INTERNAL = process.env.X402_FACILITATOR_URL_INTERNAL || "http://localhost:8090";
// External: shown in 402 response for clients that need it
const SELF_FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://agntos.dev/x402";
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
};

function buildPaymentRequired(req: Request, minUsdc: number, metadata?: X402Metadata) {
  const resource = "https://" + (req.get("host") || "agntos.dev") + req.originalUrl;
  const description = metadata?.description || "AgentOS: " + req.method + " " + req.originalUrl;
  const amount = String(Math.round(minUsdc * 1e6));

  const bazaar: Record<string, any> = { discoverable: true };
  if (metadata?.category) bazaar.category = metadata.category;
  if (metadata?.tags && metadata.tags.length > 0) bazaar.tags = metadata.tags;

  return {
    x402Version: 2,
    resource: { url: resource, description, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount,
        payTo: payToSolana,
        maxTimeoutSeconds: 60,
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        extra: {
          name: "AgentOS",
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

async function handleSvmPayment(
  paymentPayload: any,
  matchedRequirement: any,
): Promise<{ verified: boolean; settled: boolean; reason?: string; signature?: string; payer?: string }> {
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

  return { verified: true, settled: true, signature: settleResult.signature, payer: verifyResult.payer };
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
      console.error("[x402] CDP facilitator error:", e?.message);
      return { verified: false, settled: false, reason: "cdp_error: " + (e?.message || "unknown") };
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
    return { verified: true, settled: true, signature: settleResult.transaction || result.txHash };
  } catch (e: any) {
    console.error("[x402] EVM settlement exception:", e?.message);
    return { verified: true, settled: false, reason: "settlement_error: " + (e?.message || "unknown") };
  }
}

export function x402(minUsdc: number = 0.01, metadata?: X402Metadata) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
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
      res.status(402).json({
        error: "Payment Required",
        message: "Payment header already consumed. Build a fresh x402 payment for each request.",
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

      let result: { verified: boolean; settled: boolean; reason?: string; signature?: string; payer?: string };

      if (matchedRequirement.network.startsWith("solana:")) {
        console.log("[x402] Using direct SVM verification");
        result = await handleSvmPayment(paymentPayload, matchedRequirement);
      } else {
        console.log("[x402] Using facilitator for EVM verification");
        result = await handleEvmPayment(paymentPayload, matchedRequirement);
      }

      console.log("[x402] Result:", JSON.stringify(result));

      if (!result.verified) {
        send402Response(res, req, minUsdc, "Payment verification failed: " + (result.reason || "unknown"));
        return;
      }

      // Settlement must succeed — don't hand out resources for unpaid-on-chain requests
      if (!result.settled) {
        console.warn("[x402] Settlement failed:", result.reason);
        send402Response(res, req, minUsdc, "Payment settlement failed: " + (result.reason || "unknown"));
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
        res.status(402).json({
          error: "Payment Required",
          message: "Payment already consumed (replay detected). Submit a fresh x402 payment.",
        });
        return;
      }

      req.payment = {
        signature: result.signature || "x402-verified",
        payer: result.payer || "unknown",
        amountLamports: BigInt(Math.round(minUsdc * 1e6)),
        verifiedAt: Date.now(),
      };

      next();
    } catch (err) {
      console.error("[x402] Error:", err);
      res.status(500).json({
        error: "Payment verification failed",
        message: "Internal error: " + (err instanceof Error ? err.message : String(err)),
      });
    }
  };
}

export const requireX402Payment = x402;
