export type TikTokServiceRoute = {
  method: "GET" | "POST";
  canonicalPath: string;
  legacyPath: string;
  priceUsdc: number | "dynamic";
  description: string;
};

/**
 * The public TikTok API contract. Keep this list explicit: adding a TikTok
 * route to Palmyr must be a deliberate compatibility decision, never an open
 * catch-all proxy into an independently deployed service.
 */
export const TIKTOK_SERVICE_ROUTES: readonly TikTokServiceRoute[] = [
  { method: "POST", canonicalPath: "/v1/connect", legacyPath: "/social/tiktok/connect", priceUsdc: 0.01, description: "Start a secure TikTok QR login." },
  { method: "GET", canonicalPath: "/v1/connect/:token", legacyPath: "/social/tiktok/connect/:token", priceUsdc: 0, description: "Poll a TikTok QR login." },
  { method: "GET", canonicalPath: "/v1/accounts", legacyPath: "/social/tiktok/accounts", priceUsdc: 0.001, description: "List connected TikTok accounts and session health." },
  { method: "POST", canonicalPath: "/v1/post", legacyPath: "/social/tiktok/post", priceUsdc: 0.01, description: "Post or schedule a TikTok video." },
  { method: "GET", canonicalPath: "/v1/operations/:id", legacyPath: "/social/tiktok/operations/:id", priceUsdc: 0, description: "Poll an asynchronous TikTok operation." },
  { method: "POST", canonicalPath: "/v1/follow", legacyPath: "/social/tiktok/follow", priceUsdc: 0.001, description: "Follow a TikTok user." },
  { method: "POST", canonicalPath: "/v1/like", legacyPath: "/social/tiktok/like", priceUsdc: 0.001, description: "Like a TikTok video." },
  { method: "POST", canonicalPath: "/v1/delete", legacyPath: "/social/tiktok/delete", priceUsdc: 0.001, description: "Delete a TikTok video." },
  { method: "POST", canonicalPath: "/v1/profile", legacyPath: "/social/tiktok/profile", priceUsdc: 0.001, description: "Update a TikTok profile." },
  { method: "POST", canonicalPath: "/v1/avatar", legacyPath: "/social/tiktok/avatar", priceUsdc: 0.005, description: "Update a TikTok avatar." },
  { method: "POST", canonicalPath: "/v1/analytics", legacyPath: "/social/tiktok/analytics", priceUsdc: 0.005, description: "Collect TikTok post analytics." },
  { method: "GET", canonicalPath: "/v1/series", legacyPath: "/social/tiktok/series", priceUsdc: 0.001, description: "Read saved TikTok performance history." },
  { method: "GET", canonicalPath: "/v1/hooks", legacyPath: "/social/tiktok/hooks", priceUsdc: "dynamic", description: "Analyze TikTok hooks for an account, tag, or niche." },
  { method: "GET", canonicalPath: "/v1/niches", legacyPath: "/social/tiktok/niches", priceUsdc: 0, description: "List hook-analysis niches." },
  { method: "GET", canonicalPath: "/v1/scheduled", legacyPath: "/social/tiktok/scheduled", priceUsdc: 0.001, description: "List scheduled TikTok posts." },
  { method: "POST", canonicalPath: "/v1/scheduled/:id/cancel", legacyPath: "/social/tiktok/scheduled/:id/cancel", priceUsdc: 0.001, description: "Cancel a scheduled TikTok post." },
  { method: "GET", canonicalPath: "/v1/health", legacyPath: "/social/tiktok/health", priceUsdc: 0, description: "Read aggregate TikTok service health." },
] as const;

type Match = { route: TikTokServiceRoute; params: string[] };

function matchPath(pattern: string, actual: string): string[] | undefined {
  const expected = pattern.split("/").filter(Boolean);
  const received = actual.split("/").filter(Boolean);
  if (expected.length !== received.length) return undefined;

  const params: string[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].startsWith(":")) params.push(received[index]);
    else if (expected[index] !== received[index]) return undefined;
  }
  return params;
}

function findRoute(method: string, path: string, side: "canonicalPath" | "legacyPath"): Match | undefined {
  for (const route of TIKTOK_SERVICE_ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const params = matchPath(route[side], path);
    if (params) return { route, params };
  }
  return undefined;
}

function fillPath(pattern: string, params: string[]): string {
  let index = 0;
  return pattern
    .split("/")
    .map((segment) => segment.startsWith(":") ? params[index++] : segment)
    .join("/");
}

export function canonicalToLegacyPath(method: string, path: string): string | undefined {
  const match = findRoute(method, path, "canonicalPath");
  return match ? fillPath(match.route.legacyPath, match.params) : undefined;
}

export function legacyToCanonicalPath(method: string, path: string): string | undefined {
  const match = findRoute(method, path, "legacyPath");
  return match ? fillPath(match.route.canonicalPath, match.params) : undefined;
}

export function rewritePollUrls(value: unknown, direction: "canonical" | "legacy"): unknown {
  if (Array.isArray(value)) return value.map((item) => rewritePollUrls(item, direction));
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "poll_url" && typeof child === "string") {
      result[key] = direction === "canonical"
        ? child.replace(/^\/social\/tiktok(?=\/|$)/, "/v1")
        : child.replace(/^\/v1(?=\/|$)/, "/social/tiktok");
    } else {
      result[key] = rewritePollUrls(child, direction);
    }
  }
  return result;
}
