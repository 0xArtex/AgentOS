/**
 * Agent Skills discovery + hosted references smoke test.
 *
 * Boots the BUILT server (`node dist/index.js`) on a temp port and probes:
 *
 *   (a) GET /.well-known/agent-skills/index.json → 200, $schema v0.2.0 exact,
 *       one skill named "palmyr" (type skill-md, url /skill.md), and its digest
 *       equals sha256 computed over the EXACT bytes fetched from /skill.md.
 *   (b) GET /skill/references/payment.md         → 200 text/markdown.
 *   (c) GET /skill/references/..%2f..%2fpackage.json and a plain ../ variant → 404.
 *   (d) GET /skill.md                            → 200 and starts with "---\nname: palmyr".
 *
 * Mirrors the mcp-server / bazaar-discovery child-process idiom; always rebuilds
 * so it tests the current source.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";

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
      s.once("connect", () => { s.end(); resolve(true); });
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start listening on port ${port} within ${timeoutMs}ms`);
}

/** GET raw bytes (no text decoding) so digests match the exact wire bytes. */
function rawGetBuffer(
  port: number,
  path: string,
  method = "GET",
): Promise<{ status: number; body: Buffer; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method }, r => {
      const chunks: Buffer[] = [];
      r.on("data", c => chunks.push(c as Buffer));
      r.on("end", () =>
        resolve({
          status: r.statusCode ?? 0,
          body: Buffer.concat(chunks),
          contentType: r.headers["content-type"] as string | undefined,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function bootServer(port: number): ChildProcess {
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

describe("agent skills discovery + references", () => {
  let server: ChildProcess;
  let port: number;

  before(async () => {
    const b = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, shell: true, stdio: "inherit" });
    if (b.status !== 0) throw new Error("npm run build failed");
    port = await findFreePort();
    server = bootServer(port);
    await waitForPort(port, 30_000);
  });

  after(async () => {
    if (server) await killAndWait(server);
  });

  it("(a) index.json is 200, v0.2.0 schema, one palmyr skill with a digest matching /skill.md", async () => {
    const idx = await rawGetBuffer(port, "/.well-known/agent-skills/index.json");
    assert.equal(idx.status, 200, "index.json should be 200");
    const json = JSON.parse(idx.body.toString("utf8"));
    assert.equal(
      json.$schema,
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      "$schema exact",
    );
    assert.ok(Array.isArray(json.skills) && json.skills.length === 1, "exactly one skill entry");
    const skill = json.skills[0];
    assert.equal(skill.name, "palmyr");
    assert.equal(skill.type, "skill-md");
    assert.equal(skill.url, "/skill.md");
    assert.ok(typeof skill.description === "string" && skill.description.length > 0, "has description");
    assert.match(skill.digest, /^sha256:[0-9a-f]{64}$/, "digest is sha256:<64-hex>");

    // Digest must match the exact bytes served at /skill.md.
    const md = await rawGetBuffer(port, "/skill.md");
    assert.equal(md.status, 200);
    const expected = "sha256:" + crypto.createHash("sha256").update(md.body).digest("hex");
    assert.equal(skill.digest, expected, "digest matches sha256 over /skill.md body");
  });

  it("(b) serves /skill/references/payment.md as text/markdown", async () => {
    const res = await rawGetBuffer(port, "/skill/references/payment.md");
    assert.equal(res.status, 200);
    assert.ok((res.contentType || "").startsWith("text/markdown"), "content-type text/markdown");
    assert.ok(res.body.toString("utf8").length > 0, "non-empty body");
  });

  it("(c) rejects path traversal on references with 404", async () => {
    const encoded = await rawGetBuffer(port, "/skill/references/..%2f..%2fpackage.json");
    assert.equal(encoded.status, 404, "encoded ../ traversal → 404");
    assert.ok(!encoded.body.toString("utf8").includes('"version"'), "must not leak package.json");

    const plain = await rawGetBuffer(port, "/skill/references/../package.json");
    assert.equal(plain.status, 404, "plain ../ traversal → 404");
  });

  it("(d) /skill.md still 200 and starts with the palmyr frontmatter", async () => {
    const res = await rawGetBuffer(port, "/skill.md");
    assert.equal(res.status, 200);
    // CRLF-tolerant: git autocrlf may rewrite line endings on a Windows checkout.
    assert.match(res.body.toString("utf8"), /^---\r?\nname: palmyr\r?\n/, "starts with ---\\nname: palmyr");
  });
});
