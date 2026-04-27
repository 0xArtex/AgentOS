/**
 * Hetzner Cloud server-type catalog. Fetched live at boot from
 * GET /v1/server_types so we never hardcode types that get deprecated.
 *
 * - `refreshHcloudTypes()` — pull the live list, filter to non-deprecated
 *   shared types, compute USDC pricing from EUR monthly rates.
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

let cache: { plans: ServerPlan[]; refreshedAt: number } | null = null;
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

export async function refreshHcloudTypes(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const token = process.env.HCLOUD_TOKEN;
      if (!token) {
        console.warn("[hcloud-types] HCLOUD_TOKEN not set — using static fallback");
        cache = { plans: STATIC_FALLBACK, refreshedAt: Date.now() };
        return;
      }

      const types = await fetchAllServerTypes(token);
      const plans: ServerPlan[] = [];
      for (const t of types) {
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

      cache = { plans, refreshedAt: Date.now() };
      console.log(`[hcloud-types] Loaded ${plans.length} active shared server types from Hetzner`);
    } catch (err: any) {
      console.error("[hcloud-types] Refresh failed:", err?.message || err);
      // Keep existing cache if any; otherwise fall back.
      if (!cache) cache = { plans: STATIC_FALLBACK, refreshedAt: Date.now() };
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
