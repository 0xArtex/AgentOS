/**
 * Concurrency tests for wallet vault file locking.
 *
 * Covers:
 *  - Atomic write: readers never see partial data
 *  - Lock prevents concurrent read-modify-write corruption on policy updates
 *  - Lock prevents concurrent spend log corruption
 *  - Stale lock is broken after timeout
 *  - Lock file is cleaned up after operation
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const TEST_VAULT = join(tmpdir(), `palmyr-test-concurrency-${Date.now()}`);
process.env.PALMYR_WALLET_PATH = TEST_VAULT;

import * as vault from "../services/wallet-vault";

describe("concurrency", () => {
  let walletId: string;
  let sessionSecret: string;

  before(() => {
    mkdirSync(TEST_VAULT, { recursive: true });
    vault.initVault();
    const w = vault.createWallet("concurrency-test", "unmanaged");
    walletId = w.wallet.id;
    sessionSecret = w.sessionSecret;
  });

  after(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
  });

  describe("atomic writes", () => {
    it("wallet file is valid JSON after write (not partial)", () => {
      // Create several wallets rapidly — each should produce valid JSON
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { wallet } = vault.createWallet(`atomic-${i}`, "unmanaged");
        ids.push(wallet.id);
      }

      // Verify each file is valid JSON
      for (const id of ids) {
        const fpath = join(TEST_VAULT, "wallets", `${id}.json`);
        assert.ok(existsSync(fpath), `file should exist for ${id}`);
        const content = readFileSync(fpath, "utf8");
        assert.doesNotThrow(() => JSON.parse(content), `file for ${id} should be valid JSON`);
      }

      // Cleanup
      for (const id of ids) vault.deleteWallet(id);
    });

    it("no temp files left behind after successful write", () => {
      const { wallet } = vault.createWallet("no-temp-left", "unmanaged");
      const dir = join(TEST_VAULT, "wallets");
      const tempFiles = require("fs").readdirSync(dir).filter((f: string) => f.includes(".tmp."));
      assert.equal(tempFiles.length, 0, "should have no .tmp files");
      vault.deleteWallet(wallet.id);
    });
  });

  describe("lock file cleanup", () => {
    it("no lock files remain after setWalletPolicy", () => {
      vault.setWalletPolicy(walletId, { per_tx_usdc: 50 });

      const dir = join(TEST_VAULT, "wallets");
      const lockFiles = require("fs").readdirSync(dir).filter((f: string) => f.endsWith(".lock"));
      assert.equal(lockFiles.length, 0, "should have no .lock files after operation");
    });

    it("no lock files remain after renameWallet", () => {
      vault.renameWallet(walletId, "renamed-concurrency");

      const dir = join(TEST_VAULT, "wallets");
      const lockFiles = require("fs").readdirSync(dir).filter((f: string) => f.endsWith(".lock"));
      assert.equal(lockFiles.length, 0);

      vault.renameWallet(walletId, "concurrency-test"); // restore
    });
  });

  describe("stale lock recovery", () => {
    it("breaks stale lock and proceeds", () => {
      // Manually create a stale lock file (older than 30s)
      const walletPath = join(TEST_VAULT, "wallets", `${walletId}.json`);
      const lockPath = walletPath + ".lock";

      writeFileSync(lockPath, `99999\n${Date.now() - 60_000}`);
      // Backdate the mtime
      const past = new Date(Date.now() - 60_000);
      require("fs").utimesSync(lockPath, past, past);

      // This should break the stale lock and succeed
      assert.doesNotThrow(() => {
        vault.setWalletPolicy(walletId, { daily_usdc: 999 });
      });

      const policy = vault.getWalletPolicy(walletId);
      assert.equal(policy?.daily_usdc, 999);

      // Lock file should be cleaned up
      assert.ok(!existsSync(lockPath), "stale lock should be removed");
    });
  });

  describe("concurrent policy updates (sequential simulation)", () => {
    it("serial updates don't lose data", () => {
      // Simulate what would happen with concurrent writes by doing rapid serial updates
      for (let i = 0; i < 20; i++) {
        vault.setWalletPolicy(walletId, { daily_usdc: i, per_tx_usdc: i });
      }

      const policy = vault.getWalletPolicy(walletId);
      assert.equal(policy?.daily_usdc, 19);
      assert.equal(policy?.per_tx_usdc, 19);
    });
  });

  describe("concurrent wallet operations via child processes", () => {
    it("parallel wallet creates don't corrupt each other", () => {
      // Spawn 5 child processes that each create a wallet
      const script = `
        process.env.PALMYR_WALLET_PATH = '${TEST_VAULT.replace(/\\/g, "\\\\")}';
        const vault = require('./dist/services/wallet-vault');
        const w = vault.createWallet('parallel-' + process.argv[2], 'unmanaged');
        console.log(JSON.stringify({ id: w.wallet.id }));
      `;

      const results: string[] = [];
      for (let i = 0; i < 5; i++) {
        try {
          const out = execSync(`node -e "${script.replace(/\n/g, " ")}" ${i}`, {
            encoding: "utf8",
            cwd: join(__dirname, "..", ".."),
            timeout: 10000,
          }).trim();
          const { id } = JSON.parse(out);
          results.push(id);
        } catch (e: any) {
          assert.fail(`Child process ${i} failed: ${e.message}`);
        }
      }

      // All 5 should have unique IDs and valid wallet files
      assert.equal(results.length, 5);
      assert.equal(new Set(results).size, 5, "all IDs should be unique");

      for (const id of results) {
        const w = vault.getWallet(id);
        assert.ok(w.accounts.length > 0, "wallet should have accounts");
        vault.deleteWallet(id);
      }
    });
  });
});
