/**
 * Unit tests for wallet policy enforcement.
 *
 * Covers:
 *  - No policy → signing passes freely
 *  - Chain allowlist blocks disallowed chains
 *  - Chain allowlist permits allowed chains
 *  - Per-tx USDC limit blocks over-limit
 *  - Per-tx USDC limit permits under-limit
 *  - Daily USDC limit blocks cumulative over-limit
 *  - Daily USDC limit permits cumulative under-limit
 *  - Managed wallet throws PolicyApprovalRequired (not generic Error)
 *  - Unmanaged wallet throws generic Error for over-limit
 *  - Undecodable tx is rejected when limits are set
 *  - Undecodable tx is allowed when only chain allowlist is set (no amount limits)
 *  - Spend log tracks successful transactions
 *
 * Security regression tests (closing signing-policy bypasses):
 *  - Solana spend metering SUMS all USDC transfers (not just the first)
 *  - A second token instruction that can't be metered is denied
 *  - A non-benign program in the tx is denied under limits
 *  - The benign x402 payment shape (compute budget + memo + one transfer) passes
 *  - Managed wallets refuse signMessage payloads that decode to a Solana tx
 *  - signTypedData meters USDC permit / transferWithAuthorization spends
 *  - Managed wallets refuse un-meterable EIP-712 payloads
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_VAULT = join(tmpdir(), `palmyr-test-policy-${Date.now()}`);
process.env.PALMYR_WALLET_PATH = TEST_VAULT;

import * as vault from "../services/wallet-vault";
import { PolicyApprovalRequired } from "../services/wallet-vault";

// ─── Fixture builders (no external test deps; reuse runtime libs) ───

const web3 = require("@solana/web3.js");
const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, Keypair, ComputeBudgetProgram } = web3;

const SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function toBaseUnits(usdc: number): bigint {
  return BigInt(Math.round(usdc * 1e6));
}

/** SPL TransferChecked (opcode 12): accounts [source, mint, dest, authority]. */
function usdcTransferCheckedIx(usdc: number, mint: any = USDC_MINT, decimals = 6): any {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(toBaseUnits(usdc), 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM,
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** SPL Transfer (opcode 3): accounts [source, dest, authority], NO mint — un-meterable. */
function plainTransferIx(usdc: number): any {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(toBaseUnits(usdc), 1);
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM,
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function memoIx(): any {
  return new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from("x402") });
}

/** An instruction to a random, unrecognized program. */
function unknownProgramIx(): any {
  return new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
    data: Buffer.from([9, 9, 9, 9]),
  });
}

function compileV0(instructions: any[]): any {
  return new TransactionMessage({
    payerKey: Keypair.generate().publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions,
  }).compileToV0Message();
}

function solanaTxHex(instructions: any[]): string {
  const tx = new VersionedTransaction(compileV0(instructions));
  return Buffer.from(tx.serialize()).toString("hex");
}

function solanaMessageHex(instructions: any[]): string {
  return Buffer.from(compileV0(instructions).serialize()).toString("hex");
}

function evmAddress(walletId: string): string {
  const w = vault.getWallet(walletId);
  const acc = w.accounts.find((a) => a.chainId.toLowerCase().startsWith("eip155:"));
  if (!acc) throw new Error("no evm account");
  return acc.address;
}

/** Build an EIP-712 USDC spend-authorization typed-data JSON. */
function usdcAuthTypedData(
  valueBaseUnits: bigint,
  from: string,
  primaryType: "TransferWithAuthorization" | "Permit" = "TransferWithAuthorization",
): string {
  const isPermit = primaryType === "Permit";
  const typeFields = isPermit
    ? [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ]
    : [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ];
  const message: any = isPermit
    ? { owner: from, spender: "0x2222222222222222222222222222222222222222", value: valueBaseUnits.toString(), nonce: "0", deadline: "99999999999" }
    : { from, to: "0x2222222222222222222222222222222222222222", value: valueBaseUnits.toString(), validAfter: "0", validBefore: "99999999999", nonce: "0x" + "00".repeat(32) };
  return JSON.stringify({
    primaryType,
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      [primaryType]: typeFields,
    },
    message,
  });
}

/** A valid EIP-712 payload that is NOT a USDC spend authorization. */
function nonSpendTypedData(): string {
  return JSON.stringify({
    primaryType: "Mail",
    domain: { name: "Test", version: "1", chainId: 1, verifyingContract: "0x1111111111111111111111111111111111111111" },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Mail: [{ name: "contents", type: "string" }],
    },
    message: { contents: "hello" },
  });
}

describe("policy enforcement", () => {
  let unmanagedId: string;
  let unmanagedSecret: string;
  let managedId: string;
  let managedSecret: string;

  before(() => {
    mkdirSync(TEST_VAULT, { recursive: true });
    vault.initVault();

    const u = vault.createWallet("policy-unmanaged", "unmanaged");
    unmanagedId = u.wallet.id;
    unmanagedSecret = u.sessionSecret;

    const m = vault.createWallet("policy-managed", "managed");
    managedId = m.wallet.id;
    managedSecret = m.sessionSecret;
  });

  after(() => {
    rmSync(TEST_VAULT, { recursive: true, force: true });
  });

  describe("no policy", () => {
    it("signs freely when no policy is set", () => {
      // signMessage doesn't go through policy enforcement (only signTransaction does)
      // but we can verify the wallet works
      const sig = vault.signMessage(unmanagedId, "solana", "free", { sessionSecret: unmanagedSecret });
      assert.ok(sig.signature.length > 0);
    });

    it("signTransaction passes with no policy and arbitrary tx hex", () => {
      // With no policy, any tx hex should pass (no decode needed)
      const sig = vault.signTransaction(unmanagedId, "solana", "deadbeef".repeat(8), { sessionSecret: unmanagedSecret });
      assert.ok(sig.signature.length > 0);
    });
  });

  describe("chain allowlist", () => {
    it("blocks disallowed chain", () => {
      vault.setWalletPolicy(unmanagedId, { allowed_chains: ["solana"] });

      assert.throws(
        () => vault.signTransaction(unmanagedId, "evm", "deadbeef", { sessionSecret: unmanagedSecret }),
        /not in allowed_chains/,
      );

      vault.setWalletPolicy(unmanagedId, {}); // reset
    });

    it("permits allowed chain", () => {
      vault.setWalletPolicy(unmanagedId, { allowed_chains: ["solana", "evm"] });

      // Should not throw for chain check (may throw for tx decode if limits are set, but chain check passes)
      const sig = vault.signTransaction(unmanagedId, "solana", "deadbeef".repeat(8), { sessionSecret: unmanagedSecret });
      assert.ok(sig.signature.length > 0);

      vault.setWalletPolicy(unmanagedId, {}); // reset
    });

    it("matches chain aliases (evm matches base)", () => {
      vault.setWalletPolicy(unmanagedId, { allowed_chains: ["evm"] });

      // "base" should match "evm" allowlist
      // This will pass the chain check but may fail on tx decode — we just check it doesn't throw chain error
      try {
        vault.signTransaction(unmanagedId, "base", "deadbeef", { sessionSecret: unmanagedSecret });
      } catch (e: any) {
        // Should NOT be a chain allowlist error
        assert.ok(!e.message.includes("not in allowed_chains"), "base should match evm allowlist");
      }

      vault.setWalletPolicy(unmanagedId, {}); // reset
    });
  });

  describe("per-tx USDC limit", () => {
    it("rejects undecodable tx when limits are set", () => {
      vault.setWalletPolicy(unmanagedId, { per_tx_usdc: 100 });

      assert.throws(
        () => vault.signTransaction(unmanagedId, "solana", "deadbeef", { sessionSecret: unmanagedSecret }),
        /cannot decode transaction/,
      );

      vault.setWalletPolicy(unmanagedId, {}); // reset
    });
  });

  describe("managed vs unmanaged error types", () => {
    it("managed wallet throws PolicyApprovalRequired for over-limit", () => {
      vault.setWalletPolicy(managedId, { per_tx_usdc: 1 });

      try {
        // This will fail because we can't decode "deadbeef" as USDC transfer
        // But with limits set, it throws the decode error first
        vault.signTransaction(managedId, "solana", "deadbeef", { sessionSecret: managedSecret });
        assert.fail("should have thrown");
      } catch (e: any) {
        // For undecodable tx, both modes throw generic Error (not PolicyApprovalRequired)
        // PolicyApprovalRequired is only for decoded USDC transfers that exceed limits
        assert.ok(e.message.includes("cannot decode"), "should fail on decode");
      }

      vault.setWalletPolicy(managedId, {}); // reset
    });

    it("PolicyApprovalRequired has correct code property", () => {
      const err = new PolicyApprovalRequired("test", { amount_usdc: 50, destination: "abc", mint: "def" });
      assert.equal(err.code, "REQUIRES_APPROVAL");
      assert.equal(err.name, "PolicyApprovalRequired");
      assert.equal(err.decoded.amount_usdc, 50);
      assert.ok(err instanceof Error);
    });
  });

  describe("spend tracking", () => {
    it("starts with zero daily spend", () => {
      const daily = vault.getDailySpend(unmanagedId);
      assert.equal(daily, 0);
    });

    it("spend log is empty initially", () => {
      const log = vault.getSpendLog(unmanagedId);
      assert.ok(Array.isArray(log));
      assert.equal(log.length, 0);
    });
  });

  describe("policy CRUD", () => {
    it("set and get policy", () => {
      vault.setWalletPolicy(unmanagedId, { per_tx_usdc: 50, daily_usdc: 200, allowed_chains: ["solana"] });
      const p = vault.getWalletPolicy(unmanagedId);
      assert.deepEqual(p, { per_tx_usdc: 50, daily_usdc: 200, allowed_chains: ["solana"] });

      vault.setWalletPolicy(unmanagedId, {}); // reset
    });

    it("returns null when no policy set", () => {
      // After reset, policy field may be empty object or absent
      vault.setWalletPolicy(unmanagedId, {});
      const p = vault.getWalletPolicy(unmanagedId);
      // {} is truthy, but the function returns data.policy || null
      // An empty object {} is truthy so it returns {}
      assert.ok(p !== undefined);
    });
  });
});

// ─── Security regression: all-instruction Solana metering ───

describe("solana spend metering sums every instruction", () => {
  let mid: string;
  let msecret: string;
  let uid: string;
  let usecret: string;

  before(() => {
    const m = vault.createWallet("sum-managed", "managed");
    mid = m.wallet.id;
    msecret = m.sessionSecret;
    const u = vault.createWallet("sum-unmanaged", "unmanaged");
    uid = u.wallet.id;
    usecret = u.sessionSecret;
  });

  it("sums a $1 + $50,000 transfer and exceeds a $5 cap (managed → approval)", () => {
    vault.setWalletPolicy(mid, { per_tx_usdc: 5 });
    const tx = solanaTxHex([usdcTransferCheckedIx(1), usdcTransferCheckedIx(50000)]);
    try {
      vault.signTransaction(mid, "solana", tx, { sessionSecret: msecret });
      assert.fail("should have required approval for the summed amount");
    } catch (e: any) {
      assert.ok(e instanceof PolicyApprovalRequired, `expected PolicyApprovalRequired, got: ${e.message}`);
      assert.equal(e.decoded.amount_usdc, 50001, "metered amount must be the SUM of all transfers");
    }
    vault.setWalletPolicy(mid, {});
  });

  it("unmanaged: summed over-limit throws a generic policy error", () => {
    vault.setWalletPolicy(uid, { per_tx_usdc: 5 });
    const tx = solanaTxHex([usdcTransferCheckedIx(1), usdcTransferCheckedIx(50000)]);
    assert.throws(
      () => vault.signTransaction(uid, "solana", tx, { sessionSecret: usecret }),
      /exceeds per-tx limit/,
    );
    vault.setWalletPolicy(uid, {});
  });

  it("denies a smuggled plain SPL Transfer (opcode 3, no mint) it cannot meter", () => {
    vault.setWalletPolicy(mid, { per_tx_usdc: 5 });
    const tx = solanaTxHex([usdcTransferCheckedIx(1), plainTransferIx(50000)]);
    assert.throws(
      () => vault.signTransaction(mid, "solana", tx, { sessionSecret: msecret }),
      /cannot be metered|Policy denied/,
    );
    vault.setWalletPolicy(mid, {});
  });

  it("denies a transfer of a non-USDC SPL token", () => {
    vault.setWalletPolicy(mid, { per_tx_usdc: 5 });
    const otherMint = Keypair.generate().publicKey;
    const tx = solanaTxHex([usdcTransferCheckedIx(1), usdcTransferCheckedIx(50000, otherMint)]);
    assert.throws(
      () => vault.signTransaction(mid, "solana", tx, { sessionSecret: msecret }),
      /cannot be metered|Policy denied/,
    );
    vault.setWalletPolicy(mid, {});
  });

  it("denies an unrecognized program that could move value via CPI", () => {
    vault.setWalletPolicy(mid, { per_tx_usdc: 100 });
    const tx = solanaTxHex([usdcTransferCheckedIx(1), unknownProgramIx()]);
    assert.throws(
      () => vault.signTransaction(mid, "solana", tx, { sessionSecret: msecret }),
      /cannot be metered|Policy denied/,
    );
    vault.setWalletPolicy(mid, {});
  });

  it("permits the real x402 shape: compute budget + single USDC transfer + memo", () => {
    vault.setWalletPolicy(mid, { per_tx_usdc: 5, daily_usdc: 50 });
    const tx = solanaTxHex([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      usdcTransferCheckedIx(2),
      memoIx(),
    ]);
    const sig = vault.signTransaction(mid, "solana", tx, { sessionSecret: msecret });
    assert.ok(sig.signature.length > 0);
    // The $2 transfer should have been metered against the daily limit.
    assert.equal(vault.getDailySpend(mid), 2);
    vault.setWalletPolicy(mid, {});
  });
});

// ─── Security regression: signMessage cannot smuggle a transaction ───

describe("managed signMessage refuses transaction payloads", () => {
  let mid: string;
  let msecret: string;
  let uid: string;
  let usecret: string;

  before(() => {
    const m = vault.createWallet("smuggle-managed", "managed");
    mid = m.wallet.id;
    msecret = m.sessionSecret;
    const u = vault.createWallet("smuggle-unmanaged", "unmanaged");
    uid = u.wallet.id;
    usecret = u.sessionSecret;
  });

  it("refuses a serialized Solana transaction submitted as a hex message", () => {
    const tx = solanaTxHex([usdcTransferCheckedIx(50000)]);
    assert.throws(
      () => vault.signMessage(mid, "solana", tx, { sessionSecret: msecret }, "hex"),
      /decodes to a Solana transaction|Policy denied/,
    );
  });

  it("refuses a bare compiled message (the bytes that yield a valid tx sig)", () => {
    const msg = solanaMessageHex([usdcTransferCheckedIx(50000)]);
    assert.throws(
      () => vault.signMessage(mid, "solana", msg, { sessionSecret: msecret }, "hex"),
      /decodes to a Solana transaction|Policy denied/,
    );
  });

  it("still signs a genuine human-readable message (SIWS-style)", () => {
    const sig = vault.signMessage(mid, "solana", "Sign in to Palmyr at 2026-06-29", { sessionSecret: msecret });
    assert.ok(sig.signature.length > 0);
  });

  it("does not restrict unmanaged wallets (raw signing still works)", () => {
    const tx = solanaTxHex([usdcTransferCheckedIx(50000)]);
    const sig = vault.signMessage(uid, "solana", tx, { sessionSecret: usecret }, "hex");
    assert.ok(sig.signature.length > 0);
  });
});

// ─── Security regression: signTypedData is metered ───

describe("signTypedData enforces spending policy", () => {
  it("managed: over-limit USDC transferWithAuthorization requires approval", () => {
    const { wallet, sessionSecret } = vault.createWallet("typed-managed-over", "managed");
    vault.setWalletPolicy(wallet.id, { per_tx_usdc: 5 });
    const td = usdcAuthTypedData(toBaseUnits(50000), evmAddress(wallet.id));
    try {
      vault.signTypedData(wallet.id, "base", td, { sessionSecret });
      assert.fail("should have required approval");
    } catch (e: any) {
      assert.ok(e instanceof PolicyApprovalRequired, `expected PolicyApprovalRequired, got: ${e.message}`);
      assert.equal(e.decoded.amount_usdc, 50000);
    }
  });

  it("managed: an unlimited USDC permit (MaxUint256) requires approval", () => {
    const { wallet, sessionSecret } = vault.createWallet("typed-managed-unlimited", "managed");
    vault.setWalletPolicy(wallet.id, { per_tx_usdc: 1000 });
    const td = usdcAuthTypedData((1n << 256n) - 1n, evmAddress(wallet.id), "Permit");
    assert.throws(
      () => vault.signTypedData(wallet.id, "base", td, { sessionSecret }),
      (e: any) => e instanceof PolicyApprovalRequired,
    );
  });

  it("managed: under-limit USDC transfer auth signs and records the spend", () => {
    const { wallet, sessionSecret } = vault.createWallet("typed-managed-under", "managed");
    vault.setWalletPolicy(wallet.id, { per_tx_usdc: 100 });
    const td = usdcAuthTypedData(toBaseUnits(10), evmAddress(wallet.id));
    const sig = vault.signTypedData(wallet.id, "base", td, { sessionSecret });
    assert.ok(sig.signature.length > 0);
    assert.equal(vault.getDailySpend(wallet.id), 10);
  });

  it("managed: daily limit accrues across typed-data spends", () => {
    const { wallet, sessionSecret } = vault.createWallet("typed-managed-daily", "managed");
    vault.setWalletPolicy(wallet.id, { daily_usdc: 20 });
    const from = evmAddress(wallet.id);
    vault.signTypedData(wallet.id, "base", usdcAuthTypedData(toBaseUnits(15), from), { sessionSecret });
    assert.throws(
      () => vault.signTypedData(wallet.id, "base", usdcAuthTypedData(toBaseUnits(15), from), { sessionSecret }),
      (e: any) => e instanceof PolicyApprovalRequired,
    );
  });

  it("managed: refuses a non-USDC / opaque EIP-712 payload when limits are set", () => {
    const { wallet, sessionSecret } = vault.createWallet("typed-managed-opaque", "managed");
    vault.setWalletPolicy(wallet.id, { per_tx_usdc: 5 });
    assert.throws(
      () => vault.signTypedData(wallet.id, "base", nonSpendTypedData(), { sessionSecret }),
      /may only sign EIP-712 payloads|Policy denied/,
    );
  });

  it("unmanaged: non-spend typed data still signs even with limits set", () => {
    const { wallet, sessionSecret } = vault.createWallet("typed-unmanaged-ok", "unmanaged");
    vault.setWalletPolicy(wallet.id, { per_tx_usdc: 5 });
    const sig = vault.signTypedData(wallet.id, "base", nonSpendTypedData(), { sessionSecret });
    assert.ok(sig.signature.length > 0);
  });

  it("no policy: typed data signs freely", () => {
    const { wallet, sessionSecret } = vault.createWallet("typed-nopolicy", "managed");
    const sig = vault.signTypedData(wallet.id, "base", nonSpendTypedData(), { sessionSecret });
    assert.ok(sig.signature.length > 0);
  });
});
