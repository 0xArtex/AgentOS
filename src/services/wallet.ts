/**
 * Wallet service — powered by Palmyr Wallet Vault.
 *
 * Two modes:
 *   - Unmanaged: agent has full control, no limits, session secret in OS cred store
 *   - Managed: policy engine enforces limits, human approves via passkey
 *
 * Key material is stored in the encrypted vault at ~/.palmyr/wallet/.
 * Palmyr stores metadata (user→wallet associations, labels, on-chain refs) in SQLite.
 */
import { db } from "../db";
import { randomBytes } from "crypto";
import * as vault from "./wallet-vault";
import type { WalletInfo as VaultWalletInfo, SignResult, ApiKeyResult } from "./wallet-vault";

// ─── DB schema ───
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT DEFAULT 'My Wallet',
    vault_wallet_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'unmanaged',
    sol_address TEXT,
    base_address TEXT,
    supported_chains TEXT DEFAULT 'solana,evm',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, vault_wallet_id)
  )
`);

// Migrations for existing DBs
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN vault_wallet_id TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN supported_chains TEXT DEFAULT 'solana,evm'"); } catch {}
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN mode TEXT DEFAULT 'unmanaged'"); } catch {}
try { db.exec("UPDATE agent_wallets SET vault_wallet_id = ows_wallet_id WHERE vault_wallet_id IS NULL AND ows_wallet_id IS NOT NULL"); } catch {}

// Setup tokens for managed wallets
db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_setup_tokens (
    token TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Approval requests for managed wallets
db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_approval_requests (
    id TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL,
    action TEXT NOT NULL,
    params TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )
`);

// ─── Types ───

export interface WalletInfo {
  id: string;
  label: string;
  vaultWalletId: string;
  mode: "unmanaged" | "managed";
  solana: { address: string | null };
  base: { address: string | null };
  accounts: Array<{ chainId: string; address: string }>;
  supportedChains: string[];
  created_at: string;
}

export interface AuthCreds {
  sessionSecret?: string;
  token?: string;
}

// ─── Auth resolution ───
// The server always requires explicit auth (API key token or session secret
// passed by the caller). The OS credential store is a CLI-only concept —
// servers run as services/containers where DPAPI/Keychain/D-Bus are unavailable.

// ─── Wallet CRUD ───

/**
 * Create a new wallet. Returns wallet info, session secret (for OS cred store),
 * and optionally a setup link for managed wallets.
 */
export async function createWallet(
  userId: string,
  label?: string,
  chains?: string[],
  mode: "unmanaged" | "managed" = "unmanaged",
): Promise<{ walletInfo: WalletInfo; sessionSecret: string; setupLink?: string }> {
  const walletLabel = label || "My Wallet";
  const id = randomBytes(16).toString("hex");

  const count = (db.prepare("SELECT COUNT(*) as c FROM agent_wallets WHERE user_id = ?").get(userId) as any).c;
  const vaultName = `agent-${userId}-${count}`;

  const { wallet: vaultWallet, sessionSecret } = vault.createWallet(vaultName, mode);
  const { solana, evm } = vault.getDefaultAddresses(vaultWallet);

  const supportedChains = chains || ["solana", "evm"];

  db.prepare(`
    INSERT INTO agent_wallets (id, user_id, label, vault_wallet_id, mode, sol_address, base_address, supported_chains)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, walletLabel, vaultWallet.id, mode, solana, evm, supportedChains.join(","));

  let setupLink: string | undefined;
  if (mode === "managed") {
    const setupToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    db.prepare("INSERT INTO wallet_setup_tokens (token, wallet_id, expires_at) VALUES (?, ?, ?)").run(setupToken, id, expiresAt);
    setupLink = `/wallet/${id}/setup?token=${setupToken}`;
  }

  const walletInfo = toWalletInfo(
    { id, user_id: userId, label: walletLabel, vault_wallet_id: vaultWallet.id, mode, sol_address: solana, base_address: evm, supported_chains: supportedChains.join(","), created_at: new Date().toISOString() },
    vaultWallet,
  );

  return { walletInfo, sessionSecret, setupLink };
}

/**
 * Register a managed wallet that was created via the CLI on the agent's machine.
 *
 * The vault lives on the agent's machine — the server only stores metadata needed
 * to drive the passkey setup flow. Called by `POST /wallet/register-managed` (public,
 * no dashboard auth). The setup token in the returned link is the only secret.
 */
export async function registerManagedWallet(
  walletId: string,
  name: string,
  solanaAddress: string | null,
  evmAddress: string | null,
): Promise<{ setupLink: string; walletId: string }> {
  // Reject if already registered
  const existing = db.prepare("SELECT id FROM agent_wallets WHERE id = ?").get(walletId) as any;
  if (existing) throw new Error(`Wallet ${walletId} already registered`);

  const CLI_USER = "cli-managed";
  // Use the walletId as the vault_wallet_id too — there is no server-side vault file
  db.prepare(`
    INSERT INTO agent_wallets (id, user_id, label, vault_wallet_id, mode, sol_address, base_address, supported_chains)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(walletId, CLI_USER, name, walletId, "managed", solanaAddress, evmAddress, "solana,evm");

  // Generate setup token (7-day expiry)
  const setupToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO wallet_setup_tokens (token, wallet_id, expires_at) VALUES (?, ?, ?)")
    .run(setupToken, walletId, expiresAt);

  return {
    walletId,
    setupLink: `/wallet/${walletId}/setup?token=${setupToken}`,
  };
}

/**
 * Import a wallet from a mnemonic phrase.
 */
export async function importWallet(
  userId: string,
  mnemonic: string,
  label?: string,
  mode: "unmanaged" | "managed" = "unmanaged",
): Promise<{ walletInfo: WalletInfo; sessionSecret: string }> {
  const walletLabel = label || "Imported Wallet";
  const id = randomBytes(16).toString("hex");
  const count = (db.prepare("SELECT COUNT(*) as c FROM agent_wallets WHERE user_id = ?").get(userId) as any).c;
  const vaultName = `agent-${userId}-${count}`;

  const { wallet: vaultWallet, sessionSecret } = vault.importWalletMnemonic(vaultName, mnemonic, mode);
  const { solana, evm } = vault.getDefaultAddresses(vaultWallet);

  db.prepare(`
    INSERT INTO agent_wallets (id, user_id, label, vault_wallet_id, mode, sol_address, base_address, supported_chains)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, walletLabel, vaultWallet.id, mode, solana, evm, "solana,evm");

  const walletInfo = toWalletInfo(
    { id, user_id: userId, label: walletLabel, vault_wallet_id: vaultWallet.id, mode, sol_address: solana, base_address: evm, supported_chains: "solana,evm", created_at: new Date().toISOString() },
    vaultWallet,
  );

  return { walletInfo, sessionSecret };
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
  } catch {}

  const result = db.prepare("DELETE FROM agent_wallets WHERE id = ? AND user_id = ?").run(walletId, userId);
  return result.changes > 0;
}

// ─── Signing ───

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

export function deriveChainAddress(userId: string, walletId: string, chain: string): string {
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

export function getAddresses(userId: string, walletId: string): Array<{ chainId: string; address: string }> {
  const r = db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  const vaultWallet = vault.getWallet(r.vault_wallet_id);
  return vaultWallet.accounts.map((a) => ({ chainId: a.chainId, address: a.address }));
}

// ─── Policy management ───

export function updatePolicy(userId: string, walletId: string, policy: vault.WalletPolicy): void {
  const r = db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  vault.setWalletPolicy(r.vault_wallet_id, policy);
}

export function getPolicy(userId: string, walletId: string): vault.WalletPolicy | null {
  const r = db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  return vault.getWalletPolicy(r.vault_wallet_id);
}

export function getSpending(
  userId: string,
  walletId: string,
): { entries: vault.SpendEntry[]; daily_total_usdc: number } {
  const r = db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  return {
    entries: vault.getSpendLog(r.vault_wallet_id),
    daily_total_usdc: vault.getDailySpend(r.vault_wallet_id),
  };
}

// ─── API key management ───

export function createApiKeyForWallet(
  userId: string,
  walletId: string,
  name: string,
  sessionSecret: string,
  policyIds?: string[],
  expiresAt?: string,
): ApiKeyResult {
  const r = db.prepare("SELECT vault_wallet_id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  return vault.createApiKey(name, [r.vault_wallet_id], sessionSecret, policyIds || [], expiresAt);
}

export function revokeWalletApiKey(userId: string, walletId: string, keyId: string): void {
  const r = db.prepare("SELECT id FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  vault.revokeApiKey(keyId);
}

// ─── Approval requests (managed wallets) ───

export function requestApproval(
  userId: string,
  walletId: string,
  action: string,
  params: Record<string, any>,
): { approvalId: string; approvalPath: string } {
  const r = db.prepare("SELECT id, mode FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) throw new Error("Wallet not found");
  if (r.mode !== "managed") throw new Error("Approval requests are only for managed wallets");

  const approvalId = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

  db.prepare(
    "INSERT INTO wallet_approval_requests (id, wallet_id, action, params, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(approvalId, walletId, action, JSON.stringify(params), expiresAt);

  return {
    approvalId,
    approvalPath: `/wallet/${walletId}/approve/${approvalId}`,
  };
}

export function getApprovalRequest(approvalId: string): any | null {
  return db.prepare("SELECT * FROM wallet_approval_requests WHERE id = ? AND status = 'pending' AND expires_at > datetime('now')").get(approvalId) as any;
}

export function completeApproval(approvalId: string): void {
  db.prepare("UPDATE wallet_approval_requests SET status = 'approved' WHERE id = ?").run(approvalId);
}

// ─── Agent config export ───

export function getAgentConfig(
  userId: string,
  walletId: string,
  sessionSecret: string,
): object | null {
  const wallet = getWallet(userId, walletId);
  if (!wallet) return null;

  const apiKey = createApiKeyForWallet(userId, walletId, `agent-config-${walletId}`, sessionSecret);

  return {
    apiKey: apiKey.token,
    wallets: {
      solana: wallet.solana.address
        ? { chain: "solana", network: "mainnet-beta", address: wallet.solana.address, rpc: "https://api.mainnet-beta.solana.com" }
        : null,
      base: wallet.base.address
        ? { chain: "base", network: "mainnet", address: wallet.base.address, rpc: "https://mainnet.base.org" }
        : null,
    },
    accounts: wallet.accounts,
    mode: wallet.mode,
    note: "Use the Palmyr API key for signing. The server cannot decrypt this wallet without the API key or session secret.",
  };
}

// ─── Internal helpers ───

function toWalletInfo(row: any, vaultWallet: VaultWalletInfo | null): WalletInfo {
  return {
    id: row.id,
    label: row.label,
    vaultWalletId: row.vault_wallet_id,
    mode: row.mode || "unmanaged",
    solana: { address: row.sol_address || (vaultWallet ? vault.getAddressForChain(vaultWallet, "solana") : null) },
    base: { address: row.base_address || (vaultWallet ? vault.getAddressForChain(vaultWallet, "evm") : null) },
    accounts: vaultWallet ? vaultWallet.accounts.map((a) => ({ chainId: a.chainId, address: a.address })) : [],
    supportedChains: (row.supported_chains || "solana,evm").split(",").filter(Boolean),
    created_at: row.created_at,
  };
}
