/**
 * End-to-end test of the agent-side executor pipeline.
 *
 * Spawns:
 *   1. A fake Palmyr server on a random port that returns:
 *      - POST /chat → a canned "approved" plan with 3 steps, different URL
 *        shapes (path params, $STEPS.* templating, static endpoints).
 *      - Handlers for each step's endpoint that return canned outputs.
 *   2. The real built CLI binary as a child process with PALMYR_API pointed
 *      at the fake server and PALMYR_WALLET_PASSPHRASE set so the SDK doesn't
 *      try to load a real vault.
 *
 * What this proves (without real wallet / real x402):
 *   - Real SDK chat() → fetches plan, status 'approved'
 *   - Real SDK chatExecute() iterates plan.steps in topological order
 *   - Path-template substitution: "/phone/numbers/{phone_number_id}/send"
 *     becomes "/phone/numbers/abc123/send" with phone_number_id stripped from body
 *   - $STEPS.s1.output.field is resolved into s2's input before s2's request
 *   - Step outputs chain correctly
 *   - Summary event is emitted and the CLI exits 0
 *
 * The fake server returns 200 OK (not 402), so paidRequest short-circuits and
 * no real x402 payment is attempted.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const CLI_DIST = join(REPO_ROOT, "cli", "dist", "cli.js");

// -------------------- Fake Palmyr server --------------------

interface CapturedCall {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

interface FakeServerHandle {
  port: number;
  calls: CapturedCall[];
  close: () => Promise<void>;
}

async function launchFakePalmyr(): Promise<FakeServerHandle> {
  const calls: CapturedCall[] = [];
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Capture every request for later inspection
  app.use((req, _res, next) => {
    calls.push({
      method: req.method,
      path: req.path,
      body: req.body,
      headers: req.headers as any,
    });
    next();
  });

  // POST /chat → returns an already-approved plan with 3 steps.
  // Each step's endpoint points back at this same server on the same port,
  // so the CLI's client-side executor will call them.
  app.post("/chat", (req, res) => {
    const port = (res as any).req.socket.localPort;
    const base = `http://127.0.0.1:${port}`;
    res.status(200).json({
      session_id: "sess_e2e_test",
      plan_id: "plan_e2e_test",
      status: "approved",
      intent: {
        original: req.body?.intent ?? "test",
        interpreted: "Register a domain, deploy a VPS, send an SMS from a phone number.",
      },
      steps: [
        {
          step_id: "s1",
          capability: "register_domain",
          provider: "palmyr.register_domain",
          description: "Register freshkicks.io",
          input: { domain: "freshkicks.io" },
          cost_usdc: 9.99,
          eta_seconds: 20,
          x402: { endpoint: `${base}/domains/register`, method: "POST", payment_rail: "x402-solana" },
        },
        {
          step_id: "s2",
          capability: "send_sms",
          provider: "palmyr.send_sms",
          description: "Confirmation SMS with the registered domain",
          input: {
            phone_number_id: "abc123",
            to: "+15551234567",
            // Ensure $STEPS.* templating resolves from s1's output
            body: "Domain $STEPS.s1.output.domain_registered is registered",
          },
          cost_usdc: 0.05,
          eta_seconds: 1,
          depends_on: ["s1"],
          x402: {
            endpoint: `${base}/phone/numbers/{phone_number_id}/send`,
            method: "POST",
            payment_rail: "x402-solana",
          },
        },
        {
          step_id: "s3",
          capability: "deploy_vps",
          provider: "palmyr.deploy_vps",
          description: "Deploy a VPS",
          input: { name: "srv-fresh", serverType: "cx23" },
          cost_usdc: 6.0,
          eta_seconds: 60,
          x402: { endpoint: `${base}/compute/servers`, method: "POST", payment_rail: "x402-solana" },
        },
      ],
      totals: {
        step_cost_usdc: 16.04,
        orchestration_fee_usdc: 2.41,
        total_cost_usdc: 18.45,
        within_budget: true,
        eta_seconds: 81,
      },
    });
  });

  app.post("/domains/register", (_req, res) => {
    res.status(200).json({
      id: "dom_1",
      domain: "freshkicks.io",
      domain_registered: "freshkicks.io",
      expires_at: "2027-04-22",
      registrar: "namecheap",
    });
  });

  app.post("/phone/numbers/abc123/send", (_req, res) => {
    res.status(200).json({ message_id: "msg_1", status: "delivered" });
  });

  app.post("/compute/servers", (_req, res) => {
    res.status(200).json({ id: "srv_1", ipv4: "203.0.113.42", status: "running" });
  });

  return new Promise<FakeServerHandle>(resolve => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind failed");
      resolve({
        port: addr.port,
        calls,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

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

async function runCli(args: string[], env: Record<string, string>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const proc: ChildProcess = spawn("node", [CLI_DIST, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", d => (stdout += d.toString()));
    proc.stderr?.on("data", d => (stderr += d.toString()));
    const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    proc.on("exit", code => {
      clearTimeout(killer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

// -------------------- Tests --------------------

describe("i402 end-to-end (fake Palmyr + real CLI binary)", () => {
  let server: FakeServerHandle;

  before(async () => {
    if (!existsSync(CLI_DIST)) {
      const r = spawnSync("npm", ["run", "build"], { cwd: join(REPO_ROOT, "cli"), shell: true, stdio: "inherit" });
      if (r.status !== 0) throw new Error("CLI build failed");
    }
    // Also ensure the server dist exists, but we don't actually use it here.
    await findFreePort(); // warm port-finder; side-effect-free
    server = await launchFakePalmyr();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("drives a 3-step plan end-to-end: path substitution, templating, output chaining", async () => {
    const result = await runCli(
      [
        "chat", "run", "launch a product",
        "--budget", "20",
        "--execute",
      ],
      {
        // The CLI resolves its API base from PALMYR_API (env) || config.api.
        // (An earlier revision passed a --url flag here too, but main() never
        // read it — and the strict unknown-flag guard now rejects it.)
        PALMYR_API: `http://127.0.0.1:${server.port}`,
        // paidRequest lazy-loads the vault; set a dummy passphrase so no prompt.
        PALMYR_WALLET_PASSPHRASE: "test-passphrase-not-used",
        // Skip the chat-run USDC balance preflight: this harness is hermetic
        // (fake server, 200s instead of 402s, no wallet), while the preflight
        // would read the host's real vault/config + a mainnet RPC balance.
        PALMYR_NO_PREFLIGHT: "1",
      }
    );

    // CLI should exit cleanly
    assert.equal(result.exitCode, 0, `CLI exited ${result.exitCode}. stderr: ${result.stderr.slice(0, 500)}`);

    // ── Verify call sequence on the fake server ──
    // Expect at least 4 calls: POST /chat + 3 step calls
    assert.ok(server.calls.length >= 4, `expected ≥4 calls, got ${server.calls.length}: ${server.calls.map(c => c.method + " " + c.path).join(", ")}`);

    const [chatCall, ...stepCalls] = server.calls;
    assert.equal(chatCall.method, "POST");
    assert.equal(chatCall.path, "/chat");

    // Step 1: POST /domains/register with { domain: "freshkicks.io" }
    const step1 = stepCalls.find(c => c.path === "/domains/register");
    assert.ok(step1, `step 1 call to /domains/register not found. Calls: ${stepCalls.map(c => c.path).join(", ")}`);
    assert.equal(step1!.method, "POST");
    assert.equal(step1!.body.domain, "freshkicks.io");

    // Step 2: POST /phone/numbers/abc123/send (path param substituted!) with body NOT containing phone_number_id
    const step2 = stepCalls.find(c => c.path === "/phone/numbers/abc123/send");
    assert.ok(step2, `step 2 call to /phone/numbers/abc123/send not found. Calls: ${stepCalls.map(c => c.path).join(", ")}`);
    assert.equal(step2!.body.to, "+15551234567");
    assert.equal(
      step2!.body.phone_number_id,
      undefined,
      "phone_number_id should be stripped from body after path-param substitution"
    );
    // $STEPS.s1.output.domain_registered resolves from the fake server's s1 response
    assert.equal(
      step2!.body.body,
      "Domain freshkicks.io is registered",
      `expected $STEPS template to resolve to 'Domain freshkicks.io is registered', got '${step2!.body.body}'`
    );

    // Step 3: POST /compute/servers with { name, serverType }
    const step3 = stepCalls.find(c => c.path === "/compute/servers");
    assert.ok(step3, `step 3 call to /compute/servers not found`);
    assert.equal(step3!.body.serverType, "cx23");
    assert.equal(step3!.body.name, "srv-fresh");

    // ── Verify CLI printed the expected progress ──
    assert.match(result.stdout, /register_domain/, "stdout should mention register_domain");
    assert.match(result.stdout, /send_sms/, "stdout should mention send_sms");
    assert.match(result.stdout, /deploy_vps/, "stdout should mention deploy_vps");
    assert.match(result.stdout, /"status":\s*"completed"/, "stdout should show the summary status 'completed'");
  });

  it("respects topological order — step with depends_on runs after its prerequisite", async () => {
    // The test above already guarantees this implicitly because s2 depends on s1
    // and s2's body contains a $STEPS.s1.output.domain_registered reference — if
    // s2 ran before s1, the template would remain unresolved. The explicit check
    // in the prior test covers this. Here we just verify the call order on the
    // fake server matches: /domains/register must appear before /phone/.../send.
    const registerIdx = server.calls.findIndex(c => c.path === "/domains/register");
    const smsIdx = server.calls.findIndex(c => c.path === "/phone/numbers/abc123/send");
    assert.ok(registerIdx !== -1 && smsIdx !== -1, "both steps should have been called");
    assert.ok(registerIdx < smsIdx, `s1 (idx ${registerIdx}) must run before s2 (idx ${smsIdx})`);
  });
});
