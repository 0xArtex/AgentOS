/**
 * Test x402 Solana payment against AgentOS
 * Uses @x402/svm client to build a proper payment payload
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferCheckedInstruction, getMint } from '@solana/spl-token';
import bs58 from 'bs58';

const AGENTOS_URL = 'http://localhost:3001';
const AGENT_TOKEN = 'aos_n8t7pr3qzmgoxmxxmumzfwkef3jqhfzjp4u9y89325jlyf0l';
const RPC_URL = 'https://api.mainnet-beta.solana.com';

// Load wallet from the zolty keypair (has USDC)
import { readFileSync } from 'fs';
const walletData = JSON.parse(readFileSync('/root/.zolty-keypair.json', 'utf8'));

async function main() {
  // Step 1: Make request, get 402 response
  console.log('Step 1: Getting 402 payment requirements...');
  const resp = await fetch(`${AGENTOS_URL}/email/inboxes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': AGENT_TOKEN,
    },
    body: JSON.stringify({ name: 'zolty-test', walletAddress: walletData.publicKey }),
  });

  if (resp.status !== 402) {
    console.log('Status:', resp.status);
    console.log('Body:', await resp.text());
    return;
  }

  const paymentRequired = await resp.json() as any;
  console.log('Got 402. Accepts:', paymentRequired.accepts?.map((a: any) => a.network));

  // Find Solana accept
  const solanaAccept = paymentRequired.accepts?.find((a: any) => a.network?.startsWith('solana:'));
  if (!solanaAccept) {
    console.error('No Solana payment option');
    return;
  }

  console.log('Solana requirement:', JSON.stringify(solanaAccept, null, 2));

  // Step 2: Build the x402-compatible transaction
  // Must have exactly 3 instructions: SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked
  const connection = new Connection(RPC_URL);
  const feePayer = new PublicKey(solanaAccept.extra.feePayer);
  const payTo = new PublicKey(solanaAccept.payTo);
  const mint = new PublicKey(solanaAccept.asset);
  const amount = BigInt(solanaAccept.amount);

  // Use our wallet
  const payer = Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
  console.log('Payer:', payer.publicKey.toBase58());

  // Get ATAs
  const sourceATA = await getAssociatedTokenAddress(mint, payer.publicKey);
  const destATA = await getAssociatedTokenAddress(mint, payTo);
  console.log('Source ATA:', sourceATA.toBase58());
  console.log('Dest ATA:', destATA.toBase58());

  // Check balance
  try {
    const balance = await connection.getTokenAccountBalance(sourceATA);
    console.log('USDC Balance:', balance.value.uiAmount);
  } catch (e) {
    console.error('No USDC token account found for payer');
    return;
  }

  // Get mint decimals
  const mintInfo = await getMint(connection, mint);
  console.log('Mint decimals:', mintInfo.decimals);

  // Build transaction with exactly 3 instructions
  const { blockhash } = await connection.getLatestBlockhash();
  
  const ix1 = ComputeBudgetProgram.setComputeUnitLimit({ units: 6500 });
  const ix2 = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
  const ix3 = createTransferCheckedInstruction(
    sourceATA, mint, destATA, payer.publicKey, amount, mintInfo.decimals
  );

  const messageV0 = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: [ix1, ix2, ix3],
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  // Partially sign with our key only (facilitator signs as feePayer)
  tx.sign([payer]);

  const serialized = Buffer.from(tx.serialize()).toString('base64');
  console.log('Transaction built, length:', serialized.length);

  // Step 3: Build x402 payment payload and retry
  const paymentPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: solanaAccept.network,
    payload: {
      transaction: serialized,
    },
    accepted: {
      scheme: 'exact',
      network: solanaAccept.network,
    },
  };

  // Encode as the server expects (base64 JSON or direct header)
  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  console.log('\nStep 3: Retrying with payment...');
  const resp2 = await fetch(`${AGENTOS_URL}/email/inboxes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': AGENT_TOKEN,
      'Payment-Signature': paymentHeader,
    },
    body: JSON.stringify({ name: 'zolty-test', walletAddress: walletData.publicKey }),
  });

  console.log('Status:', resp2.status);
  const result = await resp2.json();
  console.log('Result:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
