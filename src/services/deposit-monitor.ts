import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { db } from "../db";
import { deposit } from "./balance";
import { getSolanaKeypair, getEvmPrivateKey } from "./deposit-wallets";

// ─── Config ───
const SOL_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TREASURY_SOL = new PublicKey("B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3");

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TREASURY_EVM = "0x7fA8aC4b42fd0C97ca983Bc73135EdbeA5bD6ab2";

const POLL_INTERVAL = 60_000; // 60s
const SWEEP_MIN_USDC = 1; // Don't sweep dust

// RPC — use Helius if available, else public
const SOL_RPC = process.env.HELIUS_RPC || process.env.SOLANA_MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";

const solConn = new Connection(SOL_RPC, "confirmed");

// ─── DB: Track processed deposits to prevent double-crediting ───
function ensureTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deposit_credits (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      amount_usdc REAL NOT NULL,
      tx_signature TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    CREATE INDEX IF NOT EXISTS idx_deposit_credits_wallet ON deposit_credits(wallet_id);
  `);
}

function wasAlreadyCredited(walletId: string, chain: string, amount: number): boolean {
  // Check if we already credited this exact amount from this wallet recently (last 5 min)
  // Use amount + wallet + chain as dedup key since we're polling balances not tx signatures
  const row = db.prepare(
    "SELECT 1 FROM deposit_credits WHERE wallet_id = ? AND chain = ? AND amount_usdc = ? AND created_at > datetime('now', '-5 minutes')"
  ).get(walletId, chain, amount);
  return !!row;
}

function recordCredit(walletId: string, chain: string, amount: number, txSig?: string): void {
  db.prepare(
    "INSERT INTO deposit_credits (id, wallet_id, chain, amount_usdc, tx_signature) VALUES (?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), walletId, chain, amount, txSig || null);
}

// ─── Solana USDC Deposits ───
async function checkSolanaDeposits(): Promise<void> {
  const wallets = db.prepare("SELECT * FROM deposit_wallets").all() as any[];
  if (!wallets.length) return;

  for (const w of wallets) {
    try {
      const pubkey = new PublicKey(w.solana_address);

      // Get USDC token accounts
      const tokenAccounts = await solConn.getParsedTokenAccountsByOwner(pubkey, { mint: SOL_USDC_MINT });

      for (const ta of tokenAccounts.value) {
        const info = ta.account.data.parsed?.info;
        const amount = info?.tokenAmount?.uiAmount || 0;

        if (amount > 0) {
          // Check if already credited
          if (wasAlreadyCredited(w.id, "solana", amount)) continue;

          // Credit user balance
          const refId = `sol_${w.solana_address}_${amount}_${Date.now()}`;
          try {
            deposit(w.user_id, amount, refId, `Solana USDC deposit: $${amount}`);
            recordCredit(w.id, "solana", amount);
            console.log(`💰 [deposit-monitor] Credited $${amount} USDC to user ${w.user_id} (Solana)`);

            // Sweep to treasury
            if (amount >= SWEEP_MIN_USDC) {
              await sweepSolanaUsdc(w.derivation_index, pubkey, amount);
            }
          } catch (e: any) {
            if (e.message?.includes("Duplicate")) continue;
            console.error(`[deposit-monitor] Credit failed for ${w.user_id}:`, e.message);
          }
        }
      }
    } catch (e: any) {
      if (!e.message?.includes("429")) {
        // Suppress rate limit errors — they're expected on public RPC
        console.error(`[deposit-monitor] Solana check failed for ${w.solana_address}:`, e.message);
      }
    }

    // Delay between wallets to avoid rate limiting (longer for public RPC)
    await sleep(SOL_RPC.includes("helius") ? 200 : 2000);
  }
}

async function sweepSolanaUsdc(derivationIndex: number, fromPubkey: PublicKey, amount: number): Promise<void> {
  try {
    const keypair = getSolanaKeypair(derivationIndex);
    const fromAta = getAssociatedTokenAddressSync(SOL_USDC_MINT, fromPubkey);
    const toAta = getAssociatedTokenAddressSync(SOL_USDC_MINT, TREASURY_SOL);

    // Amount in smallest units (USDC has 6 decimals)
    const amountRaw = BigInt(Math.floor(amount * 1_000_000));

    const ix = createTransferInstruction(fromAta, toAta, fromPubkey, amountRaw, [], TOKEN_PROGRAM_ID);

    const { Transaction } = await import("@solana/web3.js");
    const tx = new Transaction().add(ix);
    tx.feePayer = fromPubkey;
    tx.recentBlockhash = (await solConn.getLatestBlockhash()).blockhash;
    tx.sign(keypair);

    const sig = await solConn.sendRawTransaction(tx.serialize());
    console.log(`📤 [deposit-monitor] Swept $${amount} USDC to treasury (Solana): ${sig}`);
  } catch (e: any) {
    // Sweep failures are non-critical — funds are safe, just not swept yet
    // Common reason: deposit wallet has no SOL for gas
    console.warn(`[deposit-monitor] Sweep failed (Solana): ${e.message}`);
  }
}

// ─── Base USDC Deposits ───
async function checkBaseDeposits(): Promise<void> {
  const wallets = db.prepare("SELECT * FROM deposit_wallets").all() as any[];
  if (!wallets.length) return;

  for (const w of wallets) {
    try {
      // Query USDC balance via eth_call (balanceOf)
      const paddedAddr = w.evm_address.replace("0x", "").padStart(64, "0");
      const callData = "0x70a08231" + paddedAddr; // balanceOf(address)

      const resp = await fetch(BASE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: BASE_USDC, data: callData }, "latest"],
        }),
      });

      const result = await resp.json() as any;
      if (!result.result || result.result === "0x" || result.result === "0x0") continue;

      const rawBalance = BigInt(result.result);
      const amount = Number(rawBalance) / 1_000_000; // USDC has 6 decimals

      if (amount > 0) {
        if (wasAlreadyCredited(w.id, "base", amount)) continue;

        const refId = `base_${w.evm_address}_${amount}_${Date.now()}`;
        try {
          deposit(w.user_id, amount, refId, `Base USDC deposit: $${amount}`);
          recordCredit(w.id, "base", amount);
          console.log(`💰 [deposit-monitor] Credited $${amount} USDC to user ${w.user_id} (Base)`);

          // TODO: Sweep Base USDC to treasury
          // Needs: ethers/viem to sign tx with getEvmPrivateKey(w.derivation_index)
          if (amount >= SWEEP_MIN_USDC) {
            console.log(`📤 [deposit-monitor] TODO: Sweep $${amount} USDC from ${w.evm_address} to ${TREASURY_EVM}`);
          }
        } catch (e: any) {
          if (e.message?.includes("Duplicate")) continue;
          console.error(`[deposit-monitor] Credit failed for ${w.user_id}:`, e.message);
        }
      }
    } catch (e: any) {
      console.error(`[deposit-monitor] Base check failed for ${w.evm_address}:`, e.message);
    }

    await sleep(1000);
  }
}

// ─── Monitor Lifecycle ───
let intervalId: NodeJS.Timeout | null = null;

export function startDepositMonitor(): void {
  ensureTable();
  console.log(`👀 [deposit-monitor] Started (polling every ${POLL_INTERVAL / 1000}s, Solana RPC: ${SOL_RPC.includes("helius") ? "Helius" : "public"})`);

  // Initial check after 15s (let server finish starting)
  setTimeout(async () => {
    await checkSolanaDeposits().catch(e => console.error("[deposit-monitor] Solana:", e.message));
    await checkBaseDeposits().catch(e => console.error("[deposit-monitor] Base:", e.message));
  }, 15_000);

  // Then every POLL_INTERVAL
  intervalId = setInterval(async () => {
    await checkSolanaDeposits().catch(e => console.error("[deposit-monitor] Solana:", e.message));
    await checkBaseDeposits().catch(e => console.error("[deposit-monitor] Base:", e.message));
  }, POLL_INTERVAL);
}

export function stopDepositMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[deposit-monitor] Stopped");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
