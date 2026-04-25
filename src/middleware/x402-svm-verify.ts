/**
 * Direct SVM verification and settlement for x402 payments.
 * Verifies and settles on-chain directly without external facilitator.
 * 
 * Security model:
 * - Only allows whitelisted programs (ComputeBudget, SPL Token, Memo)
 * - Verifies payer signature is present
 * - Validates transfer amount, mint, destination
 * - Prevents feePayer from being the token authority
 * - Simulates before submitting
 * - On-chain confirmation before returning success
 * - Blockhash checked via simulation (Solana rejects expired blockhashes)
 * - Replay protection via Solana's native dupe detection
 */
import { Connection, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync } from 'fs';

let feePayerKeypair: Keypair | null = null;

// Whitelisted programs that are safe for the feePayer to co-sign
const ALLOWED_PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',   // Compute budget
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',  // Memo v2
  'Memo1UhkJBfCR6MNB9bFzAdXsqM6wFAMicSTQ8GFAT8',  // Memo v1
]);

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
  transaction?: VersionedTransaction;
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

  // 2. Verify feePayer matches our keypair
  const feePayer = loadFeePayer();
  if (feePayer.publicKey.toBase58() !== expectedFeePayer) {
    return { isValid: false, invalidReason: 'fee_payer_mismatch', payer: '' };
  }

  const accountKeys = tx.message.getAccountKeys();
  const feePayerKey = accountKeys.get(0);
  if (!feePayerKey || feePayerKey.toBase58() !== expectedFeePayer) {
    return { isValid: false, invalidReason: 'fee_payer_not_first_account', payer: '' };
  }

  // 3. Verify ALL programs are whitelisted (critical: prevents malicious instructions)
  const compiledInstructions = tx.message.compiledInstructions;
  for (const ix of compiledInstructions) {
    const programId = accountKeys.get(ix.programIdIndex);
    if (!programId || !ALLOWED_PROGRAMS.has(programId.toBase58())) {
      return { 
        isValid: false, 
        invalidReason: 'disallowed_program: ' + (programId?.toBase58() || 'unknown'),
        payer: '' 
      };
    }
  }

  // 4. Find TransferChecked instruction (discriminator 12)
  let transferIx: any = null;
  let transferPayer = '';

  for (const ix of compiledInstructions) {
    const programId = accountKeys.get(ix.programIdIndex);
    if (!programId) continue;
    
    const programStr = programId.toBase58();
    if (programStr === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || 
        programStr === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
      if (ix.data.length > 0 && ix.data[0] === 12) {
        transferIx = ix;
        // TransferChecked accounts: source, mint, destination, authority
        if (ix.accountKeyIndexes.length >= 4) {
          const authorityKey = accountKeys.get(ix.accountKeyIndexes[3]);
          if (authorityKey) transferPayer = authorityKey.toBase58();
        }
        break;
      }
    }
  }

  if (!transferIx) {
    return { isValid: false, invalidReason: 'no_transfer_checked_instruction', payer: '' };
  }

  // 5. Parse and verify transfer amount
  if (transferIx.data.length < 10) {
    return { isValid: false, invalidReason: 'invalid_transfer_data', payer: transferPayer };
  }

  const amountBuf = transferIx.data.slice(1, 9);
  const amount = Buffer.from(amountBuf).readBigUInt64LE();
  
  if (amount < expectedAmount) {
    return { isValid: false, invalidReason: 'insufficient_amount_got_' + amount + '_need_' + expectedAmount, payer: transferPayer };
  }

  // 6. Verify mint
  if (transferIx.accountKeyIndexes.length < 4) {
    return { isValid: false, invalidReason: 'malformed_transfer_accounts', payer: transferPayer };
  }
  
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

  // 8. Prevent feePayer from being the token authority (no self-draining)
  if (transferPayer === expectedFeePayer) {
    return { isValid: false, invalidReason: 'fee_payer_cannot_be_token_authority', payer: transferPayer };
  }

  // 9. Verify the payer actually signed the transaction
  // The payer's signature should be present (not all zeros)
  const signerKeys = tx.message.getAccountKeys();
  const payerAccountIndex = findAccountIndex(signerKeys, transferPayer);
  if (payerAccountIndex === -1) {
    return { isValid: false, invalidReason: 'payer_not_in_accounts', payer: transferPayer };
  }
  
  // Check that the payer's signature slot is populated (not empty)
  // In a VersionedTransaction, signatures array corresponds to the signable accounts
  if (payerAccountIndex < tx.signatures.length) {
    const sig = tx.signatures[payerAccountIndex];
    const isEmpty = sig.every(b => b === 0);
    if (isEmpty) {
      return { isValid: false, invalidReason: 'payer_signature_missing', payer: transferPayer };
    }
  } else {
    return { isValid: false, invalidReason: 'payer_not_a_signer', payer: transferPayer };
  }

  // 10. Verify only one TransferChecked instruction exists (prevent hidden extra transfers)
  let transferCount = 0;
  for (const ix of compiledInstructions) {
    const programId = accountKeys.get(ix.programIdIndex);
    if (!programId) continue;
    const programStr = programId.toBase58();
    if ((programStr === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || 
         programStr === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') &&
        ix.data.length > 0 && ix.data[0] === 12) {
      transferCount++;
    }
  }
  if (transferCount > 1) {
    return { isValid: false, invalidReason: 'multiple_transfers_not_allowed', payer: transferPayer };
  }

  return { isValid: true, payer: transferPayer, transaction: tx };
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
 */
export async function settleSvmPayment(
  txBase64: string,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const feePayer = loadFeePayer();
  const connection = new Connection(RPC_URL, 'confirmed');

  let tx: VersionedTransaction;
  try {
    const txBytes = Buffer.from(txBase64, 'base64');
    tx = VersionedTransaction.deserialize(txBytes);
  } catch (e) {
    return { success: false, error: 'invalid_transaction_encoding' };
  }

  // Co-sign with feePayer
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
