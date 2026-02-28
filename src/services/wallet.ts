import { db } from "../db";
import { createHmac, randomBytes } from "crypto";
import { Keypair } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import bs58 from "bs58";

const DATA_DIR = join(process.cwd(), "data");
const SEED_PATH = join(DATA_DIR, "wallet-master.json");

// ─── Config ───
// When AGENTWALLET_API is set, create on-chain wallets via agentwallet-aos
// Otherwise fall back to HD-derived local wallets
const AGENTWALLET_API = process.env.AGENTWALLET_API || "";

// Separate master seed from deposit wallets for security
let masterSeed: Buffer;

function loadOrCreateSeed(): Buffer {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(SEED_PATH)) {
    const data = JSON.parse(readFileSync(SEED_PATH, "utf-8"));
    return Buffer.from(data.seed, "hex");
  }
  const seed = randomBytes(32);
  writeFileSync(SEED_PATH, JSON.stringify({ seed: seed.toString("hex"), created: new Date().toISOString() }));
  console.log("🔑 Generated new wallet master seed");
  return seed;
}

masterSeed = loadOrCreateSeed();

function deriveKey(domain: string, userId: string): Buffer {
  return createHmac("sha512", masterSeed)
    .update(`${domain}:${userId}`)
    .digest()
    .subarray(0, 32);
}

// Init DB table
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT DEFAULT 'My Wallet',
    sol_address TEXT NOT NULL,
    sol_pubkey TEXT NOT NULL,
    base_address TEXT NOT NULL,
    onchain_base TEXT,
    onchain_sol TEXT,
    policy_daily_limit INTEGER DEFAULT 50000000,
    policy_per_tx_limit INTEGER DEFAULT 25000000,
    policy_approval_threshold INTEGER DEFAULT 25000000,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, sol_address)
  )
`);

// Add new columns if missing (migration)
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN onchain_base TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN onchain_sol TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN policy_daily_limit INTEGER DEFAULT 50000000"); } catch {}
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN policy_per_tx_limit INTEGER DEFAULT 25000000"); } catch {}
try { db.exec("ALTER TABLE agent_wallets ADD COLUMN policy_approval_threshold INTEGER DEFAULT 25000000"); } catch {}

export interface WalletInfo {
  id: string;
  label: string;
  solana: { address: string; pubkey: string };
  base: { address: string };
  onchain: {
    base: string | null;
    solana: string | null;
  };
  policy: {
    dailyLimit: number;
    perTxLimit: number;
    approvalThreshold: number;
  };
  created_at: string;
}

/**
 * Create a wallet pair (Solana + Base).
 * If agentwallet-aos API is available, deploys on-chain smart wallets.
 * Otherwise creates HD-derived local wallets.
 */
export async function createWallet(userId: string, label?: string): Promise<WalletInfo> {
  // Count existing wallets for this user to derive unique keys
  const count = (db.prepare("SELECT COUNT(*) as c FROM agent_wallets WHERE user_id = ?").get(userId) as any).c;
  const idx = `${userId}:${count}`;

  // Derive Solana keypair (agent always generates locally)
  const solSecret = deriveKey("agent-sol", idx);
  const solKeypair = Keypair.fromSeed(new Uint8Array(solSecret));
  const solAddress = solKeypair.publicKey.toBase58();

  // Derive EVM key
  const evmSecret = deriveKey("agent-evm", idx);
  const evmAddrRaw = createHmac("sha256", evmSecret).update("address").digest().subarray(0, 20);
  const evmAddress = "0x" + evmAddrRaw.toString("hex");

  const walletLabel = label || "My Wallet";
  const id = randomBytes(16).toString("hex");

  // Try to deploy on-chain wallets via agentwallet-aos
  let onchainBase: string | null = null;
  let onchainSol: string | null = null;

  if (AGENTWALLET_API) {
    try {
      // For Base: the agent's EVM address is the session key
      // Owner is the platform's admin wallet (human can transfer ownership later)
      const res = await fetch(`${AGENTWALLET_API}/wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: evmAddress, // agent's own address as owner for now
          agent: evmAddress,
        }),
      });
      if (res.ok) {
        const data = await res.json() as any;
        onchainBase = data.wallet?.address || null;
        console.log(`[wallet] On-chain Base wallet deployed: ${onchainBase}`);
      }
    } catch (err) {
      console.warn("[wallet] Failed to create on-chain wallet, using HD fallback:", err);
    }
  }

  db.prepare(`
    INSERT INTO agent_wallets (id, user_id, label, sol_address, sol_pubkey, base_address, onchain_base, onchain_sol, policy_daily_limit, policy_per_tx_limit, policy_approval_threshold)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, walletLabel, solAddress, solAddress, evmAddress, onchainBase, onchainSol, 50_000_000, 25_000_000, 25_000_000);

  return {
    id,
    label: walletLabel,
    solana: { address: solAddress, pubkey: solAddress },
    base: { address: onchainBase || evmAddress },
    onchain: { base: onchainBase, solana: onchainSol },
    policy: {
      dailyLimit: 50_000_000,
      perTxLimit: 25_000_000,
      approvalThreshold: 25_000_000,
    },
    created_at: new Date().toISOString(),
  };
}

export function getWallets(userId: string): WalletInfo[] {
  const rows = db.prepare("SELECT * FROM agent_wallets WHERE user_id = ? ORDER BY created_at").all(userId) as any[];
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    solana: { address: r.sol_address, pubkey: r.sol_pubkey },
    base: { address: r.onchain_base || r.base_address },
    onchain: { base: r.onchain_base || null, solana: r.onchain_sol || null },
    policy: {
      dailyLimit: r.policy_daily_limit || 50_000_000,
      perTxLimit: r.policy_per_tx_limit || 25_000_000,
      approvalThreshold: r.policy_approval_threshold || 25_000_000,
    },
    created_at: r.created_at,
  }));
}

export function getWallet(userId: string, walletId: string): WalletInfo | null {
  const r = db.prepare("SELECT * FROM agent_wallets WHERE id = ? AND user_id = ?").get(walletId, userId) as any;
  if (!r) return null;
  return {
    id: r.id,
    label: r.label,
    solana: { address: r.sol_address, pubkey: r.sol_pubkey },
    base: { address: r.onchain_base || r.base_address },
    onchain: { base: r.onchain_base || null, solana: r.onchain_sol || null },
    policy: {
      dailyLimit: r.policy_daily_limit || 50_000_000,
      perTxLimit: r.policy_per_tx_limit || 25_000_000,
      approvalThreshold: r.policy_approval_threshold || 25_000_000,
    },
    created_at: r.created_at,
  };
}

export function deleteWallet(userId: string, walletId: string): boolean {
  const result = db.prepare("DELETE FROM agent_wallets WHERE id = ? AND user_id = ?").run(walletId, userId);
  return result.changes > 0;
}

/**
 * Update wallet spending policy.
 */
export function updatePolicy(userId: string, walletId: string, dailyLimit?: number, perTxLimit?: number, approvalThreshold?: number): boolean {
  const wallet = getWallet(userId, walletId);
  if (!wallet) return false;

  const dl = dailyLimit ?? wallet.policy.dailyLimit;
  const pt = perTxLimit ?? wallet.policy.perTxLimit;
  const at = approvalThreshold ?? wallet.policy.approvalThreshold;

  db.prepare("UPDATE agent_wallets SET policy_daily_limit = ?, policy_per_tx_limit = ?, policy_approval_threshold = ? WHERE id = ? AND user_id = ?")
    .run(dl, pt, at, walletId, userId);

  // If on-chain wallet exists, sync policy on-chain too
  if (wallet.onchain.base && AGENTWALLET_API) {
    fetch(`${AGENTWALLET_API}/wallet/${wallet.onchain.base}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dailyLimit: dl, perTxLimit: pt, approvalThreshold: at }),
    }).catch(err => console.warn("[wallet] Failed to sync on-chain policy:", err));
  }

  return true;
}

/**
 * Export wallet credentials for injecting into an agent's OpenClaw config.
 */
export function exportWalletCredentials(userId: string, walletId: string): {
  solana: { address: string; privateKey: string };
  base: { address: string; privateKey: string };
} | null {
  const wallet = getWallet(userId, walletId);
  if (!wallet) return null;

  const rows = db.prepare("SELECT id FROM agent_wallets WHERE user_id = ? ORDER BY created_at").all(userId) as any[];
  const idx = rows.findIndex(r => r.id === walletId);
  if (idx === -1) return null;

  const keyIdx = `${userId}:${idx}`;
  const solSecret = deriveKey("agent-sol", keyIdx);
  const solKeypair = Keypair.fromSeed(new Uint8Array(solSecret));
  const evmSecret = deriveKey("agent-evm", keyIdx);

  return {
    solana: {
      address: solKeypair.publicKey.toBase58(),
      privateKey: bs58.encode(solKeypair.secretKey),
    },
    base: {
      address: wallet.base.address,
      privateKey: "0x" + evmSecret.toString("hex"),
    },
  };
}

/**
 * Generate the config snippet an agent needs to use these wallets.
 */
export function getAgentConfig(userId: string, walletId: string): object | null {
  const creds = exportWalletCredentials(userId, walletId);
  const wallet = getWallet(userId, walletId);
  if (!creds || !wallet) return null;

  return {
    wallets: {
      solana: {
        chain: "solana",
        network: "mainnet-beta",
        address: creds.solana.address,
        rpc: "https://api.mainnet-beta.solana.com",
      },
      base: {
        chain: "base",
        network: "mainnet",
        address: creds.base.address,
        smartWallet: wallet.onchain.base || null,
        rpc: "https://mainnet.base.org",
      },
    },
    policy: wallet.policy,
    note: wallet.onchain.base
      ? "On-chain smart wallet deployed. Policies enforced by contract."
      : "HD-derived wallet. On-chain deployment pending.",
  };
}
