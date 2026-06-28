/**
 * Proves the CLI's registration-signature wiring round-trips against the REAL
 * server auth contract hardened in PR #321.
 *
 * The CLI (cli/wallet.ts `signMessageLocal`, called from `wallet register`)
 * signs `palmyr-register:<wallet>:<timestamp>` with the wallet key and sends a
 * HEX signature. The server (src/middleware/auth.ts) verifies it via
 * `verifyWalletControl` after building the message with `registerAuthMessage`.
 *
 * Here we reproduce EXACTLY what the CLI does (the CLI module is ESM and can't
 * be imported into the CommonJS server test runner — same constraint noted in
 * credential-store.test.ts), then assert it verifies against the imported
 * server functions. If the message string, encoding, or curve choice drifts on
 * either side, these break.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import nacl from "tweetnacl";
import bs58 from "bs58";
import { ethers } from "ethers";

import {
  registerAuthMessage,
  verifyWalletControl,
  walletProofFresh,
  WALLET_PROOF_SKEW_MS,
} from "../middleware/auth";

// ─── Mirrors of cli/vault.ts signMessageLocal (the exact bytes the CLI sends) ──

// Solana: Ed25519 over the UTF-8 message, hex-encoded (CLI returns hex).
function cliSignSolanaHex(message: string, secretKey: Uint8Array): string {
  const sig = nacl.sign.detached(Buffer.from(message, "utf8"), secretKey);
  return Buffer.from(sig).toString("hex");
}

// EVM: ethers EIP-191 personal_sign, then strip the 0x (CLI: sig.replace('0x','')).
function cliSignEvmHex(message: string, hd: ethers.HDNodeWallet): string {
  return hd.signMessageSync(message).replace(/^0x/, "");
}

describe("CLI registration signature ↔ server verifyWalletControl", () => {
  it("Solana: hex Ed25519 signature over palmyr-register:<wallet>:<ts> verifies", () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(Buffer.from(kp.publicKey)); // base58 Solana address
    const ts = Date.now();
    const message = registerAuthMessage(wallet, ts);

    // The CLI builds the same string independently — assert the format matches.
    assert.equal(message, `palmyr-register:${wallet}:${ts}`);

    const signature = cliSignSolanaHex(message, kp.secretKey);
    assert.ok(walletProofFresh(ts), "fresh timestamp must pass the skew window");
    assert.equal(
      verifyWalletControl(wallet, message, signature),
      true,
      "server must accept the CLI's hex Ed25519 signature",
    );
  });

  it("EVM: hex EIP-191 signature over palmyr-register:<wallet>:<ts> verifies", () => {
    // Same derivation path the CLI uses for the Base/EVM account.
    const random = ethers.Wallet.createRandom();
    const hd = ethers.HDNodeWallet.fromPhrase(
      random.mnemonic!.phrase,
      undefined,
      "m/44'/60'/0'/0/0",
    );
    const wallet = hd.address; // 0x… EVM address
    const ts = Date.now();
    const message = registerAuthMessage(wallet, ts);

    const signature = cliSignEvmHex(message, hd);
    assert.equal(signature.length, 130, "EIP-191 sig is 65 bytes → 130 hex chars");
    assert.equal(
      verifyWalletControl(wallet, message, signature),
      true,
      "server must accept the CLI's hex EIP-191 signature",
    );
  });

  it("rejects a signature from a different wallet (no takeover)", () => {
    const victim = nacl.sign.keyPair();
    const attacker = nacl.sign.keyPair();
    const victimAddr = bs58.encode(Buffer.from(victim.publicKey));
    const ts = Date.now();
    const message = registerAuthMessage(victimAddr, ts);
    // Attacker signs the victim's message with the attacker's key.
    const forged = cliSignSolanaHex(message, attacker.secretKey);
    assert.equal(verifyWalletControl(victimAddr, message, forged), false);
  });

  it("rejects a signature over a tampered timestamp", () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(Buffer.from(kp.publicKey));
    const ts = Date.now();
    const signature = cliSignSolanaHex(registerAuthMessage(wallet, ts), kp.secretKey);
    // Verify against a DIFFERENT timestamp's message → must fail.
    const otherMessage = registerAuthMessage(wallet, ts + 1);
    assert.equal(verifyWalletControl(wallet, otherMessage, signature), false);
  });

  it("enforces the freshness window the CLI relies on (Date.now ms)", () => {
    const now = Date.now();
    assert.equal(walletProofFresh(now), true);
    assert.equal(walletProofFresh(now - (WALLET_PROOF_SKEW_MS + 1000)), false, "stale → rejected");
    assert.equal(walletProofFresh("not-a-number"), false);
  });
});
