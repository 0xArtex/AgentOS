/**
 * Cross-tenant isolation regression tests for the dashboard balance + projects
 * routes.
 *
 * Both routers used to derive the acting user from the raw `X-Dashboard-User`
 * header (a header any caller can set), with no session validation. That let an
 * anonymous request:
 *   - read another tenant's balance, ledger, and deposit addresses, and
 *   - list / read / overwrite (canvas_state holds wallet private keys, API keys,
 *     SSH keys) / delete another tenant's projects.
 *
 * The fix gates every route on `requireDashboardAuth` (a validated Bearer
 * session) and makes `getUserId` return ONLY `req.dashUserId` — never the
 * spoofable header. These tests assert:
 *   - header-only requests (no Bearer session) are 401, and
 *   - a valid session is scoped to its OWN user even when the request also
 *     carries a forged `X-Dashboard-User` header for a different victim, and
 *   - legitimate owners can still read their own data.
 *
 * Mirrors the temp-DB setup used by deposit-idempotency.test.ts: point the data
 * dir at a throwaway temp location BEFORE importing the DB-opening modules.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DATA_DIR = join(tmpdir(), `palmyr-test-xtenant-${Date.now()}`);
mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.PALMYR_DATA_DIR = TEST_DATA_DIR;

import { db, initDatabase } from "../db";
import balanceRoutes from "../routes/balance";
import projectRoutes from "../routes/projects";
import { deposit } from "../services/balance";

initDatabase();

// ── Fixtures ──────────────────────────────────────────────────────────────
const VICTIM = "victim-user-id";
const ATTACKER = "attacker-user-id";
const VICTIM_TOKEN = "victim-session-token";
const ATTACKER_TOKEN = "attacker-session-token";
const VICTIM_PROJECT = "victim-project-id";
const SECRET = "0xVICTIM_WALLET_PRIVATE_KEY";

function seed(): void {
  for (const id of [VICTIM, ATTACKER]) {
    db.prepare("INSERT INTO dashboard_users (id, display_name) VALUES (?, ?)").run(id, id);
  }
  db.prepare(
    "INSERT INTO dashboard_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))"
  ).run("sess-victim", VICTIM, VICTIM_TOKEN);
  db.prepare(
    "INSERT INTO dashboard_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))"
  ).run("sess-attacker", ATTACKER, ATTACKER_TOKEN);

  // Victim project whose canvas_state holds a node secret.
  db.prepare(
    "INSERT INTO projects (id, user_id, name, canvas_state) VALUES (?, ?, ?, ?)"
  ).run(VICTIM_PROJECT, VICTIM, "Victim Project", JSON.stringify({ nodes: [{ config: { privateKey: SECRET } }] }));

  // Distinct ledgers so we can prove a session is scoped to its own user.
  deposit(VICTIM, 999, "victim-seed", "victim deposit");
  deposit(ATTACKER, 13, "attacker-seed", "attacker deposit");
}

// ── Test server + HTTP helper ───────────────────────────────────────────────
let server: http.Server;
let port: number;

function launch(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/balance", balanceRoutes);
  app.use("/projects", projectRoutes);
  return new Promise(resolve => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind failed");
      port = addr.port;
      resolve();
    });
  });
}

interface Res { status: number; body: any; }

function request(method: string, path: string, opts: { token?: string; spoofUser?: string; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.spoofUser) headers["X-Dashboard-User"] = opts.spoofUser;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, res => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", c => (buf += c));
      res.on("end", () => {
        let body: any = buf;
        try { body = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe("dashboard cross-tenant isolation", () => {
  before(async () => { seed(); await launch(); });
  after(() => { try { server?.close(); } catch {} ; try { db.close(); } catch {} ; rmSync(TEST_DATA_DIR, { recursive: true, force: true }); });

  describe("projects.ts", () => {
    it("rejects a header-only request with 401 (no validated session)", async () => {
      const res = await request("GET", "/projects", { spoofUser: VICTIM });
      assert.equal(res.status, 401);
    });

    it("does NOT let a header-only request auto-create or list projects", async () => {
      await request("GET", "/projects", { spoofUser: VICTIM });
      // The unauthenticated list handler must never have run, so no stray
      // project should have been auto-created for the spoofed victim.
      const rows = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(VICTIM) as { n: number };
      assert.equal(rows.n, 1, "only the seeded victim project exists");
    });

    it("blocks attacker (valid session) from reading the victim's project even with a spoofed header", async () => {
      const res = await request("GET", `/projects/${VICTIM_PROJECT}`, { token: ATTACKER_TOKEN, spoofUser: VICTIM });
      assert.equal(res.status, 404);
      assert.ok(!JSON.stringify(res.body).includes(SECRET), "victim's node secret must not leak");
    });

    it("blocks attacker from overwriting the victim's canvas_state", async () => {
      const res = await request("PUT", `/projects/${VICTIM_PROJECT}`, {
        token: ATTACKER_TOKEN, spoofUser: VICTIM, body: { canvas_state: { nodes: [], tampered: true } },
      });
      assert.equal(res.status, 404);
      const row = db.prepare("SELECT canvas_state FROM projects WHERE id = ?").get(VICTIM_PROJECT) as { canvas_state: string };
      assert.ok(row.canvas_state.includes(SECRET), "victim canvas_state untouched");
    });

    it("blocks attacker from deleting the victim's project", async () => {
      const res = await request("DELETE", `/projects/${VICTIM_PROJECT}`, { token: ATTACKER_TOKEN, spoofUser: VICTIM });
      assert.equal(res.status, 404);
      const row = db.prepare("SELECT id FROM projects WHERE id = ?").get(VICTIM_PROJECT);
      assert.ok(row, "victim project still exists");
    });

    it("still lets the legitimate owner read their own project (with secrets)", async () => {
      const res = await request("GET", `/projects/${VICTIM_PROJECT}`, { token: VICTIM_TOKEN });
      assert.equal(res.status, 200);
      assert.equal(res.body.canvas_state.nodes[0].config.privateKey, SECRET);
    });
  });

  describe("balance.ts", () => {
    for (const path of ["/balance", "/balance/transactions", "/balance/deposit-address"]) {
      it(`rejects header-only GET ${path} with 401`, async () => {
        const res = await request("GET", path, { spoofUser: VICTIM });
        assert.equal(res.status, 401);
      });
    }

    it("scopes a valid session to its OWN ledger, ignoring a spoofed X-Dashboard-User header", async () => {
      const res = await request("GET", "/balance/transactions", { token: ATTACKER_TOKEN, spoofUser: VICTIM });
      assert.equal(res.status, 200);
      const txns = res.body.transactions as Array<{ user_id: string; amount_usdc: number }>;
      assert.ok(txns.length >= 1);
      for (const t of txns) {
        assert.equal(t.user_id, ATTACKER, "only the attacker's own rows are returned");
        assert.notEqual(t.amount_usdc, 999, "the victim's deposit must never leak");
      }
    });
  });
});
