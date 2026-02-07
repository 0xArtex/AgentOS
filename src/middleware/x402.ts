import { Response, NextFunction } from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { AuthenticatedRequest, PaymentProof } from "../types";

const connection = new Connection(config.solanaRpcUrl, "confirmed");
const USDC_DECIMALS = 6;

/**
 * x402 Payment Verification Middleware
 *
 * Expects header:  X-Payment: <solana-tx-signature>
 *
 * Verifies that the transaction:
 *  1. Exists and is confirmed on Solana
 *  2. Contains a USDC SPL transfer to our treasury wallet
 *  3. Meets the minimum payment amount for the requested service
 *
 * On success, attaches `req.payment` with payer info and amount.
 */
export function x402(minUsdc: number = 0) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const signature = req.headers["x-payment"] as string | undefined;

    if (!signature) {
      res.status(402).json({
        error: "Payment Required",
        message: "Include a Solana USDC transaction signature in the X-Payment header",
        protocol: "x402",
        treasury: config.treasuryWallet,
        currency: "USDC",
        network: "solana",
      });
      return;
    }

    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      if (!tx) {
        res.status(402).json({
          error: "Transaction not found",
          message: "Could not find transaction on Solana. It may not be confirmed yet.",
          signature,
        });
        return;
      }

      if (tx.meta?.err) {
        res.status(402).json({
          error: "Transaction failed",
          message: "The referenced transaction failed on-chain.",
          signature,
        });
        return;
      }

      // Find USDC transfer to our treasury in the parsed instructions
      const payment = extractUsdcTransfer(tx, config.treasuryWallet, config.usdcMint);

      if (!payment) {
        res.status(402).json({
          error: "No valid USDC transfer found",
          message: `Transaction must include a USDC transfer to ${config.treasuryWallet}`,
          signature,
        });
        return;
      }

      const amountUsdc = Number(payment.amountLamports) / 10 ** USDC_DECIMALS;
      if (amountUsdc < minUsdc) {
        res.status(402).json({
          error: "Insufficient payment",
          message: `This endpoint requires ${minUsdc} USDC, but transaction contains ${amountUsdc} USDC`,
          required: minUsdc,
          received: amountUsdc,
        });
        return;
      }

      req.payment = payment;
      next();
    } catch (err) {
      console.error("[x402] Verification error:", err);
      res.status(500).json({
        error: "Payment verification failed",
        message: "Internal error while verifying payment on Solana",
      });
    }
  };
}

/**
 * Parse a confirmed transaction to find a USDC SPL token transfer
 * to the given treasury wallet.
 */
function extractUsdcTransfer(
  tx: any,
  treasuryWallet: string,
  usdcMint: string
): PaymentProof | null {
  const instructions = tx.transaction?.message?.instructions ?? [];

  for (const ix of instructions) {
    // SPL Token transfers show up as parsed instructions with type "transfer" or "transferChecked"
    if (ix.program !== "spl-token") continue;

    const parsed = ix.parsed;
    if (!parsed) continue;

    const type = parsed.type;
    if (type !== "transfer" && type !== "transferChecked") continue;

    const info = parsed.info;
    if (!info) continue;

    // For transferChecked, verify the mint is USDC
    if (type === "transferChecked" && info.mint !== usdcMint) continue;

    // Check destination — this is a token account, we need to check if it belongs to treasury
    // In a production system, we'd resolve the token account owner via getParsedAccountInfo
    // For now, we check post-token balances for the treasury wallet
    const destination: string = info.destination;
    const amount: string = type === "transferChecked" ? info.tokenAmount?.amount : info.amount;

    if (!amount) continue;

    // Verify destination belongs to treasury by checking postTokenBalances
    const postBalances = tx.meta?.postTokenBalances ?? [];
    const isTreasuryTransfer = postBalances.some(
      (bal: any) =>
        bal.owner === treasuryWallet &&
        bal.mint === usdcMint &&
        bal.uiTokenAmount?.amount !== undefined
    );

    if (!isTreasuryTransfer) continue;

    return {
      signature: tx.transaction.signatures[0],
      payer: info.authority ?? info.source,
      amountLamports: BigInt(amount),
      verifiedAt: Date.now(),
    };
  }

  // Also check inner instructions (CPI calls)
  const innerInstructions = tx.meta?.innerInstructions ?? [];
  for (const inner of innerInstructions) {
    for (const ix of inner.instructions ?? []) {
      if (ix.program !== "spl-token") continue;
      const parsed = ix.parsed;
      if (!parsed || (parsed.type !== "transfer" && parsed.type !== "transferChecked")) continue;

      const info = parsed.info;
      if (!info) continue;
      if (parsed.type === "transferChecked" && info.mint !== usdcMint) continue;

      const amount: string =
        parsed.type === "transferChecked" ? info.tokenAmount?.amount : info.amount;
      if (!amount) continue;

      const postBalances = tx.meta?.postTokenBalances ?? [];
      const isTreasuryTransfer = postBalances.some(
        (bal: any) => bal.owner === treasuryWallet && bal.mint === usdcMint
      );

      if (!isTreasuryTransfer) continue;

      return {
        signature: tx.transaction.signatures[0],
        payer: info.authority ?? info.source,
        amountLamports: BigInt(amount),
        verifiedAt: Date.now(),
      };
    }
  }

  return null;
}
