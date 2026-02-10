import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { AuthenticatedRequest, PaymentProof } from "../types";

// Our EVM (Base) payment address — AgentWallet EVM address
const payToEvm = config.treasuryEvmWallet;

/**
 * Standard x402 payment middleware.
 * 
 * If no X-Payment header: returns 402 with payment requirements
 * that are compatible with AgentWallet's x402/fetch and any standard x402 client.
 * 
 * If X-Payment header present: verifies via the x402 facilitator.
 */
export function x402(minUsdc: number = 0.01) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const paymentHeader = req.headers["x-payment"] as string | undefined;

    if (!paymentHeader) {
      // Return standard 402 with payment requirements as HEADER (x402 standard)
      const paymentRequirements = {
        x402: 1,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            maxAmountRequired: String(Math.round(minUsdc * 1e6)),
            resource: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
            description: `AgentOS: ${req.method} ${req.originalUrl}`,
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

      res.setHeader("X-Payment-Required", JSON.stringify(paymentRequirements));
      res.status(402).json({
        error: "Payment Required",
        ...paymentRequirements,
      });
      return;
    }

    // Verify payment via facilitator
    try {
      const verifyResp = await fetch("https://x402.org/facilitator/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: paymentHeader,
          details: {
            scheme: "exact",
            network: "eip155:8453",
            maxAmountRequired: String(Math.round(minUsdc * 1e6)),
            resource: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
            payTo: payToEvm,
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          },
        }),
      });

      if (!verifyResp.ok) {
        const err = await verifyResp.text();
        console.error("[x402] Facilitator verify failed:", verifyResp.status, err);
        res.status(402).json({
          error: "Payment verification failed",
          message: err,
        });
        return;
      }

      const result = await verifyResp.json() as any;
      if (!result.valid) {
        res.status(402).json({
          error: "Invalid payment",
          message: result.reason || "Payment verification failed",
        });
        return;
      }

      // Payment verified — settle it
      try {
        await fetch("https://x402.org/facilitator/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload: paymentHeader }),
        });
      } catch (settleErr) {
        console.error("[x402] Settlement error (non-blocking):", settleErr);
      }

      // Attach payment info
      req.payment = {
        signature: typeof result.txHash === "string" ? result.txHash : paymentHeader.slice(0, 64),
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

// Alias for backwards compat
export const requireX402Payment = x402;
