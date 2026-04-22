/**
 * Tests for i402 federation (Agentic Market + external provider handlers).
 *
 * Covers:
 *  - MockCatalogAdapter end-to-end ingest: fetched providers appear in i402_providers
 *    with source='agentic_market' and the configured reputation seed.
 *  - Unknown capability classes are skipped, counted, and do not crash the ingest.
 *  - Duplicate ingestion is idempotent (INSERT OR IGNORE — metrics preserved).
 *  - defaultAgenticMarketParser correctly maps a reasonable { services: [...] } shape.
 *  - pruneDisappeared disables providers no longer in the catalog.
 *  - externalHttpHandler factory: api_key auth; input/output transformers; retries on 5xx;
 *    passes timeouts; surfaces HTTP errors with status codes.
 *  - Scoring integration: when AM providers are registered alongside first-party ones,
 *    scoreProviders picks correctly per quality tier.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.I402_ORCHESTRATION_FEE_PCT = "0.15";
process.env.I402_SESSION_IDLE_TIMEOUT_HOURS = "24";
process.env.I402_SESSION_MAX_BUDGET_USDC = "1000";
process.env.AGENTOS_API_BASE = "https://staging.agntos.dev";

import { db, initDatabase } from "../db";
import {
  seedAgentOSPrimitives,
  listProviders,
  scoreProviders,
  setProviderEnabled,
  getProvider,
} from "../services/i402-providers";
import {
  MockCatalogAdapter,
  ingestCatalog,
  pruneDisappeared,
  defaultAgenticMarketParser,
  type FederatedProviderSpec,
} from "../services/i402-agentic-market";
import { externalHttpHandler } from "../services/i402-external-handlers";
import type { StepExecutionContext } from "../services/i402-executor";

// -------------------- Setup --------------------

initDatabase();
seedAgentOSPrimitives();

function clearFederatedProviders(): void {
  db.prepare(`DELETE FROM i402_providers WHERE source IN ('agentic_market','clawhub')`).run();
}

// -------------------- MockCatalogAdapter ingest --------------------

describe("ingestCatalog — MockCatalogAdapter happy path", () => {
  before(clearFederatedProviders);

  it("registers all valid providers and skips unknown capabilities", async () => {
    const specs: FederatedProviderSpec[] = [
      {
        id: "am.foo.web_search",
        capability: "web_search",
        name: "AM foo search",
        endpoint: "https://foo.am.coinbase.com/search",
        authScheme: "x402-base",
        costPerCallUsdc: 0.08,
        p50LatencyMs: 2500,
        reputationSeed: 0.72,
      },
      {
        id: "am.bar.image_gen",
        capability: "image_gen",
        name: "AM bar image gen",
        endpoint: "https://bar.am.coinbase.com/image",
        authScheme: "x402-base",
        costPerCallUsdc: 0.40,
      },
      {
        id: "am.bogus.thing",
        capability: "not_a_real_capability",
        name: "bogus",
        endpoint: "https://bogus",
        authScheme: "x402-base",
        costPerCallUsdc: 0.10,
      },
    ];
    const adapter = new MockCatalogAdapter("agentic_market", "Test AM", specs);
    const result = await ingestCatalog(adapter);

    assert.equal(result.fetched, 3);
    assert.equal(result.registered, 2);
    assert.equal(result.skipped_unknown_capability, 1);
    assert.equal(result.errors.length, 0);

    const provs = listProviders({ source: "agentic_market" });
    assert.equal(provs.length, 2);
    const ws = provs.find(p => p.id === "am.foo.web_search");
    assert.ok(ws);
    assert.equal(ws!.reputationScore, 0.72);
    assert.equal(ws!.capability, "web_search");

    const img = provs.find(p => p.id === "am.bar.image_gen");
    assert.ok(img);
    assert.equal(img!.reputationScore, 0.6); // default seed when adapter didn't provide one
  });
});

describe("ingestCatalog — idempotent on duplicate ingestion", () => {
  before(clearFederatedProviders);

  it("does not duplicate existing providers; preserves their metrics", async () => {
    const specs: FederatedProviderSpec[] = [
      {
        id: "am.dup.search",
        capability: "web_search",
        name: "Dup",
        endpoint: "https://dup",
        authScheme: "x402-base",
        costPerCallUsdc: 0.10,
      },
    ];
    const adapter = new MockCatalogAdapter("agentic_market", "Test AM", specs);

    const first = await ingestCatalog(adapter);
    assert.equal(first.registered, 1);

    // Simulate metrics accumulating
    db.prepare(`UPDATE i402_providers SET success_rate = 0.42 WHERE id = ?`).run("am.dup.search");

    const second = await ingestCatalog(adapter);
    // INSERT OR IGNORE means no new row, but the function still counts the attempt
    assert.equal(second.registered, 1);

    const p = getProvider("am.dup.search");
    assert.ok(p);
    assert.equal(p!.successRate, 0.42); // preserved
  });
});

describe("defaultAgenticMarketParser", () => {
  it("parses { services: [...] } with cost_usdc_per_call", () => {
    const raw = {
      services: [
        {
          id: "am.x.y",
          capability: "web_search",
          name: "X",
          endpoint: "https://x",
          auth_scheme: "x402-base",
          cost_usdc_per_call: 0.12,
          p50_latency_ms: 1800,
        },
      ],
    };
    const parsed = defaultAgenticMarketParser(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, "am.x.y");
    assert.equal(parsed[0].costPerCallUsdc, 0.12);
    assert.equal(parsed[0].p50LatencyMs, 1800);
    assert.equal(parsed[0].authScheme, "x402-base");
  });

  it("parses { providers: [...] } with cost_usdc alternate field", () => {
    const raw = {
      providers: [
        {
          id: "am.alt",
          capability: "image_gen",
          name: "Alt",
          endpoint: "https://alt",
          auth: "x402-svm",
          cost_usdc: 0.50,
        },
      ],
    };
    const parsed = defaultAgenticMarketParser(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].authScheme, "x402-solana"); // x402-svm alias
  });

  it("silently drops malformed entries", () => {
    const raw = { services: [{ id: "missing-capability", name: "x" }] };
    const parsed = defaultAgenticMarketParser(raw);
    assert.equal(parsed.length, 0);
  });
});

describe("pruneDisappeared", () => {
  before(clearFederatedProviders);

  it("disables providers no longer in the catalog, leaves current ones alone", async () => {
    const initialSpecs: FederatedProviderSpec[] = [
      {
        id: "am.still-here",
        capability: "web_search",
        name: "A",
        endpoint: "https://a",
        authScheme: "x402-base",
        costPerCallUsdc: 0.10,
      },
      {
        id: "am.will-vanish",
        capability: "web_search",
        name: "B",
        endpoint: "https://b",
        authScheme: "x402-base",
        costPerCallUsdc: 0.10,
      },
    ];
    await ingestCatalog(new MockCatalogAdapter("agentic_market", "Test", initialSpecs));

    pruneDisappeared("agentic_market", new Set(["am.still-here"]));

    const stillHere = getProvider("am.still-here");
    const vanished = getProvider("am.will-vanish");
    assert.ok(stillHere);
    assert.ok(vanished);
    assert.equal(stillHere!.enabled, true);
    assert.equal(vanished!.enabled, false);
  });
});

// -------------------- externalHttpHandler --------------------

describe("externalHttpHandler", () => {
  const originalFetch = globalThis.fetch;

  after(() => {
    (globalThis as any).fetch = originalFetch;
    delete process.env.TEST_EXTERNAL_KEY;
  });

  it("sends request with api_key header and transforms input/output", async () => {
    process.env.TEST_EXTERNAL_KEY = "secret-123";
    let captured: { url: string; init: RequestInit } | null = null;
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ upstream_results: [{ t: "A", u: "https://a" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const handler = externalHttpHandler({
      providerId: "test.provider",
      endpoint: "https://external/api/search",
      method: "POST",
      auth: { kind: "api_key", header: "x-api-key", valueEnv: "TEST_EXTERNAL_KEY" },
      transformInput: (input) => ({ q: input.query }),
      transformOutput: (raw) => {
        const r = raw as { upstream_results: Array<{ t: string; u: string }> };
        return { results: r.upstream_results.map(x => ({ title: x.t, url: x.u, snippet: "" })) };
      },
    });

    const ctx: StepExecutionContext = {
      sessionId: "s",
      planId: "p",
      stepId: "s1",
      walletAddress: "W",
      priorOutputs: {},
    };
    const out = (await handler({ query: "sneakers" }, ctx)) as any;

    assert.ok(captured);
    assert.equal((captured as any).url, "https://external/api/search");
    const headers = (captured as any).init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "secret-123");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal((captured as any).init.body, JSON.stringify({ q: "sneakers" }));

    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].title, "A");
  });

  it("retries on 5xx and ultimately surfaces the last error", async () => {
    let attempts = 0;
    (globalThis as any).fetch = async () => {
      attempts++;
      return new Response("server go boom", { status: 503 });
    };

    const handler = externalHttpHandler({
      providerId: "test.retries",
      endpoint: "https://retry",
      auth: { kind: "none" },
      maxAttempts: 3,
    });

    await assert.rejects(
      handler({}, { sessionId: "s", planId: "p", stepId: "s1", walletAddress: "W", priorOutputs: {} }),
      /503/
    );
    assert.equal(attempts, 3);
  });

  it("throws immediately on missing env var for api_key", async () => {
    delete process.env.MISSING_VAR_FOR_TEST;
    const handler = externalHttpHandler({
      providerId: "test.noenv",
      endpoint: "https://x",
      auth: { kind: "api_key", header: "x-api-key", valueEnv: "MISSING_VAR_FOR_TEST" },
    });
    await assert.rejects(
      handler({}, { sessionId: "s", planId: "p", stepId: "s1", walletAddress: "W", priorOutputs: {} }),
      /MISSING_VAR_FOR_TEST/
    );
  });
});

// -------------------- Scoring integration: AM + AgentOS providers compete --------------------

describe("scoreProviders with federated providers", () => {
  before(() => {
    clearFederatedProviders();
    // Disable existing web_search providers to get deterministic ranking
    for (const p of listProviders({ capability: "web_search" })) {
      setProviderEnabled(p.id, false);
    }
  });

  after(() => {
    // Re-enable AgentOS primitives for subsequent tests
    for (const p of listProviders({ capability: "web_search", enabledOnly: false })) {
      setProviderEnabled(p.id, true);
    }
  });

  it("picks highest reputation under 'best' quality when costs tie", async () => {
    clearFederatedProviders();
    await ingestCatalog(
      new MockCatalogAdapter("agentic_market", "Test", [
        {
          id: "am.cheap.search",
          capability: "web_search",
          name: "Cheap",
          endpoint: "https://c",
          authScheme: "x402-base",
          costPerCallUsdc: 0.05,
          p50LatencyMs: 2500,
          reputationSeed: 0.55,
        },
        {
          id: "am.premium.search",
          capability: "web_search",
          name: "Premium",
          endpoint: "https://p",
          authScheme: "x402-base",
          costPerCallUsdc: 0.20,
          p50LatencyMs: 900,
          reputationSeed: 0.95,
        },
      ])
    );

    const best = scoreProviders("web_search", "best");
    assert.equal(best[0].id, "am.premium.search");

    const cheap = scoreProviders("web_search", "cheap");
    assert.equal(cheap[0].id, "am.cheap.search");

    const fast = scoreProviders("web_search", "fast");
    assert.equal(fast[0].id, "am.premium.search");
  });
});
