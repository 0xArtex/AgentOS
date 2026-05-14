/**
 * Post-trade fill forensics — Phase 2 lite.
 *
 * Compares the realized OUT amount against the quoted OUT amount and flags
 * fills that consumed more than half the slippage budget. A simple delta
 * heuristic, not a full block parse — Phase 3+ may add real sandwich
 * detection by scanning the surrounding block for matching counter-swaps.
 *
 * Why "50% of budget" as the suspect threshold? A healthy fill on a liquid
 * pair typically consumes <20% of the slippage tolerance. Above 50% means
 * either: (a) genuine adverse price move during the quote-to-confirm window,
 * (b) the AMM was sandwiched, or (c) the slippage was set too tight for the
 * pool's depth. All three are worth flagging for review.
 */

export interface FillForensics {
  /**
   * Realized slippage in bps. Positive = worse fill than quoted; negative =
   * improved fill (we got more out than the quote promised).
   */
  realizedSlippageBps: number;
  /** Fraction of the slippage budget consumed. 1.0 = the tx maxed out tolerance. */
  budgetUsed: number;
  /** Heuristic verdict. */
  flag: "ok" | "suspect-mev";
}

export function analyzeFill(
  quotedOutRaw: number | string,
  realizedOutRaw: number | string,
  slippageBudgetBps: number,
): FillForensics {
  const quoted = Number(quotedOutRaw);
  const realized = Number(realizedOutRaw);
  if (!isFinite(quoted) || quoted <= 0 || !isFinite(realized)) {
    return { realizedSlippageBps: 0, budgetUsed: 0, flag: "ok" };
  }
  // Positive when realized < quoted (worse than promised).
  const realizedSlippageBps = ((quoted - realized) / quoted) * 10000;
  const budgetUsed =
    slippageBudgetBps > 0 ? realizedSlippageBps / slippageBudgetBps : 0;
  const flag: "ok" | "suspect-mev" = budgetUsed > 0.5 ? "suspect-mev" : "ok";
  return { realizedSlippageBps, budgetUsed, flag };
}
