/**
 * How the i402 executor decides an async operation is finished.
 *
 * `running` sits in the terminal-OK word list because for a VPS that IS the
 * finished state — the server is up. For a browser op it means the exact
 * opposite: still working. TikTok ops report `status: 'running'` while in
 * flight, so reading the word alone declared every post complete the moment it
 * started: the executor stopped polling, handed downstream steps an operation
 * handle instead of a video_url, and never waited for the post the caller had
 * already paid for.
 *
 * The rule these tests pin: a service that publishes an explicit `done` boolean
 * knows its own lifecycle better than a shared word list, so when it states it,
 * believe it — and a failure signal still outranks both.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

// Loaded from the BUILT cli output at runtime. A static `import ... from
// "../../cli/sdk"` would drag cli/ into the server tsconfig, whose rootDir is
// src/ — that breaks the build outright. Same reason the CLI smoke tests drive
// the built artifact rather than the sources.
let operationState: (op: any) => string;

before(async () => {
  const dist = join(__dirname, "..", "..", "cli", "dist", "sdk.js");
  if (!existsSync(dist)) throw new Error("cli/dist/sdk.js missing — run `npm run build` in cli/");
  // The full-suite runner transpiles this import() to require(), which rejects
  // a file:// URL; a real ESM runner rejects a bare Windows path. Try the path
  // first, fall back to the URL, so both entry points work.
  const mod: any = await import(dist).catch(() => import(pathToFileURL(dist).href));
  operationState = mod.operationState;
});

describe("i402 async operation classification", () => {
  it("treats a TikTok op that says it is not done as still running", () => {
    // The exact shape GET /social/tiktok/operations/:id returns mid-flight.
    const inFlight = { operation_id: "op1", op: "post", status: "running", done: false, result: null };
    assert.equal(operationState(inFlight), "pending", "'running' + done:false is in progress, not success");
  });

  it("still treats a bare 'running' with no done flag as finished", () => {
    // A VPS reports 'running' to mean the server came up, and carries no `done`
    // field. That behaviour must not regress while fixing the browser ops.
    assert.equal(operationState({ status: "running", poll_url: "/x" }), "ok");
    assert.equal(operationState({ status: "active" }), "ok");
    assert.equal(operationState({ status: "provisioned" }), "ok");
  });

  it("accepts a completed TikTok op", () => {
    const done = { operation_id: "op1", status: "done", done: true, result: { video_url: "https://t/v" } };
    assert.equal(operationState(done), "ok");
  });

  it("reports failure even though the server marks a failed op done", () => {
    // The poll endpoint sets done = (status === 'done' || status === 'failed'),
    // so a failure arrives as done:true. The failure branch must win, or every
    // failed op would be consumed as a success.
    const failed = { operation_id: "op1", status: "failed", done: true, error: "upload rejected", error_code: "UI_TIMEOUT" };
    assert.equal(operationState(failed), "failed");
  });

  it("does not read a payment challenge as a failed operation", () => {
    // A paid, owner-gated poll endpoint answers 402 first. The poller settles it
    // and retries; reading the challenge body's error as failure would abort a
    // perfectly healthy operation.
    assert.equal(operationState({ x402Version: 1, accepts: [{ scheme: "exact" }], error: "Payment Required" }), "pending");
  });

  it("defaults to pending for anything it does not recognise", () => {
    // Guessing 'ok' here is what turns an unknown state into a fabricated
    // success; waiting is always the safe direction.
    assert.equal(operationState({ status: "queued" }), "pending");
    assert.equal(operationState({}), "pending");
    assert.equal(operationState(null), "pending");
    assert.equal(operationState("nonsense"), "pending");
  });
});
