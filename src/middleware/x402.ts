import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { AuthenticatedRequest } from "../types";
import { verifySvmPayment, settleSvmPayment } from "./x402-svm-verify";

const { encodePaymentRequiredHeader, decodePaymentSignatureHeader } = require("@x402/core/http");

const payToEvm = config.treasuryEvmWallet;
const payToSolana = config.treasuryWallet;

// Self-hosted x402 facilitator (for EVM)
// Internal: used for server-side verify/settle
const FACILITATOR_URL_INTERNAL = "http://localhost:8090";
// External: shown in 402 response for clients that need it
const FACILITATOR_URL = "https://agntos.dev/x402";
const FACILITATOR_BEARER = "agntos-facilitator-secret-2026";

// Fee payer for Solana (must match the key in x402-svm-verify)
const SOLANA_FEE_PAYER = "4R67MWivvc52g9BSzQRvQyD8GshttW1QLbnj46usBrcQ";

function buildPaymentRequired(req: Request, minUsdc: number) {
  const resource = "https://" + (req.get("host") || "agntos.dev") + req.originalUrl;
  const description = "AgentOS: " + req.method + " " + req.originalUrl;
  const amount = String(Math.round(minUsdc * 1e6));

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
          facilitator: FACILITATOR_URL,
          feePayer: SOLANA_FEE_PAYER,
        },
      },
      {
        scheme: "exact",
        network: "eip155:8453",
        amount,
        payTo: payToEvm,
        maxTimeoutSeconds: 60,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: {
          name: "AgentOS",
          facilitator: FACILITATOR_URL,
        },
      },
    ],
  };
}

export function send402Response(res: Response, req: Request, minUsdc: number, message: string) {
  const paymentRequired = buildPaymentRequired(req, minUsdc);
  const encoded = encodePaymentRequiredHeader(paymentRequired);

  res.setHeader("PAYMENT-REQUIRED", encoded);
  res.setHeader("X-Payment-Required", JSON.stringify(paymentRequired));
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

  // Settle: co-sign and submit
  const settleResult = await settleSvmPayment(svmPayload.transaction);
  if (!settleResult.success) {
    return { verified: true, settled: false, reason: settleResult.error, payer: verifyResult.payer };
  }

  return { verified: true, settled: true, signature: settleResult.signature, payer: verifyResult.payer };
}

async function handleEvmPayment(
  paymentPayload: any,
  matchedRequirement: any,
): Promise<{ verified: boolean; settled: boolean; reason?: string; signature?: string; payer?: string }> {
  // Use facilitator for EVM
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
      return { verified: true, settled: false, reason: settleResult.error || settleResult.errorReason };
    }
    return { verified: true, settled: true, signature: settleResult.transaction || result.txHash };
  } catch (e) {
    // Don't block on settlement failure
    return { verified: true, settled: false, reason: "settlement_error" };
  }
}

export function x402(minUsdc: number = 0.01) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined;

    if (!paymentHeader) {
      send402Response(res, req, minUsdc, "Payment required. Use x402 protocol.");
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
