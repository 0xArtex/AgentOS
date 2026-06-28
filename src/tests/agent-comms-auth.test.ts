/**
 * Regression tests for the cross-tenant auth holes closed in
 *   - src/routes/agent-comms.ts  (trusted the raw X-Agent-Id header directly)
 *   - src/middleware/wallet-auth.ts (un-stripped inbound X-Dashboard-User)
 *
 * Invariants under test:
 *   1. A spoofed `X-Agent-Id` header (no token / payment / signature) can NEVER
 *      send as, or read the inbox of, another agent — agent-comms now routes
 *      through the hardened requireAuth and keys off the VERIFIED req.agentId.
 *   2. A legitimately-authenticated agent (valid token) can only read its OWN
 *      inbox, can't forge a message's `from`, and can't mark another agent's
 *      message read.
 *   3. wallet-auth strips any inbound `x-dashboard-user` it did not itself set
 *      from a validated session — a forged header is ignored.
 *
 * Harness mirrors agent-register-comms.test.ts: boot the real router on an
 * ephemeral port and drive it over HTTP.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { db, initDatabase } from "../db";
import agentCommsRoutes from "../routes/agent-comms";
import { resolveWalletAuth } from "../middleware/wallet-auth";

initDatabase();

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58Wallet(seed: string): string {
  const cleaned = seed.split("").filter(c => B58.includes(c)).join("");
  return (cleaned + "1".repeat(44)).slice(0, 44);
}

// Two registered agents. The attacker has valid credentials of their own; the
// victim is who they must never be able to impersonate or read.
const VICTIM_ID = "agent_victim_" + SUFFIX;
const VICTIM_TOKEN = "aos_victim_" + SUFFIX;
const ATTACKER_ID = "agent_attacker_" + SUFFIX;
const ATTACKER_TOKEN = "aos_attacker_" + SUFFIX;

function seedAgents(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agents (id, name, description, wallet_address, webhook_url, token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(VICTIM_ID, "victim-" + SUFFIX, null, b58Wallet("VC" + SUFFIX), null, VICTIM_TOKEN, now);
  db.prepare(
    `INSERT INTO agents (id, name, description, wallet_address, webhook_url, token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(ATTACKER_ID, "attacker-" + SUFFIX, null, b58Wallet("AT" + SUFFIX), null, ATTACKER_TOKEN, now);
}

async function launch(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use("/api/agent-comms", agentCommsRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind failed");
      resolve({ port: addr.port, close: () => new Promise<void>(r => server.close(() => r())) });
    });
  });
}

function reqHttp(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
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
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
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
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe("agent-comms: a spoofed X-Agent-Id grants nothing", () => {
  let ctx: { port: number; close: () => Promise<void> };
  before(async () => { seedAgents(); ctx = await launch(); });
  after(async () => { await ctx.close(); });

  it("send with a bare X-Agent-Id (no token/payment) is rejected (402), not delivered", async () => {
    const res = await reqHttp(
      ctx.port,
      "POST",
      "/api/agent-comms/send",
      { "X-Agent-Id": VICTIM_ID },
      { toAgent: ATTACKER_ID, subject: "forged", message: "i am the victim" },
    );
    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.notEqual(res.body.status, "delivered");
    // Nothing was written as the victim.
    const leaked = db
      .prepare("SELECT COUNT(*) as c FROM agent_messages WHERE from_agent = ? AND body = ?")
      .get(VICTIM_ID, "i am the victim") as any;
    assert.equal(leaked.c, 0, "a header-only caller must not write a message as the victim");
  });

  it("inbox read with a bare X-Agent-Id is rejected (402)", async () => {
    const res = await reqHttp(ctx.port, "GET", "/api/agent-comms/inbox", { "X-Agent-Id": VICTIM_ID });
    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.messages, undefined, "no inbox contents may leak to a header-only caller");
  });
});

describe("agent-comms: an authenticated agent is confined to its own identity", () => {
  let ctx: { port: number; close: () => Promise<void> };
  let msgId: string;
  before(async () => { ctx = await launch(); }); // agents already seeded above
  after(async () => { await ctx.close(); });

  it("attacker (own token) can send to the victim — sender is the attacker, not forged", async () => {
    const res = await reqHttp(
      ctx.port,
      "POST",
      "/api/agent-comms/send",
      { Authorization: "Bearer " + ATTACKER_TOKEN },
      { toAgent: VICTIM_ID, subject: "hi", message: "legit message" },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.from, ATTACKER_ID);
    assert.equal(res.body.to, VICTIM_ID);
    msgId = res.body.id;
    const stored = db.prepare("SELECT from_agent, to_agent FROM agent_messages WHERE id = ?").get(msgId) as any;
    assert.equal(stored.from_agent, ATTACKER_ID);
    assert.equal(stored.to_agent, VICTIM_ID);
  });

  it("attacker CANNOT forge `from` as the victim (403)", async () => {
    const res = await reqHttp(
      ctx.port,
      "POST",
      "/api/agent-comms/send",
      { Authorization: "Bearer " + ATTACKER_TOKEN },
      { from: VICTIM_ID, toAgent: ATTACKER_ID, message: "spoofed sender" },
    );
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.error, /Forbidden Sender/i);
  });

  it("attacker CANNOT read the victim's inbox via ?agentId (403)", async () => {
    const res = await reqHttp(
      ctx.port,
      "GET",
      `/api/agent-comms/inbox?agentId=${VICTIM_ID}`,
      { Authorization: "Bearer " + ATTACKER_TOKEN },
    );
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.messages, undefined);
  });

  it("victim (own token) reads only its own inbox and sees the message", async () => {
    const res = await reqHttp(
      ctx.port,
      "GET",
      "/api/agent-comms/inbox",
      { Authorization: "Bearer " + VICTIM_TOKEN },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.agentId, VICTIM_ID);
    assert.ok(Array.isArray(res.body.messages));
    assert.ok(res.body.messages.find((m: any) => m.id === msgId), "victim must see the message addressed to it");
  });

  it("attacker CANNOT mark the victim's message read (403); the recipient can (200)", async () => {
    const forbidden = await reqHttp(
      ctx.port,
      "POST",
      `/api/agent-comms/read/${msgId}`,
      { Authorization: "Bearer " + ATTACKER_TOKEN },
    );
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));

    const ok = await reqHttp(
      ctx.port,
      "POST",
      `/api/agent-comms/read/${msgId}`,
      { Authorization: "Bearer " + VICTIM_TOKEN },
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "read");
  });
});

describe("wallet-auth: a forged X-Dashboard-User is never trusted", () => {
  const DASH_USER = "dash_user_" + SUFFIX;
  const DASH_TOKEN = "session_" + SUFFIX;

  before(() => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO dashboard_users (id, email, wallet_address, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(DASH_USER, `dash-${SUFFIX}@example.test`, b58Wallet("DU" + SUFFIX), "Dash " + SUFFIX, now);
    db.prepare(
      `INSERT INTO dashboard_sessions (id, user_id, token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("sess_" + SUFFIX, DASH_USER, DASH_TOKEN, "2999-01-01 00:00:00", now);
  });

  function runMiddleware(headers: Record<string, string>): any {
    const req: any = { headers: { ...headers } };
    let called = false;
    resolveWalletAuth(req, {} as any, () => { called = true; });
    assert.equal(called, true, "middleware must call next()");
    return req;
  }

  it("strips an inbound x-dashboard-user when there is no valid session", () => {
    const req = runMiddleware({ "x-dashboard-user": "victim-account" });
    assert.equal(req.headers["x-dashboard-user"], undefined, "forged header must be stripped");
    assert.equal(req.dashUserId, undefined);
  });

  it("ignores a forged x-dashboard-user and uses the validated session id instead", () => {
    const req = runMiddleware({
      authorization: "Bearer " + DASH_TOKEN,
      "x-dashboard-user": "victim-account", // attacker tries to override
    });
    assert.equal(req.dashUserId, DASH_USER, "identity must come from the validated session");
    assert.equal(
      req.headers["x-dashboard-user"],
      DASH_USER,
      "the surviving header must be the session user, never the forged value",
    );
  });
});
