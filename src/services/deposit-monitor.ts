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
const SOL_USDC_MINT_STR = SOL_USDC_MINT.toBase58();
const TREASURY_SOL = new PublicKey(config.treasuryWallet);

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TREASURY_EVM = config.treasuryEvmWallet;

const POLL_INTERVAL = 60_000; // 60s
const SWEEP_MIN_USDC = 1; // Don't sweep dust
const MIN_CREDIT_USDC = 0.001; // Ignore dust transfers (mirrors the Base path)

// RPC — use Helius if available, else public
const SOL_RPC = process.env.HELIUS_RPC || process.env.SOLANA_MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const SOL_RPC_IS_PUBLIC = !SOL_RPC.includes("helius");

// Detect deposits at a SAFE commitment. Crediting at chain head ("confirmed")
// lets a reorged deposit be over-credited; "finalized" applies a finality buffer
// (a finalized slot cannot be rolled back) so a credited deposit can't later be
// un-done on-chain. Latency cost is a handful of seconds — acceptable for a 60s
// poll. (Finding #3.)
const SOL_COMMITMENT: "finalized" = "finalized";

// Bound per-cycle signature enumeration so a one-off backlog (e.g. after long
// downtime, or a fresh wallet's history) is chunked across cycles instead of
// hammering the RPC in a single tick.
const SOL_SIG_PAGE = 50;       // signatures per getSignaturesForAddress call
const SOL_MAX_SIG_PAGES = 4;   // ≤200 signatures scanned per token account per cycle

const solConn = new Connection(SOL_RPC, "confirmed");

// ─── DB: dedup + resume state ───
// deposit_credits is the per-credit audit + dedup CACHE (the Base path records
// tx_hash here; Solana now records the tx signature). The AUTHORITATIVE
// idempotency backstop remains the UNIQUE(reference_id) index on
// balance_transactions enforced inside balance.deposit(); this table only lets us
// cheaply skip a parsed-tx fetch for a signature we've already consumed.
//
// deposit_sol_cursor is a per-token-account resume point (the newest
// fully-scanned signature) — analogous to the Base scan_cursor. It bounds
// enumeration and, critically, anchors the cutover from the legacy balance-delta
// scheme so historical (already-credited, signature-less) deposits are never
// replayed and re-credited.
export function ensureTable(): void {
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
    CREATE INDEX IF NOT EXISTS idx_deposit_credits_sig ON deposit_credits(tx_signature);

    CREATE TABLE IF NOT EXISTS deposit_sol_cursor (
      token_account TEXT PRIMARY KEY,
      last_signature TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
  `);
}

// A concrete on-chain transfer SIGNATURE is credited at most once. Checked
// before any parsed-tx fetch (cheap skip), and again — authoritatively — by the
// UNIQUE(reference_id) constraint inside deposit().
function wasSignatureCredited(signature: string): boolean {
  return !!db.prepare("SELECT 1 FROM deposit_credits WHERE tx_signature = ? LIMIT 1").get(signature);
}

function recordCredit(walletId: string, chain: string, amount: number, txSig?: string): void {
  db.prepare(
    "INSERT INTO deposit_credits (id, wallet_id, chain, amount_usdc, tx_signature) VALUES (?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), walletId, chain, amount, txSig || null);
}

// Legacy Solana credits (the old balance-delta scheme) were written WITHOUT a
// signature. Their presence means this wallet's deposit history was already
// credited under that scheme; per-signature dedup cannot catch those rows (there
// is no signature to match), so on first sight we anchor the cursor at chain head
// rather than replaying — and re-crediting — the wallet's whole history.
function hasLegacySolanaCredits(walletId: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM deposit_credits WHERE wallet_id = ? AND chain = 'solana' AND tx_signature IS NULL LIMIT 1"
  ).get(walletId);
}

function getSolCursor(tokenAccount: string): string | null {
  const row = db.prepare("SELECT last_signature FROM deposit_sol_cursor WHERE token_account = ?").get(tokenAccount) as { last_signature: string } | undefined;
  return row ? row.last_signature : null;
}

function setSolCursor(tokenAccount: string, signature: string): void {
  db.prepare(
    "INSERT INTO deposit_sol_cursor (token_account, last_signature, updated_at) VALUES (?, ?, datetime('now', 'utc')) " +
    "ON CONFLICT(token_account) DO UPDATE SET last_signature = excluded.last_signature, updated_at = excluded.updated_at"
  ).run(tokenAccount, signature);
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

// ─── Solana credit attribution ───
// Net USDC credited TO `ownerAddr` within ONE transaction, derived from that
// transaction's own pre/post token balances (authoritative and reorg-proof at the
// chosen commitment). An outgoing transfer (a sweep) nets negative → 0; only a
// genuine incoming transfer yields a positive credit. Exported for tests.
export function usdcCreditForOwner(meta: any, ownerAddr: string): number {
  const pre = meta?.preTokenBalances ?? [];
  const post = meta?.postTokenBalances ?? [];
  const preByIdx = new Map<number, number>();
  for (const b of pre) {
    if (b?.mint === SOL_USDC_MINT_STR && b?.owner === ownerAddr) {
      preByIdx.set(b.accountIndex, b.uiTokenAmount?.uiAmount ?? 0);
    }
  }
  let delta = 0;
  for (const b of post) {
    if (b?.mint === SOL_USDC_MINT_STR && b?.owner === ownerAddr) {
      delta += (b.uiTokenAmount?.uiAmount ?? 0) - (preByIdx.get(b.accountIndex) ?? 0);
    }
  }
  return delta > 0 ? delta : 0;
}

// Credit one Solana transfer SIGNATURE exactly once. Idempotent across stale RPC
// reads, overlapping poll cycles and process restarts:
//   • the cheap wasSignatureCredited() pre-check skips an obvious replay;
//   • deposit()'s UNIQUE(reference_id = `sol_<sig>`) is the real backstop — a
//     replay (including a crash AFTER deposit() but BEFORE recordCredit) throws
//     "Duplicate", which we treat as the no-op it is and use to heal the cache.
// A genuine re-deposit of an identical amount lands under a DIFFERENT signature,
// hence a different reference_id, and is therefore correctly credited — fixing
// the old delta scheme's "identical re-deposit never credited" bug.
// (Findings #1 and #2.) Exported for tests.
export function creditSolanaTransfer(w: { id: string; user_id: string }, signature: string, amount: number): boolean {
  if (wasSignatureCredited(signature)) return false;
  const refId = `sol_${signature}`;
  try {
    deposit(w.user_id, amount, refId, `Solana USDC deposit: $${amount.toFixed(6)} (tx ${signature.slice(0, 10)}...)`);
    recordCredit(w.id, "solana", amount, signature);
    console.log(`💰 [deposit-monitor] Credited $${amount.toFixed(6)} USDC to user ${w.user_id} (Solana, tx: ${signature.slice(0, 10)}...)`);
    return true;
  } catch (e: any) {
    if (e.message?.includes("Duplicate")) {
      // Already credited under this signature by a prior run that died before
      // recordCredit persisted the cache row. Heal it so future cycles skip the
      // parsed-tx fetch; the credit itself stays singular (deposit() rejected this
      // replay). Treat as a no-op.
      try { recordCredit(w.id, "solana", amount, signature); } catch {}
      return false;
    }
    console.error(`[deposit-monitor] Solana credit failed for ${w.user_id}:`, e.message);
    return false;
  }
}

// Collect signatures NEWER than `until` (the cursor), paginated newest→older,
// then return them OLDEST-first (chronological credit order) along with the
// newest signature seen. The newest is returned even when nothing is creditable
// (e.g. a sweep-only tx) so the cursor still advances. Already-credited
// signatures are filtered up front so we never re-fetch their parsed tx.
async function fetchNewSolSignatures(tokenAccount: PublicKey, until?: string): Promise<{ toCredit: string[]; newest: string | null }> {
  const all: string[] = [];
  let before: string | undefined;
  let newest: string | null = null;
  for (let page = 0; page < SOL_MAX_SIG_PAGES; page++) {
    const opts: { limit: number; before?: string; until?: string } = { limit: SOL_SIG_PAGE };
    if (before) opts.before = before;
    if (until) opts.until = until;
    const sigs = await solConn.getSignaturesForAddress(tokenAccount, opts, SOL_COMMITMENT);
    if (!sigs.length) break;
    if (newest === null) newest = sigs[0].signature;
    for (const s of sigs) all.push(s.signature);
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < SOL_SIG_PAGE) break; // last page
  }
  const toCredit = all.reverse().filter(sig => !wasSignatureCredited(sig));
  return { toCredit, newest };
}

// Resolve how much USDC a given signature credited to `ownerAddr`. Reads the
// transaction at the safe commitment; a dropped/failed tx (or one not yet
// finalized) credits nothing.
async function solUsdcCreditForSignature(signature: string, ownerAddr: string): Promise<number> {
  const tx = await solConn.getParsedTransaction(signature, { commitment: SOL_COMMITMENT, maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) return 0;
  return usdcCreditForOwner(tx.meta, ownerAddr);
}

function solanaUsdcBalance(tokenAccounts: { value: any[] }): number {
  let sum = 0;
  for (const ta of tokenAccounts.value) sum += ta.account.data.parsed?.info?.tokenAmount?.uiAmount || 0;
  return sum;
}

// ─── Solana USDC Deposits (signature-attributed, like the Base log path) ───
// Each incoming transfer is attributed to its on-chain SIGNATURE and credited
// exactly once — NOT inferred from a balance snapshot. This eliminates the
// stale-post-sweep-balance double-credit (a returning/stale balance no longer
// looks like a new deposit) and the "identical re-deposit never credited" bug,
// and dedups on the signature exactly as the Base path dedups on the tx hash.
async function checkSolanaDeposits(): Promise<void> {
  const wallets = db.prepare("SELECT * FROM deposit_wallets").all() as any[];
  if (!wallets.length) return;

  for (const w of wallets) {
    try {
      const owner = new PublicKey(w.solana_address);

      // Get USDC token accounts (at the safe commitment)
      const tokenAccounts = await solConn.getParsedTokenAccountsByOwner(owner, { mint: SOL_USDC_MINT }, SOL_COMMITMENT);

      for (const ta of tokenAccounts.value) {
        const ataStr = ta.pubkey.toBase58();
        const cursor = getSolCursor(ataStr);

        // Cutover anchor: a wallet already credited under the legacy balance-delta
        // scheme has signature-less credit rows that per-signature dedup can't
        // match. On first sight, anchor the cursor at chain head so its history is
        // NOT replayed/re-credited. A wallet with NO legacy credits is genuinely
        // new and is scanned from a bounded recent window (cursor === null below),
        // so its very first deposits are credited.
        if (cursor === null && hasLegacySolanaCredits(w.id)) {
          const latest = await solConn.getSignaturesForAddress(ta.pubkey, { limit: 1 }, SOL_COMMITMENT);
          if (latest.length) setSolCursor(ataStr, latest[0].signature);
          continue;
        }

        const { toCredit, newest } = await fetchNewSolSignatures(ta.pubkey, cursor ?? undefined);
        for (const sig of toCredit) {
          const amount = await solUsdcCreditForSignature(sig, w.solana_address);
          if (amount < MIN_CREDIT_USDC) continue; // sweep / non-deposit / dust tx
          creditSolanaTransfer(w, sig, amount);
          if (SOL_RPC_IS_PUBLIC) await sleep(250); // ease off public RPC between parsed-tx reads
        }
        // Advance the cursor past everything we just scanned (credited or not), so
        // the next cycle only looks at strictly newer signatures.
        if (newest) setSolCursor(ataStr, newest);
      }

      // Best-effort sweep, fully DECOUPLED from crediting: drain whatever USDC is
      // currently parked in the deposit wallet. A dropped/failed/stale sweep just
      // leaves the funds to be swept next cycle — it can no longer cause a
      // double-credit, because credits are attributed to signatures, not to
      // balance movements. (This is what made the old delta scheme unsafe.)
      const onChain = solanaUsdcBalance(tokenAccounts);
      if (onChain >= SWEEP_MIN_USDC) {
        await sweepSolanaUsdc(w.derivation_index, owner, onChain);
      }
    } catch (e: any) {
      if (!e.message?.includes("429")) {
        // Suppress rate limit errors — they're expected on public RPC
        console.error(`[deposit-monitor] Solana check failed for ${w.solana_address}:`, e.message);
      }
    }

    // Delay between wallets to avoid rate limiting (longer for public RPC)
    await sleep(SOL_RPC_IS_PUBLIC ? 2000 : 200);
  }
}

// Submit a sweep of the deposit wallet's USDC to the treasury. Best-effort: a
// submitted Solana tx can still be dropped, but that's harmless now — the funds
// simply stay put and are re-swept next cycle. Crucially, sweeping NEVER feeds
// back into crediting, so an unconfirmed/stale sweep cannot cause a re-credit.
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
    console.log(`📤 [deposit-monitor] Submitted sweep of $${amount} USDC to treasury (Solana): ${sig}`);
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
// first. Per-signature dedup already makes a concurrent double-credit impossible
// (both ticks resolve the same signature → the UNIQUE(reference_id) index lets
// exactly one through), but the guard still avoids the wasted duplicate RPC work.
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
