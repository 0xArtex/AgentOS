/**
 * Deposit wallet service — server-internal infrastructure.
 *
 * Each user gets a unique deposit wallet (Solana + EVM) for receiving USDC.
 * Funds are auto-swept to the treasury, so the server MUST be able to sign
 * sweep transactions without user interaction. Deposit wallets are intentionally
 * CUSTODIAL — but their vault session secrets are AES-GCM-encrypted at rest
 * with DEPOSIT_MASTER_KEY (held in env only). A stolen DB file alone is
 * useless; the attacker also needs the env variable.
 */
import { db } from "../db";
import * as vault from "./wallet-vault";
import { Keypair } from "@solana/web3.js";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

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

// ─── Encryption at rest ───
const MASTER_KEY_ENV = "DEPOSIT_MASTER_KEY";
const ENC_PREFIX = "enc:v1:";

function getMasterKey(): Buffer {
  const hex = process.env[MASTER_KEY_ENV];
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(`${MASTER_KEY_ENV} must be a 64-char hex string (32 bytes) in production`);
    }
    // Dev fallback: derive a dummy key from a fixed seed so local testing works.
    // Never reach here in prod (guarded above).
    return Buffer.from("00".repeat(32), "hex");
  }
  return Buffer.from(hex, "hex");
}

function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}.${ct.toString("hex")}.${tag.toString("hex")}`;
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy plaintext row — return as-is. Will be re-encrypted on next write.
    return stored;
  }
  const [iv, ct, tag] = stored.slice(ENC_PREFIX.length).split(".");
  const key = getMasterKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let pt = decipher.update(ct, "hex", "utf8");
  pt += decipher.final("utf8");
  return pt;
}

function getDepositWallet(index: number): { vaultWalletId: string; sessionSecret: string } | null {
  const row = db.prepare("SELECT vault_wallet_id, session_secret FROM deposit_wallets WHERE derivation_index = ?").get(index) as any;
  if (!row || !row.vault_wallet_id) return null;
  const sessionSecret = decryptSecret(row.session_secret);
  // Opportunistic upgrade: if the stored value was legacy-plaintext, re-encrypt.
  if (!row.session_secret.startsWith(ENC_PREFIX) && sessionSecret) {
    try {
      db.prepare("UPDATE deposit_wallets SET session_secret = ? WHERE derivation_index = ?")
        .run(encryptSecret(sessionSecret), index);
    } catch {}
  }
  return { vaultWalletId: row.vault_wallet_id, sessionSecret };
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
  const sessionSecretEncrypted = encryptSecret(sessionSecret);
  db.prepare(
    "INSERT INTO deposit_wallets (id, user_id, derivation_index, vault_wallet_id, session_secret, solana_address, evm_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
  ).run(id, userId, index, vaultWallet.id, sessionSecretEncrypted, solAddr, evmAddr);

  console.log(`[deposit] Created wallet #${index} for ${userId}: SOL=${solAddr} EVM=${evmAddr}`);
  return { solanaAddress: solAddr, evmAddress: evmAddr };
}
