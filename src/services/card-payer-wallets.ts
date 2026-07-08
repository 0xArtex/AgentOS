/**
 * Per-agent Laso payer wallets.
 *
 * Laso's account identity IS the paying wallet (CAIP-122 sign-in), and Laso's
 * guidance to us (2026-07-09) was explicit: shard to per-agent wallets rather
 * than aggregate hundreds of agents' purchases through one account. So every
 * owner (agent wallet / dashboard identity) gets a dedicated server-held EVM
 * keypair, generated on first purchase and stored AES-256-GCM under
 * SECRETS_MASTER_KEY (the deposit-wallets custody model — recoverable by
 * design). That wallet is the agent's own Laso account: its cards, tokens,
 * limits, and compliance surface are isolated from every other agent's.
 *
 * Funding: agent wallets hold no standing balance. Before each purchase the
 * FLOAT wallet (LASO_FLOAT_EVM_PRIVATE_KEY — the only wallet the operator
 * funds; USDC + a little ETH for transfer gas on Base) tops the agent wallet
 * up by exactly the SHORTFALL (card amount minus whatever the wallet already
 * holds). Shortfall-only funding makes stranded USDC self-recycling: money
 * left behind by a failed purchase is consumed by that agent's next one.
 * The agent wallet itself never needs ETH — paying Laso is gasless EIP-3009.
 *
 * Concurrency: two purchases by the same owner racing the shortfall math
 * could double-fund, so fund+buy runs under a per-owner in-process lock
 * (jobs all execute in this process).
 */
import { randomUUID } from "crypto";
import { db } from "../db";
import { sealSecret, openSecret } from "./secret-box";
import { baseUsdcBalance, BASE_USDC } from "./x402-client";

const FLOAT_KEY_ENV = "LASO_FLOAT_EVM_PRIVATE_KEY";
// Back-compat: the pre-sharding design called this the payer key. Never
// deployed, but honor it so an operator who already filled it isn't confused.
const LEGACY_FLOAT_KEY_ENV = "LASO_PAYER_EVM_PRIVATE_KEY";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";

db.exec(`
  CREATE TABLE IF NOT EXISTS card_payer_wallets (
    owner TEXT PRIMARY KEY,
    evm_address TEXT NOT NULL UNIQUE,
    key_ciphertext TEXT NOT NULL,
    tokens_ciphertext TEXT,
    tokens_obtained_at TEXT,
    created_at TEXT NOT NULL
  );
`);

function getEthers(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("ethers").ethers ?? require("ethers");
}

// ─── Float wallet (operator-funded; the only key in env) ───

let _floatWallet: any = null;

export function lasoEnabled(): boolean {
  return !!(process.env[FLOAT_KEY_ENV] || process.env[LEGACY_FLOAT_KEY_ENV]);
}

export function loadFloatWallet(): any {
  if (_floatWallet) return _floatWallet;
  const raw = process.env[FLOAT_KEY_ENV] || process.env[LEGACY_FLOAT_KEY_ENV];
  if (!raw) return null;
  try {
    const ethers = getEthers();
    _floatWallet = new ethers.Wallet(raw);
    console.log(`[card-wallets] float wallet loaded: ${_floatWallet.address}`);
    return _floatWallet;
  } catch (e: any) {
    console.error(`[card-wallets] ${FLOAT_KEY_ENV} failed to parse:`, e?.message || e);
    return null;
  }
}

let _floatCache: { value: number; at: number } | null = null;

/** Float wallet's USDC on Base, cached 30s — the route preflight's solvency check. */
export async function floatUsdcBalance(): Promise<number | null> {
  const wallet = loadFloatWallet();
  if (!wallet) return null;
  if (_floatCache && Date.now() - _floatCache.at < 30_000) return _floatCache.value;
  try {
    const value = await baseUsdcBalance(wallet.address);
    _floatCache = { value, at: Date.now() };
    return value;
  } catch (e: any) {
    console.warn("[card-wallets] float balance check failed (RPC):", e?.message || e);
    return null; // unknown — callers proceed rather than block on an RPC blip
  }
}

/** Test hooks. */
export function _resetCardWalletCachesForTest(): void {
  _floatWallet = null;
  _floatCache = null;
}
export function _setFloatCacheForTest(value: number): void {
  _floatCache = { value, at: Date.now() };
}

// ─── Per-owner payer wallets ───

export interface PayerWalletRow {
  owner: string;
  evm_address: string;
  key_ciphertext: string;
  tokens_ciphertext: string | null;
  tokens_obtained_at: string | null;
  created_at: string;
}

export function getPayerWalletRow(owner: string): PayerWalletRow | null {
  return (db.prepare("SELECT * FROM card_payer_wallets WHERE owner = ?").get(owner) as PayerWalletRow) || null;
}

/**
 * The owner's dedicated payer wallet — created (and persisted encrypted) on
 * first use. Deterministic per owner thereafter: same owner, same Laso account.
 */
export function getOrCreatePayerWallet(owner: string): { row: PayerWalletRow; wallet: any } {
  const ethers = getEthers();
  const existing = getPayerWalletRow(owner);
  if (existing) {
    return { row: existing, wallet: new ethers.Wallet(openSecret(existing.key_ciphertext)) };
  }
  const fresh = ethers.Wallet.createRandom();
  try {
    db.prepare(
      `INSERT INTO card_payer_wallets (owner, evm_address, key_ciphertext, created_at) VALUES (?, ?, ?, ?)`
    ).run(owner, fresh.address, sealSecret(fresh.privateKey), new Date().toISOString());
  } catch (e: any) {
    // Lost a concurrent-create race — the sibling's row wins; use it.
    if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      const won = getPayerWalletRow(owner);
      if (won) return { row: won, wallet: new ethers.Wallet(openSecret(won.key_ciphertext)) };
    }
    throw e;
  }
  console.log(`[card-wallets] created payer wallet for ${owner}: ${fresh.address}`);
  return { row: getPayerWalletRow(owner)!, wallet: new ethers.Wallet(fresh.privateKey) };
}

/** The address an owner's purchases pay from (null when never created). */
export function payerAddressFor(owner: string): string | null {
  return getPayerWalletRow(owner)?.evm_address ?? null;
}

// ─── Per-owner Laso auth context (tokens live on the wallet row) ───

export interface LasoAuthCtx {
  wallet: any;
  readTokens(): { id_token: string; refresh_token: string; obtained_at_ms: number } | null;
  persistTokens(idToken: string, refreshToken: string): void;
}

export function payerAuthCtx(owner: string): LasoAuthCtx {
  const { wallet } = getOrCreatePayerWallet(owner);
  return {
    wallet,
    readTokens() {
      const row = getPayerWalletRow(owner);
      if (!row?.tokens_ciphertext) return null;
      try {
        const parsed = JSON.parse(openSecret(row.tokens_ciphertext));
        return {
          id_token: parsed.id_token,
          refresh_token: parsed.refresh_token,
          obtained_at_ms: new Date(row.tokens_obtained_at || 0).getTime(),
        };
      } catch (e: any) {
        console.error(`[card-wallets] token cache unreadable for ${owner} — will re-auth:`, e?.message || e);
        return null;
      }
    },
    persistTokens(idToken: string, refreshToken: string) {
      if (!idToken || !refreshToken) return;
      db.prepare(`UPDATE card_payer_wallets SET tokens_ciphertext = ?, tokens_obtained_at = ? WHERE owner = ?`).run(
        sealSecret(JSON.stringify({ id_token: idToken, refresh_token: refreshToken })),
        new Date().toISOString(),
        owner
      );
    },
  };
}

/** Drop an owner's cached tokens (after laso_auth_rejected) forcing re-auth. */
export function clearPayerTokens(owner: string): void {
  db.prepare("UPDATE card_payer_wallets SET tokens_ciphertext = NULL, tokens_obtained_at = NULL WHERE owner = ?").run(
    owner
  );
}

// ─── Just-in-time funding (float → agent wallet, shortfall only) ───

/** Insufficient float is DEFINITIVE — the caller refunds the agent. */
export class CardFundingError extends Error {
  constructor(message: string, public definitive: boolean) {
    super(message);
    this.name = "CardFundingError";
  }
}

export interface EnsureFundedResult {
  address: string;
  fundedUsdc: number;
  fundingTx: string | null;
}

export interface EnsureFundedDeps {
  balanceOf?: (address: string) => Promise<number>;
  /** Send `amountUsdc` USDC from the float wallet; resolves once confirmed. */
  transfer?: (to: string, amountUsdc: number) => Promise<string>;
}

async function defaultTransfer(to: string, amountUsdc: number): Promise<string> {
  const wallet = loadFloatWallet();
  if (!wallet) throw new CardFundingError("float wallet not configured", true);
  const ethers = getEthers();
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const erc20 = new ethers.Contract(
    BASE_USDC,
    ["function transfer(address to, uint256 value) returns (bool)"],
    wallet.connect(provider)
  );
  const tx = await erc20.transfer(to, BigInt(Math.round(amountUsdc * 1e6)));
  await tx.wait(1); // Base ~2s; the balance must exist before Laso settles
  _floatCache = null; // float moved — invalidate the cached solvency number
  return tx.hash as string;
}

/**
 * Make sure `owner`'s payer wallet holds at least `amountUsd` USDC, funding
 * only the shortfall from the float wallet. Throws:
 *   CardFundingError(definitive=true)  — float missing/insolvent → refund agent
 *   CardFundingError(definitive=false) — transfer/RPC hiccup → park + retry;
 *     a transfer that landed anyway only shrinks the next attempt's shortfall
 *     (funds are in a wallet we control either way — never stranded).
 */
export async function ensurePayerFunded(
  owner: string,
  amountUsd: number,
  deps: EnsureFundedDeps = {}
): Promise<EnsureFundedResult> {
  const { wallet } = getOrCreatePayerWallet(owner);
  const balanceOf = deps.balanceOf || baseUsdcBalance;

  let balance: number;
  try {
    balance = await balanceOf(wallet.address);
  } catch (e: any) {
    throw new CardFundingError(`payer balance check failed: ${e?.message || e}`, false);
  }
  const shortfall = Math.round(Math.max(0, amountUsd - balance) * 1e6) / 1e6;
  if (shortfall <= 0) return { address: wallet.address, fundedUsdc: 0, fundingTx: null };

  const float = await floatUsdcBalance();
  if (float != null && float < shortfall) {
    throw new CardFundingError(
      `float wallet holds $${float} but $${shortfall} is needed — top up the float wallet`,
      true
    );
  }

  const transfer = deps.transfer || defaultTransfer;
  try {
    const fundingTx = await transfer(wallet.address, shortfall);
    console.log(`[card-wallets] funded ${owner} payer ${wallet.address} with $${shortfall} (${fundingTx})`);
    return { address: wallet.address, fundedUsdc: shortfall, fundingTx };
  } catch (e: any) {
    if (e instanceof CardFundingError) throw e;
    throw new CardFundingError(`funding transfer failed: ${e?.message || e}`, false);
  }
}

// ─── Per-owner serialization ───

// FIFO waiter queues, one per owner currently holding the lock. Resolver-based
// (rather than promise-chaining) so a rejecting task never leaves a dangling
// unhandled promise branch, and each waiter's continuation stays in its own
// async context.
const ownerQueues = new Map<string, Array<() => void>>();

/**
 * Serialize fund+buy per owner so concurrent purchases can't race the
 * shortfall computation into a double-fund. Owners don't block each other;
 * the map entry is removed when the last waiter drains.
 */
export async function withOwnerLock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    const queue = ownerQueues.get(owner);
    if (!queue) {
      ownerQueues.set(owner, []); // lock acquired — an empty queue marks "held"
      resolve();
    } else {
      queue.push(resolve); // FIFO — woken by the current holder's release
    }
  });
  try {
    return await fn();
  } finally {
    const queue = ownerQueues.get(owner)!;
    const nextWaiter = queue.shift();
    if (nextWaiter) nextWaiter();
    else ownerQueues.delete(owner);
  }
}
