/**
 * Tests for compute deploy pre-payment validation + refund retry safety.
 *
 * Covers:
 *  - HcloudApiError parses Hetzner's machine-readable error code
 *  - Platform-capacity circuit breaker opens/clears and gates the preflight
 *  - validateCreateServerBody rejects, BEFORE payment:
 *      missing fields, invalid hostname, unknown/deprecated server type,
 *      unknown location, type sold out in the effective location (409 with
 *      alternatives — including when location is omitted and the default
 *      applies), type never offered in a location (400)
 *  - validateCreateServerBody passes a deployable request through
 *  - retryFailedRefunds only targets failed rows with no broadcast tx and
 *    skips chains whose treasury key isn't configured
 *
 * Hetzner's catalog endpoints are mocked via global.fetch so the REAL
 * refresh/parsing path (supported vs available maps) is exercised.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.HCLOUD_TOKEN = "test-token";
process.env.HCLOUD_LOCATION = "fsn1";
delete process.env.TREASURY_SOL_PRIVATE_KEY;
delete process.env.SVM_PRIVATE_KEY;
delete process.env.TREASURY_EVM_PRIVATE_KEY;

import { db } from "../db";
import {
  HcloudApiError,
  notePlatformCapacityError,
  clearPlatformCapacityError,
  platformCapacityRetryAfterSeconds,
} from "../services/compute";
import { refreshHcloudTypes, isTypeAvailableInLocation, isTypeSupportedInLocation } from "../services/hcloud-types";
import { retryFailedRefunds } from "../services/refund";
import { validateCreateServerBody } from "../routes/compute";

// ── Hetzner catalog fixture ──────────────────────────────────
// cx23 (id 1): available everywhere.
// cax11 (id 2): supported in fsn1 + nbg1 but only AVAILABLE in nbg1 → sold
//               out in fsn1 (the default location).
// cx22 (id 3): deprecated → must not appear in plans at all.
const SERVER_TYPES = {
  server_types: [
    mkType(1, "cx23", false),
    mkType(2, "cax11", false),
    mkType(3, "cx22", true),
  ],
  meta: { pagination: { next_page: null } },
};
const DATACENTERS = {
  datacenters: [
    mkDc("fsn1-dc14", "fsn1", [1, 2, 3], [1]),
    mkDc("nbg1-dc3", "nbg1", [1, 2], [1, 2]),
  ],
  meta: { pagination: { next_page: null } },
};

function mkType(id: number, name: string, deprecated: boolean) {
  return {
    id,
    name,
    cores: 2,
    memory: 4,
    disk: 40,
    cpu_type: "shared",
    architecture: name.startsWith("cax") ? "arm" : "x86",
    deprecated,
    prices: [{ location: "fsn1", price_monthly: { net: "4.00", gross: "4.76" } }],
  };
}

function mkDc(name: string, loc: string, supported: number[], available: number[]) {
  return {
    id: 1,
    name,
    description: name,
    location: { id: 1, name: loc, city: loc, country: "DE", description: loc, network_zone: "eu-central", latitude: 0, longitude: 0 },
    server_types: { supported, available, available_for_migration: available },
  };
}

const realFetch = global.fetch;

function mockHetznerFetch(): void {
  global.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("api.hetzner.cloud/v1/server_types")) {
      return new Response(JSON.stringify(SERVER_TYPES), { status: 200 });
    }
    if (u.includes("api.hetzner.cloud/v1/datacenters")) {
      return new Response(JSON.stringify(DATACENTERS), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
}

// ── Express stand-ins ────────────────────────────────────────
function mkRes() {
  const res: any = {
    statusCode: 0,
    body: null as any,
    headers: {} as Record<string, string>,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: any) { res.body = payload; return res; },
    set(k: string, v: string) { res.headers[k] = v; return res; },
  };
  return res;
}

async function runPreflight(body: Record<string, unknown>) {
  const req: any = { body };
  const res = mkRes();
  let nextCalled = false;
  await validateCreateServerBody(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

describe("compute preflight", () => {
  before(async () => {
    // dotenv (pulled in via config) may have re-added treasury keys from a
    // local .env AFTER the top-of-file deletes — strip them again so the
    // refund retry test can never sign a real transaction.
    delete process.env.TREASURY_SOL_PRIVATE_KEY;
    delete process.env.SVM_PRIVATE_KEY;
    delete process.env.TREASURY_EVM_PRIVATE_KEY;
    mockHetznerFetch();
    await refreshHcloudTypes();
    clearPlatformCapacityError();
  });

  after(() => {
    global.fetch = realFetch;
    clearPlatformCapacityError();
  });

  describe("HcloudApiError", () => {
    it("parses the machine-readable code from a Hetzner error body", () => {
      const err = new HcloudApiError("POST", "/servers", 403,
        JSON.stringify({ error: { code: "resource_limit_exceeded", message: "Primary IP limit exceeded" } }));
      assert.equal(err.code, "resource_limit_exceeded");
      assert.equal(err.status, 403);
      assert.match(err.message, /Primary IP limit exceeded/);
    });

    it("survives a non-JSON error body", () => {
      const err = new HcloudApiError("POST", "/servers", 502, "Bad Gateway");
      assert.equal(err.code, null);
      assert.match(err.message, /Bad Gateway/);
    });
  });

  describe("availability maps", () => {
    it("distinguishes sold-out from not-offered", () => {
      assert.equal(isTypeAvailableInLocation("cax11", "fsn1"), false);
      assert.equal(isTypeSupportedInLocation("cax11", "fsn1"), true); // sold out
      assert.equal(isTypeAvailableInLocation("cax11", "nbg1"), true);
      assert.equal(isTypeSupportedInLocation("cx23", "nbg1"), true);
    });
  });

  describe("validateCreateServerBody", () => {
    it("rejects missing required fields pre-payment", async () => {
      const { res, nextCalled } = await runPreflight({ name: "box" });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, "Missing Required Fields");
    });

    it("rejects an invalid hostname pre-payment", async () => {
      const { res, nextCalled } = await runPreflight({ name: "Bad_Name", serverType: "cx23" });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, "Invalid server name");
    });

    it("rejects a deprecated/unknown server type pre-payment with the live list", async () => {
      const { res, nextCalled } = await runPreflight({ name: "box", serverType: "cx22" });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, "Unknown server type");
      assert.ok(res.body.validTypes.includes("cx23"));
      assert.ok(!res.body.validTypes.includes("cx22"));
    });

    it("rejects an unknown location pre-payment", async () => {
      const { res, nextCalled } = await runPreflight({ name: "box", serverType: "cx23", location: "atlantis" });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, "Invalid location");
    });

    it("409s a sold-out type in an explicit location, pointing at live alternatives", async () => {
      const { res, nextCalled } = await runPreflight({ name: "box", serverType: "cax11", location: "fsn1" });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error, "Out of capacity");
      assert.deepEqual(res.body.availableIn, ["nbg1"]);
    });

    it("applies the same capacity check when location is omitted (default location)", async () => {
      const { res, nextCalled } = await runPreflight({ name: "box", serverType: "cax11" });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error, "Out of capacity");
    });

    it("passes a deployable request through", async () => {
      const { res, nextCalled } = await runPreflight({ name: "box", serverType: "cx23", location: "nbg1" });
      assert.equal(nextCalled, true);
      assert.equal(res.statusCode, 0);
    });

    it("503s pre-payment while the platform-capacity breaker is open, then recovers", async () => {
      notePlatformCapacityError();
      assert.ok(platformCapacityRetryAfterSeconds() > 0);
      const blocked = await runPreflight({ name: "box", serverType: "cx23", location: "nbg1" });
      assert.equal(blocked.nextCalled, false);
      assert.equal(blocked.res.statusCode, 503);
      assert.equal(blocked.res.body.error, "Platform at capacity");
      assert.ok(blocked.res.headers["Retry-After"]);

      clearPlatformCapacityError();
      const open = await runPreflight({ name: "box", serverType: "cx23", location: "nbg1" });
      assert.equal(open.nextCalled, true);
    });
  });

  describe("retryFailedRefunds", () => {
    it("skips chains without a treasury key and never touches rows with a broadcast tx", async () => {
      db.prepare("DELETE FROM refunds WHERE original_payment_signature LIKE 'test-preflight-%'").run();
      db.prepare(
        "INSERT INTO refunds (id, original_payment_signature, payer, chain, amount_usdc, reason, endpoint, status) " +
        "VALUES ('test_rf_1', 'test-preflight-1', 'payer1', 'base', 6.0, 'test', 'POST /compute/servers', 'failed')"
      ).run();
      db.prepare(
        "INSERT INTO refunds (id, original_payment_signature, payer, chain, amount_usdc, reason, endpoint, status, refund_tx) " +
        "VALUES ('test_rf_2', 'test-preflight-2', 'payer2', 'base', 6.0, 'test', 'POST /compute/servers', 'failed', '0xdeadbeef')"
      ).run();

      // No treasury keys configured → both rows must remain untouched and
      // unattempted (a retry without keys would just rewrite the same error).
      const result = await retryFailedRefunds();
      assert.equal(result.retried, 0);
      assert.equal(result.sent, 0);

      const rows = db.prepare(
        "SELECT id, status, refund_tx FROM refunds WHERE original_payment_signature LIKE 'test-preflight-%' ORDER BY id"
      ).all() as any[];
      assert.equal(rows[0].status, "failed");
      assert.equal(rows[0].refund_tx, null);
      assert.equal(rows[1].refund_tx, "0xdeadbeef");

      db.prepare("DELETE FROM refunds WHERE original_payment_signature LIKE 'test-preflight-%'").run();
    });
  });
});
