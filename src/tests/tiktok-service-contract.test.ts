import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import {
  buildTikTokOpenApi,
  buildTikTokWellKnown,
  createTikTokCompatibilityProxy,
  tiktokCanonicalAlias,
  tiktokHostIsolation,
} from "../middleware/tiktok-service";
import {
  TIKTOK_SERVICE_ROUTES,
  canonicalToLegacyPath,
  legacyToCanonicalPath,
} from "../services/tiktok-service-contract";

describe("TikTok service route contract", () => {
  it("maps every route in both directions without a catch-all", () => {
    assert.equal(legacyToCanonicalPath("POST", "/social/tiktok/post"), "/v1/post");
    assert.equal(canonicalToLegacyPath("GET", "/v1/operations/op%2Fsafe"), "/social/tiktok/operations/op%2Fsafe");
    assert.equal(legacyToCanonicalPath("POST", "/social/tiktok/corpus"), undefined);
    assert.equal(canonicalToLegacyPath("DELETE", "/v1/post"), undefined);
    assert.equal(TIKTOK_SERVICE_ROUTES.length, 17);
  });

  it("publishes only TikTok /v1 routes in discovery", () => {
    const openapi = buildTikTokOpenApi() as any;
    const wellKnown = buildTikTokWellKnown() as any;
    assert.ok(openapi.paths["/v1/post"].post);
    assert.equal(openapi.paths["/v1/post"].post["x-payment-info"].price.amount, "0.01");
    assert.ok(!openapi.paths["/social/tiktok/post"]);
    assert.ok(wellKnown.resources.includes("https://tiktok.palmyr.ai/v1/post"));
    assert.ok(!wellKnown.resources.includes("https://tiktok.palmyr.ai/v1/niches"));
  });
});

describe("TikTok canonical alias", () => {
  it("runs the existing handler and returns canonical poll URLs", async () => {
    const previousHost = process.env.TIKTOK_SERVICE_HOST;
    process.env.TIKTOK_SERVICE_HOST = "127.0.0.1";
    const app = express();
    app.use(tiktokCanonicalAlias);
    app.post("/social/tiktok/post", (req, res) => {
      res.json({ original_url: req.originalUrl, poll_url: "/social/tiktok/operations/op_1" });
    });
    const listener = app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = (listener.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/post`, {
        method: "POST",
        headers: { host: "tiktok.palmyr.ai" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        original_url: "/v1/post",
        poll_url: "/v1/operations/op_1",
      });
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      if (previousHost === undefined) delete process.env.TIKTOK_SERVICE_HOST;
      else process.env.TIKTOK_SERVICE_HOST = previousHost;
    }
  });

  it("isolates the TikTok hostname from unrelated Palmyr routes", async () => {
    const previousHost = process.env.TIKTOK_SERVICE_HOST;
    process.env.TIKTOK_SERVICE_HOST = "127.0.0.1";
    const app = express();
    app.use(tiktokCanonicalAlias);
    app.use(tiktokHostIsolation);
    app.get("/social/tiktok/niches", (_req, res) => res.json({ niches: [] }));
    app.get("/connect/:token", (_req, res) => res.send("qr"));
    app.get("/phone", (_req, res) => res.json({ leaked: true }));
    const listener = app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = (listener.address() as AddressInfo).port;
    try {
      const api = await fetch(`http://127.0.0.1:${port}/v1/niches`);
      assert.equal(api.status, 200);
      const qr = await fetch(`http://127.0.0.1:${port}/connect/token_1`);
      assert.equal(qr.status, 200);
      const unrelated = await fetch(`http://127.0.0.1:${port}/phone`);
      assert.equal(unrelated.status, 404);
      assert.equal((await unrelated.json() as any).message, "This route is not part of the TikTok Automation API.");
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      if (previousHost === undefined) delete process.env.TIKTOK_SERVICE_HOST;
      else process.env.TIKTOK_SERVICE_HOST = previousHost;
    }
  });
});

describe("Palmyr TikTok compatibility proxy", () => {
  let upstream: ReturnType<express.Express["listen"]>;
  let gateway: ReturnType<express.Express["listen"]>;
  let upstreamOrigin: string;
  let gatewayOrigin: string;
  let localFallbackCalls = 0;
  const seenHeaders: Record<string, string | undefined>[] = [];

  before(async () => {
    const service = express();
    service.use(express.json());
    service.post("/v1/post", (req, res) => {
      seenHeaders.push({
        xPayment: req.get("x-payment") || undefined,
        paymentSignature: req.get("payment-signature") || undefined,
      });
      if (!req.get("x-payment") && !req.get("payment-signature")) {
        res.status(402).set("payment-required", "challenge-header").json({
          error: "Payment Required",
          resource: { url: `${upstreamOrigin}/v1/post` },
          accepts: [{ network: "eip155:8453", amount: "10000" }],
        });
        return;
      }
      res.status(202).set("payment-response", "receipt-header").json({
        operation_id: "op_1",
        poll_url: "/v1/operations/op_1",
      });
    });
    upstream = service.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const app = express();
    app.use(express.json({ verify: (req: any, _res, buffer) => { req.rawBody = buffer; } }));
    app.use(createTikTokCompatibilityProxy({ origin: upstreamOrigin }));
    app.post("/social/tiktok/post", (_req, res) => {
      localFallbackCalls += 1;
      res.status(500).json({ error: "local fallback must not run" });
    });
    gateway = app.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    gatewayOrigin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });

  after(async () => {
    await Promise.all([
      new Promise<void>((resolve) => upstream.close(() => resolve())),
      new Promise<void>((resolve) => gateway.close(() => resolve())),
    ]);
  });

  it("passes the canonical x402 challenge through without charging locally", async () => {
    const response = await fetch(`${gatewayOrigin}/social/tiktok/post`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: "brand", caption: "launch" }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 402);
    assert.equal(response.headers.get("payment-required"), "challenge-header");
    assert.equal(body.resource.url, `${upstreamOrigin}/v1/post`);
    assert.equal(localFallbackCalls, 0);
  });

  it("forwards both payment header names, receipts, and legacy poll URLs", async () => {
    const first = await fetch(`${gatewayOrigin}/social/tiktok/post`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": "paid-x" },
      body: "{}",
    });
    assert.equal(first.status, 202);
    assert.equal(first.headers.get("payment-response"), "receipt-header");
    assert.equal((await first.json() as any).poll_url, "/social/tiktok/operations/op_1");

    const second = await fetch(`${gatewayOrigin}/social/tiktok/post`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": "paid-v2" },
      body: "{}",
    });
    assert.equal(second.status, 202);
    assert.equal(seenHeaders.at(-2)?.xPayment, "paid-x");
    assert.equal(seenHeaders.at(-1)?.paymentSignature, "paid-v2");
    assert.equal(localFallbackCalls, 0);
  });

  it("does not let a caller-supplied proxy marker bypass the canonical service", async () => {
    const response = await fetch(`${gatewayOrigin}/social/tiktok/post`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-palmyr-tiktok-proxy": "1",
      },
      body: "{}",
    });
    assert.equal(response.status, 402);
    assert.equal(localFallbackCalls, 0);
  });
});
