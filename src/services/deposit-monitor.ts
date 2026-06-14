import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { db } from "../db";
import { deposit } from "./balance";
import { getSolanaKeypair, getEvmPrivateKey } from "./deposit-wallets";
import { config } from "../config";

// ─── Config ───
// Treasury addresses are sourced from `config` (TREASURY_WALLET /
// TREASURY_EVM_WALLET) — the SAME source x402 uses for `payTo` and refund.ts
// uses for the refund origin. Single source of truth means rotating the
// treasury is a pure env change; nothing here hardcodes a specific wallet.
const SOL_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TREASURY_SOL = new PublicKey(config.treasuryWallet);

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TREASURY_EVM = config.treasuryEvmWallet;

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

// Per-wallet+chain count of credits already recorded. Used to build a STABLE
// Solana deposit reference-id: the same logical deposit always maps to the same
// id across restarts/cycles (so balance.deposit()'s UNIQUE(reference_id) backstop
// can reject a replay), while a genuine re-deposit of the same amount — which
// only happens AFTER a prior credit was recorded — gets the next seq and is
// correctly treated as new.
function creditSeq(walletId: string, chain: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM deposit_credits WHERE wallet_id = ? AND chain = ?"
  ).get(walletId, chain) as { n: number };
  return row.n;
}

// ─── Persistent scan cursor (Base) ───
function loadScanCursor(chain: string): number | null {
  const row = db.prepare("SELECT last_block FROM scan_cursor WHERE chain = ?").get(chain) as { last_block: number } | undefined;
  return row ? row.last_block : null;
}

function saveScanCursor(chain: string, lastBlock: number): void {
  db.prepare(
    "INSERT INTO scan_cursor (chain, last_block, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(chain) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at"
  ).run(chain, lastBlock);
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

          // STABLE reference-id: deterministic in (wallet, credit sequence,
          // amount) — NO Date.now(). This makes balance.deposit()'s
          // UNIQUE(reference_id) constraint a real backstop: if this exact
          // credit is replayed (e.g. a dropped sweep leaves the balance intact
          // and a later cycle re-derives the same id), the DB rejects it instead
          // of double-crediting. creditSeq is read BEFORE recordCredit so it
          // names "this" deposit; a genuine re-deposit of the same amount can
          // only occur after a prior credit was recorded, bumping the seq.
          const seq = creditSeq(w.id, "solana");
          const refId = `sol_${w.solana_address}_${seq}_${amount}`;
          try {
            deposit(w.user_id, delta, refId, `Solana USDC deposit: $${delta.toFixed(6)}`);
            recordCredit(w.id, "solana", amount);
            console.log(`💰 [deposit-monitor] Credited $${delta.toFixed(6)} USDC to user ${w.user_id} (Solana)`);

            // Sweep to treasury, then reset the in-memory snapshot to 0 ONLY
            // once the sweep is CONFIRMED on-chain. sweepSolanaUsdc returns the
            // signature on submission; a submitted tx can still drop. Until it
            // confirms, keep _lastSeen at the credited amount so the unchanged
            // on-chain balance yields delta 0 next cycle (no re-credit). When it
            // does confirm, the balance is ~0, so dropping _lastSeen to 0 lets a
            // future same-amount re-deposit be credited again.
            if (amount >= SWEEP_MIN_USDC) {
              const sig = await sweepSolanaUsdc(w.derivation_index, pubkey, amount);
              if (sig && await confirmSolanaSweep(sig)) _lastSeen.set(key, 0);
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

// Returns the submitted tx signature (NOT a confirmation), or null on failure.
// Callers MUST confirm via confirmSolanaSweep before treating the source wallet
// as drained — a submitted Solana tx can still be dropped by the cluster.
async function sweepSolanaUsdc(derivationIndex: number, fromPubkey: PublicKey, amount: number): Promise<string | null> {
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
    console.log(`📤 [deposit-monitor] Submitted sweep of $${amount} USDC to treasury (Solana): ${sig}`);
    return sig;
  } catch (e: any) {
    // Sweep failures are non-critical — funds are safe, just not swept yet
    // Common reason: deposit wallet has no SOL for gas
    console.warn(`[deposit-monitor] Sweep failed (Solana): ${e.message}`);
    return null;
  }
}

// Poll signature status until the sweep reaches at least "confirmed", or give
// up after SWEEP_CONFIRM_TIMEOUT_MS. Returns true ONLY on confirmed success.
// On timeout, drop, or on-chain error it returns false and the caller keeps
// _lastSeen at the credited amount, so the still-funded wallet is not mistaken
// for drained and re-credited. Uses getSignatureStatuses (bounded, explicit)
// rather than the deprecated confirmTransaction legacy-timeout strategy.
const SWEEP_CONFIRM_TIMEOUT_MS = 30_000;
const SWEEP_CONFIRM_POLL_MS = 2_000;

async function confirmSolanaSweep(sig: string): Promise<boolean> {
  const deadline = Date.now() + SWEEP_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { value } = await solConn.getSignatureStatuses([sig], { searchTransactionHistory: false });
      const st = value[0];
      if (st) {
        if (st.err) {
          console.warn(`[deposit-monitor] Sweep tx failed on-chain (Solana): ${sig}`, st.err);
          return false;
        }
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
          console.log(`✅ [deposit-monitor] Sweep confirmed (Solana): ${sig}`);
          return true;
        }
      }
    } catch (e: any) {
      // Transient RPC error — keep polling until the deadline.
      console.warn(`[deposit-monitor] Sweep status check error (Solana): ${sig} — ${e.message}`);
    }
    await sleep(SWEEP_CONFIRM_POLL_MS);
  }
  // Not confirmed within the window. Funds stay put; the next cycle re-evaluates
  // the on-chain balance. Safer to under-sweep than to risk a double-credit.
  console.warn(`[deposit-monitor] Sweep not confirmed within ${SWEEP_CONFIRM_TIMEOUT_MS}ms (Solana): ${sig}`);
  return false;
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
// How far back to scan when there is NO persisted cursor (first run on a fresh
// DB). ~1800 blocks ≈ 1h on Base. The persistent scan_cursor row is what lets
// us resume across restarts; without it a long downtime would silently skip
// deposits that landed while the process was down.
const BASE_COLD_START_LOOKBACK = 1800;
// Hard ceiling on a single eth_getLogs range so one huge catch-up (e.g. after
// days of downtime) is chunked across cycles instead of timing out the RPC.
const BASE_MAX_RANGE = 10000;

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

  // One chain-wide cursor (persisted) rather than a per-wallet in-memory map:
  // every wallet is scanned over the same [fromBlock, toBlock] window each
  // cycle, so a single resume point is sufficient and survives restarts.
  const persisted = loadScanCursor("base");
  let fromBlock = persisted ?? (currentBlock - BASE_COLD_START_LOOKBACK);
  // Clamp: never scan a negative floor, and chunk oversized catch-ups.
  if (fromBlock < 0) fromBlock = 0;
  if (currentBlock - fromBlock > BASE_MAX_RANGE) fromBlock = currentBlock - BASE_MAX_RANGE;
  // toBlock is pinned for the whole cycle so the cursor we persist matches the
  // exact range every wallet was scanned over.
  const toBlock = currentBlock;

  // Advance the persistent cursor only if EVERY wallet scanned cleanly this
  // cycle. A re-scan of the same window next cycle is safe — deposit() dedups
  // on base_${txHash} (now backed by the UNIQUE(reference_id) index).
  let cycleClean = true;

  for (const w of wallets) {
    try {
      const paddedAddr = w.evm_address.replace("0x", "").toLowerCase().padStart(64, "0");

      // Get Transfer logs TO this address
      const resp = await fetch(BASE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_getLogs",
          params: [{
            fromBlock: "0x" + fromBlock.toString(16),
            toBlock: "0x" + toBlock.toString(16),
            address: BASE_USDC,
            topics: [TRANSFER_TOPIC, null, "0x" + paddedAddr],
          }],
        }),
      });

      const result = await resp.json() as any;

      if (!result.result || !Array.isArray(result.result)) {
        // Malformed/empty RPC response (e.g. transient error object): don't let
        // this wallet advance the shared cursor past a range it didn't scan.
        if (result?.error) cycleClean = false;
        continue;
      }

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
      cycleClean = false;
      console.error(`[deposit-monitor] Base check failed for ${w.evm_address}:`, e.message);
    }

    await sleep(1000);
  }

  // Persist progress only on a fully-clean cycle. On a partial failure we keep
  // the old cursor and rescan next cycle (idempotent), so no deposit is skipped.
  if (cycleClean) saveScanCursor("base", toBlock + 1);
}

// ─── Monitor Lifecycle ───
let intervalId: NodeJS.Timeout | null = null;

// Re-entrancy guard. A full Solana cycle sleeps ~2s/wallet on public RPC, so
// with enough wallets a cycle can exceed POLL_INTERVAL. Without this flag a
// second setInterval tick would run checkSolanaDeposits() concurrently with the
// first — both seeing the same unswept on-chain balance and crediting it twice
// (and the DB-level dedup only catches it now because the Solana reference-id is
// stable). The guard makes overlapping ticks a no-op; the next tick after the
// in-flight cycle finishes picks up any new deposits.
let _cycleRunning = false;

async function runCycle(): Promise<void> {
  if (_cycleRunning) {
    console.warn("[deposit-monitor] Previous cycle still running — skipping this tick");
    return;
  }
  _cycleRunning = true;
  try {
    await checkSolanaDeposits().catch(e => console.error("[deposit-monitor] Solana:", e.message));
    await checkBaseDeposits().catch(e => console.error("[deposit-monitor] Base:", e.message));
  } finally {
    _cycleRunning = false;
  }
}

export function startDepositMonitor(): void {
  ensureTable();
  initLastSeen();
  console.log(`👀 [deposit-monitor] Started (polling every ${POLL_INTERVAL / 1000}s, Solana RPC: ${SOL_RPC.includes("helius") ? "Helius" : "public"})`);

  // Initial check after 15s (let server finish starting)
  setTimeout(() => { void runCycle(); }, 15_000);

  // Then every POLL_INTERVAL. runCycle() guards against overlap if a cycle
  // runs longer than POLL_INTERVAL.
  intervalId = setInterval(() => { void runCycle(); }, POLL_INTERVAL);
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
