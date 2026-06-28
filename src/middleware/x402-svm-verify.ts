/**
 * Direct SVM verification and settlement for x402 payments.
 * Verifies and settles on-chain directly without external facilitator.
 *
 * Security model:
 * - INSTRUCTION-LEVEL allowlist (not just program-level): the fee payer
 *   co-signs the submitted transaction, so every instruction it puts its
 *   signature behind is scrutinised. The ONLY shapes accepted are:
 *     • SPL Token / Token-2022: exactly ONE instruction, and it must be the
 *       payment `TransferChecked` (discriminator 12). Any other token op
 *       (Transfer / Approve / SetAuthority / CloseAccount / Burn / a second
 *       TransferChecked / an empty instruction) rejects the WHOLE transaction.
 *     • ComputeBudget: only SetComputeUnitLimit (2) / SetComputeUnitPrice (3).
 *     • Memo (v1/v2): allowed (log-only, touches no fund-bearing accounts).
 *     • Any other program: rejected.
 * - Anti-drain invariant: NO instruction may reference the fee payer in ANY
 *   account slot. A legitimate single TransferChecked to the treasury never
 *   touches the fee payer, so any reference can only be an attempt to make the
 *   server co-sign an action against its own funds. The fee payer's signature
 *   must authorise ONLY the SOL transaction fee.
 * - Address-lookup-table transactions are rejected outright (we cannot see the
 *   resolved accounts without an extra on-chain fetch, and a table index could
 *   hide a reference to the fee payer's accounts). Legit payments never need them.
 * - Validates transfer amount, mint, destination ATA, and payer signature.
 * - The SAME allowlist is re-asserted inside `settleSvmPayment` on the exact
 *   bytes about to be co-signed, so a verify/settle payload mismatch can never
 *   get the fee payer to sign something the verifier did not approve.
 * - Simulates before submitting; on-chain confirmation before returning success.
 * - Replay protection via Solana's native dupe detection + the caller's store.
 */
import { Connection, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'fs';

let feePayerKeypair: Keypair | null = null;

// Program ids relevant to the allowlist.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';     // SPL Token
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'; // Token-2022
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo v2
  'Memo1UhkJBfCR6MNB9bFzAdXsqM6wFAMicSTQ8GFAT8', // Memo v1
]);

// SPL Token instruction discriminator for TransferChecked (legacy + Token-2022).
const TRANSFER_CHECKED_DISCRIMINATOR = 12;
// ComputeBudget instruction discriminators we permit.
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

/**
 * Pull the claimed payer out of an x402 Payment-Signature header WITHOUT
 * doing on-chain verification. Lets pre-paywall route logic do cheap checks
 * (e.g. domain ownership) before charging the user. Spoofing the claim
 * gains nothing — the full verifier in `verifySvmPayment` still runs and
 * catches signature mismatches before settlement.
 *
 * Returns null on any decode failure (treat as unauthenticated).
 */
export function extractClaimedSvmPayer(paymentSignatureB64: string): string | null {
  try {
    const json = JSON.parse(Buffer.from(paymentSignatureB64, 'base64').toString('utf8'));
    const txB64 = json?.payload?.transaction;
    if (typeof txB64 !== 'string') return null;
    const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
    const accountKeys = tx.message.getAccountKeys();
    for (const ix of tx.message.compiledInstructions) {
      const programId = accountKeys.get(ix.programIdIndex);
      if (!programId) continue;
      if (!TOKEN_PROGRAMS.has(programId.toBase58())) continue;
      // TransferChecked discriminator is 12; account index 3 is the authority
      // (the wallet that owns the source token account, i.e. the actual payer).
      if (ix.data.length > 0 && ix.data[0] === TRANSFER_CHECKED_DISCRIMINATOR && ix.accountKeyIndexes.length >= 4) {
        const authorityKey = accountKeys.get(ix.accountKeyIndexes[3]);
        if (authorityKey) return authorityKey.toBase58();
      }
    }
    return null;
  } catch {
    return null;
  }
}

function loadFeePayer(): Keypair {
  if (feePayerKeypair) return feePayerKeypair;

  // 1. Env var (preferred — works on dev and prod)
  const envKey = process.env.SVM_PRIVATE_KEY;
  if (envKey) {
    feePayerKeypair = Keypair.fromSecretKey(bs58.decode(envKey));
  }

  // 2. Legacy fallback: production server's facilitator .env file
  if (!feePayerKeypair) {
    try {
      const envContent = readFileSync('/root/x402-facilitator/examples/facilitator-server/.env', 'utf8');
      const match = envContent.match(/SVM_PRIVATE_KEY=(\S+)/);
      if (match) {
        feePayerKeypair = Keypair.fromSecretKey(bs58.decode(match[1]));
      }
    } catch {}
  }

  if (!feePayerKeypair) {
    throw new Error('No SVM fee payer key configured (set SVM_PRIVATE_KEY env var)');
  }

  console.log('[x402-svm] Fee payer loaded:', feePayerKeypair.publicKey.toBase58());
  return feePayerKeypair;
}

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

interface SvmVerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer: string;
  /** Actual transferred amount in USDC base units (may exceed the required minimum). */
  amount?: bigint;
  transaction?: VersionedTransaction;
}

interface CoSignGuardResult {
  ok: boolean;
  reason?: string;
  /** Resolved (static) account keys — reused by the caller to avoid re-resolving. */
  accountKeys?: ReturnType<VersionedTransaction['message']['getAccountKeys']>;
  /** Index into `message.compiledInstructions` of the single TransferChecked. */
  tokenIxIndex?: number;
}

/**
 * The instruction-level allowlist that gates whether the fee payer may co-sign.
 *
 * This is intentionally self-contained (depends ONLY on the transaction and the
 * fee payer pubkey, not on route config) so it can be re-run verbatim inside
 * `settleSvmPayment` against the exact bytes about to be signed. It enforces the
 * structural / anti-drain constraints; route-specific checks (amount, mint,
 * destination, payer signature) live in `verifySvmPayment`.
 *
 * Fails closed: any decode ambiguity or unexpected shape rejects.
 */
function assertCoSignSafe(tx: VersionedTransaction, expectedFeePayer: string): CoSignGuardResult {
  // Reject address-lookup-table transactions outright. We can't see the
  // resolved accounts without an extra on-chain fetch, and a table index could
  // hide a reference to the fee payer's accounts behind the lookup. Legit x402
  // payments are all-static (transfer + compute budget + memo). Fail closed.
  const lookups = (tx.message as any).addressTableLookups;
  if (Array.isArray(lookups) && lookups.length > 0) {
    return { ok: false, reason: 'address_lookup_tables_not_allowed' };
  }

  let accountKeys;
  try {
    accountKeys = tx.message.getAccountKeys();
  } catch {
    // getAccountKeys throws when lookups are unresolved — already guarded above,
    // but any other failure to resolve the account table is a hard reject.
    return { ok: false, reason: 'account_keys_unresolved' };
  }

  // Fee payer must be the first account (index 0) and match the server key.
  const feePayerKey = accountKeys.get(0);
  if (!feePayerKey || feePayerKey.toBase58() !== expectedFeePayer) {
    return { ok: false, reason: 'fee_payer_not_first_account' };
  }

  const ixs = tx.message.compiledInstructions;
  let tokenIxCount = 0;
  let tokenIxIndex = -1;

  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const programId = accountKeys.get(ix.programIdIndex);
    if (!programId) return { ok: false, reason: 'unresolved_program_id_ix_' + i };
    const program = programId.toBase58();
    const op = ix.data.length > 0 ? ix.data[0] : -1;

    if (TOKEN_PROGRAMS.has(program)) {
      // The ONLY token-program instruction permitted is the single payment
      // TransferChecked. Everything else (incl. a second TransferChecked or an
      // empty instruction) rejects the whole transaction.
      if (op !== TRANSFER_CHECKED_DISCRIMINATOR) {
        return { ok: false, reason: 'disallowed_token_instruction_op_' + op + '_ix_' + i };
      }
      tokenIxCount++;
      tokenIxIndex = i;
      if (tokenIxCount > 1) {
        return { ok: false, reason: 'multiple_token_instructions' };
      }
    } else if (program === COMPUTE_BUDGET_PROGRAM) {
      if (op !== SET_COMPUTE_UNIT_LIMIT && op !== SET_COMPUTE_UNIT_PRICE) {
        return { ok: false, reason: 'disallowed_compute_budget_op_' + op + '_ix_' + i };
      }
    } else if (MEMO_PROGRAMS.has(program)) {
      // Memo is log-only; references no fund-bearing accounts. Allowed.
    } else {
      return { ok: false, reason: 'disallowed_program: ' + program };
    }
  }

  if (tokenIxCount !== 1) {
    return { ok: false, reason: 'expected_exactly_one_token_transfer_got_' + tokenIxCount };
  }

  // Anti-drain invariant: NO instruction may reference the fee payer in ANY
  // account slot. A legitimate single TransferChecked to the treasury never
  // names the fee payer (its accounts are payer-ATA / mint / treasury-ATA /
  // payer). Any reference is an attempt to make the server co-sign an action
  // against its own funds (Approve/Transfer/SetAuthority/CloseAccount on the
  // fee payer's accounts). The fee payer's signature must cover ONLY the fee.
  for (let i = 0; i < ixs.length; i++) {
    for (const accIdx of ixs[i].accountKeyIndexes) {
      if (accIdx === 0) {
        return { ok: false, reason: 'instruction_references_fee_payer_ix_' + i };
      }
      const k = accountKeys.get(accIdx);
      if (k && k.toBase58() === expectedFeePayer) {
        return { ok: false, reason: 'instruction_references_fee_payer_ix_' + i };
      }
    }
  }

  return { ok: true, accountKeys, tokenIxIndex };
}

export async function verifySvmPayment(
  txBase64: string,
  expectedPayTo: string,
  expectedAmount: bigint,
  expectedMint: string,
  expectedFeePayer: string,
): Promise<SvmVerifyResult> {
  // 1. Decode transaction
  let tx: VersionedTransaction;
  try {
    const txBytes = Buffer.from(txBase64, 'base64');
    tx = VersionedTransaction.deserialize(txBytes);
  } catch (e) {
    return { isValid: false, invalidReason: 'invalid_transaction_encoding', payer: '' };
  }

  // 2. Verify feePayer matches our keypair (we must be the one co-signing)
  const feePayer = loadFeePayer();
  if (feePayer.publicKey.toBase58() !== expectedFeePayer) {
    return { isValid: false, invalidReason: 'fee_payer_mismatch', payer: '' };
  }

  // 3. Instruction-level allowlist + anti-drain guard. This is the same check
  //    re-run before co-signing in settleSvmPayment.
  const guard = assertCoSignSafe(tx, expectedFeePayer);
  if (!guard.ok) {
    return { isValid: false, invalidReason: guard.reason, payer: '' };
  }
  const accountKeys = guard.accountKeys!;
  const transferIx = tx.message.compiledInstructions[guard.tokenIxIndex!];

  // 4. Identify the payer (TransferChecked accounts: source, mint, destination, authority)
  if (transferIx.accountKeyIndexes.length < 4) {
    return { isValid: false, invalidReason: 'malformed_transfer_accounts', payer: '' };
  }
  const authorityKey = accountKeys.get(transferIx.accountKeyIndexes[3]);
  const transferPayer = authorityKey ? authorityKey.toBase58() : '';
  if (!transferPayer) {
    return { isValid: false, invalidReason: 'transfer_authority_unresolved', payer: '' };
  }

  // 5. Parse and verify transfer amount. TransferChecked data = [12][amount u64 LE][decimals u8].
  if (transferIx.data.length < 10) {
    return { isValid: false, invalidReason: 'invalid_transfer_data', payer: transferPayer };
  }
  const amountBuf = transferIx.data.slice(1, 9);
  const amount = Buffer.from(amountBuf).readBigUInt64LE();
  if (amount < expectedAmount) {
    return { isValid: false, invalidReason: 'insufficient_amount_got_' + amount + '_need_' + expectedAmount, payer: transferPayer };
  }

  // 6. Verify mint
  const mintKey = accountKeys.get(transferIx.accountKeyIndexes[1]);
  if (!mintKey || mintKey.toBase58() !== expectedMint) {
    return { isValid: false, invalidReason: 'mint_mismatch', payer: transferPayer };
  }

  // 7. Verify destination ATA matches expected payTo
  const expectedDestATA = await getAssociatedTokenAddress(
    new PublicKey(expectedMint),
    new PublicKey(expectedPayTo),
  );
  const destKey = accountKeys.get(transferIx.accountKeyIndexes[2]);
  if (!destKey || destKey.toBase58() !== expectedDestATA.toBase58()) {
    return { isValid: false, invalidReason: 'destination_mismatch', payer: transferPayer };
  }

  // 8. Prevent feePayer from being the token authority (no self-draining).
  //    assertCoSignSafe already guarantees no instruction references the fee
  //    payer, so this is belt-and-suspenders, but keep it explicit.
  if (transferPayer === expectedFeePayer) {
    return { isValid: false, invalidReason: 'fee_payer_cannot_be_token_authority', payer: transferPayer };
  }

  // 9. Verify the payer actually signed the transaction (signature slot populated).
  const payerAccountIndex = findAccountIndex(accountKeys, transferPayer);
  if (payerAccountIndex === -1) {
    return { isValid: false, invalidReason: 'payer_not_in_accounts', payer: transferPayer };
  }
  if (payerAccountIndex < tx.signatures.length) {
    const sig = tx.signatures[payerAccountIndex];
    const isEmpty = sig.every(b => b === 0);
    if (isEmpty) {
      return { isValid: false, invalidReason: 'payer_signature_missing', payer: transferPayer };
    }
  } else {
    return { isValid: false, invalidReason: 'payer_not_a_signer', payer: transferPayer };
  }

  return { isValid: true, payer: transferPayer, amount, transaction: tx };
}

function findAccountIndex(accountKeys: any, address: string): number {
  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys.get(i);
    if (key && key.toBase58() === address) return i;
  }
  return -1;
}

/**
 * Co-sign and submit the transaction on-chain.
 *
 * Before placing the production fee payer's signature on ANYTHING, we
 * re-deserialize the exact bytes we are about to submit and re-run the full
 * `assertCoSignSafe` allowlist on them. This guarantees the bytes that get
 * co-signed are exactly the bytes that satisfy the allowlist — even if a
 * verify/settle payload mismatch or a re-encoding slipped a different
 * transaction in here, the fee payer never signs anything that could drain it.
 */
export async function settleSvmPayment(
  txBase64: string,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const feePayer = loadFeePayer();

  let tx: VersionedTransaction;
  try {
    const txBytes = Buffer.from(txBase64, 'base64');
    tx = VersionedTransaction.deserialize(txBytes);
  } catch (e) {
    return { success: false, error: 'invalid_transaction_encoding' };
  }

  // Re-assert the instruction-level allowlist on the exact bytes about to be
  // signed. Fail CLOSED before any signing / network round-trip.
  const guard = assertCoSignSafe(tx, feePayer.publicKey.toBase58());
  if (!guard.ok) {
    console.error('[x402-svm] cosign guard rejected settlement:', guard.reason);
    return { success: false, error: 'cosign_guard_failed: ' + guard.reason };
  }

  const connection = new Connection(RPC_URL, 'confirmed');

  // Co-sign with feePayer (only after the guard passed)
  tx.sign([feePayer]);

  // Simulate first (catches expired blockhash, insufficient funds, etc.)
  try {
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      console.error('[x402-svm] Simulation failed:', JSON.stringify(sim.value.err));
      return { success: false, error: 'simulation_failed: ' + JSON.stringify(sim.value.err) };
    }
  } catch (e: any) {
    console.error('[x402-svm] Simulation error:', e);
    return { success: false, error: 'simulation_error: ' + String(e) };
  }

  // Submit on-chain. Once sendRawTransaction returns, the tx may have landed
  // and moved USDC — we must not swallow that state. `confirmTransaction` with
  // just a commitment argument polls indefinitely on public RPC, causing the
  // edge (nginx/Cloudflare) to serve HTML while the server hangs. Use explicit
  // getSignatureStatus polling with a hard 25s deadline so we stay under edge
  // timeouts, and log unresolved signatures for manual reconciliation.
  let sig: string;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (e: any) {
    console.error('[x402-svm] Submit error:', e);
    return { success: false, error: 'submit_error: ' + String(e) };
  }

  const deadline = Date.now() + 25_000;
  let lastErr: any = null;
  while (Date.now() < deadline) {
    try {
      const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: false });
      const v = st.value;
      if (v) {
        if (v.err) {
          return { success: false, error: 'confirmation_failed: ' + JSON.stringify(v.err), signature: sig };
        }
        if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') {
          console.log('[x402-svm] Settlement successful:', sig);
          return { success: true, signature: sig };
        }
      }
    } catch (e: any) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // Timeout — tx was submitted but we didn't observe confirmation in time. The
  // on-chain outcome is unknown: USDC may already have moved. Emit a marker so
  // ops can reconcile by looking up the signature on an explorer.
  console.error('[x402-svm] [RECONCILE NEEDED] settlement confirmation timeout', {
    signature: sig,
    rpc: RPC_URL,
    lastPollError: lastErr?.message || null,
  });
  return {
    success: false,
    error: 'settlement_timeout: tx may still land — reconcile signature ' + sig,
    signature: sig,
  };
}
