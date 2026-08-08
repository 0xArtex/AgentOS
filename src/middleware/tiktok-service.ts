import type { Express, NextFunction, Request, Response } from "express";
import {
  TIKTOK_SERVICE_ROUTES,
  canonicalToLegacyPath,
  legacyToCanonicalPath,
  rewritePollUrls,
} from "../services/tiktok-service-contract";

const DEFAULT_HOST = "tiktok.palmyr.ai";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requestHost(req: Request): string {
  return (req.get("host") || "").split(":")[0].toLowerCase();
}

function requestAuthority(req: Request): string {
  return (req.get("host") || "").toLowerCase();
}

export function isTikTokServiceRequest(req: Request): boolean {
  return requestHost(req) === (process.env.TIKTOK_SERVICE_HOST || DEFAULT_HOST).toLowerCase();
}

function replaceJson(res: Response, direction: "canonical" | "legacy"): void {
  const original = res.json.bind(res);
  res.json = ((body: unknown) => original(rewritePollUrls(body, direction))) as typeof res.json;
}

/** Rewrite the public /v1 contract into the existing TikTok runtime in-place. */
export function tiktokCanonicalAlias(req: Request, res: Response, next: NextFunction): void {
  if (!isTikTokServiceRequest(req)) {
    next();
    return;
  }
  const legacyPath = canonicalToLegacyPath(req.method, req.path);
  if (!legacyPath) {
    next();
    return;
  }
  const queryIndex = req.url.indexOf("?");
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
  req.url = legacyPath + query;
  replaceJson(res, "canonical");
  next();
}

function forwardedHeaders(req: Request): Headers {
  const result = new Headers();
  for (const [name, rawValue] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    result.set(name, value);
  }
  result.set("x-palmyr-tiktok-proxy", "1");
  result.set("x-forwarded-host", req.get("host") || "palmyr.ai");
  return result;
}

function forwardResponseHeaders(upstream: globalThis.Response, res: Response): void {
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
  });
}

function requestBody(req: Request): Buffer | undefined {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  if (req.body === undefined) return undefined;
  return Buffer.from(JSON.stringify(req.body));
}

export type TikTokProxyOptions = {
  origin?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Preserve Palmyr's /social/tiktok surface while the canonical service owns
 * payment and execution. A missing origin intentionally falls through to the
 * local handlers, which makes rollout and rollback deterministic.
 */
export function createTikTokCompatibilityProxy(options: TikTokProxyOptions = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const originValue = options.origin || process.env.TIKTOK_SERVICE_ORIGIN || "";
    if (!originValue || isTikTokServiceRequest(req)) {
      next();
      return;
    }

    let origin: URL;
    try {
      origin = new URL(originValue);
      if (origin.protocol !== "https:" && origin.protocol !== "http:") throw new Error("unsupported protocol");
    } catch {
      res.status(503).json({ error: "TikTok service is misconfigured" });
      return;
    }
    if (requestAuthority(req) === origin.host.toLowerCase()) {
      next();
      return;
    }

    const canonicalPath = legacyToCanonicalPath(req.method, req.path);
    if (!canonicalPath) {
      next();
      return;
    }

    const queryIndex = req.originalUrl.indexOf("?");
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
    const target = new URL(canonicalPath + query, origin);

    try {
      const timeoutSignal = (req as Request & { timeoutSignal?: AbortSignal }).timeoutSignal;
      const upstream = await fetchImpl(target, {
        method: req.method,
        headers: forwardedHeaders(req),
        body: requestBody(req),
        redirect: "manual",
        signal: timeoutSignal,
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      forwardResponseHeaders(upstream, res);
      res.status(upstream.status);

      const contentType = upstream.headers.get("content-type") || "";
      if (contentType.includes("application/json") && bytes.length > 0) {
        try {
          const json = rewritePollUrls(JSON.parse(bytes.toString("utf8")), "legacy");
          res.json(json);
          return;
        } catch {
          // Preserve a malformed upstream body exactly; the gateway must not
          // turn a service error into a different error shape.
        }
      }
      res.send(bytes);
    } catch (error) {
      const timeoutSignal = (req as Request & { timeoutSignal?: AbortSignal }).timeoutSignal;
      if (timeoutSignal?.aborted || res.headersSent) return;
      res.status(502).json({
        error: "TikTok service unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

function openApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

export function buildTikTokOpenApi(host = DEFAULT_HOST): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of TIKTOK_SERVICE_ROUTES) {
    const path = openApiPath(route.canonicalPath);
    if (!paths[path]) paths[path] = {};
    const paid = route.priceUsdc !== 0;
    const parameters = [...route.canonicalPath.matchAll(/:([^/]+)/g)].map((match) => ({
      name: match[1], in: "path", required: true, schema: { type: "string" },
    }));
    if (paid) parameters.push({
      name: "X-Payment", in: "header", required: true, schema: { type: "string" },
    });
    paths[path][route.method.toLowerCase()] = {
      summary: route.description,
      tags: ["tiktok"],
      ...(parameters.length ? { parameters } : {}),
      ...(route.method === "POST" ? {
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      } : {}),
      "x-payment-info": route.priceUsdc === "dynamic"
        ? { price: { mode: "dynamic", currency: "USD", hint: "Send the request unpaid to receive the exact x402 challenge." }, protocols: [{ x402: {} }] }
        : { price: { mode: paid ? "fixed" : "free", currency: "USD", amount: String(route.priceUsdc) }, ...(paid ? { protocols: [{ x402: {} }] } : {}) },
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        ...(paid ? { "402": { description: "Payment Required" } } : {}),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "TikTok Automation API",
      version: "1.0.0",
      description: "Connect, post, schedule, manage, and analyze TikTok accounts. Paid actions use x402; no API key or subscription is required.",
    },
    servers: [{ url: `https://${host}` }],
    paths,
    components: { securitySchemes: { x402: { type: "apiKey", in: "header", name: "X-Payment" } } },
  };
}

export function buildTikTokWellKnown(host = DEFAULT_HOST): Record<string, unknown> {
  return {
    version: 1,
    resources: TIKTOK_SERVICE_ROUTES
      .filter((route) => route.priceUsdc !== 0)
      .map((route) => `https://${host}${route.canonicalPath}`),
    openapi: `https://${host}/openapi.json`,
  };
}

/** TikTok-only discovery pages take precedence on the TikTok service host. */
export function mountTikTokServiceDiscovery(app: Express): void {
  const onlyTikTok = (handler: (req: Request, res: Response) => void) =>
    (req: Request, res: Response, next: NextFunction) => isTikTokServiceRequest(req) ? handler(req, res) : next();

  app.get("/", onlyTikTok((_req, res) => {
    res.type("text/plain").send("TikTok Automation API\n\nOpenAPI: /openapi.json\nAgent skill: /skill.md\nMCP: https://github.com/0xArtex/tiktok-mcp\n");
  }));
  app.get("/api", onlyTikTok((req, res) => {
    const host = req.get("host") || DEFAULT_HOST;
    res.json({
      service: "TikTok Automation API",
      version: "v1",
      origin: `https://${host}`,
      discovery: {
        openapi: `https://${host}/openapi.json`,
        x402: `https://${host}/.well-known/x402`,
        skill: `https://${host}/skill.md`,
        mcp: "https://github.com/0xArtex/tiktok-mcp",
      },
    });
  }));
  app.get("/.well-known/x402", onlyTikTok((req, res) => {
    res.json(buildTikTokWellKnown(req.get("host") || DEFAULT_HOST));
  }));
  app.get("/openapi.json", onlyTikTok((req, res) => {
    res.json(buildTikTokOpenApi(req.get("host") || DEFAULT_HOST));
  }));
  app.get("/skill.md", onlyTikTok((_req, res) => {
    const fs = require("fs");
    const path = require("path");
    const skillPath = path.join(__dirname, "..", "..", "skills", "tiktok", "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      res.status(404).type("text/markdown").send("# TikTok skill not found");
      return;
    }
    res.type("text/markdown").send(fs.readFileSync(skillPath, "utf8"));
  }));
}
