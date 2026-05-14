import type { Connection, Keypair } from "@solana/web3.js";

export interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps: number;
}

export interface SwapParams {
  connection: Connection;
  wallet: Keypair;
  inputMint: string;
  outputMint: string;
  inputAmountRaw: number;
  slippageBps: number;
  dryRun?: boolean;
  quoteMaxAgeMs?: number;
  /**
   * If set, route the swap through Jito Block Engine with this tip (lamports).
   * Jupiter builds the tip transfer into the swap tx itself via
   * `prioritizationFeeLamports.jitoTipLamports`, then we submit through Jito's
   * sendTransaction endpoint instead of the public RPC. Unset = plain RPC with
   * Jupiter's `computeUnitPriceMicroLamports: "auto"` priority fee.
   */
  jitoTipLamports?: number;
}

export interface SwapResult {
  txSignature: string;
  inputAmountRaw: number;
  /**
   * Actual realized output from parsing the confirmed transaction's
   * pre/post balance changes. Falls back to `quotedOutRaw` if the tx parse
   * fails (e.g. RPC doesn't return meta yet). Equal to `quotedOutRaw` in
   * dry-run mode.
   */
  outputAmountRaw: number;
  /** Output amount as promised by the Jupiter quote, before slippage. */
  quotedOutRaw: number;
  priceImpactPct: number;
  /** Actual network fee paid (lamports). Populated after confirmation. */
  feeLamports?: number;
  /** Jito tip paid (lamports). Mirrors SwapParams.jitoTipLamports, 0 otherwise. */
  tipLamports?: number;
}
