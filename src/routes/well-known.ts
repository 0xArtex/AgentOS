/**
 * Discovery endpoints for x402scan, Coinbase Bazaar, and any other agent
 * indexer that crawls the x402 ecosystem.
 *
 * Two surfaces, both backed by the same paid-route registry from
 * `route-discovery.ts`:
 *
 *   GET /.well-known/x402   →  { version: 1, resources: ["METHOD /path", ...] }
 *   GET /openapi.json       →  OpenAPI 3.1 doc with x-payment-info on each
 *                              paid operation, suitable for x402scan canonical
 *                              discovery
 *
 * Both routes must be mounted BEFORE the catch-all `/:agentId` wildcard in
 * `agent-health-report.ts` (which would otherwise swallow them).
 */

import type { Express, Request, Response } from "express";
import { enumeratePaidRoutes } from "../services/route-discovery";

interface WellKnownX402Doc {
  version: 1;
  resources: string[];
}

export function buildWellKnownDoc(app: Express): WellKnownX402Doc {
  const routes = enumeratePaidRoutes(app);
  return {
    version: 1,
    resources: routes.map(r => `${r.method} ${r.path}`),
  };
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
      "x-payment-info": {
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

  return {
    openapi: "3.1.0",
    info: {
      title: "AgentOS",
      description: "Autonomous infrastructure for AI agents — pay with USDC on Solana or Base via x402.",
      version: "1.0.0",
      "x-guidance": [
        "AgentOS is a paid HTTP API that lets agents buy and operate their own infrastructure: phone numbers, email inboxes, custom domains, cloud servers, third-party API keys.",
        "Identity = wallet address. Pay with USDC; the wallet that pays becomes the owner of the resource.",
        "Every paid endpoint returns 402 with a valid x402 challenge. Use the `extra.facilitator` field on each accepts entry to route the settlement (CDP for EVM, self-hosted for Solana).",
        "Solana uses a server-paid fee-payer pattern — payers only need USDC, never SOL.",
        "Free helper endpoints: GET /api, /health, /version, /pricing.",
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
}

export function mountDiscoveryRoutes(app: Express): void {
  app.get("/.well-known/x402", (_req: Request, res: Response) => {
    res.json(buildWellKnownDoc(app));
  });

  app.get("/openapi.json", (req: Request, res: Response) => {
    const host = req.get("host") || "agntos.dev";
    res.json(buildOpenApiDoc(app, host));
  });
}
