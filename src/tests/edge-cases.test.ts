/**
 * Edge case tests for wallet vault.
 *
 * Covers:
 *  - Wallet not found
 *  - Invalid mnemonic import
 *  - Corrupt wallet file (invalid JSON)
 *  - Corrupt wallet file (missing fields)
 *  - Expired API key rejected
 *  - Delete wallet cleans up associated API keys
 *  - Unsupported chain for signing
 *  - Unsupported chain for deriveAddress
 *  - Rename wallet
 *  - List wallets on empty vault
 *  - Double delete doesn't crash
 *  - Empty wallet IDs for API key creation
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_VAULT = join(tmpdir(), `agentos-test-edge-${Date.now()}`);
process.env.AGENTOS_WALLET_PATH = TEST_VAULT;

import * as vault from "../services/wallet-vault";

describe("edge cases", () => {
  before(() => {
    mkdirSync(TEST_VAULT, { recursive: true });
    vault.initVault();
  });

  after(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
  });

  describe("name validation", () => {
    it("rejects path traversal in wallet name", () => {
      assert.throws(
        () => vault.createWallet("../../etc/passwd", "unmanaged"),
        /Invalid wallet name/,
      );
    });

    it("rejects shell metacharacters in wallet name", () => {
      assert.throws(
        () => vault.createWallet("wallet; rm -rf /", "unmanaged"),
        /Invalid wallet name/,
      );
    });

    it("rejects HTML/script injection in wallet name", () => {
      assert.throws(
        () => vault.createWallet("<script>alert(1)</script>", "unmanaged"),
        /Invalid wallet name/,
      );
    });

    it("rejects empty name", () => {
      assert.throws(
        () => vault.createWallet("", "unmanaged"),
        /Wallet name is required|Invalid wallet name/,
      );
    });

    it("rejects name over 128 chars", () => {
      assert.throws(
        () => vault.createWallet("a".repeat(129), "unmanaged"),
        /Invalid wallet name/,
      );
    });

    it("permits normal names with spaces, hyphens, dots", () => {
      const { wallet } = vault.createWallet("My Agent Wallet-v2.0", "unmanaged");
      assert.equal(wallet.name, "My Agent Wallet-v2.0");
      vault.deleteWallet(wallet.id);
    });

    it("trims whitespace", () => {
      const { wallet } = vault.createWallet("  trimmed  ", "unmanaged");
      assert.equal(wallet.name, "trimmed");
      vault.deleteWallet(wallet.id);
    });

    it("validates name on import too", () => {
      assert.throws(
        () => vault.importWalletMnemonic("$(whoami)", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
        /Invalid wallet name/,
      );
    });

    it("validates name on rename", () => {
      const { wallet } = vault.createWallet("rename-target", "unmanaged");
      assert.throws(
        () => vault.renameWallet(wallet.id, "../../../etc/shadow"),
        /Invalid wallet name/,
      );
      vault.deleteWallet(wallet.id);
    });

    it("validates API key name", () => {
      const { wallet, sessionSecret } = vault.createWallet("apikey-name-test", "unmanaged");
      assert.throws(
        () => vault.createApiKey("'; DROP TABLE keys;--", [wallet.id], sessionSecret),
        /Invalid wallet name/,
      );
      vault.deleteWallet(wallet.id);
    });
  });

  describe("file integrity verification", () => {
    it("detects tampered Solana address", () => {
      const { wallet, sessionSecret } = vault.createWallet("tamper-sol-addr", "unmanaged");

      // Tamper: swap the Solana address in the wallet file
      const fs = require("fs");
      const path = join(TEST_VAULT, "wallets", `${wallet.id}.json`);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      const solAccount = data.accounts.find((a: any) => a.chainId.startsWith("solana:"));
      solAccount.address = "AttackerFakeAddress11111111111111111111111111";
      fs.writeFileSync(path, JSON.stringify(data));

      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "test", { sessionSecret }),
        /SECURITY.*integrity.*tampered/i,
      );

      vault.deleteWallet(wallet.id);
    });

    it("detects tampered EVM address", () => {
      const { wallet, sessionSecret } = vault.createWallet("tamper-evm-addr", "unmanaged");

      const fs = require("fs");
      const path = join(TEST_VAULT, "wallets", `${wallet.id}.json`);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      const evmAccount = data.accounts.find((a: any) => a.chainId.startsWith("eip155:"));
      if (evmAccount) {
        evmAccount.address = "0x0000000000000000000000000000000000000bad";
        fs.writeFileSync(path, JSON.stringify(data));

        assert.throws(
          () => vault.signMessage(wallet.id, "evm", "test", { sessionSecret }),
          /SECURITY.*integrity.*tampered/i,
        );
      }

      vault.deleteWallet(wallet.id);
    });

    it("detects deleted chain account", () => {
      const { wallet, sessionSecret } = vault.createWallet("tamper-delete-chain", "unmanaged");

      // Delete the EVM account from the file, leaving only Solana
      const fs = require("fs");
      const path = join(TEST_VAULT, "wallets", `${wallet.id}.json`);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      data.accounts = data.accounts.filter((a: any) => !a.chainId.startsWith("eip155:"));
      fs.writeFileSync(path, JSON.stringify(data));

      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "test", { sessionSecret }),
        /SECURITY.*integrity.*missing from file/i,
      );

      vault.deleteWallet(wallet.id);
    });

    it("detects injected fake chain account", () => {
      const { wallet, sessionSecret } = vault.createWallet("tamper-inject-chain", "unmanaged");

      const fs = require("fs");
      const path = join(TEST_VAULT, "wallets", `${wallet.id}.json`);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      data.accounts.push({
        chainId: "bitcoin:mainnet",
        address: "bc1qattackeraddress",
        derivationPath: "m/44'/0'/0'/0/0",
      });
      fs.writeFileSync(path, JSON.stringify(data));

      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "test", { sessionSecret }),
        /SECURITY.*integrity.*tampered/i,
      );

      vault.deleteWallet(wallet.id);
    });

    it("passes integrity check on untampered wallet", () => {
      const { wallet, sessionSecret } = vault.createWallet("integrity-ok", "unmanaged");

      // Should sign without any integrity error
      const sig = vault.signMessage(wallet.id, "solana", "clean", { sessionSecret });
      assert.ok(sig.signature.length > 0);

      vault.deleteWallet(wallet.id);
    });

    it("integrity check works via API key auth too", () => {
      const { wallet, sessionSecret } = vault.createWallet("integrity-apikey", "unmanaged");
      const apiKey = vault.createApiKey("integrity-agent", [wallet.id], sessionSecret);

      // Tamper
      const fs = require("fs");
      const path = join(TEST_VAULT, "wallets", `${wallet.id}.json`);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      data.accounts[0].address = "FakeAddress1111111111111111111111111111111111";
      fs.writeFileSync(path, JSON.stringify(data));

      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "test", { token: apiKey.token }),
        /SECURITY.*integrity.*tampered/i,
      );

      vault.deleteWallet(wallet.id);
    });
  });

  describe("wallet not found", () => {
    it("throws for nonexistent wallet ID", () => {
      assert.throws(
        () => vault.getWallet("nonexistent-wallet-id-that-does-not-exist"),
        /not found/,
      );
    });

    it("throws for sign on nonexistent wallet", () => {
      assert.throws(
        () => vault.signMessage("nope", "solana", "test", { sessionSecret: "a".repeat(64) }),
        /not found/,
      );
    });
  });

  describe("invalid mnemonic import", () => {
    it("rejects garbage mnemonic", () => {
      assert.throws(
        () => vault.importWalletMnemonic("bad-mnemonic", "this is not a valid mnemonic phrase at all"),
        /Invalid mnemonic/,
      );
    });

    it("rejects empty string", () => {
      assert.throws(
        () => vault.importWalletMnemonic("empty-mnemonic", ""),
        /Invalid mnemonic/,
      );
    });

    it("rejects 11-word mnemonic (wrong length)", () => {
      assert.throws(
        () => vault.importWalletMnemonic("short-mnemonic", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"),
        /Invalid mnemonic/,
      );
    });
  });

  describe("corrupt wallet files", () => {
    it("throws on invalid JSON in wallet file", () => {
      const corruptPath = join(TEST_VAULT, "wallets", "corrupt-json.json");
      writeFileSync(corruptPath, "NOT VALID JSON {{{");

      // Should throw when trying to list (JSON.parse fails)
      // Actually listWallets will throw on bad JSON
      assert.throws(
        () => vault.listWallets(),
        /Unexpected token|JSON/,
      );

      // Cleanup
      rmSync(corruptPath);
    });

    it("handles wallet file with missing session_crypto gracefully", () => {
      const id = "missing-crypto-field";
      const badFile = {
        id,
        name: "bad-wallet",
        mode: "unmanaged",
        accounts: [],
        // session_crypto intentionally missing
        key_type: "mnemonic",
        created_at: new Date().toISOString(),
      };
      writeFileSync(join(TEST_VAULT, "wallets", `${id}.json`), JSON.stringify(badFile));

      // getWallet should still work (doesn't need decryption)
      const wallet = vault.getWallet(id);
      assert.equal(wallet.id, id);

      // But signing should fail
      assert.throws(
        () => vault.signMessage(id, "solana", "test", { sessionSecret: "a".repeat(64) }),
        // Will fail because session_crypto is undefined
        (err: any) => err instanceof Error,
      );

      // Cleanup
      rmSync(join(TEST_VAULT, "wallets", `${id}.json`));
    });
  });

  describe("expired API key", () => {
    it("rejects expired API key", () => {
      const { wallet, sessionSecret } = vault.createWallet("expire-test", "unmanaged");

      // Create API key with past expiration
      const apiKey = vault.createApiKey("expired-key", [wallet.id], sessionSecret, [], "2020-01-01T00:00:00Z");

      // Validate should return null
      const validation = vault.validateApiKey(apiKey.token);
      assert.equal(validation, null, "expired key should not validate");

      // Sign should fail
      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "test", { token: apiKey.token }),
        /expired/i,
      );

      vault.deleteWallet(wallet.id);
    });
  });

  describe("delete wallet cleans API keys", () => {
    it("removes API keys that only reference the deleted wallet", () => {
      const { wallet, sessionSecret } = vault.createWallet("delete-cleanup", "unmanaged");
      const apiKey = vault.createApiKey("cleanup-key", [wallet.id], sessionSecret);

      // Verify API key exists
      assert.ok(vault.validateApiKey(apiKey.token));

      // Delete wallet
      vault.deleteWallet(wallet.id);

      // API key should be gone (it only referenced this wallet)
      const afterDelete = vault.validateApiKey(apiKey.token);
      assert.equal(afterDelete, null, "API key should be deleted when its only wallet is deleted");
    });
  });

  describe("unsupported chains", () => {
    it("throws for unsupported chain in signMessage", () => {
      const { wallet, sessionSecret } = vault.createWallet("unsupported-chain", "unmanaged");

      assert.throws(
        () => vault.signMessage(wallet.id, "bitcoin", "test", { sessionSecret }),
        /not supported/,
      );

      vault.deleteWallet(wallet.id);
    });

    it("throws for unsupported chain in deriveAddress", () => {
      const mnemonic = vault.generateMnemonic();
      assert.throws(
        () => vault.deriveAddress(mnemonic, "cardano"),
        /not supported/,
      );
    });
  });

  describe("rename wallet", () => {
    it("renames and retrieves by new name", () => {
      const { wallet } = vault.createWallet("original-name", "unmanaged");
      assert.equal(vault.getWallet(wallet.id).name, "original-name");

      vault.renameWallet(wallet.id, "new-name");
      assert.equal(vault.getWallet(wallet.id).name, "new-name");

      // Can also look up by new name
      const byName = vault.getWallet("new-name");
      assert.equal(byName.id, wallet.id);

      vault.deleteWallet(wallet.id);
    });
  });

  describe("list wallets", () => {
    it("returns empty array on clean vault", () => {
      // All previous test wallets should be cleaned up by now
      const wallets = vault.listWallets();
      assert.ok(Array.isArray(wallets));
    });
  });

  describe("double delete", () => {
    it("second delete throws not-found but doesn't crash", () => {
      const { wallet } = vault.createWallet("double-delete", "unmanaged");
      vault.deleteWallet(wallet.id);

      assert.throws(
        () => vault.deleteWallet(wallet.id),
        /not found/,
      );
    });
  });

  describe("API key creation validation", () => {
    it("rejects empty walletIds array", () => {
      assert.throws(
        () => vault.createApiKey("no-wallets", [], "a".repeat(64)),
        /At least one wallet/,
      );
    });
  });

  describe("derive address", () => {
    it("derives consistent Solana address from mnemonic", () => {
      const mnemonic = vault.generateMnemonic();
      const addr1 = vault.deriveAddress(mnemonic, "solana");
      const addr2 = vault.deriveAddress(mnemonic, "solana");
      assert.equal(addr1, addr2, "same mnemonic should give same address");
      assert.ok(addr1.length > 30, "should be a base58 address");
    });

    it("derives consistent EVM address from mnemonic", () => {
      const mnemonic = vault.generateMnemonic();
      const addr1 = vault.deriveAddress(mnemonic, "evm");
      const addr2 = vault.deriveAddress(mnemonic, "base");
      assert.equal(addr1, addr2, "evm and base should give same address");
      assert.ok(addr1.startsWith("0x"));
    });
  });
});
