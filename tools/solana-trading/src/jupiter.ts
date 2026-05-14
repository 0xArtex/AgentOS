import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import type {
  JupiterQuoteParams,
  QuoteResponse,
  SwapParams,
  SwapResult,
} from "./types.js";
import { SOL_MINT } from "./wallet.js";

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

/**
 * Structured route error mirroring `cli/evm-trading.ts:RouteError`. Defined
 * here so this package can be consumed standalone; the CLI catches both
 * shapes via duck typing on `errorCode`.
 */
export class JupiterRouteError extends Error {
  readonly errorCode: 'TOKEN_NOT_TRADABLE' | 'NO_ROUTE' | 'RATE_LIMITED' | 'PROVIDER_ERROR';
  readonly provider: 'jupiter';
  readonly chain: 'solana';
  readonly status?: number;
  constructor(
    code: JupiterRouteError['errorCode'],
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'JupiterRouteError';
    this.errorCode = code;
    this.provider = 'jupiter';
    this.chain = 'solana';
    this.status = status;
  }
}

export async function fetchQuote(p: JupiterQuoteParams): Promise<QuoteResponse> {
  const url =
    `${JUP_QUOTE}?inputMint=${p.inputMint}&outputMint=${p.outputMint}` +
    `&amount=${p.amount}&slippageBps=${p.slippageBps}` +
    `&onlyDirectRoutes=false&asLegacyTransaction=false`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    // Jupiter signals untradable tokens via 400 + `TOKEN_NOT_TRADABLE`. Pattern-match
    // both the explicit code and the message text so the CLI can return a stable
    // exit code regardless of upstream wording shifts.
    if (res.status === 400 && /TOKEN_NOT_TRADABLE|is not tradable/i.test(body)) {
      throw new JupiterRouteError('TOKEN_NOT_TRADABLE', `Jupiter: ${p.outputMint} is not tradable`, 400);
    }
    if (res.status === 429) {
      throw new JupiterRouteError('RATE_LIMITED', `Jupiter rate limit: ${body}`, 429);
    }
    throw new JupiterRouteError('PROVIDER_ERROR', `Jupiter quote failed: ${res.status} ${body}`, res.status);
  }
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
    const quotedOutRaw = Number(quote.outAmount);
    return {
      txSignature: `dryrun_${Date.now()}`,
      inputAmountRaw: Number(quote.inAmount),
      outputAmountRaw: quotedOutRaw, // no realized in dry-run; quoted stands in
      quotedOutRaw,
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

  // Manual CU bump used when Jupiter's dynamic CU estimate is too low. Some
  // protected/Jito sells with complex routes simulate as
  // `ComputationalBudgetExceeded`; bumping to 1.4M CU clears the typical case
  // while staying well under Solana's 1.4M per-tx cap (which is exactly the
  // ceiling, so we'd not bump beyond that).
  const RETRY_CU_LIMIT = 1_400_000;

  for (let attempt = 1; attempt <= 3; attempt++) {
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
      const errStr = JSON.stringify(sim.value.err);
      // ComputationalBudgetExceeded — Jupiter's auto-estimate didn't allow
      // enough compute units for the chosen route. Retry once with a manual
      // hard CU cap before giving up; this is the failure mode QA hit on
      // protected Solana sells.
      const isCuExceeded =
        /ComputationalBudgetExceeded/i.test(errStr) ||
        /computational budget exceeded/i.test(errStr);
      if (isCuExceeded && attempt < 3 && !swapBody.computeUnitLimit) {
        swapBody.dynamicComputeUnitLimit = false;
        swapBody.computeUnitLimit = RETRY_CU_LIMIT;
        continue;
      }
      throw new Error(`Simulation failed before send: ${errStr}`);
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

      // Fetch the confirmed tx once for both actual fee AND realized out.
      // Makes cost-basis post-fee real and lets forensics see actual slippage.
      const quotedOutRaw = Number(quote.outAmount);
      const { feeLamports, realizedOutRaw } = await fetchTxOutcome(
        connection,
        sig,
        wallet,
        outputMint,
        quotedOutRaw,
        useJito ? jitoTipLamports : 0,
      );

      return {
        txSignature: sig,
        inputAmountRaw: Number(quote.inAmount),
        outputAmountRaw: realizedOutRaw,
        quotedOutRaw,
        priceImpactPct: Number(quote.priceImpactPct),
        feeLamports,
        tipLamports: useJito ? jitoTipLamports : 0,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/blockhash not found/i.test(msg) && attempt < 3) {
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

/**
 * Single getTransaction call that extracts both the actual fee and the
 * realized OUT amount from the confirmed tx's pre/post balance deltas.
 *
 * - For SOL output (output mint is wSOL): the owner's SOL balance gains the
 *   swap output but loses the fee. Realized = (post - pre) + fee.
 * - For SPL output: the owner's token account for the output mint gains the
 *   tokens. Realized = postTokenBalance - preTokenBalance.
 *
 * Both fall back to the quote on any parse failure — better to record a
 * promised number than crash the swap pipeline.
 */
async function fetchTxOutcome(
  connection: Connection,
  sig: string,
  wallet: Keypair,
  outputMint: string,
  quotedOutRaw: number,
  tipLamports: number,
): Promise<{ feeLamports: number; realizedOutRaw: number }> {
  try {
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) return { feeLamports: 5000, realizedOutRaw: quotedOutRaw };

    const feeLamports = tx.meta.fee ?? 5000;
    const owner = wallet.publicKey.toBase58();

    if (outputMint === SOL_MINT.toBase58()) {
      // SOL output: balance change is net of fee AND tip. Add both back to
      // recover the gross swap proceeds. Tip is not counted in tx.meta.fee —
      // it's a separate SystemProgram.transfer that Jupiter built into the tx.
      const pre = tx.meta.preBalances?.[0] ?? 0;
      const post = tx.meta.postBalances?.[0] ?? 0;
      const realized = post - pre + feeLamports + tipLamports;
      return {
        feeLamports,
        realizedOutRaw: realized > 0 ? realized : quotedOutRaw,
      };
    }

    // SPL output: diff the owner's token balance for the output mint.
    const preList = tx.meta.preTokenBalances ?? [];
    const postList = tx.meta.postTokenBalances ?? [];
    const preBal =
      preList.find((b) => b.owner === owner && b.mint === outputMint)
        ?.uiTokenAmount.amount ?? "0";
    const postBal =
      postList.find((b) => b.owner === owner && b.mint === outputMint)
        ?.uiTokenAmount.amount ?? "0";
    const realized = Number(BigInt(postBal) - BigInt(preBal));
    return {
      feeLamports,
      realizedOutRaw: realized > 0 ? realized : quotedOutRaw,
    };
  } catch {
    return { feeLamports: 5000, realizedOutRaw: quotedOutRaw };
  }
}
