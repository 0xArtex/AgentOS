/**
 * CLI binary smoke tests.
 *
 * Spawns `node cli/dist/cli.js <subcommand>` as child processes and verifies
 * exit codes + output. Catches CLI wiring bugs that don't show up in unit tests
 * (broken imports, bad argv parsing, missing SDK methods on a fresh build).
 *
 * Requires cli/dist/cli.js to be built. Tries to build if missing.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const CLI_DIST = join(REPO_ROOT, "cli", "dist", "cli.js");
const CLI_DIR = join(REPO_ROOT, "cli");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync("node", [CLI_DIST, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    exitCode: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    combined: (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

// -------------------- Setup --------------------

describe("CLI binary smoke tests", () => {
  before(() => {
    if (!existsSync(CLI_DIST)) {
      const r = spawnSync("npm", ["run", "build"], { cwd: CLI_DIR, shell: true, stdio: "inherit" });
      if (r.status !== 0) throw new Error("CLI build failed");
    }
  });

  it("`agentos --version` prints a version string and exits 0", () => {
    const r = runCli(["--version"]);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it("`agentos chat capabilities` calls the API and prints JSON (expect auth error or valid JSON)", () => {
    // Point at a non-existent API so we get a network error rather than hitting production
    const r = runCli(["chat", "capabilities"], { AGENTOS_API: "http://127.0.0.1:1", AGENTOS_TOKEN: "" });
    // Expect non-zero exit because the API isn't reachable, but the CLI should handle it gracefully
    // — no node stack traces in user output for expected network errors
    assert.notEqual(r.exitCode, 0, "expected non-zero exit when API unreachable");
    assert.ok(r.combined.length > 0, "CLI should print something on failure");
  });

  it("`agentos chat` (no subcommand) prints the chat menu without crashing", () => {
    const r = runCli(["chat"]);
    // Ink renders to stdout/stderr; even in non-TTY there should be SOMETHING, and not a crash
    assert.ok(r.combined.length > 0, "chat menu should produce output");
    // Should not leak a node stack trace from an uncaught exception
    assert.ok(!r.combined.includes("UnhandledPromiseRejection"), "no unhandled promise rejections");
  });

  it("`agentos chat bogus` errors out with a usage hint", () => {
    const r = runCli(["chat", "bogus"]);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.combined.includes("Unknown chat command") || r.combined.includes("Try:"), "should hint at valid subcommands");
  });

  it("`agentos chat run` without --budget errors with a clear message", () => {
    const r = runCli(["chat", "run", "do stuff"]);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.combined.includes("budget"), "error should mention --budget");
  });

  it("`agentos chat status` without session_id errors cleanly", () => {
    const r = runCli(["chat", "status"]);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.combined.includes("session_id"), "error should mention session_id");
  });
});
