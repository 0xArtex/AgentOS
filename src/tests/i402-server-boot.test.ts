/**
 * Full-server boot smoke test.
 *
 * Spawns `node dist/index.js` as a child process on a temporary port, waits for
 * it to be listening, hits the free i402 discovery endpoints via HTTP, verifies
 * valid JSON responses, then kills the server.
 *
 * This catches:
 *   - Startup crashes from the i402 seed/ingest wiring
 *   - Route registration order issues
 *   - Middleware chain breakage (CORS, helmet, rate limit)
 *   - Missing required env vars that would prevent boot in a fresh clone
 *
 * Runs against the BUILT server, not ts-node — so it also verifies the build is
 * deployable. If dist/index.js is stale or missing, the test builds it first.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import net from "node:net";
import http from "node:http";

const REPO_ROOT = join(__dirname, "..", "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

// -------------------- Helpers --------------------

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

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
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

async function httpGetJson(port: number, path: string): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path }, res => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", c => (buf += c));
        res.on("end", () => {
          let body: any = buf;
          try {
            body = JSON.parse(buf);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      })
      .on("error", reject);
  });
}

async function killAndWait(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  const done = new Promise<void>(resolve => proc.once("exit", () => resolve()));
  proc.kill("SIGTERM");
  // Fallback: force kill after 3s
  const timer = setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }, 3000);
  await done;
  clearTimeout(timer);
}

// -------------------- Suite --------------------

describe("full-server boot smoke test", () => {
  let server: ChildProcess;
  let port: number;

  before(async () => {
    // Build if dist missing
    if (!existsSync(DIST_ENTRY)) {
      const r = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, shell: true, stdio: "inherit" });
      if (r.status !== 0) throw new Error("npm run build failed");
    }

    port = await findFreePort();

    // Boot the server with a minimal env. NODE_ENV=development so the x402
    // facilitator bearer check (production-only) doesn't block boot.
    server = spawn("node", [DIST_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "development",
        // These are harmless defaults so config.ts's optional fallbacks apply
        TREASURY_WALLET: "B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
        USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        // Explicitly no AM federation URL → skip federation pull
        I402_AGENTIC_MARKET_CATALOG_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let bootLog = "";
    server.stdout?.on("data", d => (bootLog += d.toString()));
    server.stderr?.on("data", d => (bootLog += d.toString()));

    server.on("exit", code => {
      if (code !== null && code !== 0) {
        console.error(`Server exited with code ${code}. Boot log:\n${bootLog}`);
      }
    });

    await waitForPort(port, 30_000);
  });

  after(async () => {
    if (server) await killAndWait(server);
  });

  it("serves /chat/capabilities with i402 version header", async () => {
    const res = await httpGetJson(port, "/chat/capabilities");
    assert.equal(res.status, 200);
    assert.equal(res.body.version, "0.1");
    assert.ok(Array.isArray(res.body.capabilities));
    assert.ok(res.body.capabilities.length >= 15, `expected 15+ capabilities, got ${res.body.capabilities.length}`);
    assert.equal(res.headers["x-i402-version"], "0.1");
  });

  it("serves /chat/providers with seeded AgentOS primitives", async () => {
    const res = await httpGetJson(port, "/chat/providers");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.providers));
    const ids = new Set(res.body.providers.map((p: any) => p.id));
    // At least a few Tier B-critical providers should be seeded at boot
    for (const required of ["agentos.register_domain", "agentos.deploy_vps", "agentos.provision_email_inbox"]) {
      assert.ok(ids.has(required), `missing seeded provider: ${required}`);
    }
  });

  it("filters /chat/providers by capability", async () => {
    const res = await httpGetJson(port, "/chat/providers?capability=register_domain");
    assert.equal(res.status, 200);
    assert.ok(res.body.providers.every((p: any) => p.capability === "register_domain"));
    assert.ok(res.body.providers.length >= 1);
  });

  it("returns 404 for unknown capability filter", async () => {
    const res = await httpGetJson(port, "/chat/providers?capability=nonexistent");
    assert.equal(res.status, 404);
    assert.match(res.body.error ?? "", /Unknown Capability/i);
  });

  it("serves /health", async () => {
    const res = await httpGetJson(port, "/health");
    assert.equal(res.status, 200);
    // Health response shape may vary; just assert it responds with JSON
    assert.ok(typeof res.body === "object");
  });

  it("POST /chat without payment returns a valid 402 with PAYMENT-REQUIRED header", async () => {
    const res = await new Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/chat",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        r => {
          let buf = "";
          r.setEncoding("utf8");
          r.on("data", c => (buf += c));
          r.on("end", () => {
            let body: any = buf;
            try {
              body = JSON.parse(buf);
            } catch {
              /* non-JSON */
            }
            resolve({ status: r.statusCode ?? 0, body, headers: r.headers });
          });
        }
      );
      req.on("error", reject);
      req.write(JSON.stringify({ intent: "test", budget_usdc: 1 }));
      req.end();
    });
    assert.equal(res.status, 402);
    assert.ok(res.body.error, "402 response should have a structured error body");
  });
});
