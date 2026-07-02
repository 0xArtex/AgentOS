#!/usr/bin/env node
/**
 * bazaar-verify.mjs — check whether Palmyr's paid endpoints are listed in the
 * Coinbase x402 Bazaar (which also feeds Agentic.Market).
 *
 * The Bazaar catalogs a resource once a payment for it settles through the CDP
 * facilitator (https://api.cdp.coinbase.com/platform/v2/x402). This script hits
 * the PUBLIC discovery endpoint (no auth), paginates the full catalog, and
 * filters resources whose URL contains a host you pass on argv.
 *
 *   node scripts/bazaar-verify.mjs            # defaults to host "palmyr.ai"
 *   node scripts/bazaar-verify.mjs palmyr.ai
 *   node scripts/bazaar-verify.mjs api.palmyr.ai
 *   npm run bazaar:verify -- palmyr.ai
 *
 * Exit codes: 0 = ran cleanly (0 or more matches), 1 = network/HTTP failure.
 *
 * No dependencies — plain Node (global fetch, Node 18+).
 */

const DISCOVERY_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE_LIMIT = 1000;
const MAX_PAGES = 100; // hard stop so a misbehaving cursor can't loop forever

const hostFilter = (process.argv[2] || "palmyr.ai").toLowerCase();

/**
 * Pull one page from the discovery API. Returns the parsed JSON or throws with
 * a readable message on any non-200.
 */
async function fetchPage(offset) {
  const url = `${DISCOVERY_URL}?type=http&limit=${PAGE_LIMIT}&offset=${offset}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`network error fetching ${url}: ${e?.message || e}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}${detail ? ` — ${detail}` : ""}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`invalid JSON from ${url}: ${e?.message || e}`);
  }
}

/**
 * The discovery API has shipped a few envelope shapes over time. Normalize:
 * accept `items`, `resources`, or a bare array, and read the resource URL from
 * whichever of the common field names is present.
 */
function extractItems(page) {
  if (Array.isArray(page)) return page;
  if (Array.isArray(page?.items)) return page.items;
  if (Array.isArray(page?.resources)) return page.resources;
  if (Array.isArray(page?.data)) return page.data;
  return [];
}

function resourceUrl(item) {
  return (
    item?.resource ||
    item?.url ||
    item?.resourceUrl ||
    item?.resource?.url ||
    ""
  );
}

function networksOf(item) {
  const accepts = item?.accepts || item?.paymentRequirements?.accepts || [];
  if (!Array.isArray(accepts)) return [];
  const nets = accepts
    .map((a) => a?.network)
    .filter((n) => typeof n === "string" && n.length > 0);
  return [...new Set(nets)];
}

async function main() {
  console.log(`Querying x402 Bazaar for resources on host "${hostFilter}"…`);
  console.log(`  ${DISCOVERY_URL}\n`);

  const matches = [];
  let totalSeen = 0;
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    let json;
    try {
      json = await fetchPage(offset);
    } catch (e) {
      console.error(`\nFailed to reach the Bazaar discovery API: ${e.message}`);
      process.exit(1);
    }
    const items = extractItems(json);
    if (items.length === 0) break;
    totalSeen += items.length;

    for (const item of items) {
      const url = String(resourceUrl(item) || "");
      let host = "";
      try {
        host = new URL(url).host.toLowerCase();
      } catch {
        host = url.toLowerCase();
      }
      if (host.includes(hostFilter) || url.toLowerCase().includes(hostFilter)) {
        matches.push({
          url,
          x402Version: item?.x402Version ?? item?.type ?? "?",
          networks: networksOf(item).join(", ") || "—",
          lastUpdated: item?.lastUpdated || item?.updatedAt || item?.updated || "—",
        });
      }
    }

    // Stop when the API returns fewer than a full page (last page reached).
    if (items.length < PAGE_LIMIT) break;
    offset += items.length;
  }

  console.log(`Scanned ${totalSeen} catalog resource(s) total.\n`);

  if (matches.length === 0) {
    console.log(`0 Palmyr resources listed (no catalog resource matched host "${hostFilter}").`);
    console.log(
      "If you expected listings: confirm CDP_API_KEY_ID/CDP_API_KEY_SECRET are set on\n" +
        "prod and that at least one Base (eip155:8453) payment has SETTLED through CDP —\n" +
        "Solana-rail payments do not trigger cataloging, and listings expire after 30\n" +
        "days without a settled payment.",
    );
    return;
  }

  console.log(`${matches.length} Palmyr resource(s) listed:\n`);
  const rows = matches.map((m) => ({
    "Resource URL": m.url,
    "x402": String(m.x402Version),
    "Networks": m.networks,
    "Last Updated": m.lastUpdated,
  }));
  // console.table gives a clean aligned table without pulling in a dep.
  console.table(rows);
}

main().catch((e) => {
  console.error("Unexpected error:", e?.message || e);
  process.exit(1);
});
