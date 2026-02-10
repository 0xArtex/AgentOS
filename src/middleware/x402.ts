import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { AuthenticatedRequest } from "../types";

// Use the official x402 encode/decode helpers
let encodePaymentRequiredHeader: (data: any) => string;
let decodePaymentSignatureHeader: (header: string) => any;
try {
  const x402Http = require("@x402/core/http");
  encodePaymentRequiredHeader = x402Http.encodePaymentRequiredHeader;
  decodePaymentSignatureHeader = x402Http.decodePaymentSignatureHeader;
} catch {
  // Fallback: base64 encode JSON
  encodePaymentRequiredHeader = (data: any) => Buffer.from(JSON.stringify(data)).toString("base64");
  decodePaymentSignatureHeader = (header: string) => JSON.parse(Buffer.from(header, "base64").toString());
}

const payToEvm = config.treasuryEvmWallet;
const payToSolana = config.treasuryWallet; // Solana address

/**
 * Build standard x402 payment requirements object
 * Accepts both Solana and Base (EVM) USDC
 */
function buildPaymentRequired(req: Request, minUsdc: number) {
  const resource = `https://${req.get("host") || "agntos.dev"}${req.originalUrl}`;
  const description = `AgentOS: ${req.method} ${req.originalUrl}`;
  const maxAmountRequired = String(Math.round(minUsdc * 1e6));

  return {
    x402: 2,
    accepts: [
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // Solana Mainnet
        maxAmountRequired,
        resource,
        description,
        mimeType: "application/json",
        payTo: payToSolana,
        maxTimeoutSeconds: 60,
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC on Solana
        extra: {
          name: "AgentOS",
          facilitator: "https://x402.org/facilitator",
        },
      },
      {
        scheme: "exact",
        network: "eip155:8453", // Base Mainnet
        maxAmountRequired,
        resource,
        description,
        mimeType: "application/json",
        payTo: payToEvm,
        maxTimeoutSeconds: 60,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
        extra: {
          name: "AgentOS",
          facilitator: "https://x402.org/facilitator",
        },
      },
    ],
  };
}

/**
 * Send a standard 402 response with proper headers.
 * Header: PAYMENT-REQUIRED (base64-encoded JSON per x402 spec)
 * Also sets X-Payment-Required as JSON for backwards compat.
 */
export function send402Response(res: Response, req: Request, minUsdc: number, message: string) {
  const paymentRequired = buildPaymentRequired(req, minUsdc);
  const encoded = encodePaymentRequiredHeader(paymentRequired);

  // Standard x402 header (base64 encoded)
  res.setHeader("PAYMENT-REQUIRED", encoded);
  // Also set as JSON for clients that expect it
  res.setHeader("X-Payment-Required", JSON.stringify(paymentRequired));

  res.status(402).json({
    error: "Payment Required",
    message,
    ...paymentRequired,
  });
}

/**
 * Standard x402 payment middleware.
 * 
 * If no payment header: returns 402 with PAYMENT-REQUIRED header (base64, per spec).
 * If PAYMENT-SIGNATURE header present: verifies via the x402 facilitator.
 */
export function x402(minUsdc: number = 0.01) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    // Check for standard x402 header (PAYMENT-SIGNATURE) and legacy (X-Payment)
    const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined;

    if (!paymentHeader) {
      send402Response(res, req, minUsdc, "Payment required. Use x402 protocol.");
      return;
    }

    // Verify payment via facilitator
    try {
      const paymentRequired = buildPaymentRequired(req, minUsdc);

      const verifyResp = await fetch("https://x402.org/facilitator/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: paymentHeader,
          details: paymentRequired.accepts[0],
        }),
      });

      if (!verifyResp.ok) {
        const err = await verifyResp.text();
        console.error("[x402] Facilitator verify failed:", verifyResp.status, err);
        send402Response(res, req, minUsdc, `Payment verification failed: ${err}`);
        return;
      }

      const result = await verifyResp.json() as any;
      if (!result.valid) {
        send402Response(res, req, minUsdc, result.reason || "Payment verification failed");
        return;
      }

      // Settlement (non-blocking)
      try {
        await fetch("https://x402.org/facilitator/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload: paymentHeader }),
        });
      } catch (settleErr) {
        console.error("[x402] Settlement error (non-blocking):", settleErr);
      }

      // Attach payment info to request
      req.payment = {
        signature: result.txHash || paymentHeader.slice(0, 64),
        payer: result.payer || "x402-verified",
        amountLamports: BigInt(Math.round(minUsdc * 1e6)),
        verifiedAt: Date.now(),
      };

      next();
    } catch (err) {
      console.error("[x402] Verification error:", err);
      res.status(500).json({
        error: "Payment verification failed",
        message: "Could not reach x402 facilitator",
      });
    }
  };
}

// Alias
export const requireX402Payment = x402;
