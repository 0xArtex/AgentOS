/**
 * Tests for the ?limit= + ?cursor= pagination added to previously unbounded
 * list endpoints. Unbounded lists can blow an autonomous agent's context
 * window, so these endpoints now page with a backward-compatible
 * `{ ..., next_cursor }` envelope.
 *
 * What this covers (driven over real HTTP, mirroring the style of
 * agent-register-comms.test.ts — boot the real router on an ephemeral port):
 *  - GET /api/agent-directory (no paywall) is exercised end-to-end:
 *      * first page returns <= limit items AND a non-null next_cursor when more exist
 *      * passing that cursor returns the next page with NO overlap
 *      * walking the cursor reaches a final page with next_cursor: null
 *      * a small list (limit >= total) returns next_cursor: null
 *      * the legacy `agents` array key + item shape are preserved (backward compat)
 *
 * The email + social list endpoints share the exact same paginate-one-extra /
 * id-cursor / next_cursor contract; they sit behind x402/SIWX paywalls that
 * would require spending real USDC to drive over HTTP, so the directory route
 * (same contract, no paywall) is the executable proof of the pattern.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { db, initDatabase } from "../db";
import agentDirectoryRouter from "../routes/agent-directory";

// -------------------- Setup --------------------

initDatabase();

// Unique suffix so repeated runs against a persistent dev DB never collide on
// the UNIQUE(name)/UNIQUE(token) constraints, and so our SELECT only ever sees
// the rows this run inserted.
const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58Wallet(seed: string): string {
  const cleaned = seed.split("").filter(c => B58.includes(c)).join("");
  return (cleaned + "1".repeat(44)).slice(0, 44);
}

// Insert N directory agents with deterministic, lexically-ordered ids so the
// route's `ORDER BY id DESC` keyset cursor is predictable in the assertions.
// Returns the ids in the order the endpoint will emit them (DESC).
function seedAgents(prefix: string, n: number): string[] {
  const ids: string[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    // Zero-padded index keeps string ordering aligned with numeric ordering.
    const id = `dir_${prefix}_${String(i).padStart(3, "0")}`;
    db.prepare(
      `INSERT INTO agents (id, name, description, wallet_address, webhook_url, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, `${prefix}-name-${i}-${SUFFIX}`, `desc ${prefix} ${i}`, b58Wallet(prefix + i + SUFFIX), null, `aos_${id}_${SUFFIX}`, now);
    ids.push(id);
  }
  // Endpoint emits ORDER BY id DESC.
  return ids.slice().sort().reverse();
}

async function launchTestServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use("/api/agent-directory", agentDirectoryRouter);
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind failed");
      resolve({
        port: addr.port,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

async function httpGet(
  port: number,
  path: string
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path, headers: { Accept: "application/json" } }, res => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", chunk => (buf += chunk));
        res.on("end", () => {
          let body: any = buf;
          try { body = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
      })
      .on("error", reject);
  });
}

// -------------------- GET /api/agent-directory pagination --------------------

describe("GET /api/agent-directory — ?limit= + ?cursor= pagination", () => {
  let ctx: { port: number; close: () => Promise<void> };
  // A search term unique to this run so our SELECT (search-filtered) only sees
  // the rows we just inserted, regardless of what else lives in the dev DB.
  const PREFIX = `pgn${SUFFIX}`;
  let expectedDescIds: string[];
  const TOTAL = 5;

  before(async () => {
    expectedDescIds = seedAgents(PREFIX, TOTAL);
    ctx = await launchTestServer();
  });
  after(async () => {
    await ctx.close();
    db.prepare("DELETE FROM agents WHERE id LIKE ?").run(`dir_${PREFIX}_%`);
  });

  it("first page returns <= limit items, a next_cursor, and the legacy `agents` array shape", async () => {
    // Scope to our run's rows via ?search so other dev-DB agents don't bleed in.
    const res = await httpGet(ctx.port, `/api/agent-directory?search=${PREFIX}&limit=2`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // Backward-compat: items still live under `agents`, with the same fields.
    assert.ok(Array.isArray(res.body.agents), "legacy `agents` array must be present");
    assert.ok(res.body.agents.length <= 2, "must not exceed the requested limit");
    assert.equal(res.body.agents.length, 2);
    const first = res.body.agents[0];
    assert.ok("id" in first && "name" in first && "description" in first && "created_at" in first,
      "item shape (id/name/description/created_at) must be unchanged");

    // New envelope fields.
    assert.equal(res.body.limit, 2, "limit should be echoed");
    assert.ok(res.body.next_cursor, "next_cursor must be set when more pages exist");

    // Ordering matches ORDER BY id DESC; cursor is the last id on the page.
    assert.deepEqual(res.body.agents.map((a: any) => a.id), expectedDescIds.slice(0, 2));
    assert.equal(res.body.next_cursor, expectedDescIds[1]);
  });

  it("passing the cursor returns the next page with NO overlap, and terminates with next_cursor: null", async () => {
    const seenIds = new Set<string>();
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    // Walk the cursor to exhaustion. limit=2 over 5 rows => 3 pages (2,2,1).
    do {
      const qs = `/api/agent-directory?search=${PREFIX}&limit=2` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const res: { status: number; body: any } = await httpGet(ctx.port, qs);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      pages++;

      for (const a of res.body.agents as Array<{ id: string }>) {
        assert.ok(!seenIds.has(a.id), `cursor paging must not overlap — saw ${a.id} twice`);
        seenIds.add(a.id);
        collected.push(a.id);
      }
      cursor = res.body.next_cursor;
      assert.ok(pages <= 10, "pagination did not terminate");
    } while (cursor !== null);

    // Final page signalled completion via next_cursor: null, and we saw every
    // row exactly once, in the endpoint's stable DESC order.
    assert.equal(cursor, null, "last page must report next_cursor: null");
    assert.equal(collected.length, TOTAL, "every row must be returned exactly once across pages");
    assert.deepEqual(collected, expectedDescIds, "concatenated pages must equal the full stable ordering");
    assert.equal(pages, 3, "5 rows at limit=2 should span exactly 3 pages");
  });

  it("a small list (limit >= total) returns next_cursor: null on the first page", async () => {
    const res = await httpGet(ctx.port, `/api/agent-directory?search=${PREFIX}&limit=50`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.agents.length, TOTAL, "all rows fit on one page");
    assert.equal(res.body.next_cursor, null, "no further page => next_cursor must be null");
  });

  it("ignores garbage ?limit= and falls back to the default (does not 500)", async () => {
    const res = await httpGet(ctx.port, `/api/agent-directory?search=${PREFIX}&limit=notanumber`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.limit, 50, "garbage limit must clamp to the default of 50");
    // 5 rows < default 50 => single page, no cursor.
    assert.equal(res.body.agents.length, TOTAL);
    assert.equal(res.body.next_cursor, null);
  });
});
