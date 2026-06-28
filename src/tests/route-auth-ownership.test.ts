/**
 * Regression tests proving cross-tenant access is blocked on the routes that
 * previously trusted the raw, spoofable `X-Agent-Id` header (or had no auth at
 * all) as identity: agent-env, agent-backup, messages, config, webhooks.
 *
 * The fix routes every handler through requireAuth(0) and keys all
 * reads/writes/deletes on the VERIFIED `req.agentId` (token → wallet identity),
 * never the inbound header. These tests authenticate with the cryptographic
 * token path (Authorization: Bearer aos_*) — the unforgeable on-ramp — and
 * show that:
 *   • a different tenant cannot read/overwrite/delete your data,
 *   • a spoofed X-Agent-Id header is ignored when a real token is present,
 *   • completely unauthenticated requests are rejected (402), not served.
 *
 * Harness style mirrors agent-register-comms.test.ts: boot the real routers on
 * an ephemeral port and drive them over HTTP.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { db, initDatabase } from "../db";
import agentEnvRoutes from "../routes/agent-env";
import agentBackupRoutes from "../routes/agent-backup";
import messageRoutes from "../routes/messages";
import configRoutes from "../routes/config";
import webhookRoutes from "../routes/webhooks";

initDatabase();

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Two distinct tenants. wallet_address is the identity requireAuth resolves a
// token to (req.agentId), and agent_messages.from_agent/to_agent store the id.
const A = { id: `auth_A_${SUFFIX}`, name: `auth-a-${SUFFIX}`, wallet: `WALLET_A_${SUFFIX}`, token: `aos_A_${SUFFIX}` };
const B = { id: `auth_B_${SUFFIX}`, name: `auth-b-${SUFFIX}`, wallet: `WALLET_B_${SUFFIX}`, token: `aos_B_${SUFFIX}` };

function seedAgent(a: typeof A) {
  db.prepare(
    `INSERT INTO agents (id, name, description, wallet_address, webhook_url, token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(a.id, a.name, null, a.wallet, null, a.token, new Date().toISOString());
}

function bearer(a: typeof A): Record<string, string> {
  return { Authorization: `Bearer ${a.token}` };
}

async function launch(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use("/api/agent-env", agentEnvRoutes);
  app.use("/api/agent-backup", agentBackupRoutes);
  app.use("/messages", messageRoutes);
  app.use("/api/config", configRoutes);
  app.use("/api/webhooks", webhookRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind failed");
      resolve({ port: addr.port, close: () => new Promise<void>(r => server.close(() => r())) });
    });
  });
}

function req(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      res => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", c => (buf += c));
        res.on("end", () => {
          let parsed: any = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    r.on("error", reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

let ctx: { port: number; close: () => Promise<void> };

before(async () => {
  seedAgent(A);
  seedAgent(B);
  ctx = await launch();
});
after(async () => { await ctx.close(); });

// ── agent-env ─────────────────────────────────────────────────
describe("agent-env: no header trust, tenant isolation", () => {
  it("ignores a spoofed X-Agent-Id header when a real token is present", async () => {
    // A writes while SPOOFING B's id in the header. The write must land in A's
    // bucket (token wins), never B's.
    const set = await req(ctx.port, "POST", "/api/agent-env", { ...bearer(A), "X-Agent-Id": B.id }, { key: "SECRET_A", value: "valA" });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    const bSees = await req(ctx.port, "GET", "/api/agent-env", bearer(B));
    assert.equal(bSees.status, 200);
    assert.ok(!bSees.body.env.some((e: any) => e.key === "SECRET_A"), "B must NOT see A's env var via a spoofed header");

    const aSees = await req(ctx.port, "GET", "/api/agent-env", bearer(A));
    assert.ok(aSees.body.env.some((e: any) => e.key === "SECRET_A"), "A must see its own env var");
  });

  it("rejects unauthenticated access with 402", async () => {
    const res = await req(ctx.port, "GET", "/api/agent-env");
    assert.equal(res.status, 402);
  });
});

// ── config ────────────────────────────────────────────────────
describe("config: tenant isolation", () => {
  it("does not leak one tenant's config to another", async () => {
    const put = await req(ctx.port, "PUT", "/api/config", { ...bearer(A), "X-Agent-Id": B.id }, { alertEmail: "a@example.com" });
    assert.equal(put.status, 200);

    const bGet = await req(ctx.port, "GET", "/api/config", bearer(B));
    assert.equal(bGet.status, 200);
    assert.notEqual(bGet.body.config.alertEmail, "a@example.com");

    const aGet = await req(ctx.port, "GET", "/api/config", bearer(A));
    assert.equal(aGet.body.config.alertEmail, "a@example.com");
  });

  it("rejects unauthenticated GET with 402", async () => {
    const res = await req(ctx.port, "GET", "/api/config");
    assert.equal(res.status, 402);
  });
});

// ── webhooks ──────────────────────────────────────────────────
describe("webhooks: registration is owner-scoped", () => {
  it("does not expose one tenant's webhooks to another", async () => {
    const reg = await req(ctx.port, "POST", "/api/webhooks", bearer(A), { url: "https://a.example/hook", events: ["invoice.paid"] });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));

    const bList = await req(ctx.port, "GET", "/api/webhooks", bearer(B));
    assert.equal(bList.status, 200);
    assert.equal(bList.body.count, 0, "B must not see A's webhook");

    const aList = await req(ctx.port, "GET", "/api/webhooks", bearer(A));
    assert.equal(aList.body.count, 1);
  });

  it("rejects unauthenticated registration with 402", async () => {
    const res = await req(ctx.port, "POST", "/api/webhooks", {}, { url: "https://x", events: ["invoice.paid"] });
    assert.equal(res.status, 402);
  });
});

// ── agent-backup ──────────────────────────────────────────────
describe("agent-backup: export is owner-only", () => {
  it("403s when exporting another agent's data via the path param", async () => {
    const res = await req(ctx.port, "GET", `/api/agent-backup/${B.id}`, bearer(A));
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it("allows exporting your own data (by wallet, by id, and with no param)", async () => {
    for (const p of [`/${A.wallet}`, `/${A.id}`, ``]) {
      const res = await req(ctx.port, "GET", `/api/agent-backup${p}`, bearer(A));
      assert.equal(res.status, 200, `own export ${p || "(no param)"} should 200: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.agentId, A.wallet);
    }
  });

  it("rejects a fully unauthenticated export with 402 (was an open dump)", async () => {
    const res = await req(ctx.port, "GET", `/api/agent-backup/${B.id}`);
    assert.equal(res.status, 402);
  });
});

// ── messages ──────────────────────────────────────────────────
describe("messages: inbox/send/read are identity-scoped", () => {
  it("403s reading another agent's inbox", async () => {
    const res = await req(ctx.port, "GET", `/messages/inbox/${B.id}`, bearer(A));
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it("serves your own inbox", async () => {
    const res = await req(ctx.port, "GET", `/messages/inbox/${A.id}`, bearer(A));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.messages));
  });

  it("403s forging the `from` of a sent message", async () => {
    const res = await req(ctx.port, "POST", "/messages/send", bearer(A), { from: B.id, to: A.id, body: "spoofed" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it("derives `from` from the authenticated identity when omitted", async () => {
    const res = await req(ctx.port, "POST", "/messages/send", bearer(A), { to: B.id, body: "legit" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.message.from.id, A.id);
    assert.equal(res.body.message.to.id, B.id);
  });

  it("403s marking another agent's message as read; recipient can", async () => {
    const id = `msg_test_${SUFFIX}`;
    db.prepare(
      `INSERT INTO agent_messages (id, from_agent, to_agent, subject, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, A.id, B.id, "s", "to B", new Date().toISOString());

    const aTry = await req(ctx.port, "POST", `/messages/${id}/read`, bearer(A));
    assert.equal(aTry.status, 403, "non-recipient A must not mark B's message read");

    const bOk = await req(ctx.port, "POST", `/messages/${id}/read`, bearer(B));
    assert.equal(bOk.status, 200);
    assert.equal(bOk.body.ok, true);
  });
});
