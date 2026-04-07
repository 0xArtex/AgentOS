/**
 * Deposit wallet service — powered by AgentOS Wallet Vault.
 *
 * Each user gets a unique deposit wallet (Solana + EVM) for receiving USDC.
 * Keys live in the encrypted vault at ~/.agentos/wallet/.
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
    solana_address TEXT NOT NULL,
    evm_address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
  )
`);

// Migration for existing DBs
try { db.exec("ALTER TABLE deposit_wallets ADD COLUMN vault_wallet_id TEXT"); } catch {}
try { db.exec("UPDATE deposit_wallets SET vault_wallet_id = ows_wallet_id WHERE vault_wallet_id IS NULL AND ows_wallet_id IS NOT NULL"); } catch {}

/**
 * Get the vault wallet ID for a deposit wallet by derivation index.
 */
export function getVaultWalletId(index: number): string | null {
  const row = db.prepare("SELECT vault_wallet_id FROM deposit_wallets WHERE derivation_index = ?").get(index) as any;
  return row?.vault_wallet_id || null;
}

/**
 * Get the raw Solana keypair for a deposit wallet (used by the deposit monitor for sweeps).
 */
export function getSolanaKeypair(index: number): Keypair {
  const id = getVaultWalletId(index);
  if (!id) throw new Error(`No deposit wallet for index ${index}`);
  return vault.getSolanaKeypair(id);
}

/**
 * Get the raw EVM private key for a deposit wallet (used by the deposit monitor for sweeps).
 */
export function getEvmPrivateKey(index: number): string {
  const id = getVaultWalletId(index);
  if (!id) throw new Error(`No deposit wallet for index ${index}`);
  return vault.getEvmPrivateKey(id);
}

/**
 * Get or create a deposit wallet for a user.
 */
export function getOrCreateWallet(userId: string): { solanaAddress: string; evmAddress: string } {
  const existing = db.prepare("SELECT solana_address, evm_address FROM deposit_wallets WHERE user_id = ?").get(userId) as any;
  if (existing) return { solanaAddress: existing.solana_address, evmAddress: existing.evm_address };

  const row = db.prepare("SELECT MAX(derivation_index) as mx FROM deposit_wallets").get() as any;
  const index = (row?.mx ?? -1) + 1;

  const vaultWallet = vault.createWallet(`deposit-${userId}-${index}`);
  const solAddr = vault.getAddressForChain(vaultWallet, "solana");
  const evmAddr = vault.getAddressForChain(vaultWallet, "evm");

  if (!solAddr || !evmAddr) {
    throw new Error("Vault wallet did not derive Solana or EVM address");
  }

  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO deposit_wallets (id, user_id, derivation_index, vault_wallet_id, solana_address, evm_address, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  ).run(id, userId, index, vaultWallet.id, solAddr, evmAddr);

  console.log(`[deposit] Created wallet #${index} for ${userId}: SOL=${solAddr} EVM=${evmAddr}`);
  return { solanaAddress: solAddr, evmAddress: evmAddr };
}
