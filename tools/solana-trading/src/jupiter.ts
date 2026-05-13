import { VersionedTransaction } from "@solana/web3.js";
import type {
  JupiterQuoteParams,
  QuoteResponse,
  SwapParams,
  SwapResult,
} from "./types.js";

const JUP_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP = "https://quote-api.jup.ag/v6/swap";
const DEFAULT_QUOTE_MAX_AGE_MS = 5000;

export async function fetchQuote(p: JupiterQuoteParams): Promise<QuoteResponse> {
  const url =
    `${JUP_QUOTE}?inputMint=${p.inputMint}&outputMint=${p.outputMint}` +
    `&amount=${p.amount}&slippageBps=${p.slippageBps}` +
    `&onlyDirectRoutes=false&asLegacyTransaction=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as QuoteResponse;
}

export async function executeSwap(params: SwapParams): Promise<SwapResult> {
  const {
    connection,
    wallet,
    inputMint,
    outputMint,
    inputAmountRaw,
    slippageBps,
    dryRun,
    quoteMaxAgeMs = DEFAULT_QUOTE_MAX_AGE_MS,
  } = params;

  const quoteParams: JupiterQuoteParams = {
    inputMint,
    outputMint,
    amount: inputAmountRaw,
    slippageBps,
  };

  let quote = await fetchQuote(quoteParams);
  let fetchedAt = Date.now();

  if (dryRun) {
    return {
      txSignature: `dryrun_${Date.now()}`,
      inputAmountRaw: Number(quote.inAmount),
      outputAmountRaw: Number(quote.outAmount),
      priceImpactPct: Number(quote.priceImpactPct),
    };
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (Date.now() - fetchedAt >= quoteMaxAgeMs) {
      quote = await fetchQuote(quoteParams);
      fetchedAt = Date.now();
    }

    const swapRes = await fetch(JUP_SWAP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        computeUnitPriceMicroLamports: "auto",
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!swapRes.ok) {
      throw new Error(`Jupiter swap-tx fetch failed: ${swapRes.status} ${await swapRes.text()}`);
    }
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([wallet]);

    const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
    if (sim.value.err) {
      throw new Error(`Simulation failed before send: ${JSON.stringify(sim.value.err)}`);
    }

    try {
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      const bh = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: bh.blockhash,
          lastValidBlockHeight: bh.lastValidBlockHeight,
        },
        "confirmed",
      );
      return {
        txSignature: sig,
        inputAmountRaw: Number(quote.inAmount),
        outputAmountRaw: Number(quote.outAmount),
        priceImpactPct: Number(quote.priceImpactPct),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/blockhash not found/i.test(msg) && attempt < 2) {
        fetchedAt = 0;
        continue;
      }
      throw e;
    }
  }

  throw new Error("executeSwap: exhausted retries");
}
