/**
 * Wallet service — powered by AgentOS Wallet Vault.
 *
 * Key material is stored in the encrypted vault at ~/.agentos/wallet/.
 * AgentOS stores metadata (user→wallet associations, labels, on-chain refs) in SQLite.
 */
import { db } from "../db";
import { randomBytes } from "crypto";
import * as vault from "./wallet-vault";
import type { WalletInfo as VaultWalletInfo, SignResult, ApiKeyResult } from "./wallet-vault";

// ─── Config ───
// When AGENTWALLET_API is set, also deploy on-chain smart wallets
const AGENTWALLET_API = process.env.AGENTWALLET_API || "";

// ─── DB schema ───
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT DEFAULT 'My Wallet',
    vault_wallet_id TEXT NOT NULL,
    sol_address TEXT,
    base_address TEXT,
    supported_chains TEXT DEFAULT 'solana,evm',
    onchain_base TEXT,
    onchain_sol TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, vault_wallet_id)
  )
`);

// Migrations for existing DBs
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN vault_wallet_id TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN supported_chains TEXT DEFAULT 'solana,evm'"); } catch {}
// Backfill from old ows_wallet_id column if present
try { db.exec("UPDATE agent_wallets SET vault_wallet_id = ows_wallet_id WHERE vault_wallet_id IS NULL AND ows_wallet_id IS NOT NULL"); } catch {}

// ─── Types ───

export interface WalletInfo {
  id: string;
  label: string;
  vaultWalletId: string;
  solana: { address: string | null };
  base: { address: string | null };
  accounts: Array<{ chainId: string; address: string }>;
  supportedChains: string[];
  onchain: {
    base: string | null;
    solana: string | null;
  };
  created_at: string;
}

// ─── Wallet CRUD ───

/**
 * Create a new wallet backed by the AgentOS vault.
 * The owner passphrase is required and never stored. The mnemonic is
 * encrypted with Scrypt(passphrase) and the server cannot decrypt it
 * without the passphrase or a derived API key.
 */
export async function createWallet(
  userId: string,
  passphrase: string,
  label?: string,
  chains?: string[],
): Promise<WalletInfo> {
  if (!passphrase) throw new Error("Owner passphrase is required");
  const walletLabel = label || "My Wallet";
  const id = randomBytes(16).toString("hex");

  const count = (db.prepare("SELECT COUNT(*) as c FROM agent_wallets WHERE user_id = ?").get(userId) as any).c;
  const vaultName = `agent-${userId}-${count}`;

  const vaultWallet = vault.createWallet(vaultName, passphrase);
  const { solana, evm } = vault.getDefaultAddresses(vaultWallet);

  const supportedChains = chains || ["solana", "evm"];

  let onchainBase: string | null = null;
  let onchainSol: string | null = null;

  if (AGENTWALLET_API && evm) {
    try {
      const res = await fetch(`${AGENTWALLET_API}/wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: evm, agent: evm }),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        onchainBase = data.wallet?.address || null;
        console.log(`[wallet] On-chain Base wallet deployed: ${onchainBase}`);
      }
    } catch (err) {
      console.warn("[wallet] Failed to create on-chain wallet:", err);
    }
  }

  db.prepare(`
    INSERT INTO agent_wallets (id, user_id, label, vault_wallet_id, sol_address, base_address, supported_chains, onchain_base, onchain_sol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, walletLabel, vaultWallet.id, solana, evm, supportedChains.join(","), onchainBase, onchainSol);

  return toWalletInfo(
    { id, user_id: userId, label: walletLabel, vault_wallet_id: vaultWallet.id, sol_address: solana, base_address: evm, supported_chains: supportedChains.join(","), onchain_base: onchainBase, onchain_sol: onchainSol, created_at: new Date().toISOString() },
    vaultWallet,
  );
}

/**
 * Import a wallet from a mnemonic phrase. The owner passphrase is required.
 */
export async function importWallet(
  userId: string,
  mnemonic: string,
  passphrase: string,
  label?: string,
): Promise<WalletInfo> {
  if (!passphrase) throw new Error("Owner passphrase is required");
  const walletLabel = label || "Imported Wallet";
  const id = randomBytes(16).toString("hex");
  const count = (db.prepare("SELECT COUNT(*) as c FROM agent_wallets WHERE user_id = ?").get(userId) as any).c;
  const vaultName = `agent-${userId}-${count}`;

  const vaultWallet = vault.importWalletMnemonic(vaultName, mnemonic, passphrase);
  const { solana, evm } = vault.getDefaultAddresses(vaultWallet);

  db.prepare(`
    INSERT INTO agent_wallets (id, user_id, label, vault_wallet_id, sol_address, base_address, supported_chains, onchain_base, onchain_sol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, walletLabel, vaultWallet.id, solana, evm, "solana,evm", null, null);

  return toWalletInfo(
    { id, user_id: userId, label: walletLabel, vault_wallet_id: vaultWallet.id, sol_address: solana, base_address: evm, supported_chains: "solana,evm", onchain_base: null, onchain_sol: null, created_at: new Date().toISOString() },
    vaultWallet,
  );
}

export function getWallets(userId: string): WalletInfo[] {
  const rows = db.prepare("SELECT * FROM agent_wallets WHERE user_id = ? ORDER BY created_at").all(userId) as any[];
  return rows.map((r) => {
    try {
      const vaultWallet = vault.getWallet(r.vault_wallet_id);
      return toWalletInfo(r, vaultWallet);
    } catch {
      return toWalletInfo(r, null);
    }
  });
}

export function getWallet(userId: string, walletId: string): WalletInfo | null {
  const r = db.prepare("SELECT * FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) return null;
  try {
    const vaultWallet = vault.getWallet(r.vault_wallet_id);
    return toWalletInfo(r, vaultWallet);
  } catch {
    return toWalletInfo(r, null);
  }
}

export function deleteWallet(userId: string, walletId: string): boolean {
  const r = db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) return false;

  try {
    vault.deleteWallet(r.vault_wallet_id);
  } catch {
    // Vault entry may already be gone
  }

  const result = db.prepare("DELETE FROM agent_wallets WHERE id = ? AND user_id = ?").run(walletId, userId);
  return result.changes > 0;
}

// ─── Signing ───

export interface AuthCreds {
  passphrase?: string;  // owner mode
  token?: string;       // agent API key mode
}

export function signTransaction(
  userId: string | null,
  walletId: string,
  chain: string,
  txHex: string,
  auth: AuthCreds,
): SignResult {
  const r = userId
    ? (db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any)
    : (db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ?").get(walletId) as any);
  if (!r) throw new Error("Wallet not found");
  return vault.signTransaction(r.vault_wallet_id, chain, txHex, auth);
}

export function signMessage(
  userId: string | null,
  walletId: string,
  chain: string,
  message: string,
  auth: AuthCreds,
  encoding?: string,
): SignResult {
  const r = userId
    ? (db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any)
    : (db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ?").get(walletId) as any);
  if (!r) throw new Error("Wallet not found");
  return vault.signMessage(r.vault_wallet_id, chain, message, auth, (encoding as "utf8" | "hex") || "utf8");
}

export function signTypedData(
  userId: string | null,
  walletId: string,
  chain: string,
  typedDataJson: string,
  auth: AuthCreds,
): SignResult {
  const r = userId
    ? (db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any)
    : (db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ?").get(walletId) as any);
  if (!r) throw new Error("Wallet not found");
  return vault.signTypedData(r.vault_wallet_id, chain, typedDataJson, auth);
}

// ─── Derive additional chain ───

export function deriveChainAddress(
  userId: string,
  walletId: string,
  chain: string,
): string {
  const r = db.prepare("SELECT vault_wallet_id, supported_chains FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");

  const vaultWallet = vault.getWallet(r.vault_wallet_id);
  const address = vault.getAddressForChain(vaultWallet, chain);
  if (!address) throw new Error(`Chain "${chain}" not supported or no address found`);

  const chains = new Set((r.supported_chains || "").split(",").filter(Boolean));
  chains.add(chain);
  db.prepare("UPDATE agent_wallets SET supported_chains = ? WHERE id = ?").run([...chains].join(","), walletId);

  return address;
}

// ─── Get all addresses ───

export function getAddresses(
  userId: string,
  walletId: string,
): Array<{ chainId: string; address: string }> {
  const r = db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  const vaultWallet = vault.getWallet(r.vault_wallet_id);
  return vaultWallet.accounts.map((a) => ({ chainId: a.chainId, address: a.address }));
}

// ─── Policy management ───

export function updatePolicy(
  userId: string,
  walletId: string,
  policyJson: string,
): void {
  const r = db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  vault.createPolicy(policyJson);
}

export function getPolicies(): any[] {
  return vault.listPolicies();
}

// ─── API key management ───

export function createApiKeyForWallet(
  userId: string,
  walletId: string,
  name: string,
  passphrase: string,
  policyIds?: string[],
  expiresAt?: string,
): ApiKeyResult {
  if (!passphrase) throw new Error("Owner passphrase is required to create an API key");
  const r = db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  return vault.createApiKey(name, [r.vault_wallet_id], passphrase, policyIds || [], expiresAt);
}

export function revokeWalletApiKey(userId: string, walletId: string, keyId: string): void {
  const r = db.prepare("SELECT id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  vault.revokeApiKey(keyId);
}

// ─── Agent config export ───

/**
 * Generate the config an agent needs to use this wallet.
 * Issues a scoped AgentOS API key (requires owner passphrase since
 * the server cannot derive HKDF without it).
 */
export function getAgentConfig(
  userId: string,
  walletId: string,
  passphrase: string,
): object | null {
  if (!passphrase) throw new Error("Owner passphrase is required");
  const wallet = getWallet(userId, walletId);
  if (!wallet) return null;

  const apiKey = createApiKeyForWallet(userId, walletId, `agent-config-${walletId}`, passphrase);

  return {
    apiKey: apiKey.token,
    wallets: {
      solana: wallet.solana.address
        ? { chain: "solana", network: "mainnet-beta", address: wallet.solana.address, rpc: "https://api.mainnet-beta.solana.com" }
        : null,
      base: wallet.base.address
        ? { chain: "base", network: "mainnet", address: wallet.base.address, smartWallet: wallet.onchain.base || null, rpc: "https://mainnet.base.org" }
        : null,
    },
    accounts: wallet.accounts,
    note: "Use the AgentOS API key for signing. The server cannot decrypt this wallet without the API key or owner passphrase.",
  };
}

// ─── Internal helpers ───

function toWalletInfo(row: any, vaultWallet: VaultWalletInfo | null): WalletInfo {
  return {
    id: row.id,
    label: row.label,
    vaultWalletId: row.vault_wallet_id,
    solana: { address: row.sol_address || (vaultWallet ? vault.getAddressForChain(vaultWallet, "solana") : null) },
    base: { address: row.onchain_base || row.base_address || (vaultWallet ? vault.getAddressForChain(vaultWallet, "evm") : null) },
    accounts: vaultWallet ? vaultWallet.accounts.map((a) => ({ chainId: a.chainId, address: a.address })) : [],
    supportedChains: (row.supported_chains || "solana,evm").split(",").filter(Boolean),
    onchain: { base: row.onchain_base || null, solana: row.onchain_sol || null },
    created_at: row.created_at,
  };
}
