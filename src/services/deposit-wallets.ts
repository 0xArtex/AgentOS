/**
 * Deposit wallet service — server-internal infrastructure.
 *
 * Each user gets a unique deposit wallet (Solana + EVM) for receiving USDC.
 * Funds are auto-swept to the treasury, so the server MUST be able to sign
 * sweep transactions without user interaction. Deposit wallets are intentionally
 * CUSTODIAL — the session secret is stored in the DB (encrypted at rest by SQLite).
 */
import { db } from "../db";
import * as vault from "./wallet-vault";
import { Keypair } from "@solana/web3.js";

// ─── DB schema ───
db.exec(`
  CREATE TABLE IF NOT EXISTS deposit_wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    derivation_index INTEGER UNIQUE NOT NULL,
    vault_wallet_id TEXT NOT NULL,
    session_secret TEXT NOT NULL,
    solana_address TEXT NOT NULL,
    evm_address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )
`);

// Migration: add session_secret column if missing
try { db.exec("ALTER TABLE deposit_wallets ADD COLUMN session_secret TEXT DEFAULT ''"); } catch {}

function getDepositWallet(index: number): { vaultWalletId: string; sessionSecret: string } | null {
  const row = db.prepare("SELECT vault_wallet_id, session_secret FROM deposit_wallets WHERE derivation_index = ?").get(index) as any;
  if (!row || !row.vault_wallet_id) return null;
  return { vaultWalletId: row.vault_wallet_id, sessionSecret: row.session_secret };
}

/**
 * Get the raw Solana keypair for a deposit wallet (used by the deposit monitor for sweeps).
 */
export function getSolanaKeypair(index: number): Keypair {
  const dw = getDepositWallet(index);
  if (!dw) throw new Error(`No deposit wallet for index ${index}`);
  return vault.getSolanaKeypair(dw.vaultWalletId, dw.sessionSecret);
}

/**
 * Get the raw EVM private key for a deposit wallet (used by the deposit monitor for sweeps).
 */
export function getEvmPrivateKey(index: number): string {
  const dw = getDepositWallet(index);
  if (!dw) throw new Error(`No deposit wallet for index ${index}`);
  return vault.getEvmPrivateKey(dw.vaultWalletId, dw.sessionSecret);
}

/**
 * Get or create a deposit wallet for a user.
 */
export function getOrCreateWallet(userId: string): { solanaAddress: string; evmAddress: string } {
  const existing = db.prepare("SELECT solana_address, evm_address FROM deposit_wallets WHERE user_id = ?").get(userId) as any;
  if (existing) return { solanaAddress: existing.solana_address, evmAddress: existing.evm_address };

  const row = db.prepare("SELECT MAX(derivation_index) as mx FROM deposit_wallets").get() as any;
  const index = (row?.mx ?? -1) + 1;

  const { wallet: vaultWallet, sessionSecret } = vault.createWallet(`deposit-${userId}-${index}`, "unmanaged");
  const solAddr = vault.getAddressForChain(vaultWallet, "solana");
  const evmAddr = vault.getAddressForChain(vaultWallet, "evm");

  if (!solAddr || !evmAddr) {
    throw new Error("Vault wallet did not derive Solana or EVM address");
  }

  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO deposit_wallets (id, user_id, derivation_index, vault_wallet_id, session_secret, solana_address, evm_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
  ).run(id, userId, index, vaultWallet.id, sessionSecret, solAddr, evmAddr);

  console.log(`[deposit] Created wallet #${index} for ${userId}: SOL=${solAddr} EVM=${evmAddr}`);
  return { solanaAddress: solAddr, evmAddress: evmAddr };
}
