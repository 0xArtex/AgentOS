/**
 * Tests for the two CLI guards (cli/cli-guards.ts + cli.ts wiring):
 *
 *   1. Strict unknown-flag guard — a typo like `--dubject` must fail fast
 *      with `Unknown flag: --dubject` + the command's valid flags, instead
 *      of falling through the parser and resurfacing as a confusing
 *      "missing required flag" error.
 *
 *   2. `chat run` USDC balance preflight — the pure comparison/message
 *      helpers, plus the CLI-level no-wallet abort path (which fires before
 *      any network call or payment) and its --skip-balance-check override.
 *
 * The pure helpers are dynamic-imported from the BUILT cli/dist/cli-guards.js:
 * the CLI package is ESM while this test runner is CJS, and a computed import
 * specifier keeps tsc out of cross-package resolution (same reasoning as the
 * replicate-don't-import note in cli-vault-scrypt.test.ts — except here the
 * logic is pure, so we can test the real artifact instead of a replica).
 * CLI-level behavior is tested by spawning the built binary, same as
 * i402-cli-smoke.test.ts.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(__dirname, "..", "..");
const CLI_DIR = join(REPO_ROOT, "cli");
const CLI_DIST = join(CLI_DIR, "dist", "cli.js");
const GUARDS_DIST = join(CLI_DIR, "dist", "cli-guards.js");

// Loaded in before() from the built ESM artifact; typed loosely on purpose.
let guards: any;

// ts-node compiles this file as CommonJS, which transpiles `import()` into
// `require()` — and require cannot load an ESM module. Evaluate a NATIVE
// dynamic import at runtime instead so the ESM artifact loads correctly.
const importEsm = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync("node", [CLI_DIST, ...args], {
    cwd: REPO_ROOT,
    // PALMYR_JSON=1 → deterministic agent-mode output (JSON errors on stderr).
    // PALMYR_NO_PREFLIGHT="" → never inherit a preflight opt-out from the host.
    env: { ...process.env, PALMYR_JSON: "1", PALMYR_NO_PREFLIGHT: "", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    exitCode: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    combined: (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

describe("CLI guards", () => {
  before(async () => {
    if (!existsSync(CLI_DIST) || !existsSync(GUARDS_DIST)) {
      const r = spawnSync("npm", ["run", "build"], { cwd: CLI_DIR, shell: true, stdio: "inherit" });
      if (r.status !== 0) throw new Error("CLI build failed");
    }
    guards = await importEsm(pathToFileURL(GUARDS_DIST).href);
  });

  // -------------------- pure: findUnknownFlags --------------------

  describe("findUnknownFlags", () => {
    it("flags a typo, passes documented flags", () => {
      const allowed = new Set(["subject", "to", "body", "id", ...guards.GLOBAL_FLAGS]);
      assert.deepEqual(guards.findUnknownFlags(["dubject", "to"], allowed), ["dubject"]);
      assert.deepEqual(guards.findUnknownFlags(["subject", "json", "help"], allowed), []);
    });

    it("handles the --no-<x> convention in both directions", () => {
      // documented --usd → --no-usd is valid
      assert.deepEqual(guards.findUnknownFlags(["no-usd"], new Set(["usd"])), []);
      // documented --no-wait → bare --wait is valid
      assert.deepEqual(guards.findUnknownFlags(["wait"], new Set(["no-wait"])), []);
      // but an unrelated no- typo is still caught
      assert.deepEqual(guards.findUnknownFlags(["no-dubject"], new Set(["usd"])), ["no-dubject"]);
    });

    it("is case-insensitive and de-duplicates, preserving the typed form", () => {
      assert.deepEqual(guards.findUnknownFlags(["publicKey"], new Set(["publickey"])), []);
      assert.deepEqual(guards.findUnknownFlags(["Dubject", "Dubject"], new Set(["subject"])), ["Dubject"]);
    });
  });

  // -------------------- pure: flagNamesFromTable --------------------

  describe("flagNamesFromTable", () => {
    it("derives flag names from flag, desc, and hint strings", () => {
      const table = {
        send: [
          { flag: "--subject <text>", desc: "Subject line (required)" },
          { flag: "<ID>", desc: "Inbox id (positional or --id)", hint: "also accepts --inbox-id" },
        ],
      };
      const names = guards.flagNamesFromTable(table);
      assert.ok(names.has("subject"));
      assert.ok(names.has("id"));
      assert.ok(names.has("inbox-id"));
      assert.ok(!names.has("send"));
    });

    it("returns an empty set for an undefined table", () => {
      assert.equal(guards.flagNamesFromTable(undefined).size, 0);
    });
  });

  // -------------------- pure: usdcShortfall --------------------

  describe("usdcShortfall", () => {
    it("returns null when the balance covers the requirement (incl. exact match)", () => {
      assert.equal(guards.usdcShortfall(10, 5), null);
      assert.equal(guards.usdcShortfall(0.1, 0.1), null);
      // float noise: 0.3 - 0.2 = 0.09999... must still pass a 0.1 requirement
      assert.equal(guards.usdcShortfall(0.3 - 0.2, 0.1), null);
    });

    it("returns the shortfall when the balance is positively known to be short", () => {
      assert.equal(guards.usdcShortfall(2.5, 10.6), 8.1);
      assert.equal(guards.usdcShortfall(0, 0.1), 0.1);
    });

    it("never blocks on an unknown balance or a non-positive requirement", () => {
      assert.equal(guards.usdcShortfall(null, 10), null);
      assert.equal(guards.usdcShortfall(undefined, 10), null);
      assert.equal(guards.usdcShortfall(5, NaN), null);
      assert.equal(guards.usdcShortfall(5, 0), null);
    });
  });

  // -------------------- pure: insufficientBalanceMessage --------------------

  describe("insufficientBalanceMessage", () => {
    it("shows balance vs required, funding target, and the override flag", () => {
      const msg = guards.insufficientBalanceMessage({
        balanceUsdc: 2.5,
        requiredUsdc: 10.6,
        chain: "solana",
        walletAddress: "GqSsWalletAddr",
        context: "this plan",
      });
      assert.ok(msg.includes("$2.50"));
      assert.ok(msg.includes("$10.60"));
      assert.ok(msg.includes("$8.10")); // shortfall
      assert.ok(msg.includes("GqSsWalletAddr"));
      assert.ok(msg.includes("solana"));
      assert.ok(msg.includes("--skip-balance-check"));
      assert.ok(msg.toLowerCase().includes("estimate"));
    });

    it("falls back to a generic wallet mention when no address is known", () => {
      const msg = guards.insufficientBalanceMessage({
        balanceUsdc: 0,
        requiredUsdc: 0.1,
        chain: "base",
        walletAddress: null,
        context: "the $0.10 i402 orchestration fee",
      });
      assert.ok(msg.includes("your pay wallet"));
      assert.ok(msg.includes("orchestration fee"));
    });
  });

  // -------------------- binary: unknown-flag guard --------------------

  describe("unknown-flag guard (spawned binary)", () => {
    it("`email send --dubject` exits 2 with `Unknown flag` + the valid flags", () => {
      const r = runCli(["email", "send", "--dubject", "hi"], { PALMYR_API: "http://127.0.0.1:1" });
      assert.equal(r.exitCode, 2);
      assert.ok(r.stderr.includes("Unknown flag: --dubject"), `stderr was: ${r.stderr}`);
      assert.ok(r.stderr.includes("--subject"), "should list the command's valid flags");
    });

    it("documented flags still fall through to the command's own validation", () => {
      // Missing --id → the command's usual BAD_INPUT error, NOT the guard's.
      const r = runCli(["email", "send", "--subject", "hi"], { PALMYR_API: "http://127.0.0.1:1" });
      assert.equal(r.exitCode, 2);
      assert.ok(!r.combined.includes("Unknown flag"), `output was: ${r.combined}`);
    });

    it("--help bypasses the guard (help beats strictness)", () => {
      const r = runCli(["email", "send", "--dubject", "hi", "--help"]);
      assert.equal(r.exitCode, 0);
      assert.ok(!r.combined.includes("Unknown flag"));
    });

    it("remote argv after a bare `--` is never flag-checked (compute exec passthrough)", () => {
      const r = runCli(
        ["compute", "exec", "no-such-server-xyz", "--", "systemctl", "status", "--no-pager"],
        { PALMYR_API: "http://127.0.0.1:1" },
      );
      // Fails on the unknown server (NOT_FOUND), never on --no-pager.
      assert.ok(!r.combined.includes("Unknown flag"), `output was: ${r.combined}`);
      assert.notEqual(r.exitCode, 2);
    });

    it("boolean agent-mode flags (--json) pass on every command", () => {
      const r = runCli(["telemetry", "status", "--json"]);
      assert.equal(r.exitCode, 0);
      assert.ok(!r.combined.includes("Unknown flag"));
    });
  });

  // -------------------- binary: chat run balance preflight --------------------

  describe("chat run balance preflight (spawned binary)", () => {
    // An empty vault dir → the preflight cannot resolve a usable pay wallet
    // and must abort BEFORE any network call or payment (PALMYR_API points at
    // a dead port to prove nothing was attempted after the guard).
    const emptyVault = mkdtempSync(join(tmpdir(), "palmyr-guards-vault-"));

    it("aborts with EXIT.PAYMENT before any network call when no pay wallet is usable", () => {
      const r = runCli(["chat", "run", "hi there", "--budget", "1"], {
        PALMYR_API: "http://127.0.0.1:1",
        PALMYR_WALLET_PATH: emptyVault,
        PALMYR_PAY_WALLET: "",
      });
      assert.equal(r.exitCode, 6, `expected payment exit code, got ${r.exitCode}: ${r.combined}`);
      assert.ok(/wallet/i.test(r.stderr), `stderr was: ${r.stderr}`);
      assert.ok(!r.combined.includes("fetch failed"), "must abort before reaching the API");
    });

    it("--skip-balance-check bypasses the preflight (fails later on the dead API instead)", () => {
      const r = runCli(["chat", "run", "hi there", "--budget", "1", "--skip-balance-check"], {
        PALMYR_API: "http://127.0.0.1:1",
        PALMYR_WALLET_PATH: emptyVault,
        PALMYR_PAY_WALLET: "",
      });
      assert.notEqual(r.exitCode, 0);
      assert.notEqual(r.exitCode, 6, `preflight must be skipped, got: ${r.combined}`);
      assert.ok(!r.combined.includes("Insufficient USDC"));
    });

    it("still validates input before spending an RPC call (missing --budget)", () => {
      const r = runCli(["chat", "run", "hi there"], {
        PALMYR_API: "http://127.0.0.1:1",
        PALMYR_WALLET_PATH: emptyVault,
      });
      assert.equal(r.exitCode, 2);
      assert.ok(r.stderr.includes("--budget"));
    });
  });
});
