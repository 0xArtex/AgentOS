/**
 * Dynamic slippage from DexScreener 5-minute volatility.
 *
 * Plan: `slippageBps = clamp(3 × abs(priceChange.m5%) × 100, 50, 1500)`.
 * Floor 0.5% so we don't get sandwiched on stable pairs; cap 15% so we don't
 * tolerate insane slippage on dead memes. Falls back to caller's default when
 * DexScreener has no data for the mint.
 */

const DEX_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens";

interface DsPair {
  priceChange?: { m5?: number };
  liquidity?: { usd?: number };
}

interface DsTokenResponse {
  pairs?: DsPair[];
}

/**
 * Fetch absolute 5-minute price change (%) for a Solana mint from DexScreener.
 * Picks the pair with the highest USD liquidity (most representative).
 * Returns null when DexScreener has nothing useful.
 */
export async function fetchTokenVolatility5m(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`${DEX_TOKEN_URL}/${mint}`);
    if (!res.ok) return null;
    const data = (await res.json()) as DsTokenResponse;
    if (!data.pairs || data.pairs.length === 0) return null;

    const pairsWithVol = data.pairs.filter(
      (p): p is DsPair & { priceChange: { m5: number } } =>
        typeof p.priceChange?.m5 === "number" && isFinite(p.priceChange.m5),
    );
    if (pairsWithVol.length === 0) return null;

    pairsWithVol.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    return Math.abs(pairsWithVol[0].priceChange.m5);
  } catch {
    return null;
  }
}

/**
 * Convert a 5-minute volatility percentage into a slippage budget in bps.
 *   3× the recent move, clamped to [50 bps, 1500 bps] = [0.5%, 15%].
 */
export function computeDynamicSlippageBps(volPct5m: number): number {
  if (!isFinite(volPct5m) || volPct5m < 0) return 100;
  const bps = Math.round(volPct5m * 3 * 100);
  return Math.max(50, Math.min(1500, bps));
}

export interface SlippageRecommendation {
  bps: number;
  volPct5m: number | null;
  source: "dexscreener" | "fallback";
}

/**
 * One-shot helper: returns a slippage recommendation, with a fallback when
 * DexScreener has no data.
 */
export async function recommendSlippageBps(
  mint: string,
  fallbackBps = 100,
): Promise<SlippageRecommendation> {
  const vol = await fetchTokenVolatility5m(mint);
  if (vol === null) {
    return { bps: fallbackBps, volPct5m: null, source: "fallback" };
  }
  return {
    bps: computeDynamicSlippageBps(vol),
    volPct5m: vol,
    source: "dexscreener",
  };
}
