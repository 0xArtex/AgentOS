/**
 * `palmyr tiktok approve` — the human-in-the-loop publish step.
 *
 * It called the post endpoint and then tested `data.success`. Posting is async
 * server-side: the response is a 202 carrying an operation_id and NO `success`
 * field. So the check was false on every single approve. The command reported
 * failure, exited non-zero, and kept the draft — after the payment had been
 * taken and while the video went on to publish in the background. Anyone
 * following the error and re-approving would post the same video twice.
 *
 * These tests drive the real built CLI against a stub server, so they pin the
 * envelope handling rather than a mock of it. State is redirected to a temp dir
 * via PALMYR_SOCIAL_PATH so the developer's own vault is never touched.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

const REPO_ROOT = join(__dirname, "..", "..");
const CLI_DIST = join(REPO_ROOT, "cli", "dist", "cli.js");

let server: http.Server;
let port: number;
let statePath: string;
/** What the stub's operation endpoint should report. */
let opOutcome: { status: string; done: boolean; [k: string]: any } = { status: "done", done: true, video_url: "https://www.tiktok.com/@a/video/7667361872923852800" };
let postCalls = 0;

function draftsDir(): string { return join(statePath, "drafts"); }

function writeDraft(id: string, account = "stubacct"): void {
  mkdirSync(draftsDir(), { recursive: true });
  writeFileSync(
    join(draftsDir(), `${id}.json`),
    JSON.stringify({
      id, platform: "tiktok", account,
      caption: "regression draft",
      url: "https://example.invalid/v.mp4",
      created_at: new Date().toISOString(),
      status: "awaiting_approval",
    }),
  );
}

/**
 * Async on purpose. spawnSync would block this process's event loop, so the
 * stub server below could never answer the CLI's requests and every run would
 * simply time out — the harness deadlocking rather than the code failing.
 */
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ exitCode: number | null; stdout: string; combined: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_DIST, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PALMYR_API: `http://127.0.0.1:${port}`,
        PALMYR_SOCIAL_PATH: statePath,
        PALMYR_JSON: "1",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    const kill = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ exitCode: code, stdout, combined: stdout + stderr });
    });
  });
}

before(async () => {
  statePath = join(tmpdir(), `palmyr-approve-test-${Date.now()}`);
  mkdirSync(statePath, { recursive: true });

  server = http.createServer((req, res) => {
    const url = req.url || "";
    if (req.method === "POST" && url.startsWith("/social/tiktok/post")) {
      postCalls++;
      // The exact envelope the real server returns: 202, an operation_id, and
      // no `success` field anywhere.
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({
        operation_id: "op-stub-1",
        poll_url: "/social/tiktok/operations/op-stub-1",
        status: "running",
        poll_after_seconds: 1,
        message: "Post accepted; poll for completion.",
      }));
      return;
    }
    if (req.method === "GET" && url.startsWith("/social/tiktok/operations/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(opOutcome));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try { rmSync(statePath, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("tiktok approve handles the async post envelope", () => {
  it("reports success when the operation completes, and clears the draft", async () => {
    if (!existsSync(CLI_DIST)) { assert.ok(true, "CLI not built; skipping"); return; }
    opOutcome = { status: "done", done: true, video_url: "https://www.tiktok.com/@a/video/7667361872923852800" };
    postCalls = 0;
    writeDraft("draft-ok");

    const r = await runCli(["tiktok", "approve", "draft-ok"]);
    assert.equal(r.exitCode, 0, `approve must succeed when the op completes.\n${r.combined}`);
    assert.match(r.stdout, /"approved":\s*true/, "the published post must be reported as approved");
    // The draft is consumed only on a real success — leaving it would invite a
    // duplicate post.
    assert.equal(existsSync(join(draftsDir(), "draft-ok.json")), false, "a published draft must be cleared");
    assert.equal(postCalls, 1, "exactly one post call");
  });

  it("writes the post-log entry with the URL the operation actually returned", () => {
    if (!existsSync(CLI_DIST)) { assert.ok(true, "CLI not built; skipping"); return; }
    const logPath = join(statePath, "post-log.jsonl");
    assert.equal(existsSync(logPath), true, "an approved post must be logged");
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.source, "draft");
    assert.equal(entry.status, "posted");
    // The URL only exists on the polled result — reading it off the 202 would
    // have logged undefined.
    assert.match(String(entry.url), /video\/7667361872923852800/);
  });

  it("keeps the draft and exits non-zero when the operation really fails", async () => {
    if (!existsSync(CLI_DIST)) { assert.ok(true, "CLI not built; skipping"); return; }
    opOutcome = { status: "failed", done: false, error: "upload rejected", error_code: "UI_TIMEOUT", refund_status: "sent" };
    writeDraft("draft-fail");

    const r = await runCli(["tiktok", "approve", "draft-fail"]);
    assert.notEqual(r.exitCode, 0, "a genuine failure must exit non-zero");
    assert.match(r.combined, /UI_TIMEOUT/, "the real error code must reach the caller");
    assert.equal(existsSync(join(draftsDir(), "draft-fail.json")), true, "a failed draft is kept so it can be retried");
  });

  it("does not claim success while the operation is still running", async () => {
    if (!existsSync(CLI_DIST)) { assert.ok(true, "CLI not built; skipping"); return; }
    // Never reaches a terminal state within the poll window.
    opOutcome = { status: "running", done: false };
    writeDraft("draft-slow");

    // Short patience so this exercises the timeout branch in seconds, not minutes.
    const r = await runCli(["tiktok", "approve", "draft-slow"], { PALMYR_TIKTOK_POLL_TIMEOUT_MS: "4000" });
    assert.match(r.stdout, /"approved":\s*false/, "an unfinished op is not an approval");
    assert.match(r.stdout, /"status":\s*"running"/);
    // Critically: it must warn against re-approving, because the post may yet
    // publish and a retry would duplicate it.
    assert.match(r.stdout, /re-approve/i, "must warn that a retry could duplicate the post");
    assert.equal(existsSync(join(draftsDir(), "draft-slow.json")), true, "the draft is kept while the op is in flight");
  });
});
