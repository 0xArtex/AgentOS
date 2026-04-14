/**
 * Tests for credential store input validation and OS integration.
 *
 * The credential store is CLI-only (cli/credential-store.ts) — the server
 * never touches OS keychains. These tests exercise the validation logic
 * and OS integration directly to ensure wallet keys are protected.
 *
 * We replicate the validation and OS calls here rather than importing
 * the ESM CLI module, since the server test runner is CommonJS.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

const SECRETS_DIR = join(homedir(), ".agentos", "secrets");
const HEX_RE = /^[0-9a-f]+$/i;

function assertHex(value: string, label: string): void {
  if (!value || !HEX_RE.test(value)) {
    throw new Error(`${label} must be a non-empty hex string, got: ${typeof value === "string" ? value.slice(0, 20) : typeof value}`);
  }
}

// Minimal DPAPI wrappers for Windows (matching cli/credential-store.ts logic)
function dpapiPath(account: string): string {
  return join(SECRETS_DIR, `${account}.dpapi`);
}

function storeWindows(account: string, secret: string): void {
  if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true });
  const outPath = dpapiPath(account);
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$bytes = [System.Text.Encoding]::UTF8.GetBytes('${secret}')`,
    "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    `[System.IO.File]::WriteAllBytes('${outPath.replace(/\\/g, "\\\\")}', $enc)`,
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore", timeout: 10000 });
}

function retrieveWindows(account: string): string | null {
  const fpath = dpapiPath(account);
  if (!existsSync(fpath)) return null;
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$enc = [System.IO.File]::ReadAllBytes('${fpath.replace(/\\/g, "\\\\")}')`,
    "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[System.Text.Encoding]::UTF8.GetString($dec)",
  ].join("; ");
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 10000 }).trim();
  } catch { return null; }
}

function deleteWindows(account: string): void {
  const fpath = dpapiPath(account);
  if (existsSync(fpath)) unlinkSync(fpath);
}

const isWindows = process.platform === "win32";
const prefix = `aa${Date.now().toString(16)}`;
const cleanup: string[] = [];

describe("credential store", () => {
  after(() => {
    for (const id of cleanup) {
      if (isWindows) deleteWindows(id);
    }
  });

  describe("input validation (hex-only)", () => {
    it("rejects non-hex account (shell injection defense)", () => {
      assert.throws(() => assertHex("'; rm -rf /; echo '", "account"), /must be a non-empty hex string/);
    });

    it("rejects non-hex secret", () => {
      assert.throws(() => assertHex("not-hex-has-special!@#$", "secret"), /must be a non-empty hex string/);
    });

    it("rejects empty string", () => {
      assert.throws(() => assertHex("", "account"), /must be a non-empty hex string/);
    });

    it("rejects account with spaces", () => {
      assert.throws(() => assertHex("aa bb cc", "account"), /must be a non-empty hex string/);
    });

    it("accepts valid hex", () => {
      assert.doesNotThrow(() => assertHex("deadbeef0123456789abcdef", "test"));
    });
  });

  // OS integration tests — only run on Windows since that's what we can test here
  if (isWindows) {
    describe("DPAPI integration (Windows)", () => {
      it("stores and retrieves a secret", () => {
        const account = prefix + "a1";
        const secret = randomBytes(32).toString("hex");
        cleanup.push(account);

        storeWindows(account, secret);
        const retrieved = retrieveWindows(account);
        assert.equal(retrieved, secret);
      });

      it("returns null for missing secret", () => {
        const result = retrieveWindows(prefix + "bb" + randomBytes(8).toString("hex"));
        assert.equal(result, null);
      });

      it("delete removes the secret", () => {
        const account = prefix + "a2";
        cleanup.push(account);

        storeWindows(account, "deadbeef0123456789abcdef");
        assert.equal(retrieveWindows(account), "deadbeef0123456789abcdef");
        deleteWindows(account);
        assert.equal(retrieveWindows(account), null);
      });

      it("multiple secrets don't interfere", () => {
        const a1 = prefix + "c1";
        const a2 = prefix + "c2";
        const s1 = randomBytes(32).toString("hex");
        const s2 = randomBytes(32).toString("hex");
        cleanup.push(a1, a2);

        storeWindows(a1, s1);
        storeWindows(a2, s2);
        assert.equal(retrieveWindows(a1), s1);
        assert.equal(retrieveWindows(a2), s2);
      });

      it("overwrite replaces existing secret", () => {
        const account = prefix + "d1";
        cleanup.push(account);

        storeWindows(account, "aabb0011");
        assert.equal(retrieveWindows(account), "aabb0011");
        storeWindows(account, "ccdd2233");
        assert.equal(retrieveWindows(account), "ccdd2233");
      });
    });
  }
});
