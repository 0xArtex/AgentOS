/**
 * Server-side corpus collection — Palmyr pays the upstream, agents just ask.
 *
 * An agent asking "what works in fitness" should get an answer, not a chore.
 * So a stale or missing niche refreshes itself here rather than waiting for an
 * operator to run a command.
 *
 * Speed is the constraint that shapes this. Collection means several paid HTTP
 * round-trips, which is far too slow to sit in front of a read, so:
 *
 *   - fresh corpus            → served immediately, nothing fetched
 *   - stale but present       → served IMMEDIATELY from what we have, with a
 *                               refresh kicked off behind the response
 *                               (stale-while-revalidate). Nobody waits for data
 *                               that is merely a few days old.
 *   - nothing at all          → a reduced, bounded, PARALLEL collection is
 *                               awaited so the caller gets a real answer, then
 *                               the remaining queries fill in behind them.
 *
 * Spending is bounded three ways, because this is money moving without a human
 * in the loop: the niche list is closed (so the reachable worst case is fixed),
 * a per-niche in-flight lock means concurrent askers trigger ONE collection
 * rather than one each, and a daily cap stops anything unforeseen from running
 * away.
 */
import { getNiche, NICHES, type Niche } from "./tiktok-niches";
import {
  storeCollection,
  recordCollectionRun,
  corpusFreshness,
  parseUpstreamPost,
  DEFAULT_STALE_DAYS,
  type UpstreamPost,
} from "./tiktok-corpus";
import { paidFetch } from "./x402-client";
import { db } from "../db";

const PAYER_KEY_ENV = "CORPUS_PAYER_EVM_PRIVATE_KEY";
const UPSTREAM = "https://stablesocial.dev/api/sc/tiktok/search/keyword";

/** Observed price per query. maxUsdc sits just above it, never wide open. */
const PRICE_PER_QUERY_USDC = 0.06;
const MAX_PER_QUERY_USDC = 0.08;
/** Total we will spend on collection in a day, across every niche. */
const DAILY_CAP_USDC = Number(process.env.CORPUS_DAILY_CAP_USDC || 5);
/** Queries awaited on a cold start. The rest follow in the background. */
const COLD_START_QUERIES = 2;
const UPSTREAM_TIMEOUT_MS = 25_000;

function getEthers(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("ethers").ethers ?? require("ethers");
}

let _payer: any;
let _payerTried = false;

/** The Base wallet that pays for collections. Deliberately NOT the card float:
 *  a corpus overspend must never be able to eat money earmarked for issuing
 *  someone's card. */
export function loadCorpusPayer(): any {
  if (_payerTried) return _payer;
  _payerTried = true;
  const raw = process.env[PAYER_KEY_ENV];
  if (!raw) return null;
  try {
    _payer = new (getEthers().Wallet)(raw);
    console.log(`[tiktok-corpus] payer wallet loaded: ${_payer.address}`);
  } catch (e: any) {
    console.error(`[tiktok-corpus] ${PAYER_KEY_ENV} failed to parse:`, e?.message || e);
    _payer = null;
  }
  return _payer;
}

export function collectorEnabled(): boolean {
  return !!loadCorpusPayer();
}

/** USDC spent on collection since midnight UTC. */
export function spentTodayUsdc(now: number = Date.now()): number {
  const since = new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z";
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_usdc), 0) AS total FROM tiktok_niche_collections WHERE collected_at >= ?`)
    .get(since) as { total: number };
  return Number(row?.total || 0);
}

function budgetRemaining(now: number = Date.now()): number {
  return Math.max(0, DAILY_CAP_USDC - spentTodayUsdc(now));
}

/** One paid upstream query. Returns [] on any failure — one bad query must not
 *  discard the ones that worked. */
async function fetchQuery(niche: Niche, query: string, wallet: any): Promise<UpstreamPost[]> {
  try {
    const r = await paidFetch(UPSTREAM, {
      method: "POST",
      body: JSON.stringify({ query }),
      wallet,
      maxUsdc: MAX_PER_QUERY_USDC,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!r.ok) {
      console.warn(`[tiktok-corpus] ${niche.id} "${query}" upstream ${r.status}`);
      return [];
    }
    const items = (r.data?.search_item_list || []) as any[];
    return items.map((x) => parseUpstreamPost(x?.aweme_info)).filter(Boolean) as UpstreamPost[];
  } catch (e: any) {
    console.warn(`[tiktok-corpus] ${niche.id} "${query}" failed:`, e?.message || e);
    return [];
  }
}

/** Niches with a collection in flight. Concurrent askers share one run rather
 *  than each starting their own — otherwise a burst of traffic multiplies the
 *  bill by the size of the burst. */
const inFlight = new Map<string, Promise<number>>();

export function isCollecting(nicheId: string): boolean {
  return inFlight.has(nicheId);
}

/**
 * Collect a niche and store it. Queries run in PARALLEL — they are independent,
 * and serialising them multiplies the wait by the number of angles for no gain.
 */
export async function collectNiche(nicheId: string, opts: { queries?: number } = {}): Promise<number> {
  const existing = inFlight.get(nicheId);
  if (existing) return existing;

  const run = (async (): Promise<number> => {
    const niche = getNiche(nicheId);
    if (!niche) return 0;
    const wallet = loadCorpusPayer();
    if (!wallet) return 0;

    const wanted = Math.max(1, Math.min(opts.queries ?? niche.queries.length, niche.queries.length));
    const affordable = Math.floor(budgetRemaining() / PRICE_PER_QUERY_USDC);
    const count = Math.min(wanted, affordable);
    if (count <= 0) {
      console.warn(`[tiktok-corpus] daily cap $${DAILY_CAP_USDC} reached — not collecting ${nicheId}`);
      return 0;
    }

    const queries = niche.queries.slice(0, count);
    const collectedAt = new Date().toISOString();
    const results = await Promise.all(queries.map((q) => fetchQuery(niche, q, wallet)));

    let stored = 0;
    results.forEach((posts, i) => {
      if (posts.length) stored += storeCollection(niche.id, queries[i], posts, collectedAt);
    });

    // Charged per query attempted — a query that returned nothing still cost.
    const cost = Number((queries.length * PRICE_PER_QUERY_USDC).toFixed(4));
    recordCollectionRun({
      niche: niche.id,
      collectedAt,
      queries: queries.length,
      posts: stored,
      costUsdc: cost,
      error: stored === 0 ? "collection stored no posts" : null,
    });
    console.log(`[tiktok-corpus] ${niche.id}: ${stored} posts from ${queries.length} queries ($${cost})`);
    return stored;
  })();

  inFlight.set(nicheId, run);
  try {
    return await run;
  } finally {
    inFlight.delete(nicheId);
  }
}

export interface EnsureResult {
  /** True when the caller waited on a collection (cold start only). */
  awaited: boolean;
  /** True when a refresh is running behind the response. */
  refreshing: boolean;
  /** Why nothing was collected, when nothing was. */
  skipped?: "not_configured" | "budget" | "unknown_niche";
}

/**
 * Make sure a niche has usable data, without making the caller wait for data
 * they don't need to wait for.
 *
 * The asymmetry is deliberate: stale data is still a real answer, so it is
 * served instantly and refreshed behind the response. NO data is not an
 * answer, so a cold start is awaited — but only for a couple of queries, in
 * parallel, with the rest filling in afterwards.
 */
export async function ensureFresh(nicheId: string, staleDays: number = DEFAULT_STALE_DAYS): Promise<EnsureResult> {
  const niche = getNiche(nicheId);
  if (!niche) return { awaited: false, refreshing: false, skipped: "unknown_niche" };
  const freshness = corpusFreshness(nicheId, staleDays);
  if (!freshness.stale) return { awaited: false, refreshing: false };

  if (!collectorEnabled()) return { awaited: false, refreshing: false, skipped: "not_configured" };
  if (budgetRemaining() < PRICE_PER_QUERY_USDC) return { awaited: false, refreshing: false, skipped: "budget" };

  // Already being collected by someone else's request — don't start a second.
  if (isCollecting(nicheId)) return { awaited: false, refreshing: true };

  if (freshness.posts > 0) {
    // Stale but usable. Serve now, refresh behind. The catch is required:
    // an unhandled rejection here would take the process down for a
    // background refresh nobody was waiting on.
    void collectNiche(nicheId).catch((e) => console.error(`[tiktok-corpus] background refresh failed:`, e?.message || e));
    return { awaited: false, refreshing: true };
  }

  // Cold: nothing to serve, so this one is worth waiting for — briefly.
  await collectNiche(nicheId, { queries: COLD_START_QUERIES });
  // Then top up the remaining angles without holding anyone up.
  void collectNiche(nicheId).catch(() => { /* best effort */ });
  return { awaited: true, refreshing: true };
}

/** Pre-warm every niche. One-time, so cold starts stop happening in practice. */
export async function warmAllNiches(): Promise<{ niche: string; stored: number }[]> {
  const out: { niche: string; stored: number }[] = [];
  for (const n of NICHES) {
    if (budgetRemaining() < PRICE_PER_QUERY_USDC) break;
    if (!corpusFreshness(n.id).stale) continue;
    out.push({ niche: n.id, stored: await collectNiche(n.id) });
  }
  return out;
}
