/**
 * Integration tests: wallet create → sign → verify.
 *
 * Covers:
 *  - Create unmanaged wallet → sign Solana message → verify with pubkey
 *  - Create unmanaged wallet → sign EVM message → verify with address
 *  - Import known mnemonic → deterministic addresses
 *  - API key flow: create wallet → issue API key → sign with key → verify
 *  - Sign with session secret and API key produce identical signatures
 *  - Wallet mode persists correctly
 *  - getDefaultAddresses returns both chains
 *  - EVM typed data signing
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_VAULT = join(tmpdir(), `palmyr-test-integration-${Date.now()}`);
process.env.PALMYR_WALLET_PATH = TEST_VAULT;

import * as vault from "../services/wallet-vault";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

describe("wallet integration", () => {
  before(() => {
    mkdirSync(TEST_VAULT, { recursive: true });
    vault.initVault();
  });

  after(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
  });

  describe("create → sign → verify (Solana)", () => {
    it("creates wallet, signs message, verifies signature with derived pubkey", () => {
      const { wallet, sessionSecret } = vault.createWallet("sol-verify", "unmanaged");

      const solAccount = wallet.accounts.find(a => a.chainId.startsWith("solana:"));
      assert.ok(solAccount, "should have Solana account");

      const message = "test message for verification";
      const sig = vault.signMessage(wallet.id, "solana", message, { sessionSecret });

      // Verify the signature using the public key from the wallet
      const pubkey = new Keypair(
        // We can't reconstruct from just pubkey — use nacl.sign.detached.verify instead
      );
      // Actually: verify using nacl with the pubkey bytes
      const pubkeyBytes = Keypair.fromSeed(Buffer.alloc(32)).publicKey; // dummy
      // Better approach: get the keypair directly and verify
      const kp = vault.getSolanaKeypair(wallet.id, sessionSecret);
      const msgBytes = Buffer.from(message, "utf8");
      const sigBytes = Buffer.from(sig.signature, "hex");

      const valid = nacl.sign.detached.verify(msgBytes, sigBytes, kp.publicKey.toBytes());
      assert.ok(valid, "signature should verify against derived public key");

      // Verify the pubkey matches what's in the wallet
      assert.equal(kp.publicKey.toBase58(), solAccount.address);

      vault.deleteWallet(wallet.id);
    });
  });

  describe("create → sign → verify (EVM)", () => {
    it("creates wallet, signs message, recovers correct address", () => {
      const { wallet, sessionSecret } = vault.createWallet("evm-verify", "unmanaged");

      const evmAccount = wallet.accounts.find(a => a.chainId.startsWith("eip155:"));
      assert.ok(evmAccount, "should have EVM account");

      const message = "test evm message";
      const sig = vault.signMessage(wallet.id, "evm", message, { sessionSecret });
      assert.ok(sig.signature.length > 0);

      // Recover address from signature
      const { ethers } = require("ethers");
      const recovered = ethers.verifyMessage(message, "0x" + sig.signature);
      assert.equal(recovered.toLowerCase(), evmAccount.address.toLowerCase(), "recovered address should match wallet");

      vault.deleteWallet(wallet.id);
    });
  });

  describe("import with known mnemonic", () => {
    // Standard test mnemonic
    const testMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    it("derives deterministic Solana address", () => {
      const { wallet, sessionSecret } = vault.importWalletMnemonic("deterministic-test", testMnemonic);

      const solAddr = vault.getAddressForChain(wallet, "solana");
      assert.ok(solAddr, "should have Solana address");
      // This mnemonic always produces the same Solana address via m/44'/501'/0'/0'
      // Verify it's consistent across runs
      const { wallet: wallet2 } = vault.importWalletMnemonic("deterministic-test-2", testMnemonic);
      const solAddr2 = vault.getAddressForChain(wallet2, "solana");
      assert.equal(solAddr, solAddr2, "same mnemonic should produce same address");

      vault.deleteWallet(wallet.id);
      vault.deleteWallet(wallet2.id);
    });

    it("derives deterministic EVM address", () => {
      const { wallet } = vault.importWalletMnemonic("deterministic-evm", testMnemonic);

      const evmAddr = vault.getAddressForChain(wallet, "evm");
      assert.ok(evmAddr, "should have EVM address");
      // The "abandon" mnemonic with m/44'/60'/0'/0/0 always gives this address
      assert.equal(evmAddr!.toLowerCase(), "0x9858effd232b4033e47d90003d41ec34ecaeda94", "should match known address for test mnemonic");

      vault.deleteWallet(wallet.id);
    });
  });

  describe("API key full flow", () => {
    it("create wallet → issue API key → sign → verify → revoke → fail", () => {
      const { wallet, sessionSecret } = vault.createWallet("apikey-flow", "unmanaged");

      // Issue API key
      const apiKey = vault.createApiKey("flow-agent", [wallet.id], sessionSecret);
      assert.ok(apiKey.token.startsWith("agos_key_"));

      // Validate API key
      const validation = vault.validateApiKey(apiKey.token);
      assert.ok(validation);
      assert.equal(validation!.name, "flow-agent");
      assert.ok(validation!.walletIds.includes(wallet.id));

      // Sign with API key
      const sig = vault.signMessage(wallet.id, "solana", "apikey-test", { token: apiKey.token });
      assert.ok(sig.signature.length > 0);

      // Revoke API key
      vault.revokeApiKey(apiKey.id);

      // Validate should now return null
      const afterRevoke = vault.validateApiKey(apiKey.token);
      assert.equal(afterRevoke, null);

      // Sign should fail
      assert.throws(
        () => vault.signMessage(wallet.id, "solana", "fail", { token: apiKey.token }),
        /Invalid API key/,
      );

      vault.deleteWallet(wallet.id);
    });
  });

  describe("session secret vs API key consistency", () => {
    it("both auth paths produce identical signatures for same message", () => {
      const { wallet, sessionSecret } = vault.createWallet("consistency", "unmanaged");
      const apiKey = vault.createApiKey("consistent-agent", [wallet.id], sessionSecret);

      const msg = "identical-output-test";
      const sig1 = vault.signMessage(wallet.id, "solana", msg, { sessionSecret });
      const sig2 = vault.signMessage(wallet.id, "solana", msg, { token: apiKey.token });

      assert.equal(sig1.signature, sig2.signature, "same underlying mnemonic should give same signature");

      vault.deleteWallet(wallet.id);
    });
  });

  describe("wallet modes", () => {
    it("unmanaged wallet has correct mode", () => {
      const { wallet } = vault.createWallet("mode-unmanaged", "unmanaged");
      const loaded = vault.getWallet(wallet.id);
      assert.equal(loaded.mode, "unmanaged");
      vault.deleteWallet(wallet.id);
    });

    it("managed wallet has correct mode", () => {
      const { wallet } = vault.createWallet("mode-managed", "managed");
      const loaded = vault.getWallet(wallet.id);
      assert.equal(loaded.mode, "managed");
      vault.deleteWallet(wallet.id);
    });
  });

  describe("address helpers", () => {
    it("getDefaultAddresses returns both chains", () => {
      const { wallet } = vault.createWallet("addr-helpers", "unmanaged");
      const addrs = vault.getDefaultAddresses(wallet);
      assert.ok(addrs.solana, "should have Solana address");
      assert.ok(addrs.evm, "should have EVM address");
      assert.ok(addrs.solana!.length > 30, "Solana address should be base58");
      assert.ok(addrs.evm!.startsWith("0x"), "EVM address should start with 0x");
      vault.deleteWallet(wallet.id);
    });

    it("getAddressForChain handles aliases", () => {
      const { wallet } = vault.createWallet("chain-aliases", "unmanaged");
      const byEvm = vault.getAddressForChain(wallet, "evm");
      const byBase = vault.getAddressForChain(wallet, "base");
      const byEthereum = vault.getAddressForChain(wallet, "ethereum");

      assert.ok(byEvm);
      assert.equal(byEvm, byBase, "evm and base should return same address");
      assert.equal(byEvm, byEthereum, "evm and ethereum should return same address");

      vault.deleteWallet(wallet.id);
    });
  });

  describe("EVM typed data signing", () => {
    it("signs EIP-712 typed data", () => {
      const { wallet, sessionSecret } = vault.createWallet("typed-data", "unmanaged");
      const evmAddr = vault.getAddressForChain(wallet, "evm");

      const typedData = JSON.stringify({
        domain: { name: "Test", version: "1", chainId: 8453 },
        types: { Message: [{ name: "content", type: "string" }] },
        message: { content: "hello" },
      });

      const sig = vault.signTypedData(wallet.id, "evm", typedData, { sessionSecret });
      assert.ok(sig.signature.length > 0);
      assert.ok(sig.recoveryId !== undefined, "EVM sig should have recovery ID");

      vault.deleteWallet(wallet.id);
    });
  });
});
