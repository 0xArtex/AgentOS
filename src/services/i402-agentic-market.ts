import { db } from "../db";
import {
  registerProvider,
  CAPABILITY_CLASSES,
  setProviderEnabled,
  type I402AuthScheme,
} from "./i402-providers";

// -------------------- Federated provider spec --------------------

/**
 * A capability-tagged service fetched from a federated catalog (e.g. Agentic Market).
 * Intentionally generic — real catalogs have additional fields we ignore.
 */
export interface FederatedProviderSpec {
  id: string;
  capability: string;                   // canonical i402 capability class name
  name: string;
  description?: string;
  endpoint: string;
  method?: "GET" | "POST";
  authScheme: I402AuthScheme;
  costPerCallUsdc: number;
  p50LatencyMs?: number;
  p99LatencyMs?: number;
  reputationSeed?: number;              // optional reputation hint from the catalog
  metadata?: Record<string, unknown>;
}

// -------------------- Adapter interface --------------------

export interface FederatedCatalogAdapter {
  readonly source: "agentic_market" | "clawhub";
  readonly name: string;
  fetch(): Promise<FederatedProviderSpec[]>;
}

// -------------------- Agentic Market adapter (HTTP) --------------------

/**
 * Configurable Agentic Market adapter.
 *
 * The exact AM catalog response shape is expected to evolve. This adapter:
 *   1. Issues a GET against I402_AGENTIC_MARKET_CATALOG_URL
 *   2. Runs the configured parser to map whatever shape AM returns into FederatedProviderSpec[]
 *
 * Default parser assumes:
 *   { services: [{ id, capability, name, endpoint, auth_scheme, cost_usdc_per_call, ... }] }
 * which is the most reasonable REST-ish shape. Override with a custom parser when
 * AM's actual API is documented without touching the ingest pipeline.
 */
export class AgenticMarketAdapter implements FederatedCatalogAdapter {
  readonly source = "agentic_market" as const;
  readonly name = "Agentic Market (Coinbase)";

  constructor(
    private readonly catalogUrl: string,
    private readonly apiKey?: string,
    private readonly parser: (raw: unknown) => FederatedProviderSpec[] = defaultAgenticMarketParser
  ) {}

  async fetch(): Promise<FederatedProviderSpec[]> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const res = await fetch(this.catalogUrl, { headers });
    if (!res.ok) {
      throw new Error(`Agentic Market catalog fetch failed: ${res.status} ${res.statusText}`);
    }
    const raw = await res.json();
    return this.parser(raw);
  }
}

/**
 * Reasonable default parser. Non-matching shapes should provide a custom parser
 * when constructing AgenticMarketAdapter.
 */
export function defaultAgenticMarketParser(raw: unknown): FederatedProviderSpec[] {
  const root = raw as { services?: unknown[]; providers?: unknown[] };
  const entries = root.services ?? root.providers ?? [];
  const out: FederatedProviderSpec[] = [];
  for (const e of entries as Array<Record<string, unknown>>) {
    const id = typeof e.id === "string" ? e.id : undefined;
    const capability = typeof e.capability === "string" ? e.capability : undefined;
    const name = typeof e.name === "string" ? e.name : id;
    const endpoint = typeof e.endpoint === "string" ? e.endpoint : undefined;
    const cost =
      typeof e.cost_usdc_per_call === "number"
        ? (e.cost_usdc_per_call as number)
        : typeof e.cost_usdc === "number"
          ? (e.cost_usdc as number)
          : undefined;
    const authRaw = (e.auth_scheme ?? e.auth) as string | undefined;
    if (!id || !capability || !endpoint || cost === undefined) continue;

    const authScheme = normalizeAuthScheme(authRaw);
    out.push({
      id,
      capability,
      name: name ?? id,
      description: typeof e.description === "string" ? (e.description as string) : undefined,
      endpoint,
      method: (e.method === "GET" || e.method === "POST") ? (e.method as "GET" | "POST") : "POST",
      authScheme,
      costPerCallUsdc: cost,
      p50LatencyMs: typeof e.p50_latency_ms === "number" ? (e.p50_latency_ms as number) : undefined,
      p99LatencyMs: typeof e.p99_latency_ms === "number" ? (e.p99_latency_ms as number) : undefined,
      reputationSeed: typeof e.reputation_seed === "number" ? (e.reputation_seed as number) : undefined,
      metadata: (e.metadata as Record<string, unknown>) ?? undefined,
    });
  }
  return out;
}

function normalizeAuthScheme(raw: string | undefined): I402AuthScheme {
  switch (raw) {
    case "x402-solana":
    case "x402-svm":
      return "x402-solana";
    case "x402-base":
    case "x402-evm":
      return "x402-base";
    case "api_key":
      return "api_key";
    case "wallet_sig":
      return "wallet_sig";
    default:
      // Safe default — AM providers nearly all speak x402 so default to that
      return "x402-base";
  }
}

// -------------------- Mock adapter (for tests) --------------------

export class MockCatalogAdapter implements FederatedCatalogAdapter {
  readonly source: "agentic_market" | "clawhub";
  readonly name: string;
  constructor(
    source: "agentic_market" | "clawhub",
    name: string,
    private readonly providers: FederatedProviderSpec[]
  ) {
    this.source = source;
    this.name = name;
  }
  async fetch(): Promise<FederatedProviderSpec[]> {
    return this.providers;
  }
}

// -------------------- Ingestion --------------------

export interface IngestResult {
  source: string;
  fetched: number;
  registered: number;
  skipped_unknown_capability: number;
  errors: string[];
  /** Every provider id seen in the fetched catalog (used to prune disappeared rows without a second fetch). */
  fetchedIds: string[];
}

/**
 * Ingest a catalog: fetch, filter, register into i402_providers.
 * Existing providers with the same ID are left untouched — registerProvider
 * uses INSERT OR IGNORE, so neither metadata (endpoint, cost, latency) nor
 * observed metrics (success_rate, etc.) are refreshed on collision. To pick up
 * upstream changes a federated row must be pruned/deleted and re-ingested.
 */
export async function ingestCatalog(adapter: FederatedCatalogAdapter): Promise<IngestResult> {
  const result: IngestResult = {
    source: adapter.source,
    fetched: 0,
    registered: 0,
    skipped_unknown_capability: 0,
    errors: [],
    fetchedIds: [],
  };

  let specs: FederatedProviderSpec[] = [];
  try {
    specs = await adapter.fetch();
  } catch (err: any) {
    result.errors.push(`fetch failed: ${err?.message ?? err}`);
    return result;
  }
  result.fetched = specs.length;

  for (const spec of specs) {
    result.fetchedIds.push(spec.id);
    if (!CAPABILITY_CLASSES[spec.capability]) {
      result.skipped_unknown_capability++;
      continue;
    }
    try {
      registerProvider({
        id: spec.id,
        source: adapter.source,
        capability: spec.capability,
        name: spec.name,
        description: spec.description,
        endpoint: spec.endpoint,
        method: spec.method,
        authScheme: spec.authScheme,
        inputSchema: CAPABILITY_CLASSES[spec.capability].inputSchema,
        outputSchema: CAPABILITY_CLASSES[spec.capability].outputSchema,
        costPerCallUsdc: spec.costPerCallUsdc,
        p50LatencyMs: spec.p50LatencyMs,
        p99LatencyMs: spec.p99LatencyMs,
        reputationScore: spec.reputationSeed ?? 0.6,
        metadata: spec.metadata,
      });
      result.registered++;
    } catch (err: any) {
      result.errors.push(`register ${spec.id}: ${err?.message ?? err}`);
    }
  }

  return result;
}

/**
 * Disable providers whose IDs are not in the current fetched set. Useful if a
 * catalog stops publishing a provider — we don't want the orchestrator to keep
 * routing to dead endpoints.
 */
export function pruneDisappeared(source: "agentic_market" | "clawhub", currentIds: Set<string>): number {
  const rows = db
    .prepare(`SELECT id FROM i402_providers WHERE source = ? AND enabled = 1`)
    .all(source) as Array<{ id: string }>;
  let disabled = 0;
  for (const row of rows) {
    if (!currentIds.has(row.id)) {
      setProviderEnabled(row.id, false);
      disabled++;
    }
  }
  return disabled;
}

// -------------------- Convenience: default AM adapter from env --------------------

export function defaultAgenticMarketAdapter(): AgenticMarketAdapter | null {
  const url = process.env.I402_AGENTIC_MARKET_CATALOG_URL;
  if (!url) return null;
  const apiKey = process.env.I402_AGENTIC_MARKET_API_KEY || undefined;
  return new AgenticMarketAdapter(url, apiKey);
}

/**
 * Orchestrator-level ingest. Call on startup + periodically.
 */
export async function refreshFederatedCatalogs(): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  const am = defaultAgenticMarketAdapter();
  if (am) {
    const r = await ingestCatalog(am);
    results.push(r);
    // Prune: only disable providers we've seen before but didn't see this round.
    // We can't easily prune on a failed fetch without thinking the whole catalog disappeared.
    if (r.errors.length === 0) {
      // Reuse the ids just ingested instead of re-fetching the catalog — a
      // second fetch doubles the round-trip and can flap the registry if the
      // catalog changes between the two reads (a provider registered in pass 1
      // but absent in pass 2 would be wrongly disabled).
      pruneDisappeared("agentic_market", new Set(r.fetchedIds));
    }
  }
  return results;
}
