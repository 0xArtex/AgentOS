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

// Track last seen balance per wallet+chain to only credit new deposits
const _lastSeen = new Map<string, number>();

function initLastSeen(): void {
  // For Solana: track last seen on-chain balance (most recent credit amount_usdc = snapshot of balance at time of credit)
  // For Base: not used (tx-hash dedup instead)
  const rows = db.prepare(
    "SELECT wallet_id, chain, amount_usdc FROM deposit_credits WHERE chain = 'solana' ORDER BY created_at DESC"
  ).all() as any[];
  for (const r of rows) {
    const key = `${r.wallet_id}:${r.chain}`;
    if (!_lastSeen.has(key)) _lastSeen.set(key, r.amount_usdc); // most recent
  }
}

function getNewDeposit(walletId: string, chain: string, currentBalance: number): number {
  const key = `${walletId}:${chain}`;
  const lastCredited = _lastSeen.get(key) || 0;
  // Only credit if balance is higher than what we've already credited (minus sweeps)
  // Simple approach: if balance > 0 and we haven't credited this exact balance recently
  return currentBalance; // We'll use the record check below
}

function wasAlreadyCredited(walletId: string, chain: string, amount: number): boolean {
  const key = `${walletId}:${chain}`;
  const lastSeen = _lastSeen.get(key) || 0;
  // If current on-chain balance matches what we already credited, skip
  if (Math.abs(amount - lastSeen) < 0.001) return true;
  // If current balance is LESS than last seen, the wallet was swept — reset
  if (amount < lastSeen - 0.001) {
    _lastSeen.set(key, 0);
    return false;
  }
  return false;
}

function recordCredit(walletId: string, chain: string, amount: number, txSig?: string): void {
  const key = `${walletId}:${chain}`;
  _lastSeen.set(key, amount);
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
          // Check if balance changed since last seen
          if (wasAlreadyCredited(w.id, "solana", amount)) continue;

          // Credit only the delta (new deposit amount)
          const key = `${w.id}:solana`;
          const lastSeen = _lastSeen.get(key) || 0;
          const delta = amount - lastSeen;
          if (delta < 0.001) continue;

          const refId = `sol_${w.solana_address}_${amount}_${Date.now()}`;
          try {
            deposit(w.user_id, delta, refId, `Solana USDC deposit: $${delta.toFixed(6)}`);
            recordCredit(w.id, "solana", amount);
            console.log(`💰 [deposit-monitor] Credited $${delta.toFixed(6)} USDC to user ${w.user_id} (Solana)`);

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

async function sweepBaseUsdc(derivationIndex: number, fromAddress: string, amount: number): Promise<void> {
  try {
    const { ethers } = require("ethers");
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const privateKey = getEvmPrivateKey(derivationIndex);
    const wallet = new ethers.Wallet(privateKey, provider);

    // ERC-20 transfer(address,uint256)
    const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
    const amountRaw = BigInt(Math.floor(amount * 1_000_000)); // USDC 6 decimals
    const data = iface.encodeFunctionData("transfer", [TREASURY_EVM, amountRaw]);

    const tx = await wallet.sendTransaction({
      to: BASE_USDC,
      data,
      gasLimit: 65000,
    });

    console.log(`📤 [deposit-monitor] Sweeping $${amount} USDC to treasury (Base): ${tx.hash}`);
    const receipt = await tx.wait(1);
    if (receipt?.status === 1) {
      console.log(`✅ [deposit-monitor] Swept $${amount} USDC to treasury (Base): ${tx.hash}`);
    } else {
      console.warn(`[deposit-monitor] Sweep tx reverted (Base): ${tx.hash}`);
    }
  } catch (e: any) {
    // Sweep failures are non-critical — funds are safe, just not swept yet
    // Common reason: deposit wallet has no ETH for gas
    console.warn(`[deposit-monitor] Sweep failed (Base): ${e.message}`);
  }
}

// ─── Base USDC Deposits (transfer event log-based) ───
// Track last scanned block per wallet to avoid rescanning
const _lastBlock = new Map<string, number>();

async function getBaseBlockNumber(): Promise<number> {
  const resp = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const r = await resp.json() as any;
  return parseInt(r.result, 16);
}

async function checkBaseDeposits(): Promise<void> {
  const wallets = db.prepare("SELECT * FROM deposit_wallets").all() as any[];
  if (!wallets.length) return;

  const currentBlock = await getBaseBlockNumber();
  // USDC Transfer event topic: Transfer(address,address,uint256)
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  for (const w of wallets) {
    try {
      const blockKey = `${w.id}:base`;
      // Start from last scanned block or ~1 hour ago (~1800 blocks on Base)
      let fromBlock = _lastBlock.get(blockKey) || (currentBlock - 1800);
      
      // Don't scan more than 10000 blocks at once
      if (currentBlock - fromBlock > 10000) fromBlock = currentBlock - 10000;

      const paddedAddr = w.evm_address.replace("0x", "").toLowerCase().padStart(64, "0");

      // Get Transfer logs TO this address
      const resp = await fetch(BASE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_getLogs",
          params: [{
            fromBlock: "0x" + fromBlock.toString(16),
            toBlock: "0x" + currentBlock.toString(16),
            address: BASE_USDC,
            topics: [TRANSFER_TOPIC, null, "0x" + paddedAddr],
          }],
        }),
      });

      const result = await resp.json() as any;
      _lastBlock.set(blockKey, currentBlock + 1);

      if (!result.result || !Array.isArray(result.result)) continue;

      for (const log of result.result) {
        const txHash = log.transactionHash;
        const rawAmount = BigInt(log.data);
        const amount = Number(rawAmount) / 1_000_000; // USDC 6 decimals

        if (amount < 0.001) continue;

        // Dedup by tx hash
        const refId = `base_${txHash}`;
        try {
          deposit(w.user_id, amount, refId, `Base USDC deposit: $${amount.toFixed(6)}`);
          recordCredit(w.id, "base", amount, txHash);
          console.log(`💰 [deposit-monitor] Credited $${amount.toFixed(6)} USDC to user ${w.user_id} (Base, tx: ${txHash.slice(0, 10)}...)`);

          if (amount >= SWEEP_MIN_USDC) {
            await sweepBaseUsdc(w.derivation_index, w.evm_address, amount);
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
  initLastSeen();
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
