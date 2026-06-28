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
    const authScheme = normalizeAuthScheme(authRaw);
    // Strict: skip rows whose auth scheme isn't an explicit x402 value. The old
    // permissive default silently coerced unknown/missing schemes to "x402-base",
    // which let a hostile listing masquerade as an x402-native provider.
    if (!id || !capability || !endpoint || cost === undefined || authScheme === null) continue;

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

/**
 * Map a catalog-declared auth scheme to a canonical x402 rail. STRICT: only
 * explicit x402 values are accepted. Anything else — api_key, wallet_sig, an
 * unknown string, or a missing value — returns null so the spec is rejected.
 * Federated providers MUST settle via x402 to be agent-side executable, and a
 * permissive default is a hijack vector (a malicious row with no/garbage auth
 * would have been silently treated as a payable x402 endpoint).
 */
function normalizeAuthScheme(raw: string | undefined): I402AuthScheme | null {
  switch (raw) {
    case "x402-solana":
    case "x402-svm":
      return "x402-solana";
    case "x402-base":
    case "x402-evm":
      return "x402-base";
    default:
      return null;
  }
}

// -------------------- Trust boundary (federated = UNTRUSTED) --------------------
//
// Federated catalog listings are submitted by untrusted third parties. Without
// these checks a hostile listing could (1) claim a first-party capability and be
// selected for a victim's intent (e.g. "post from my X account"), hijacking the
// vault cookies / wallet / PII the executor injects and redirecting the USDC
// payment to the attacker; (2) outrank first-party rows via a self-declared
// reputation; (3) point at an internal/Palmyr host (SSRF / credential theft via
// host impersonation). Everything below treats federated input as adversarial.

/** Federated reputation can never outrank a first-party Palmyr row (reps 0.7–0.9). */
export const FEDERATED_REPUTATION_CEILING = 0.5;
const FEDERATED_REPUTATION_DEFAULT = 0.4;

/** Clamp a catalog-declared reputation seed into [0, ceiling]. */
export function clampFederatedReputation(seed: number | undefined): number {
  const n = typeof seed === "number" && Number.isFinite(seed) ? seed : FEDERATED_REPUTATION_DEFAULT;
  if (n < 0) return 0;
  if (n > FEDERATED_REPUTATION_CEILING) return FEDERATED_REPUTATION_CEILING;
  return n;
}

/** Hosts Palmyr operates. A federated listing may never claim (or impersonate) one. */
function palmyrHostSuffixes(): string[] {
  const hosts = new Set<string>(["palmyr.ai", "agntos.dev"]);
  const base = process.env.PALMYR_API_BASE;
  if (base) {
    try {
      hosts.add(new URL(base).hostname.toLowerCase().replace(/\.$/, ""));
    } catch {
      /* ignore an unparseable override */
    }
  }
  return [...hosts];
}

/** True for a Palmyr-operated host (exact match or subdomain), case-insensitive. */
export function isPalmyrHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return palmyrHostSuffixes().some(ph => h === ph || h.endsWith(`.${ph}`));
}

function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (h.includes(":")) return true; // IPv6
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h); // IPv4 dotted quad
}

/** Reject loopback / private / link-local / internal / bare-label / IP-literal hosts. */
function isPrivateOrInternalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  for (const suffix of [".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"]) {
    if (h.endsWith(suffix)) return true;
  }
  // Never trust a bare IP from a federated catalog (blocks 169.254.169.254 metadata,
  // 127.0.0.1, 10/172.16/192.168 RFC1918, ::1, fc00::/7, etc.).
  if (isIpLiteral(h)) return true;
  // A single-label hostname ("metadata", "router") is internal by definition.
  if (!h.includes(".")) return true;
  return false;
}

/** Validate a federated endpoint: https + public host that is neither internal nor Palmyr. */
export function classifyFederatedEndpoint(endpoint: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: `unparseable endpoint '${endpoint}'` };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `endpoint must be https (got '${url.protocol}')` };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isPalmyrHost(host)) {
    return { ok: false, reason: `endpoint host '${host}' impersonates a first-party Palmyr host` };
  }
  if (isPrivateOrInternalHost(host)) {
    return { ok: false, reason: `endpoint host '${host}' is internal/private` };
  }
  return { ok: true };
}

/**
 * True iff an endpoint is a verified Palmyr-operated host. Used by the planner as
 * the credential-injection guard: vault cookies/credentials may only ever be sent
 * to a Palmyr host, never to a federated/untrusted endpoint.
 */
export function isTrustedExecutionEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    return isPalmyrHost(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/** True if a first-party (Palmyr/agentos) provider already serves this capability. */
function capabilityHasFirstPartyProvider(capability: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM i402_providers WHERE capability = ? AND source = 'agentos' LIMIT 1`)
    .get(capability);
  return !!row;
}

/**
 * Vet a single federated spec against the trust boundary. Applied to EVERY spec in
 * ingestCatalog (the one chokepoint), independent of which parser produced it:
 *   (a) capability hijack — federation may not serve a capability a first-party
 *       Palmyr provider already serves (this is the allowlist: federation may only
 *       serve capabilities Palmyr has no first-party row for, e.g. future
 *       web_search / image_gen);
 *   (c) auth-scheme strictness — must be x402-solana or x402-base;
 *   (d) host allowlist — https public host, never internal/private/Palmyr.
 */
export function vetFederatedSpec(
  spec: FederatedProviderSpec
): { ok: true } | { ok: false; reason: string } {
  if (!spec || typeof spec.id !== "string" || spec.id.trim() === "") {
    return { ok: false, reason: "missing id" };
  }
  if (typeof spec.capability !== "string" || spec.capability.trim() === "") {
    return { ok: false, reason: "missing capability" };
  }
  if (typeof spec.endpoint !== "string" || spec.endpoint.trim() === "") {
    return { ok: false, reason: "missing endpoint" };
  }
  if (spec.authScheme !== "x402-solana" && spec.authScheme !== "x402-base") {
    return { ok: false, reason: `auth scheme '${spec.authScheme}' is not x402-native` };
  }
  const ep = classifyFederatedEndpoint(spec.endpoint);
  if (!ep.ok) return ep;
  if (capabilityHasFirstPartyProvider(spec.capability)) {
    return {
      ok: false,
      reason: `capability '${spec.capability}' is first-party; federation may not serve it`,
    };
  }
  return { ok: true };
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
  /** Rows rejected by the trust boundary (capability hijack / bad auth / bad host). */
  skipped_untrusted: number;
  errors: string[];
  /** Human-readable reasons for each trust-boundary rejection. */
  rejections: string[];
  /**
   * Provider ids that passed vetting this round (used to prune disappeared rows
   * without a second fetch). Trust-rejected ids are deliberately excluded so a
   * previously-registered row that now fails vetting gets disabled by the prune.
   */
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
    skipped_untrusted: 0,
    errors: [],
    rejections: [],
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
    // Trust boundary FIRST — runs for every spec regardless of which parser
    // produced it. Rejected specs are not added to fetchedIds, so any matching
    // row that lingers from a prior (pre-fix) ingest gets disabled by the prune.
    const vet = vetFederatedSpec(spec);
    if (!vet.ok) {
      result.skipped_untrusted++;
      result.rejections.push(`${(spec && spec.id) || "<no-id>"}: ${vet.reason}`);
      continue;
    }
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
        // Clamp remote-declared reputation so a federated row can never outrank
        // a first-party Palmyr provider (which seed at 0.7–0.9).
        reputationScore: clampFederatedReputation(spec.reputationSeed),
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
