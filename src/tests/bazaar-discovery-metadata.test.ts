/**
 * Bazaar discovery-metadata smoke test.
 *
 * Boots the BUILT server (`node dist/index.js`) on a temp port and probes a
 * known paid route (`POST /chat`) with no payment header, then asserts the 402
 * body carries the spec-shaped Bazaar discovery metadata:
 *
 *   - resource.serviceName  (≤32 printable ASCII, starts with "Palmyr")
 *   - resource.iconUrl      (absolute https brand icon)
 *   - resource.tags         (array)
 *   - extensions.bazaar.info.input / .output   (spec `info` envelope)
 *   - extensions.bazaar.schema                 (legacy x402scan shape, KEPT)
 *   - accepts[].extensions.bazaar.info         (per-accepts duplication)
 *
 * Forces a fresh `npm run build` in `before` so it always exercises the current
 * source, not a stale dist. Mirrors the i402-server-boot child-process idiom.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";

const REPO_ROOT = join(__dirname, "..", "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

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
      s.once("connect", () => {
        s.end();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start listening on port ${port} within ${timeoutMs}ms`);
}

function postJson(
  port: number,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
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

function getJson(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path }, r => {
      let buf = "";
      r.setEncoding("utf8");
      r.on("data", c => (buf += c));
      r.on("end", () => {
        let body: any = buf;
        try { body = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: r.statusCode ?? 0, body });
      });
    }).on("error", reject);
  });
}

async function killAndWait(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  const done = new Promise<void>(resolve => proc.once("exit", () => resolve()));
  proc.kill("SIGTERM");
  const timer = setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 3000);
  await done;
  clearTimeout(timer);
}

const ICON_URL = "https://palmyr.ai/favicon.png";

describe("Bazaar discovery metadata", () => {
  let server: ChildProcess;
  let port: number;

  before(async () => {
    // Always build so we test the CURRENT source, not a stale dist.
    const b = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, shell: true, stdio: "inherit" });
    if (b.status !== 0) throw new Error("npm run build failed");

    port = await findFreePort();
    server = spawn("node", [DIST_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "development",
        TREASURY_WALLET: "B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
        USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        I402_AGENTIC_MARKET_CATALOG_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bootLog = "";
    server.stdout?.on("data", d => (bootLog += d.toString()));
    server.stderr?.on("data", d => (bootLog += d.toString()));
    server.on("exit", code => {
      if (code !== null && code !== 0) console.error(`Server exited ${code}. Boot log:\n${bootLog}`);
    });
    await waitForPort(port, 30_000);
  });

  after(async () => {
    if (server) await killAndWait(server);
  });

  it("emits spec-shaped resource + info metadata in the 402 body", async () => {
    const res = await postJson(port, "/chat", { intent: "test", budget_usdc: 1 });
    assert.equal(res.status, 402, "POST /chat without payment must 402");

    // Resource-level Bazaar metadata.
    const resource = res.body.resource;
    assert.ok(resource && typeof resource === "object", "resource object present");
    assert.equal(typeof resource.serviceName, "string");
    assert.ok(resource.serviceName.length > 0 && resource.serviceName.length <= 32, "serviceName ≤32 chars");
    assert.ok(resource.serviceName.startsWith("Palmyr"), "serviceName starts with Palmyr");
    // Printable ASCII only.
    assert.ok(/^[\x20-\x7E]+$/.test(resource.serviceName), "serviceName printable ASCII");
    assert.equal(resource.iconUrl, ICON_URL, "iconUrl is the absolute brand icon");
    assert.ok(Array.isArray(resource.tags), "tags is an array");
    assert.ok(resource.tags.length <= 5, "tags capped at 5");

    // Spec `info` envelope at extensions.bazaar.info.
    const bazaar = res.body.extensions?.bazaar;
    assert.ok(bazaar && typeof bazaar === "object", "extensions.bazaar present");
    const info = bazaar.info;
    assert.ok(info && typeof info === "object", "extensions.bazaar.info present");
    assert.equal(info.input.type, "http");
    assert.equal(info.input.method, "POST");
    assert.equal(info.input.bodyType, "json", "POST input carries bodyType json");
    assert.ok("body" in info.input, "POST input carries a body example");
    assert.ok(info.output && "example" in info.output, "info.output.example present");

    // Legacy x402scan schema shape must still be present.
    assert.ok(bazaar.schema?.properties?.input, "legacy extensions.bazaar.schema.properties.input kept");
    assert.ok(bazaar.schema?.properties?.output, "legacy extensions.bazaar.schema.properties.output kept");

    // Per-accepts duplication (shared bazaar object reference).
    assert.ok(Array.isArray(res.body.accepts) && res.body.accepts.length >= 1);
    for (const a of res.body.accepts) {
      assert.ok(a.extensions?.bazaar?.info?.input, "per-accepts bazaar.info.input present");
      assert.ok(a.extensions?.bazaar?.schema, "per-accepts legacy schema present");
    }
  });

  it("mirrors the info shape in the /openapi.json discovery surface", async () => {
    const res = await getJson(port, "/openapi.json");
    assert.equal(res.status, 200);
    const op = res.body.paths?.["/chat"]?.post;
    assert.ok(op, "POST /chat present in openapi paths");
    const bazaar = op.extensions?.bazaar;
    assert.ok(bazaar?.info?.input, "openapi op carries bazaar.info.input");
    assert.equal(bazaar.info.input.type, "http");
    assert.equal(bazaar.iconUrl, ICON_URL, "openapi op carries iconUrl");
    assert.ok(typeof bazaar.serviceName === "string" && bazaar.serviceName.startsWith("Palmyr"));
    assert.ok(bazaar.schema?.properties, "openapi op keeps legacy schema shape");
  });
});
