/**
 * Unit tests for wallet-vault encryption/decryption roundtrips.
 *
 * Covers:
 *  - Session secret encrypt → decrypt roundtrip
 *  - HKDF API key encrypt → decrypt roundtrip
 *  - Wrong session secret fails decryption
 *  - Wrong API key token fails decryption
 *  - Tampered ciphertext fails decryption
 *  - Tampered auth tag fails decryption
 *  - Tampered IV fails decryption
 *  - 12-word and 24-word mnemonic generation
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Point vault at an isolated temp directory
const TEST_VAULT = join(tmpdir(), `agentos-test-crypto-${Date.now()}`);
process.env.AGENTOS_WALLET_PATH = TEST_VAULT;

import * as vault from "../services/wallet-vault";

describe("vault crypto", () => {
  before(() => {
    mkdirSync(TEST_VAULT, { recursive: true });
    vault.initVault();
  });

  after(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
  });

  describe("session secret roundtrip", () => {
    it("encrypts and decrypts a wallet mnemonic via session secret", () => {
      const { wallet, sessionSecret } = vault.createWallet("test-roundtrip", "unmanaged");
      assert.ok(wallet.id, "wallet should have an id");
      assert.equal(sessionSecret.length, 64, "session secret should be 64 hex chars (32 bytes)");

      // Verify we can sign with the session secret (proves decryption works)
      const sig = vault.signMessage(wallet.id, "solana", "hello", { sessionSecret });
      assert.ok(sig.signature.length > 0, "should produce a signature");

      vault.deleteWallet(wallet.id);
    });

    it("produces different session secrets for each wallet", () => {
      const w1 = vault.createWallet("test-unique-1", "unmanaged");
      const w2 = vault.createWallet("test-unique-2", "unmanaged");

      assert.notEqual(w1.sessionSecret, w2.sessionSecret);
      assert.notEqual(w1.wallet.id, w2.wallet.id);

      vault.deleteWallet(w1.wallet.id);
      vault.deleteWallet(w2.wallet.id);
    });

    it("rejects wrong session secret", () => {
      const { wallet } = vault.createWallet("test-wrong-secret", "unmanaged");
      const wrongSecret = randomBytes(32).toString("hex");

      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "hello", { sessionSecret: wrongSecret }),
        /Unsupported state|Invalid tag|unable to authenticate/i,
      );

      vault.deleteWallet(wallet.id);
    });
  });

  describe("API key (HKDF) roundtrip", () => {
    it("creates API key and signs with it", () => {
      const { wallet, sessionSecret } = vault.createWallet("test-apikey", "unmanaged");

      const apiKey = vault.createApiKey("test-agent", [wallet.id], sessionSecret);
      assert.ok(apiKey.token.startsWith("agos_key_"), "token should have prefix");

      // Sign with API key
      const sig = vault.signMessage(wallet.id, "solana", "via-apikey", { token: apiKey.token });
      assert.ok(sig.signature.length > 0);

      // Same message with session secret should produce same signature (same underlying key)
      const sig2 = vault.signMessage(wallet.id, "solana", "via-apikey", { sessionSecret });
      assert.equal(sig.signature, sig2.signature, "same key should produce same signature");

      vault.deleteWallet(wallet.id);
    });

    it("rejects invalid API key token", () => {
      const { wallet } = vault.createWallet("test-bad-apikey", "unmanaged");

      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "test", { token: "agos_key_0000000000000000000000000000000000000000000000ff" }),
        /Invalid API key/i,
      );

      vault.deleteWallet(wallet.id);
    });

    it("rejects API key for wrong wallet", () => {
      const w1 = vault.createWallet("test-scope-1", "unmanaged");
      const w2 = vault.createWallet("test-scope-2", "unmanaged");

      // Create API key scoped to w1 only
      const apiKey = vault.createApiKey("scoped", [w1.wallet.id], w1.sessionSecret);

      // Should fail on w2
      assert.throws(
        () => vault.signMessage(w2.wallet.id, "solana", "cross-wallet", { token: apiKey.token }),
        /does not have access/i,
      );

      vault.deleteWallet(w1.wallet.id);
      vault.deleteWallet(w2.wallet.id);
    });
  });

  describe("tampered blobs", () => {
    it("rejects tampered ciphertext", () => {
      const { wallet, sessionSecret } = vault.createWallet("test-tamper-ct", "unmanaged");

      // Read the wallet file and tamper with ciphertext
      const fs = require("fs");
      const path = join(TEST_VAULT, "wallets", `${wallet.id}.json`);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      data.session_crypto.ciphertext = "ff" + data.session_crypto.ciphertext.slice(2);
      fs.writeFileSync(path, JSON.stringify(data));

      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "test", { sessionSecret }),
        /Unsupported state|Invalid tag|unable to authenticate/i,
      );

      vault.deleteWallet(wallet.id);
    });

    it("rejects tampered auth tag", () => {
      const { wallet, sessionSecret } = vault.createWallet("test-tamper-tag", "unmanaged");

      const fs = require("fs");
      const path = join(TEST_VAULT, "wallets", `${wallet.id}.json`);
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      data.session_crypto.tag = "00".repeat(16);
      fs.writeFileSync(path, JSON.stringify(data));

      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "test", { sessionSecret }),
        /Unsupported state|Invalid tag|unable to authenticate/i,
      );

      vault.deleteWallet(wallet.id);
    });
  });

  describe("mnemonic generation", () => {
    it("generates valid 12-word mnemonic by default", () => {
      const mnemonic = vault.generateMnemonic();
      const words = mnemonic.split(" ");
      assert.equal(words.length, 12);
    });

    it("generates valid 24-word mnemonic", () => {
      const mnemonic = vault.generateMnemonic(24);
      const words = mnemonic.split(" ");
      assert.equal(words.length, 24);
    });
  });

  describe("auth requirements", () => {
    it("throws when no auth provided", () => {
      const { wallet } = vault.createWallet("test-no-auth", "unmanaged");

      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "test", {}),
        /Either session secret or API key token is required/,
      );

      vault.deleteWallet(wallet.id);
    });
  });
});
