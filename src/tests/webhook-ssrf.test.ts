/**
 * Regression tests: agent-controlled webhook delivery must go through the
 * SSRF-safe fetch (DNS re-resolution + private/loopback/link-local/metadata
 * blocklist), so an agent can't make the server POST to internal services or
 * the cloud metadata endpoint. Covers email webhook delivery (via fetchSsrfSafe
 * directly) and notifyAgent (notifications.ts).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { fetchSsrfSafe } from "../services/email";
import { notifyAgent } from "../services/notifications";
import { db } from "../db";

describe("webhook SSRF guard", () => {
  it("fetchSsrfSafe (POST) rejects loopback / metadata / private hosts before connecting", async () => {
    const blocked = [
      "http://127.0.0.1:1/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/internal",
      "http://192.168.1.1/admin",
      "http://[::1]:80/",
    ];
    for (const url of blocked) {
      await assert.rejects(
        () => fetchSsrfSafe(url, { method: "POST", body: "{}", timeoutMs: 2000 }),
        /SSRF guard/,
        `expected ${url} to be blocked`,
      );
    }
  });

  describe("notifyAgent", () => {
    const agentId = "ssrf-agent-" + crypto.randomBytes(4).toString("hex");

    before(() => {
      db.prepare(
        "INSERT INTO agents (id, name, wallet_address, token, webhook_url, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).run(agentId, agentId, "WALLET_" + agentId, "agt_" + crypto.randomBytes(6).toString("hex"), "http://127.0.0.1:1/hook");
    });

    after(() => {
      db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
      db.prepare("DELETE FROM webhook_log WHERE agent_id = ?").run(agentId);
    });

    it("does not deliver to a private/loopback webhook_url and returns false", async () => {
      const ok = await notifyAgent(agentId, "test.event", { hello: "world" });
      assert.equal(ok, false);
      // The attempt is logged as a failed delivery (status 0 / error), proving
      // the SSRF guard rejected it rather than the server connecting internally.
      const row = db.prepare(
        "SELECT status_code FROM webhook_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(agentId) as any;
      assert.ok(row, "a webhook_log row should exist");
      assert.equal(row.status_code, 0);
    });
  });
});
