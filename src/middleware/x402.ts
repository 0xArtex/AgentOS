import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { AuthenticatedRequest } from "../types";

const { encodePaymentRequiredHeader, decodePaymentSignatureHeader } = require("@x402/core/http");

const payToEvm = config.treasuryEvmWallet;
const payToSolana = config.treasuryWallet;

// Public x402 facilitator (supports devnet only)
const FACILITATOR_URL = "https://x402.org/facilitator";

function buildPaymentRequired(req: Request, minUsdc: number) {
  const resource = `https://${req.get("host") || "agntos.dev"}${req.originalUrl}`;
  const description = `AgentOS: ${req.method} ${req.originalUrl}`;
  const amount = String(Math.round(minUsdc * 1e6));

  return {
    x402Version: 2,
    resource: { url: resource, description, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // Solana Devnet
        amount,
        payTo: payToSolana,
        maxTimeoutSeconds: 60,
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // USDC Devnet
        extra: {
          name: "AgentOS",
          facilitator: FACILITATOR_URL,
        },
      },
      {
        scheme: "exact",
        network: "eip155:84532", // Base Sepolia
        amount,
        payTo: payToEvm,
        maxTimeoutSeconds: 60,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC Base Sepolia
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
    ...paymentRequired,
  });
}

function toJsonSafe(obj: any): any {
  return JSON.parse(JSON.stringify(obj, (_, v) => typeof v === "bigint" ? v.toString() : v));
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
        try { paymentPayload = JSON.parse(paymentHeader); } catch { paymentPayload = { signature: paymentHeader }; }
      }

      console.log("[x402] Payment received, keys:", Object.keys(paymentPayload));

      const paymentRequired = buildPaymentRequired(req, minUsdc);

      // Match requirement based on accepted field in payload
      let matchedRequirement = paymentRequired.accepts[0];
      if (paymentPayload.accepted?.network) {
        const match = paymentRequired.accepts.find((a: any) => a.network === paymentPayload.accepted.network);
        if (match) matchedRequirement = match;
      }

      console.log("[x402] Matched network:", matchedRequirement.network);

      // Verify via public x402 facilitator
      const verifyResp = await fetch(`${FACILITATOR_URL}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: paymentPayload.x402Version || 2,
          paymentPayload: toJsonSafe(paymentPayload),
          paymentRequirements: toJsonSafe(matchedRequirement),
        }),
      });

      const result = await verifyResp.json() as any;
      console.log("[x402] Verify result:", JSON.stringify(result).slice(0, 300));

      if (!verifyResp.ok || !result.isValid) {
        const reason = result.invalidReason || result.invalidMessage || result.error || "Verification failed";
        console.error("[x402] Verification failed:", reason);
        send402Response(res, req, minUsdc, `Payment verification failed: ${reason}`);
        return;
      }

      // Settle via facilitator
      try {
        const settleResp = await fetch(`${FACILITATOR_URL}/settle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x402Version: paymentPayload.x402Version || 2,
            paymentPayload: toJsonSafe(paymentPayload),
            paymentRequirements: toJsonSafe(matchedRequirement),
          }),
        });
        const settleResult = await settleResp.json() as any;
        console.log("[x402] Settlement:", JSON.stringify(settleResult).slice(0, 200));

        if (settleResult.success === false) {
          console.error("[x402] Settlement failed:", settleResult);
          send402Response(res, req, minUsdc, `Settlement failed: ${settleResult.error || "unknown"}`);
          return;
        }
      } catch (settleErr) {
        console.error("[x402] Settlement error:", settleErr);
        // Don't block on settlement failure for now
      }

      req.payment = {
        signature: result.txHash || "x402-verified",
        payer: paymentPayload.payload?.authorization?.from || "x402-verified",
        amountLamports: BigInt(Math.round(minUsdc * 1e6)),
        verifiedAt: Date.now(),
      };

      next();
    } catch (err) {
      console.error("[x402] Verification error:", err);
      res.status(500).json({
        error: "Payment verification failed",
        message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
}

export const requireX402Payment = x402;
