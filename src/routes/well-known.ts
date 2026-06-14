/**
 * Discovery endpoints for x402scan, Coinbase Bazaar, and any other agent
 * indexer that crawls the x402 ecosystem.
 *
 * Two surfaces, both backed by the same paid-route registry from
 * `route-discovery.ts`:
 *
 *   GET /.well-known/x402   →  { version: 1, resources: ["https://host/path", ...] }
 *   GET /openapi.json       →  OpenAPI 3.1 doc with x-payment-info on each
 *                              paid operation, suitable for x402scan canonical
 *                              discovery
 *
 * Both routes must be mounted BEFORE the catch-all `/:agentId` wildcard in
 * `agent-health-report.ts` (which would otherwise swallow them).
 */

import type { Express, Request, Response } from "express";
import { createHash } from "crypto";
import { enumeratePaidRoutes } from "../services/route-discovery";

/**
 * Stamp the spec's `info.version` from the root package.json so crawlers can
 * tell two snapshots apart. Read once at module load, behind a try/catch — a
 * missing/garbled package.json must never make a discovery request throw. Falls
 * back to "0.0.0" so the field is always a valid semver-ish string.
 */
function readPackageVersion(): string {
  try {
    // require() resolves relative to this file (dist/routes or src/routes), so
    // ../../package.json points at the project root in both layouts.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json");
    const v = pkg && typeof pkg.version === "string" ? pkg.version : "";
    return v || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const PACKAGE_VERSION = readPackageVersion();

/**
 * Strong ETag over the JSON body the endpoint is about to return, so crawlers
 * can cache and revalidate (If-None-Match → 304) instead of re-fetching the
 * whole spec on every poll. Pure hash; cannot throw on well-formed JSON input.
 */
function etagFor(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

/**
 * Serialize `doc`, attach a content-derived ETag + a short Cache-Control, and
 * honor a matching If-None-Match with a 304. Used by both discovery endpoints.
 * `maxAgeSeconds` is intentionally short — the surface is cheap to regenerate
 * and we'd rather crawlers pick up route/price changes quickly.
 */
function sendCacheable(req: Request, res: Response, doc: unknown, maxAgeSeconds = 300): void {
  const body = JSON.stringify(doc);
  const etag = etagFor(body);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", `public, max-age=${maxAgeSeconds}`);
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.type("application/json").send(body);
}

interface WellKnownX402Doc {
  version: 1;
  resources: string[];
  openapi?: string;
  ownershipProofs?: string[];
}

/**
 * Essential FREE preflight routes, hand-curated. The paid-route walker only sees
 * 402-gated handlers, so the "check before you pay" steps an agent needs —
 * availability/pricing probes and free registration — exist only in prose
 * otherwise. We advertise a deliberately SHORT list here (price 0, mode "free")
 * so agents can discover them, while staying well under x402scan's >50-route
 * `L2_ROUTE_COUNT_HIGH` threshold. Keep this list tight and high-signal.
 *
 * Each entry is "<METHOD> <full path>" with a one-line description.
 */
const FREE_ROUTES: { route: string; description: string }[] = [
  { route: "GET /pricing", description: "Transparent pricing for every Palmyr service. Read this before paying." },
  { route: "GET /domains/check", description: "Check if a domain is available (query: ?domain=example.com). Free preflight before POST /domains/register." },
  { route: "GET /domains/pricing", description: "Per-TLD domain registration pricing. Free preflight before POST /domains/register." },
  { route: "GET /phone/numbers/search", description: "Search available phone numbers before provisioning one. Free preflight before POST /phone/numbers." },
  { route: "POST /agents/register", description: "Register an agent and receive an agent token. Free — wallet payments work without it, but a token is handy for identity." },
];

/**
 * Ownership proofs let x402scan / agentcash bind on-chain volume (including the
 * legacy agntos.dev / AgentOS history) to this origin. Each proof is a signature
 * of the bare origin string (e.g. "https://palmyr.ai") by a payTo treasury key —
 * EIP-191 personal_sign for the Base/EVM treasury (hex 0x...), Ed25519 for the
 * Solana treasury (base58). Generate them OFFLINE and set X402_OWNERSHIP_PROOFS
 * (comma-separated); the treasury keys never touch the server.
 */
function ownershipProofs(): string[] {
  return (process.env.X402_OWNERSHIP_PROOFS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

export function buildWellKnownDoc(app: Express, host: string): WellKnownX402Doc {
  const routes = enumeratePaidRoutes(app);
  // x402scan's canonical /.well-known/x402 lists absolute resource URLs.
  const seen = new Set<string>();
  const resources: string[] = [];
  for (const r of routes) {
    const url = `https://${host}${r.path}`;
    if (!seen.has(url)) {
      seen.add(url);
      resources.push(url);
    }
  }
  // Keep `resources` as the canonical bare-URL array (x402scan's format). Add a
  // sibling `openapi` link so a crawler can hop straight to the priced spec
  // (methods, prices, dynamic-vs-fixed) instead of re-deriving it from the URLs.
  const doc: WellKnownX402Doc = {
    version: 1,
    resources,
    openapi: `https://${host}/openapi.json`,
  };
  const proofs = ownershipProofs();
  if (proofs.length) doc.ownershipProofs = proofs;
  return doc;
}

/**
 * Build a minimal-but-correct OpenAPI 3.1 doc derived from the live route
 * registry. Each paid operation gets `x-payment-info` (with a fixed-price
 * block) and a `responses.402` entry so x402scan classifies it as paid.
 *
 * We deliberately keep this short and machine-driven — there's no point
 * hand-curating per-route schemas for ~70 routes when most of the value is
 * "this is paid, here's the price, hit it for the live 402 challenge."
 */
export function buildOpenApiDoc(app: Express, host: string): any {
  const routes = enumeratePaidRoutes(app);
  const paths: Record<string, any> = {};

  // Permissive default schema — declares "this op accepts/returns a JSON
  // object." Required by x402scan's discovery validator (raises
  // SCHEMA_INPUT_MISSING / SCHEMA_OUTPUT_MISSING errors when absent),
  // even though it doesn't actually constrain shape. Strict agents that
  // need the real shape can probe the live 402 challenge or read route
  // descriptions.
  const permissiveJsonSchema = { type: "object", additionalProperties: true };
  const jsonContent = { "application/json": { schema: permissiveJsonSchema } };
  const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  for (const r of routes) {
    // OpenAPI uses `{param}` for path params; Express uses `:param`. Convert.
    const oasPath = r.path.replace(/:([^/]+)/g, "{$1}");
    if (!paths[oasPath]) paths[oasPath] = {};

    // Extract path params from the Express path so we can declare them as
    // OpenAPI `parameters`. Without this, GET routes (which never have a
    // requestBody) trip L3_INPUT_SCHEMA_MISSING in the x402scan validator.
    const params: any[] = [];
    const paramMatches = r.path.match(/:([a-zA-Z0-9_]+)/g) || [];
    for (const raw of paramMatches) {
      const name = raw.slice(1);
      params.push({
        name,
        in: "path",
        required: true,
        description: `Path parameter: ${name}`,
        schema: { type: "string" },
      });
    }
    // Every paid op accepts the `X-Payment` header (x402 challenge response).
    // Declaring it explicitly gives every route a non-empty `parameters`
    // array, which is what the x402scan validator's `extractInputSchema`
    // requires for routes that lack a requestBody (e.g. plain GET listings).
    // This is honest — the header IS the way clients invoke any paid route.
    params.push({
      name: "X-Payment",
      in: "header",
      required: true,
      description: "x402 payment payload (Solana or EVM USDC). Get the challenge from the route's 402 response.",
      schema: { type: "string" },
    });

    const op: any = {
      summary: r.metadata?.description || `${r.method} ${r.path}`,
      description: r.metadata?.description,
      tags: r.metadata?.category ? [r.metadata.category] : undefined,
      parameters: params,
      // Dynamic-priced routes (e.g. /social/twitter/buy charges per country)
      // must NOT advertise a fixed amount — `priceUsdc` is a sentinel 0 here, so
      // a fixed block would tell agents to build a 0-USDC payment that the route
      // rejects. Advertise `mode:"dynamic"` and point them at the live 402.
      "x-payment-info": r.dynamicPrice
        ? {
            price: {
              mode: "dynamic",
              currency: "USD",
              hint: "Price depends on request parameters. Send the request with no payment to get a 402 challenge whose `accepts` entries carry the live amount, then pay that.",
            },
            protocols: [{ x402: {} }],
          }
        : {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: r.priceUsdc.toFixed(6).replace(/\.?0+$/, ""),
            },
            protocols: [{ x402: {} }],
          },
      // Bazaar extension on the OpenAPI op — x402scan's discovery validator
      // looks for input/output schemas at this exact path. Permissive object
      // shapes resolve SCHEMA_INPUT_MISSING / SCHEMA_OUTPUT_MISSING at
      // `extensions.bazaar.schema.properties.{input,output}`.
      extensions: {
        bazaar: {
          discoverable: true,
          ...(r.metadata?.category ? { category: r.metadata.category } : {}),
          ...(r.metadata?.tags && r.metadata.tags.length > 0 ? { tags: r.metadata.tags } : {}),
          schema: {
            properties: {
              input: permissiveJsonSchema,
              output: permissiveJsonSchema,
            },
          },
        },
      },
      responses: {
        "402": {
          description: "Payment Required",
          content: jsonContent,
        },
        "200": {
          description: "OK",
          content: jsonContent,
        },
      },
    };

    // Only mutating methods carry a request body in OpenAPI semantics. GET
    // routes pass parameters via path/query, so requestBody on them would
    // confuse downstream tooling.
    if (mutatingMethods.has(r.method)) {
      op.requestBody = {
        required: false,
        content: jsonContent,
      };
    }

    paths[oasPath][r.method.toLowerCase()] = op;
  }

  // Advertise the curated FREE preflight routes (price 0). The paid walker can't
  // see them — they're not 402-gated — so without this an agent never discovers
  // the "check before you pay" steps. Mark them `mode:"free"` and never attach a
  // 402 response so crawlers don't misclassify them as paid. Skip any whose
  // (method, path) a paid route already claimed, so we never overwrite a real
  // priced op with a free stub.
  for (const free of FREE_ROUTES) {
    const sp = free.route.indexOf(" ");
    const method = free.route.slice(0, sp).toUpperCase();
    const path = free.route.slice(sp + 1);
    const oasPath = path.replace(/:([^/]+)/g, "{$1}");
    if (!paths[oasPath]) paths[oasPath] = {};
    if (paths[oasPath][method.toLowerCase()]) continue; // don't clobber a paid op

    const params: any[] = [];
    const paramMatches = path.match(/:([a-zA-Z0-9_]+)/g) || [];
    for (const raw of paramMatches) {
      const name = raw.slice(1);
      params.push({
        name,
        in: "path",
        required: true,
        description: `Path parameter: ${name}`,
        schema: { type: "string" },
      });
    }

    const freeOp: any = {
      summary: free.description,
      description: free.description,
      tags: ["free"],
      ...(params.length ? { parameters: params } : {}),
      "x-payment-info": {
        price: { mode: "free", currency: "USD", amount: "0" },
      },
      extensions: {
        bazaar: {
          discoverable: true,
          category: "free",
          schema: {
            properties: {
              input: permissiveJsonSchema,
              output: permissiveJsonSchema,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "OK",
          content: jsonContent,
        },
      },
    };
    if (mutatingMethods.has(method)) {
      freeOp.requestBody = { required: false, content: jsonContent };
    }
    paths[oasPath][method.toLowerCase()] = freeOp;
  }

  const doc: any = {
    openapi: "3.1.0",
    info: {
      title: "Palmyr",
      description: "Autonomous infrastructure for AI agents — pay with USDC on Solana or Base via x402.",
      version: PACKAGE_VERSION,
      "x-guidance": [
        "Palmyr is a paid HTTP API that lets agents buy and operate their own infrastructure: phone numbers, email inboxes, custom domains, cloud servers, third-party API keys.",
        "Identity = wallet address. Pay with USDC; the wallet that pays becomes the owner of the resource.",
        "Every paid endpoint returns 402 with a valid x402 challenge. Use the `extra.facilitator` field on each accepts entry to route the settlement (CDP for EVM, self-hosted for Solana).",
        "Solana uses a server-paid fee-payer pattern — payers only need USDC, never SOL.",
        "Some routes price dynamically (x-payment-info.price.mode === 'dynamic', e.g. POST /social/twitter/buy) — never assume a fixed amount for these; send the request unpaid to get a 402 whose `accepts` carry the live price, then pay that.",
        "Check before you pay: free preflight routes (x-payment-info.price.mode === 'free') let you probe availability and price first — GET /pricing, GET /domains/check, GET /domains/pricing, GET /phone/numbers/search, plus free POST /agents/register. Other free helpers: GET /api, /health, /version.",
        "Async operations that aren't finished when they respond return a `poll_url` alongside `operation_id` and a `status` (and sometimes `poll_after_seconds`) — e.g. POST /compute/servers (server provisioning ~60s) and the /transfers endpoints. Treat any response carrying `poll_url` as in-progress: GET the poll_url until `status` is terminal (completed/failed; for servers, running).",
      ].join(" "),
    },
    servers: [{ url: `https://${host}` }],
    paths,
    components: {
      securitySchemes: {
        x402: {
          type: "apiKey",
          in: "header",
          name: "X-Payment",
          description: "x402 payment payload (Solana or EVM USDC). See the 402 challenge response on any paid endpoint.",
        },
      },
    },
  };

  // Bind on-chain volume to this origin. agentcash checks
  // `x-agentcash-provenance.ownershipProofs` first, then `x-discovery.ownershipProofs`.
  const proofs = ownershipProofs();
  if (proofs.length) {
    doc["x-discovery"] = { ownershipProofs: proofs };
    doc["x-agentcash-provenance"] = { ownershipProofs: proofs };
  }
  return doc;
}

export function mountDiscoveryRoutes(app: Express): void {
  app.get("/.well-known/x402", (req: Request, res: Response) => {
    const host = req.get("host") || "palmyr.ai";
    // ETag + short Cache-Control so indexers can poll cheaply and revalidate.
    sendCacheable(req, res, buildWellKnownDoc(app, host));
  });

  app.get("/openapi.json", (req: Request, res: Response) => {
    const host = req.get("host") || "palmyr.ai";
    sendCacheable(req, res, buildOpenApiDoc(app, host));
  });
}
