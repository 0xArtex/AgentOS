/**
 * Hetzner Cloud server-type + location catalog. Fetched live at boot from
 * GET /v1/server_types and GET /v1/datacenters so we never hardcode types
 * that get deprecated and we can tell agents which type is deployable in
 * which datacenter.
 *
 * - `refreshHcloudTypes()` — pull the live list, filter to non-deprecated
 *   shared types, compute USDC pricing from EUR monthly rates, build the
 *   location + per-datacenter availability map.
 * - In-memory cache, auto-refreshed every 6 hours.
 * - On fetch failure (e.g. HCLOUD_TOKEN missing or Hetzner outage), a
 *   conservative static fallback keeps the route alive but reduced.
 *
 * USDC pricing formula: max($5, round(EUR_monthly * 1.5)).
 * Margin covers the SOL fee, the wallet/identity-tracking overhead, and
 * the markup we charge agents on top of raw infra.
 */

import type { ServerPlan } from "../types";

const HCLOUD_API = "https://api.hetzner.cloud/v1";
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000; // 6h

interface HcloudServerType {
  id: number;
  name: string;
  cores: number;
  memory: number; // GB
  disk: number; // GB
  cpu_type: "shared" | "dedicated";
  architecture: "x86" | "arm";
  deprecated: boolean | null | { announced: string; unavailable_after: string };
  prices: Array<{
    location: string;
    price_monthly: { net: string; gross: string };
  }>;
}

interface HcloudLocation {
  id: number;
  name: string;
  city: string;
  country: string;
  description: string;
  network_zone: string;
  latitude: number;
  longitude: number;
}

interface HcloudDatacenter {
  id: number;
  name: string;
  description: string;
  location: HcloudLocation;
  server_types: {
    supported: number[];
    available: number[];
    available_for_migration: number[];
  };
}

export interface LocationInfo {
  name: string;          // location slug, e.g. "fsn1"
  city: string;
  country: string;       // ISO-2
  networkZone: string;   // "eu-central", "us-east", etc.
  /** Server-type names currently DEPLOYABLE in this location (Hetzner's `available` list). */
  availableTypes: string[];
}

let cache: {
  plans: ServerPlan[];
  /** Locations keyed by slug for fast lookup. */
  locations: Map<string, LocationInfo>;
  /**
   * For each server type, the set of location slugs where it's currently
   * deployable. Lets us answer "where can I run cax11?" without re-walking
   * the location list every time.
   */
  typeLocationAvailability: Map<string, Set<string>>;
  /**
   * For each server type, the locations that OFFER it at all (Hetzner's
   * `supported` list). supported-but-not-available = temporarily sold out,
   * which deserves a different answer than "never offered here".
   */
  typeLocationSupported: Map<string, Set<string>>;
  refreshedAt: number;
} | null = null;
let inflight: Promise<void> | null = null;

const STATIC_FALLBACK: ServerPlan[] = [
  // Fallback when Hetzner API is unreachable at boot. Conservative list of
  // historically-stable types — not authoritative.
  { type: "cpx11", vcpu: 2, ram: 2, disk: 40, traffic: 20, arch: "x86", hetznerMonthly: 4.99, priceUsdc: "7.00" },
  { type: "cpx21", vcpu: 3, ram: 4, disk: 80, traffic: 20, arch: "x86", hetznerMonthly: 9.99, priceUsdc: "15.00" },
  { type: "cpx31", vcpu: 4, ram: 8, disk: 160, traffic: 20, arch: "x86", hetznerMonthly: 17.99, priceUsdc: "26.00" },
];

function priceUsdcFromEur(eurMonthly: number): string {
  const usdc = Math.max(5, Math.round(eurMonthly * 1.5));
  return `${usdc}.00`;
}

function isDeprecated(d: HcloudServerType["deprecated"]): boolean {
  if (d == null) return false;
  if (typeof d === "boolean") return d;
  // Object form: { announced, unavailable_after } — treat as deprecated regardless of dates
  return true;
}

async function fetchAllServerTypes(token: string): Promise<HcloudServerType[]> {
  const all: HcloudServerType[] = [];
  let page: number | null = 1;
  while (page !== null) {
    const url = `${HCLOUD_API}/server_types?per_page=50&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Hetzner /server_types ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { server_types?: HcloudServerType[]; meta?: { pagination?: { next_page: number | null } } };
    all.push(...(data.server_types ?? []));
    page = data.meta?.pagination?.next_page ?? null;
  }
  return all;
}

async function fetchAllDatacenters(token: string): Promise<HcloudDatacenter[]> {
  const all: HcloudDatacenter[] = [];
  let page: number | null = 1;
  while (page !== null) {
    const url = `${HCLOUD_API}/datacenters?per_page=50&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Hetzner /datacenters ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { datacenters?: HcloudDatacenter[]; meta?: { pagination?: { next_page: number | null } } };
    all.push(...(data.datacenters ?? []));
    page = data.meta?.pagination?.next_page ?? null;
  }
  return all;
}

function emptyExtras() {
  return {
    locations: new Map<string, LocationInfo>(),
    typeLocationAvailability: new Map<string, Set<string>>(),
    typeLocationSupported: new Map<string, Set<string>>(),
  };
}

export async function refreshHcloudTypes(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const token = process.env.HCLOUD_TOKEN;
      if (!token) {
        console.warn("[hcloud-types] HCLOUD_TOKEN not set — using static fallback");
        cache = { plans: STATIC_FALLBACK, ...emptyExtras(), refreshedAt: Date.now() };
        return;
      }

      // Fetch types and datacenters in parallel — both feed the same cache.
      // If either fails, we'd rather fail the whole refresh than ship a
      // half-populated cache (better to keep the previous one or fall back).
      const [types, datacenters] = await Promise.all([
        fetchAllServerTypes(token),
        fetchAllDatacenters(token),
      ]);

      // Build plans (existing logic), keyed by name. We also keep a numeric-id
      // → name map so we can resolve datacenter.server_types.available[]
      // (which is numeric IDs) into our string-based plan names.
      const plans: ServerPlan[] = [];
      const idToName = new Map<number, string>();
      for (const t of types) {
        idToName.set(t.id, t.name);
        if (isDeprecated(t.deprecated)) continue;
        if (t.cpu_type !== "shared") continue;
        const prices = (t.prices ?? [])
          .map((p) => parseFloat(p.price_monthly?.gross ?? "0"))
          .filter((n) => n > 0);
        if (prices.length === 0) continue;
        const eurMonthly = Math.min(...prices);
        plans.push({
          type: t.name,
          vcpu: t.cores,
          ram: t.memory,
          disk: t.disk,
          traffic: 20,
          arch: t.architecture === "arm" ? "arm" : "x86",
          hetznerMonthly: eurMonthly,
          priceUsdc: priceUsdcFromEur(eurMonthly),
        });
      }

      // Sort: ARM first (cheaper), then by price
      plans.sort((a, b) => {
        if (a.arch !== b.arch) return a.arch === "arm" ? -1 : 1;
        return a.hetznerMonthly - b.hetznerMonthly;
      });

      // Build location + availability maps. Multiple datacenters can live in
      // one location (e.g. fsn1-dc14, fsn1-dc15 both in fsn1). We aggregate
      // their `available` sets so a type counts as "available in fsn1" if
      // ANY datacenter in fsn1 has it.
      const locations = new Map<string, LocationInfo>();
      const typeLocationAvailability = new Map<string, Set<string>>();
      const typeLocationSupported = new Map<string, Set<string>>();
      for (const dc of datacenters) {
        const locName = dc.location?.name;
        if (!locName) continue;
        let loc = locations.get(locName);
        if (!loc) {
          loc = {
            name: locName,
            city: dc.location.city,
            country: dc.location.country,
            networkZone: dc.location.network_zone,
            availableTypes: [],
          };
          locations.set(locName, loc);
        }
        const availSet = new Set(loc.availableTypes);
        for (const id of dc.server_types?.available ?? []) {
          const typeName = idToName.get(id);
          if (!typeName) continue;
          availSet.add(typeName);
          if (!typeLocationAvailability.has(typeName)) {
            typeLocationAvailability.set(typeName, new Set());
          }
          typeLocationAvailability.get(typeName)!.add(locName);
        }
        for (const id of dc.server_types?.supported ?? []) {
          const typeName = idToName.get(id);
          if (!typeName) continue;
          if (!typeLocationSupported.has(typeName)) {
            typeLocationSupported.set(typeName, new Set());
          }
          typeLocationSupported.get(typeName)!.add(locName);
        }
        loc.availableTypes = [...availSet].sort();
      }

      cache = { plans, locations, typeLocationAvailability, typeLocationSupported, refreshedAt: Date.now() };
      console.log(`[hcloud-types] Loaded ${plans.length} server types, ${locations.size} locations from Hetzner`);
    } catch (err: any) {
      console.error("[hcloud-types] Refresh failed:", err?.message || err);
      // Keep existing cache if any; otherwise fall back.
      if (!cache) cache = { plans: STATIC_FALLBACK, ...emptyExtras(), refreshedAt: Date.now() };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Background refresh trigger — non-blocking. If the cache is stale and no
 * refresh is currently in-flight, kick one off. Callers get the current
 * (possibly stale) cache immediately.
 */
function maybeRefreshInBackground(): void {
  if (!cache || Date.now() - cache.refreshedAt > REFRESH_TTL_MS) {
    refreshHcloudTypes().catch(() => { /* logged inside */ });
  }
}

export function getServerPlans(): ServerPlan[] {
  maybeRefreshInBackground();
  return cache?.plans ?? STATIC_FALLBACK;
}

export function getServerPricing(): Record<string, string> {
  return Object.fromEntries(getServerPlans().map((p) => [p.type, p.priceUsdc]));
}

export function isValidServerType(name: string): boolean {
  return getServerPlans().some((p) => p.type === name);
}

export function describeServerType(name: string): ServerPlan | undefined {
  return getServerPlans().find((p) => p.type === name);
}

/**
 * When the requested server type is sold out everywhere, pick the best
 * SAFE substitute that Hetzner actually has stock of right now:
 *   - same architecture (so the install recipe / image still runs),
 *   - no spec downgrade (>= vcpu, ram, disk),
 *   - cheapest first, then closest size.
 * Returns the substitute type + an available location, or null when nothing
 * safe is available (caller should then surface the real sold-out error). This
 * is deterministic and availability-driven — never a random type.
 */
export function pickAvailableSubstitute(requestedType: string): { type: string; location: string } | null {
  const req = describeServerType(requestedType);
  if (!req) return null;
  const candidates = getServerPlans()
    .filter(
      (p) =>
        p.type !== requestedType &&
        p.arch === req.arch &&
        p.vcpu >= req.vcpu &&
        p.ram >= req.ram &&
        p.disk >= req.disk
    )
    .map((p) => ({ p, locs: locationsForType(p.type) }))
    .filter((x) => x.locs.length > 0)
    .sort((a, b) => a.p.hetznerMonthly - b.p.hetznerMonthly || a.p.vcpu - b.p.vcpu);
  const best = candidates[0];
  return best ? { type: best.p.type, location: best.locs[0] } : null;
}

/**
 * Locations the user can target with `--location` on deploy. Each entry
 * carries the city/country/network_zone and the list of server-type names
 * currently deployable there.
 */
export function getLocations(): LocationInfo[] {
  maybeRefreshInBackground();
  return cache ? [...cache.locations.values()] : [];
}

export function isValidLocation(name: string): boolean {
  maybeRefreshInBackground();
  return !!cache && cache.locations.has(name);
}

/**
 * Where can this server type be deployed? Returns the set of location slugs.
 * Empty set when the type is unknown or no location data is loaded yet.
 */
export function locationsForType(typeName: string): string[] {
  maybeRefreshInBackground();
  const set = cache?.typeLocationAvailability.get(typeName);
  return set ? [...set].sort() : [];
}

/**
 * Pre-flight: does Hetzner currently deploy this type in this location?
 * Returns true if the type+location combo is in the live cache OR if we
 * have no location data at all (graceful degradation — let Hetzner be the
 * source of truth in fallback mode).
 */
export function isTypeAvailableInLocation(typeName: string, locationName: string): boolean {
  maybeRefreshInBackground();
  if (!cache || cache.locations.size === 0) return true; // no data → don't block
  const set = cache.typeLocationAvailability.get(typeName);
  return !!set && set.has(locationName);
}

/**
 * Does this location OFFER the type at all (Hetzner's `supported` list)?
 * supported && !available = temporarily sold out — a 409 "retry elsewhere /
 * later", not a 400 "wrong combo". Same graceful degradation as above.
 */
export function isTypeSupportedInLocation(typeName: string, locationName: string): boolean {
  maybeRefreshInBackground();
  if (!cache || cache.locations.size === 0) return true; // no data → don't block
  const set = cache.typeLocationSupported.get(typeName);
  return !!set && set.has(locationName);
}

/** True when the live location/availability maps are loaded (not the static fallback). */
export function hasLocationData(): boolean {
  return !!cache && cache.locations.size > 0;
}

/**
 * Deploy-grade freshness: the 6h background TTL is fine for browsing plans,
 * but a $6+ deploy decision should not ride on hours-old capacity data — a
 * type can sell out mid-window. Awaits a refresh when the cache is older
 * than `maxAgeMs`; on refresh failure the stale cache (or fallback) stands,
 * so this never blocks a deploy outright.
 */
export async function ensureFreshAvailability(maxAgeMs: number = 60_000): Promise<void> {
  if (cache && Date.now() - cache.refreshedAt <= maxAgeMs) return;
  try {
    await refreshHcloudTypes();
  } catch {
    // logged inside refreshHcloudTypes; stale data is better than no answer
  }
}
