/**
 * Hosted MCP server smoke test.
 *
 * Boots the BUILT server (`node dist/index.js`) on a temp port and drives the
 * MCP Streamable HTTP endpoint at POST /mcp end-to-end:
 *
 *   (a) JSON-RPC `initialize`                → 200, serverInfo.name present
 *   (b) `tools/list`                         → >= 12 tools incl. i402_plan + palmyr_pricing
 *   (c) `tools/call` palmyr_pricing (free)   → pricing JSON
 *   (d) `tools/call` i402_plan (paid, no pay)→ spec x402 challenge: isError:true,
 *                                              v2 PaymentRequired in structuredContent
 *                                              + byte-equal content[0].text +
 *                                              _meta["x402/error"], resource palmyr.ai
 *   (d2) `tools/call` i402_plan with a bogus  → the _meta["x402/payment"] → X-PAYMENT
 *        _meta["x402/payment"]                  bridge fires: settlement is attempted
 *                                               downstream and fails with a non-challenge
 *                                               error (NOT the fresh accepts challenge)
 *   (e) GET /.well-known/mcp-registry-auth   → 200 text/plain "v=MCPv1; ..."
 *       (+ a second child WITHOUT the env → 404)
 *
 * JSON-RPC requests to the SDK transport MUST carry
 * `Accept: application/json, text/event-stream`. Mirrors the i402-server-boot /
 * bazaar-discovery child-process idiom; always rebuilds so it tests the current
 * source.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";

const REPO_ROOT = join(__dirname, "..", "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");
const PUBKEY = "R7kpQ3KRjXMbyoCyAmB+Itjo6w0VdGuK8OlAMgfbBJA=";
const MCP_ACCEPT = "application/json, text/event-stream";

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return reject(new Error("bind failed"));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const s = net.createConnection({ port, host: "127.0.0.1" });
      s.once("connect", () => { s.end(); resolve(true); });
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start listening on port ${port} within ${timeoutMs}ms`);
}

/** POST a JSON-RPC message to /mcp with the required MCP Accept header. */
function mcpPost(port: number, payload: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
        headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
      },
      r => {
        let buf = "";
        r.setEncoding("utf8");
        r.on("data", c => (buf += c));
        r.on("end", () => {
          let body: any = buf;
          try { body = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: r.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

function rawGet(
  port: number,
  path: string,
  method = "GET",
): Promise<{ status: number; text: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method }, r => {
      let buf = "";
      r.setEncoding("utf8");
      r.on("data", c => (buf += c));
      r.on("end", () =>
        resolve({ status: r.statusCode ?? 0, text: buf, contentType: r.headers["content-type"] as string | undefined }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function bootServer(port: number, extraEnv: Record<string, string>): ChildProcess {
  const server = spawn("node", [DIST_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "development",
      TREASURY_WALLET: "B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      I402_AGENTIC_MARKET_CATALOG_URL: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bootLog = "";
  server.stdout?.on("data", d => (bootLog += d.toString()));
  server.stderr?.on("data", d => (bootLog += d.toString()));
  server.on("exit", code => {
    if (code !== null && code !== 0) console.error(`Server exited ${code}. Boot log:\n${bootLog}`);
  });
  return server;
}

async function killAndWait(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  const done = new Promise<void>(resolve => proc.once("exit", () => resolve()));
  proc.kill("SIGTERM");
  const timer = setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 3000);
  await done;
  clearTimeout(timer);
}

const initRequest = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } },
};

describe("hosted MCP server (/mcp)", () => {
  let server: ChildProcess;
  let port: number;

  before(async () => {
    const b = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, shell: true, stdio: "inherit" });
    if (b.status !== 0) throw new Error("npm run build failed");
    port = await findFreePort();
    server = bootServer(port, { MCP_REGISTRY_PUBKEY: PUBKEY });
    await waitForPort(port, 30_000);
  });

  after(async () => {
    if (server) await killAndWait(server);
  });

  it("(a) responds to JSON-RPC initialize with serverInfo", async () => {
    const res = await mcpPost(port, initRequest);
    assert.equal(res.status, 200, "initialize should be 200");
    assert.ok(res.body?.result?.serverInfo, "result.serverInfo present");
    assert.ok(res.body.result.serverInfo.name, "serverInfo.name present");
    assert.equal(res.body.result.serverInfo.name, "ai.palmyr/palmyr");
  });

  it("(b) tools/list returns >= 12 tools incl. i402_plan + palmyr_pricing", async () => {
    const res = await mcpPost(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(res.status, 200);
    const tools = res.body?.result?.tools;
    assert.ok(Array.isArray(tools), "result.tools is an array");
    assert.ok(tools.length >= 12, `expected >= 12 tools, got ${tools.length}`);
    const names = new Set(tools.map((t: any) => t.name));
    assert.ok(names.has("i402_plan"), "includes i402_plan");
    assert.ok(names.has("palmyr_pricing"), "includes palmyr_pricing");
  });

  it("(c) tools/call palmyr_pricing returns pricing JSON", async () => {
    const res = await mcpPost(port, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "palmyr_pricing", arguments: {} },
    });
    assert.equal(res.status, 200);
    assert.ok(!res.body.result.isError, "not an error result");
    const inner = JSON.parse(res.body.result.content[0].text);
    assert.equal(inner.currency, "USDC");
    assert.ok(Array.isArray(inner.routes) && inner.routes.length > 0, "pricing routes present");
  });

  it("(d) tools/call on a paid tool without payment returns the spec v2 x402 challenge", async () => {
    const res = await mcpPost(port, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "i402_plan", arguments: { intent: "test intent", budget_usdc: 1 } },
    });
    assert.equal(res.status, 200);
    // Spec behavior flip: the payment challenge is now an isError:true result.
    assert.equal(res.body.result.isError, true, "payment challenge is an isError result (spec)");

    // v2 PaymentRequired in structuredContent.
    const sc = res.body.result.structuredContent;
    assert.ok(sc, "structuredContent present");
    assert.equal(sc.x402Version, 2, "x402Version:2");
    assert.ok(Array.isArray(sc.accepts) && sc.accepts.length >= 1, "non-empty accepts array");

    // content[0].text must parse to the SAME PaymentRequired object (fallback).
    const inner = JSON.parse(res.body.result.content[0].text);
    assert.deepEqual(inner, sc, "content[0].text parses to the same PaymentRequired object");
    assert.equal(res.body.result.content[0].text, JSON.stringify(sc), "content[0].text byte-equal to structuredContent");

    // _meta mirror for Cloudflare-client compat.
    assert.ok(res.body.result._meta && res.body.result._meta["x402/error"], "_meta['x402/error'] mirror present");
    assert.deepEqual(res.body.result._meta["x402/error"], sc, "_meta['x402/error'] equals the challenge");

    // Resource shows palmyr.ai, never the loopback origin.
    const resourceUrl = typeof sc.resource === "string" ? sc.resource : sc.resource?.url;
    assert.ok(typeof resourceUrl === "string" && resourceUrl.includes("palmyr.ai"), "resource shows palmyr.ai");
    assert.ok(!JSON.stringify(sc).includes("127.0.0.1"), "challenge must not leak loopback");
  });

  it("(d2) tools/call with a bogus _meta['x402/payment'] fires the X-PAYMENT bridge (settlement attempted, not the fresh challenge)", async () => {
    // A decoded PaymentPayload object at params._meta["x402/payment"] must be
    // re-encoded to the base64 X-PAYMENT header and forwarded to the loopback.
    // A bogus EVM payload routes to the (unreachable-in-test) facilitator, so
    // the loopback settlement path errors out — proving the bridge fired,
    // because a NO-payment call instead returns the accepts challenge.
    const res = await mcpPost(port, {
      jsonrpc: "2.0", id: 44, method: "tools/call",
      params: {
        name: "i402_plan",
        arguments: { intent: "test intent", budget_usdc: 1 },
        _meta: {
          "x402/payment": {
            x402Version: 2,
            scheme: "exact",
            network: "eip155:8453",
            payload: { signature: "0xdeadbeef", authorization: {} },
          },
        },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, true, "bogus payment still yields an error result");
    const inner = JSON.parse(res.body.result.content[0].text);
    // The KEY discriminator: a fresh no-payment challenge always carries a
    // non-empty `accepts`. The bridge having fired means we settled downstream
    // and failed with a different (non-challenge) error → no accepts here.
    assert.ok(
      !Array.isArray(inner.accepts) || inner.accepts.length === 0,
      "bridge fired: forwarded X-PAYMENT and failed downstream, not a fresh accepts challenge",
    );
    assert.ok(res.body.result.structuredContent === undefined, "no PaymentRequired challenge was returned");
  });

  it("GET and DELETE /mcp return a JSON-RPC 405", async () => {
    const g = await rawGet(port, "/mcp", "GET");
    assert.equal(g.status, 405);
    const d = await rawGet(port, "/mcp", "DELETE");
    assert.equal(d.status, 405);
  });

  it("(e) serves /.well-known/mcp-registry-auth as text/plain when configured", async () => {
    const res = await rawGet(port, "/.well-known/mcp-registry-auth");
    assert.equal(res.status, 200);
    assert.ok((res.contentType || "").startsWith("text/plain"), "content-type text/plain");
    assert.equal(res.text, `v=MCPv1; k=ed25519; p=${PUBKEY}`);
  });

  it("(e) returns 404 for /.well-known/mcp-registry-auth when the pubkey env is unset", async () => {
    const port2 = await findFreePort();
    const server2 = bootServer(port2, {}); // no MCP_REGISTRY_PUBKEY
    try {
      await waitForPort(port2, 30_000);
      const res = await rawGet(port2, "/.well-known/mcp-registry-auth");
      assert.equal(res.status, 404);
    } finally {
      await killAndWait(server2);
    }
  });
});
