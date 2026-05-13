import { Connection, VersionedTransaction } from "@solana/web3.js";
import type {
  JupiterQuoteParams,
  QuoteResponse,
  SwapParams,
  SwapResult,
} from "./types.js";

// Jupiter migrated the free public endpoint from `quote-api.jup.ag/v6/*` to
// `lite-api.jup.ag/swap/v1/*`. The old host no longer resolves in many
// regions. Paid tier moved to `api.jup.ag` with an API key.
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const JUP_SWAP = "https://lite-api.jup.ag/swap/v1/swap";

// Jito Block Engine — single-tx submission endpoint. Accepts standard
// JSON-RPC `sendTransaction`; the tx must include a tip transfer to one of
// Jito's tip accounts (Jupiter builds this for us when we set
// `prioritizationFeeLamports.jitoTipLamports`).
const JITO_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf/api/v1/transactions";

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
    jitoTipLamports,
  } = params;

  const useJito = jitoTipLamports !== undefined && jitoTipLamports > 0;

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
      feeLamports: 5000, // sig fee estimate
      tipLamports: useJito ? jitoTipLamports : 0,
    };
  }

  const swapBody: Record<string, unknown> = {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };
  if (useJito) {
    swapBody.prioritizationFeeLamports = { jitoTipLamports };
  } else {
    swapBody.computeUnitPriceMicroLamports = "auto";
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (Date.now() - fetchedAt >= quoteMaxAgeMs) {
      quote = await fetchQuote(quoteParams);
      fetchedAt = Date.now();
      swapBody.quoteResponse = quote;
    }

    const swapRes = await fetch(JUP_SWAP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(swapBody),
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
      const rawTx = tx.serialize();
      const sig = useJito
        ? await sendViaJito(rawTx)
        : await connection.sendRawTransaction(rawTx, {
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

      // Fetch the confirmed tx for the actual network fee. One extra RPC call,
      // but it makes the cost-basis post-fee real instead of estimated.
      const feeLamports = await fetchActualFee(connection, sig);

      return {
        txSignature: sig,
        inputAmountRaw: Number(quote.inAmount),
        outputAmountRaw: Number(quote.outAmount),
        priceImpactPct: Number(quote.priceImpactPct),
        feeLamports,
        tipLamports: useJito ? jitoTipLamports : 0,
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

/**
 * Submit a signed transaction via Jito Block Engine's sendTransaction endpoint.
 * Jupiter has already baked the Jito tip transfer into the tx, so any standard
 * RPC accepts it — but routing through Jito gets priority placement.
 */
async function sendViaJito(rawTx: Uint8Array): Promise<string> {
  const buf = Buffer.from(rawTx);
  const res = await fetch(JITO_BLOCK_ENGINE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        buf.toString("base64"),
        { encoding: "base64", skipPreflight: false, maxRetries: 3 },
      ],
    }),
  });
  const data = (await res.json()) as {
    result?: string;
    error?: { message?: string };
  };
  if (data.error) throw new Error(`Jito send failed: ${data.error.message ?? "unknown"}`);
  if (!data.result) throw new Error("Jito send returned no signature");
  return data.result;
}

async function fetchActualFee(connection: Connection, sig: string): Promise<number> {
  try {
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return tx?.meta?.fee ?? 5000;
  } catch {
    return 5000; // signature fee estimate
  }
}
