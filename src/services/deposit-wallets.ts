import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createHmac, randomBytes } from "crypto";
import { Keypair } from "@solana/web3.js";
import { db } from "../db";

const DATA_DIR = join(process.cwd(), "data");
const SEED_PATH = join(DATA_DIR, "deposit-master.json");

let masterSeed: Buffer;

function loadOrCreateSeed(): Buffer {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  
  if (existsSync(SEED_PATH)) {
    const data = JSON.parse(readFileSync(SEED_PATH, "utf-8"));
    return Buffer.from(data.seed, "hex");
  }
  
  const seed = randomBytes(32);
  writeFileSync(SEED_PATH, JSON.stringify({ seed: seed.toString("hex"), created: new Date().toISOString() }));
  console.log("🔑 Generated new deposit master seed");
  return seed;
}

masterSeed = loadOrCreateSeed();

function deriveKey(domain: string, index: number): Buffer {
  return createHmac("sha512", masterSeed).update(`${domain}:${index}`).digest().subarray(0, 32);
}

export function getSolanaKeypair(index: number): Keypair {
  const secret = deriveKey("solana", index);
  return Keypair.fromSeed(new Uint8Array(secret));
}

export function getEvmPrivateKey(index: number): string {
  const secret = deriveKey("evm", index);
  return "0x" + secret.toString("hex");
}

export function getEvmAddress(index: number): string {
  const { ethers } = require("ethers");
  const secret = deriveKey("evm", index);
  const wallet = new ethers.Wallet("0x" + secret.toString("hex"));
  return wallet.address;
}

export function getOrCreateWallet(userId: string): { solanaAddress: string; evmAddress: string } {
  const existing = db.prepare("SELECT solana_address, evm_address FROM deposit_wallets WHERE user_id = ?").get(userId) as any;
  if (existing) return { solanaAddress: existing.solana_address, evmAddress: existing.evm_address };

  const row = db.prepare("SELECT MAX(derivation_index) as mx FROM deposit_wallets").get() as any;
  const index = (row?.mx ?? -1) + 1;

  const solKp = getSolanaKeypair(index);
  const solAddr = solKp.publicKey.toBase58();
  const evmAddr = getEvmAddress(index);

  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO deposit_wallets (id, user_id, derivation_index, solana_address, evm_address, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
  ).run(id, userId, index, solAddr, evmAddr);

  console.log(`💳 Created deposit wallet #${index} for ${userId}: SOL=${solAddr} EVM=${evmAddr}`);
  return { solanaAddress: solAddr, evmAddress: evmAddr };
}
