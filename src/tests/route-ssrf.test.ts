/**
 * Regression tests for the SSRF fixes:
 *
 *  - /api/agent-batch: op.path that carries a host / scheme / userinfo (the
 *    classic "@metadata-host", "//evil", "http://169.254.169.254" forms) is
 *    rejected BEFORE any network I/O, while a legitimate internal path still
 *    dispatches.
 *  - /api/agent-integration-test: an attacker-controlled callbackUrl pointing at
 *    a private / loopback / link-local / non-HTTPS target is blocked by the
 *    shared SSRF-safe fetcher and reported as a failed (never "pass") check.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import agentBatchRouter from "../routes/agent-batch";
import agentIntegrationTestRouter from "../routes/agent-integration-test";

function request(
  port: number,
  method: string,
  path: string,
  body?: any,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(buf); } catch {}
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("route SSRF guards", () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    const app = express();
    app.use(express.json());
    // A harmless internal endpoint the batch route is allowed to reach.
    app.get("/api/_echo", (_req, res) => res.json({ ok: true }));
    app.use("/api/agent-batch", agentBatchRouter);
    app.use("/api/agent-integration-test", agentIntegrationTestRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("bind failed");
        port = addr.port;
        // The batch handler builds its loopback base from process.env.PORT.
        process.env.PORT = String(port);
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe("agent-batch op.path", () => {
    const ssrfPaths = [
      "@169.254.169.254/latest/meta-data/",       // userinfo host override
      "//169.254.169.254/latest/meta-data/",       // scheme-relative host
      "http://169.254.169.254/latest/meta-data/",  // absolute URL
      "https://evil.example.com/",                 // absolute URL
      "/api/agent-batch",                          // recursion / amplification
      "api/relative",                               // not absolute
    ];

    for (const p of ssrfPaths) {
      it(`rejects SSRF/invalid op.path ${JSON.stringify(p)} with no outbound call`, async () => {
        const { status, json } = await request(port, "POST", "/api/agent-batch", {
          operations: [{ method: "GET", path: p }],
        });
        assert.equal(status, 200);
        const r = json.results[0];
        assert.equal(r.status, 400, `expected 400 rejection for ${p}`);
        assert.equal(r.latencyMs, 0, "rejection must happen before any network I/O");
        assert.match(String(r.error), /Invalid op\.path|Unsupported method/);
      });
    }

    it("rejects a non GET/POST method", async () => {
      const { json } = await request(port, "POST", "/api/agent-batch", {
        operations: [{ method: "DELETE", path: "/api/_echo" }],
      });
      assert.equal(json.results[0].status, 400);
      assert.match(String(json.results[0].error), /Unsupported method/);
    });

    it("still dispatches a legitimate internal path", async () => {
      const { json } = await request(port, "POST", "/api/agent-batch", {
        operations: [{ method: "GET", path: "/api/_echo" }],
      });
      const r = json.results[0];
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.deepEqual(r.data, { ok: true });
    });
  });

  describe("agent-integration-test callbackUrl", () => {
    const blocked = [
      "http://169.254.169.254/latest/meta-data/", // non-https + metadata IP
      "https://127.0.0.1/",                        // loopback
      "https://localhost/",                        // loopback name
      "https://[::1]/",                            // IPv6 loopback
      "https://10.0.0.5/",                         // RFC1918
      "http://example.com/",                       // non-https rejected outright
    ];

    for (const url of blocked) {
      it(`blocks callbackUrl ${JSON.stringify(url)}`, async () => {
        const { status, json } = await request(port, "POST", "/api/agent-integration-test", {
          agentId: "tester",
          services: [],
          callbackUrl: url,
        });
        assert.equal(status, 200);
        const cb = json.integration_test.results.find((r: any) => r.test === "callback_connectivity");
        assert.ok(cb, "callback_connectivity check present");
        assert.equal(cb.status, "fail", `expected fail for ${url}, got ${cb.status}`);
        assert.notEqual(cb.status, "pass");
      });
    }
  });
});
