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

  for (const r of routes) {
    // OpenAPI uses `{param}` for path params; Express uses `:param`. Convert.
    const oasPath = r.path.replace(/:([^/]+)/g, "{$1}");
    if (!paths[oasPath]) paths[oasPath] = {};

    paths[oasPath][r.method.toLowerCase()] = {
      summary: r.metadata?.description || `${r.method} ${r.path}`,
      description: r.metadata?.description,
      tags: r.metadata?.category ? [r.metadata.category] : undefined,
      "x-payment-info": {
        price: {
          mode: "fixed",
          currency: "USD",
          amount: r.priceUsdc.toFixed(6).replace(/\.?0+$/, ""),
        },
        protocols: [{ x402: {} }],
      },
      responses: {
        "402": { description: "Payment Required" },
        "200": { description: "OK" },
      },
    };
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
