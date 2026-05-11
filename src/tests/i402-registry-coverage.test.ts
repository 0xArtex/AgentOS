/**
 * Route-coverage test for the i402 provider registry.
 *
 * Guards against seed-vs-route drift. For each provider in the seed:
 *   - Confirms it maps to a real capability class
 *   - Confirms the endpoint URL is well-formed (has a host, matches PALMYR_API_BASE)
 *   - Confirms every {placeholder} in the URL corresponds to an input-schema field
 *   - Confirms payment rail is x402-native
 *
 * Also spot-checks that a few representative route files exist in src/routes/.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.PALMYR_API_BASE = "https://palmyr.ai";

import { initDatabase } from "../db";
import {
  seedPalmyrPrimitives,
  listProviders,
  CAPABILITY_CLASSES,
} from "../services/i402-providers";

initDatabase();
seedPalmyrPrimitives();

// -------------------- Helpers --------------------

function extractPlaceholders(url: string): string[] {
  const matches = url.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g);
  return [...matches].map(m => m[1]);
}

function inputFieldsOf(schema: unknown): Set<string> {
  if (schema === null || typeof schema !== "object") return new Set();
  return new Set(Object.keys(schema as Record<string, unknown>));
}

const REPO_ROOT = join(__dirname, "..", "..");

function routeFileExists(relativeRoute: string): boolean {
  // Route files are src/routes/<segment>.ts where segment is the first path chunk.
  // e.g. /phone/numbers → src/routes/phone.ts
  const seg = relativeRoute.replace(/^\//, "").split("/")[0];
  const path = join(REPO_ROOT, "src", "routes", `${seg}.ts`);
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

// -------------------- Tests --------------------

describe("i402 registry coverage", () => {
  const providers = listProviders({ source: "agentos", enabledOnly: true });

  it("has providers registered (non-empty)", () => {
    assert.ok(providers.length >= 50, `expected 50+ Palmyr providers, got ${providers.length}`);
  });

  it("every provider maps to a real capability class", () => {
    for (const p of providers) {
      assert.ok(
        CAPABILITY_CLASSES[p.capability],
        `provider ${p.id} references unknown capability ${p.capability}`
      );
    }
  });

  it("every provider's endpoint is well-formed and uses the configured base URL", () => {
    const base = process.env.PALMYR_API_BASE!;
    for (const p of providers) {
      assert.ok(
        p.endpoint.startsWith(base),
        `provider ${p.id} endpoint ${p.endpoint} does not start with ${base}`
      );
      // URL must be parseable once placeholders are stripped (substituted)
      const stripped = p.endpoint.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, "placeholder");
      assert.doesNotThrow(() => new URL(stripped), `provider ${p.id} endpoint is not a valid URL`);
    }
  });

  it("every path placeholder corresponds to a field in the provider's input schema", () => {
    for (const p of providers) {
      const placeholders = extractPlaceholders(p.endpoint);
      if (placeholders.length === 0) continue;
      const inputFields = inputFieldsOf(p.inputSchema);
      for (const ph of placeholders) {
        assert.ok(
          inputFields.has(ph),
          `provider ${p.id} endpoint has placeholder {${ph}} but input schema has no such field (input fields: ${[...inputFields].join(", ")})`
        );
      }
    }
  });

  it("every provider uses an x402-native payment rail", () => {
    for (const p of providers) {
      assert.ok(
        p.authScheme === "x402-solana" || p.authScheme === "x402-base",
        `provider ${p.id} auth scheme '${p.authScheme}' is not x402-native`
      );
    }
  });

  it("every provider has a positive cost (free endpoints should be registered as free elsewhere, not here)", () => {
    for (const p of providers) {
      assert.ok(p.costPerCallUsdc > 0, `provider ${p.id} has non-positive cost ${p.costPerCallUsdc}`);
    }
  });

  it("spot-checks: critical route files exist in src/routes/", () => {
    for (const route of ["phone", "email", "domains", "compute", "social", "apikeys"]) {
      assert.ok(routeFileExists(`/${route}`), `expected src/routes/${route}.ts to exist`);
    }
  });

  it("Tier B critical capabilities have at least one provider registered", () => {
    const required = [
      "provision_phone",
      "send_sms",
      "provision_email_inbox",
      "send_email",
      "register_domain",
      "list_domains",
      "dns_manage",
      "deploy_vps",
      "vps_action",
      "twitter_post",
      "tiktok_post",
      "twitter_buy_account",
    ];
    for (const cap of required) {
      const matching = providers.filter(p => p.capability === cap);
      assert.ok(matching.length >= 1, `no provider registered for Tier B-critical capability '${cap}'`);
    }
  });

  it("no duplicate provider IDs", () => {
    const ids = providers.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate provider IDs in seed");
  });
});
