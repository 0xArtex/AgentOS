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
}

export interface SwapResult {
  txSignature: string;
  inputAmountRaw: number;
  outputAmountRaw: number;
  priceImpactPct: number;
}
