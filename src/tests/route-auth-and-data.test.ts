/**
 * Regression tests for the broken/spoofable routes that were corrected:
 *
 *  - /api/invoice : the SQL used bare identifiers (DEFAULT USDC, datetime(now),
 *    SET status = paid) so every call 500'd; identity was the raw X-Agent-Id.
 *    Now it runs, requires auth, and is scoped to req.agentId (no cross-tenant
 *    read / pay).
 *  - /api/whoami  : queried non-existent columns/tables (always 500). Now it
 *    returns real, owner-scoped resource data for the authenticated identity.
 *  - /api/search  : SELECT * leaked agents.token / servers.root_password across
 *    tenants. Secret columns can no longer appear in results.
 *  - /api/agent-identity : no longer returns fabricated authoritative trust data.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";

import { db } from "../db";
import invoiceRouter from "../routes/invoice";
import whoamiRouter from "../routes/whoami";
import searchRouter from "../routes/agent-search-v2";
import identityRouter from "../routes/agent-identity";

function request(
  port: number,
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(buf); } catch {}
          resolve({ status: res.statusCode || 0, json, raw: buf });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function insertAgent(name: string, wallet: string, token: string): void {
  db.prepare(
    "INSERT INTO agents (id, name, wallet_address, token, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(name, name, wallet, token);
}

describe("auth + data-scoping route fixes", () => {
  let server: http.Server;
  let port: number;
  const s = Date.now().toString(36);

  const aliceName = `alice-${s}`;
  const aliceWallet = `WALLETA${s}`;
  const bobName = `bob-${s}`;
  const bobWallet = `WALLETB${s}`;

  before(async () => {
    delete process.env.PALMYR_SELF_HOSTED; // never bypass auth in this test
    insertAgent(aliceName, aliceWallet, "agt_a_" + crypto.randomBytes(6).toString("hex"));
    insertAgent(bobName, bobWallet, "agt_b_" + crypto.randomBytes(6).toString("hex"));

    const app = express();
    app.use(express.json());
    app.use("/api/invoice", invoiceRouter);
    app.use("/api/whoami", whoamiRouter);
    app.use("/api/search", searchRouter);
    app.use("/api/agent-identity", identityRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  after(async () => {
    db.prepare("DELETE FROM agents WHERE name IN (?, ?)").run(aliceName, bobName);
    db.prepare("DELETE FROM invoices WHERE agent_id IN (?, ?)").run(aliceWallet, bobWallet);
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe("invoice", () => {
    let invoiceId: string;

    it("requires authentication", async () => {
      const { status } = await request(port, "POST", "/api/invoice", { recipient: "x", items: [{ unit_price: 1 }] });
      assert.equal(status, 402);
    });

    it("creates an invoice (SQL no longer 500s) scoped to the caller", async () => {
      const { status, json } = await request(
        port, "POST", "/api/invoice",
        { recipient: "acme", items: [{ quantity: 2, unit_price: 5 }] },
        { "x-agent-id": aliceName },
      );
      assert.equal(status, 201, JSON.stringify(json));
      assert.equal(json.total, 10);
      assert.equal(json.agent_id, aliceWallet);
      invoiceId = json.invoice_id;
    });

    it("lists only the caller's invoices", async () => {
      const alice = await request(port, "GET", "/api/invoice", undefined, { "x-agent-id": aliceName });
      assert.equal(alice.json.count, 1);
      const bob = await request(port, "GET", "/api/invoice", undefined, { "x-agent-id": bobName });
      assert.equal(bob.json.count, 0);
    });

    it("won't let another agent pay your invoice", async () => {
      const bob = await request(port, "POST", `/api/invoice/${invoiceId}/pay`, {}, { "x-agent-id": bobName });
      assert.equal(bob.status, 404);
      const alice = await request(port, "POST", `/api/invoice/${invoiceId}/pay`, {}, { "x-agent-id": aliceName });
      assert.equal(alice.status, 200);
      assert.equal(alice.json.status, "paid");
    });
  });

  describe("whoami", () => {
    const waName = `who-${s}`;
    const waWallet = `WALLETW${s}`;

    before(() => {
      insertAgent(waName, waWallet, "agt_w_" + crypto.randomBytes(6).toString("hex"));
      db.prepare("INSERT INTO phone_numbers (id, phone_number, country, owner, provisioned_at, active) VALUES (?, ?, ?, ?, datetime('now'), 1)")
        .run(`ph-${s}`, `+1555${s}`.slice(0, 15), "US", waWallet);
      db.prepare("INSERT INTO email_inboxes (id, address, local_part, owner, created_at, active) VALUES (?, ?, ?, ?, datetime('now'), 1)")
        .run(`em-${s}`, `who-${s}@mail.test`, `who-${s}`, waWallet);
      db.prepare("INSERT INTO servers (id, name, server_type, image, status, owner, price_monthly, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))")
        .run(`sv-${s}`, `srv-${s}`, "cx11", "ubuntu", "running", waWallet, "5.00");
    });

    after(() => {
      db.prepare("DELETE FROM phone_numbers WHERE owner = ?").run(waWallet);
      db.prepare("DELETE FROM email_inboxes WHERE owner = ?").run(waWallet);
      db.prepare("DELETE FROM servers WHERE owner = ?").run(waWallet);
      db.prepare("DELETE FROM agents WHERE name = ?").run(waName);
    });

    it("requires authentication", async () => {
      const { status } = await request(port, "GET", "/api/whoami");
      assert.equal(status, 402);
    });

    it("returns owner-scoped resources for the authenticated identity (no 500)", async () => {
      const { status, json } = await request(port, "GET", "/api/whoami", undefined, { "x-agent-id": waName });
      assert.equal(status, 200, JSON.stringify(json));
      assert.equal(json.registered, true);
      assert.equal(json.wallet_address, waWallet);
      assert.equal(json.resources.phones, 1);
      assert.equal(json.resources.emails, 1);
      assert.equal(json.resources.servers, 1);
    });

    it("does not leak another agent's resources", async () => {
      const { json } = await request(port, "GET", "/api/whoami", undefined, { "x-agent-id": bobName });
      assert.equal(json.resources.phones, 0);
      assert.equal(json.resources.emails, 0);
      assert.equal(json.resources.servers, 0);
    });
  });

  describe("search secret-column exclusion", () => {
    const q = `zsecret${s}`;
    const secretToken = `agt_SECRET_${s}`;
    const rootPw = `ROOTPW_${s}`;

    before(() => {
      insertAgent(`${q}-agent`, `WAL${q}`, secretToken);
      db.prepare("INSERT INTO servers (id, name, server_type, image, status, owner, price_monthly, created_at, root_password) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)")
        .run(`srv-${q}`, `${q}-server`, "cx11", "ubuntu", "running", `WAL${q}`, "5.00", rootPw);
    });

    after(() => {
      db.prepare("DELETE FROM agents WHERE name = ?").run(`${q}-agent`);
      db.prepare("DELETE FROM servers WHERE id = ?").run(`srv-${q}`);
    });

    it("returns matches but never the token or root_password columns", async () => {
      const { status, json, raw } = await request(port, "GET", `/api/search?q=${q}`);
      assert.equal(status, 200);
      assert.ok(json.totalResults > 0, "expected matches");
      assert.ok(json.results.agents && json.results.agents.length > 0, "agent match present");
      for (const a of json.results.agents) assert.equal(a.token, undefined, "token must be excluded");
      assert.ok(json.results.servers && json.results.servers.length > 0, "server match present");
      for (const sv of json.results.servers) assert.equal(sv.root_password, undefined, "root_password must be excluded");
      // Defense in depth: the secret values must not appear anywhere in the body.
      assert.equal(raw.includes(secretToken), false, "token value leaked in response");
      assert.equal(raw.includes(rootPw), false, "root_password value leaked in response");
    });
  });

  describe("agent-identity honesty", () => {
    it("resolves real registration data without fabricated trust score", async () => {
      const { status, json } = await request(port, "GET", `/api/agent-identity/${aliceName}`);
      assert.equal(status, 200);
      assert.equal(json.registered, true);
      assert.equal(json.walletAddress, aliceWallet);
      assert.equal(json.walletVerified, false);
      assert.equal(json.trust_score, undefined, "must not fabricate a trust score");
      assert.equal(json.trust_level, undefined);
    });

    it("says so plainly for an unregistered identifier", async () => {
      const { json } = await request(port, "GET", `/api/agent-identity/nope-${s}`);
      assert.equal(json.registered, false);
      assert.equal(json.trust_score, undefined);
    });

    it("create returns a derived, non-persisted identity", async () => {
      const { status, json } = await request(port, "POST", "/api/agent-identity/create", { name: "demo" });
      assert.equal(status, 201);
      assert.equal(json.persisted, false);
      assert.equal(json.identity.trust_level, undefined);
      assert.match(String(json.identity.did), /^did:palmyr:/);
    });
  });
});
