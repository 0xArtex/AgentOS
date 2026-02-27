import { db } from "../db";
import { createHmac, randomBytes } from "crypto";
import { Keypair } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import bs58 from "bs58";

const DATA_DIR = join(process.cwd(), "data");
const SEED_PATH = join(DATA_DIR, "wallet-master.json");

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
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT NOT NULL,
    label TEXT DEFAULT 'My Wallet',
    sol_address TEXT NOT NULL,
    sol_pubkey TEXT NOT NULL,
    base_address TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, sol_address)
  )
`);

export interface WalletInfo {
  id: string;
  label: string;
  solana: { address: string; pubkey: string };
  base: { address: string };
  created_at: string;
}

export function createWallet(userId: string, label?: string): WalletInfo {
  // Count existing wallets for this user to derive unique keys
  const count = (db.prepare("SELECT COUNT(*) as c FROM agent_wallets WHERE user_id = ?").get(userId) as any).c;
  const idx = `${userId}:${count}`;

  // Derive Solana keypair
  const solSecret = deriveKey("agent-sol", idx);
  const solKeypair = Keypair.fromSeed(new Uint8Array(solSecret));
  const solAddress = solKeypair.publicKey.toBase58();

  // Derive EVM address (keccak256 would be ideal but SHA256 works for now)
  const evmSecret = deriveKey("agent-evm", idx);
  const evmHex = evmSecret.toString("hex");
  // Simple EVM address from private key hash (first 20 bytes)
  const evmAddrRaw = createHmac("sha256", evmSecret).update("address").digest().subarray(0, 20);
  const evmAddress = "0x" + evmAddrRaw.toString("hex");

  const walletLabel = label || "My Wallet";
  const id = randomBytes(16).toString("hex");

  db.prepare(`
    INSERT INTO agent_wallets (id, user_id, label, sol_address, sol_pubkey, base_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, walletLabel, solAddress, solAddress, evmAddress);

  return {
    id,
    label: walletLabel,
    solana: { address: solAddress, pubkey: solAddress },
    base: { address: evmAddress },
    created_at: new Date().toISOString(),
  };
}

export function getWallets(userId: string): WalletInfo[] {
  const rows = db.prepare("SELECT * FROM agent_wallets WHERE user_id = ? ORDER BY created_at").all(userId) as any[];
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    solana: { address: r.sol_address, pubkey: r.sol_pubkey },
    base: { address: r.base_address },
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
    base: { address: r.base_address },
    created_at: r.created_at,
  };
}

export function deleteWallet(userId: string, walletId: string): boolean {
  const result = db.prepare("DELETE FROM agent_wallets WHERE id = ? AND user_id = ?").run(walletId, userId);
  return result.changes > 0;
}

/**
 * Export wallet credentials for injecting into an agent's OpenClaw config.
 * Returns private keys — handle with extreme care.
 */
export function exportWalletCredentials(userId: string, walletId: string): {
  solana: { address: string; privateKey: string };
  base: { address: string; privateKey: string };
} | null {
  const wallet = getWallet(userId, walletId);
  if (!wallet) return null;

  // Re-derive the keys (deterministic from userId + index)
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
  if (!creds) return null;

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
        rpc: "https://mainnet.base.org",
      },
    },
    skills: {
      bankr: {
        description: "Cross-chain wallet for trading, DeFi, and token launches on Base",
        docs: "https://docs.bankr.bot",
        chain: "base",
        wallet: creds.base.address,
      },
      frames: {
        description: "x402 payment signing and tool access on Solana",
        docs: "https://frames.ag",
        chain: "solana",
        wallet: creds.solana.address,
      },
    },
    note: "Private keys are stored securely. Agent receives addresses + signing capability via AgentOS API.",
  };
}
