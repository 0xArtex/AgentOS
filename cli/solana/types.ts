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
  /**
   * Raw input amount (u64). Accepts bigint (preferred — high-supply token
   * amounts ≥ 2^53 stay exact) or number (small, fixed request sizes such as
   * readiness probes). Only ever stringified into the quote URL, so both
   * round-trip losslessly; the realized OUTPUT amount is what must stay bigint.
   */
  amount: bigint | number;
  slippageBps: number;
}

export interface SwapParams {
  connection: Connection;
  wallet: Keypair;
  inputMint: string;
  outputMint: string;
  /**
   * Raw input amount (u64) as a bigint — lamports for SOL, 6-dec raw for USDC,
   * or raw token units when selling. bigint so it never rounds through Number.
   */
  inputAmountRaw: bigint;
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
  /** Raw input amount (u64) as bigint — never coerced through Number. */
  inputAmountRaw: bigint;
  /**
   * Actual realized output (raw u64) from parsing the confirmed transaction's
   * pre/post balance changes. Falls back to `quotedOutRaw` if the tx parse
   * fails (e.g. RPC doesn't return meta yet). Equal to `quotedOutRaw` in
   * dry-run mode. bigint so high-supply token amounts (≥ 2^53) stay exact.
   */
  outputAmountRaw: bigint;
  /** Output amount (raw u64) as promised by the Jupiter quote, before slippage. */
  quotedOutRaw: bigint;
  priceImpactPct: number;
  /** Actual network fee paid (lamports). Populated after confirmation. */
  feeLamports?: number;
  /** Jito tip paid (lamports). Mirrors SwapParams.jitoTipLamports, 0 otherwise. */
  tipLamports?: number;
}
