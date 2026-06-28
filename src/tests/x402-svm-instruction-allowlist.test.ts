/**
 * Regression tests for the x402 SVM instruction-level allowlist.
 *
 * Background (the bug being fixed): the Solana payment verifier only checked
 * programs at a PROGRAM level. The settlement path then co-signs the submitted
 * transaction with the production fee-payer key. So a caller could craft a
 * transaction that passes verify but smuggles EXTRA SPL-Token instructions
 * (Approve / SetAuthority / CloseAccount / a second Transfer) referencing the
 * FEE PAYER's own token accounts, and get the server to co-sign them — draining
 * the fee payer's USDC (and, via CloseAccount, its SOL rent).
 *
 * These tests assert:
 *   • a NORMAL single-TransferChecked payment is ACCEPTED, and
 *   • every malicious multi-instruction variant is REJECTED by verify, and
 *   • settle re-runs the same guard and refuses to co-sign the malicious bytes
 *     (before any network round-trip).
 *
 * All transactions are built offline (no RPC) the same way the CLI builds a
 * real payment: payerKey = fee payer (index 0), client partial-signs, server
 * co-signs later.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  createApproveInstruction,
  createCloseAccountInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
} from '@solana/spl-token';
import bs58 from 'bs58';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Fee payer = the server's hot key. Expose it to the module under test via the
// env var its loadFeePayer() reads. loadFeePayer is lazy, so setting it here
// (before any verify/settle call) is sufficient.
const feePayer = Keypair.generate();
process.env.SVM_PRIVATE_KEY = bs58.encode(feePayer.secretKey);

import { verifySvmPayment, settleSvmPayment } from '../middleware/x402-svm-verify';

const expectedFeePayer = feePayer.publicKey.toBase58();
const treasury = Keypair.generate().publicKey;
const expectedPayTo = treasury.toBase58();
const expectedMint = USDC_MINT.toBase58();
const AMOUNT = 10_000n; // 0.01 USDC (6 decimals)

let payer: Keypair;
let attacker: PublicKey;
let sourceAta: PublicKey;
let destAta: PublicKey;
let feePayerAta: PublicKey;
let attackerAta: PublicKey;
let blockhash: string;

before(async () => {
  payer = Keypair.generate();
  attacker = Keypair.generate().publicKey;
  sourceAta = await getAssociatedTokenAddress(USDC_MINT, payer.publicKey);
  destAta = await getAssociatedTokenAddress(USDC_MINT, treasury);
  feePayerAta = await getAssociatedTokenAddress(USDC_MINT, feePayer.publicKey);
  attackerAta = await getAssociatedTokenAddress(USDC_MINT, attacker);
  // Any valid base58 32-byte value works for an offline (never-submitted) tx.
  blockhash = Keypair.generate().publicKey.toBase58();
});

function buildTx(instructions: TransactionInstruction[]): string {
  const msg = new TransactionMessage({
    payerKey: feePayer.publicKey, // fee payer is account index 0
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  // Client partial-signs; the fee payer co-signs server-side during settle.
  tx.sign([payer]);
  return Buffer.from(tx.serialize()).toString('base64');
}

function cuLimit() { return ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }); }
function cuPrice() { return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }); }
function memoIx() { return new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from('x402') }); }
function paymentTransfer() {
  return createTransferCheckedInstruction(sourceAta, USDC_MINT, destAta, payer.publicKey, AMOUNT, 6);
}
function normal(): TransactionInstruction[] {
  return [cuLimit(), cuPrice(), paymentTransfer(), memoIx()];
}

function verify(tx: string) {
  return verifySvmPayment(tx, expectedPayTo, AMOUNT, expectedMint, expectedFeePayer);
}

describe('x402 SVM instruction-level allowlist', () => {
  it('ACCEPTS a normal single-TransferChecked payment (compute budget + memo)', async () => {
    const r = await verify(buildTx(normal()));
    assert.equal(r.isValid, true, 'expected accept, got reason=' + r.invalidReason);
    assert.equal(r.payer, payer.publicKey.toBase58());
    assert.equal(r.amount, AMOUNT);
  });

  it('REJECTS an extra Approve on the fee payer ATA', async () => {
    // The classic drain: grant the attacker delegate authority over the fee
    // payer's USDC, to be swept in a follow-up tx.
    const approve = createApproveInstruction(feePayerAta, attacker, feePayer.publicKey, 1_000_000_000n);
    const r = await verify(buildTx([cuLimit(), cuPrice(), paymentTransfer(), approve, memoIx()]));
    assert.equal(r.isValid, false);
    assert.match(r.invalidReason || '', /disallowed_token_instruction|multiple_token|references_fee_payer/);
  });

  it('REJECTS an extra SetAuthority handing the fee payer ATA to the attacker', async () => {
    const setAuth = createSetAuthorityInstruction(
      feePayerAta, feePayer.publicKey, AuthorityType.AccountOwner, attacker,
    );
    const r = await verify(buildTx([cuLimit(), cuPrice(), paymentTransfer(), setAuth]));
    assert.equal(r.isValid, false);
  });

  it('REJECTS an extra CloseAccount draining the fee payer ATA rent + balance', async () => {
    const close = createCloseAccountInstruction(feePayerAta, attacker, feePayer.publicKey);
    const r = await verify(buildTx([cuLimit(), cuPrice(), paymentTransfer(), close]));
    assert.equal(r.isValid, false);
  });

  it('REJECTS a second TransferChecked moving the fee payer USDC to the attacker', async () => {
    const drain = createTransferCheckedInstruction(
      feePayerAta, USDC_MINT, attackerAta, feePayer.publicKey, 500_000_000n, 6,
    );
    const r = await verify(buildTx([cuLimit(), cuPrice(), paymentTransfer(), drain, memoIx()]));
    assert.equal(r.isValid, false);
    assert.match(r.invalidReason || '', /multiple_token_instructions/);
  });

  it('REJECTS a System transfer of SOL out of the fee payer', async () => {
    const sysDrain = SystemProgram.transfer({
      fromPubkey: feePayer.publicKey, toPubkey: attacker, lamports: 1_000_000,
    });
    const r = await verify(buildTx([cuLimit(), cuPrice(), paymentTransfer(), sysDrain]));
    assert.equal(r.isValid, false);
    assert.match(r.invalidReason || '', /disallowed_program/);
  });

  it('REJECTS a disallowed ComputeBudget op (RequestHeapFrame)', async () => {
    const heap = ComputeBudgetProgram.requestHeapFrame({ bytes: 1024 * 32 });
    const r = await verify(buildTx([heap, cuLimit(), cuPrice(), paymentTransfer()]));
    assert.equal(r.isValid, false);
    assert.match(r.invalidReason || '', /disallowed_compute_budget_op/);
  });

  it('REJECTS an empty (no-op) SPL Token instruction smuggled alongside the payment', async () => {
    const emptyTokenIx = new TransactionInstruction({
      keys: [{ pubkey: feePayerAta, isSigner: false, isWritable: true }],
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      data: Buffer.alloc(0),
    });
    const r = await verify(buildTx([cuLimit(), cuPrice(), paymentTransfer(), emptyTokenIx]));
    assert.equal(r.isValid, false);
  });

  it('settle re-runs the guard and refuses to co-sign a malicious tx (no network)', async () => {
    const approve = createApproveInstruction(feePayerAta, attacker, feePayer.publicKey, 1_000_000_000n);
    const malicious = buildTx([cuLimit(), cuPrice(), paymentTransfer(), approve, memoIx()]);
    const r = await settleSvmPayment(malicious);
    assert.equal(r.success, false);
    assert.match(r.error || '', /cosign_guard_failed/);
  });

  it('settle refuses to co-sign a second-TransferChecked drain (no network)', async () => {
    const drain = createTransferCheckedInstruction(
      feePayerAta, USDC_MINT, attackerAta, feePayer.publicKey, 500_000_000n, 6,
    );
    const malicious = buildTx([cuLimit(), cuPrice(), paymentTransfer(), drain]);
    const r = await settleSvmPayment(malicious);
    assert.equal(r.success, false);
    assert.match(r.error || '', /cosign_guard_failed/);
  });
});
