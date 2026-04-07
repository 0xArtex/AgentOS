/**
 * AgentOS Wallet Vault — pure-JS HD wallet management.
 *
 * Stores BIP-39 mnemonics encrypted with Scrypt + AES-256-GCM in
 * the AgentOS data directory. Derives BIP-44 keys for multiple chains.
 *
 * Vault layout (default `~/.agentos/wallet/`):
 *   wallets/   — encrypted wallet files (one per wallet)
 *   keys/      — agent API keys (token hashes)
 *   policies/  — declarative policy rules
 *
 * Vault file format is OWS-compatible so wallets can be imported into
 * native @open-wallet-standard/core if desired.
 */
import { randomBytes, createCipheriv, createDecipheriv, scryptSync, createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";

// ─── Types ───

export interface AccountInfo {
  chainId: string;
  address: string;
  derivationPath: string;
}

export interface WalletInfo {
  id: string;
  name: string;
  accounts: AccountInfo[];
  createdAt: string;
}

export interface SignResult {
  signature: string;
  recoveryId?: number;
}

export interface ApiKeyResult {
  token: string;
  id: string;
  name: string;
}

export interface ApiKeyValidation {
  id: string;
  name: string;
  walletIds: string[];
  policyIds: string[];
}

// ─── Vault config ───

const DEFAULT_VAULT_PATH = join(homedir(), ".agentos", "wallet");
const VAULT_PATH = process.env.AGENTOS_WALLET_PATH || DEFAULT_VAULT_PATH;
const PASSPHRASE = process.env.AGENTOS_WALLET_PASSWORD || "";

function ensureVault(): string {
  if (!existsSync(VAULT_PATH)) mkdirSync(VAULT_PATH, { recursive: true });
  for (const sub of ["wallets", "keys", "policies"]) {
    const p = join(VAULT_PATH, sub);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
  return VAULT_PATH;
}

// ─── Encryption ───

interface EncryptedBlob {
  iv: string;
  salt: string;
  ciphertext: string;
  tag: string;
}

function encryptSecret(plaintext: string, passphrase: string): EncryptedBlob {
  const salt = randomBytes(32);
  const key = scryptSync(passphrase || "default", salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  return {
    iv: iv.toString("hex"),
    salt: salt.toString("hex"),
    ciphertext: encrypted,
    tag: cipher.getAuthTag().toString("hex"),
  };
}

function decryptSecret(blob: EncryptedBlob, passphrase: string): string {
  const key = scryptSync(passphrase || "default", Buffer.from(blob.salt, "hex"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  let decrypted = decipher.update(blob.ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ─── HD derivation ───

function deriveAllAccounts(mnemonic: string): AccountInfo[] {
  const accounts: AccountInfo[] = [];
  const seed = bip39.mnemonicToSeedSync(mnemonic);

  // Solana (Ed25519, BIP-44)
  try {
    const derived = derivePath("m/44'/501'/0'/0'", seed.toString("hex"));
    const kp = Keypair.fromSeed(derived.key);
    accounts.push({
      chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      address: kp.publicKey.toBase58(),
      derivationPath: "m/44'/501'/0'/0'",
    });
  } catch {}

  // EVM (secp256k1, BIP-44)
  try {
    const { HDNodeWallet } = require("ethers");
    const hd = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0");
    accounts.push({
      chainId: "eip155:1",
      address: hd.address,
      derivationPath: "m/44'/60'/0'/0/0",
    });
  } catch {}

  // Bitcoin (secp256k1, BIP-84) — placeholder address until bech32 lib added
  try {
    const { HDNodeWallet } = require("ethers");
    const hd = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/84'/0'/0'/0/0");
    accounts.push({
      chainId: "bip122:000000000019d6689c085ae165831e93",
      address: hd.address,
      derivationPath: "m/84'/0'/0'/0/0",
    });
  } catch {}

  // Sui (Ed25519)
  try {
    const derived = derivePath("m/44'/784'/0'/0'/0'", seed.toString("hex"));
    const hash = createHash("blake2b512")
      .update(Buffer.concat([Buffer.from([0x00]), derived.key]))
      .digest();
    accounts.push({
      chainId: "sui:mainnet",
      address: "0x" + hash.subarray(0, 32).toString("hex"),
      derivationPath: "m/44'/784'/0'/0'/0'",
    });
  } catch {}

  return accounts;
}

function deriveSolanaKeypair(mnemonic: string): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derived = derivePath("m/44'/501'/0'/0'", seed.toString("hex"));
  return Keypair.fromSeed(derived.key);
}

function deriveEvmWallet(mnemonic: string): any {
  const { HDNodeWallet } = require("ethers");
  return HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0");
}

// ─── Wallet file I/O ───

interface WalletFile {
  agentos_version: number;
  id: string;
  name: string;
  accounts: AccountInfo[];
  crypto: EncryptedBlob;
  key_type: "mnemonic" | "private_key";
  created_at: string;
}

function loadWalletFile(nameOrId: string): { path: string; data: WalletFile } {
  ensureVault();
  const dir = join(VAULT_PATH, "wallets");
  for (const f of readdirSync(dir).filter(x => x.endsWith(".json"))) {
    const fpath = join(dir, f);
    const data = JSON.parse(readFileSync(fpath, "utf8")) as WalletFile;
    if (data.id === nameOrId || data.name === nameOrId) {
      return { path: fpath, data };
    }
  }
  throw new Error(`Wallet "${nameOrId}" not found`);
}

function getMnemonic(nameOrId: string): string {
  const { data } = loadWalletFile(nameOrId);
  if (data.key_type !== "mnemonic") {
    throw new Error("Wallet was imported as a raw private key, no mnemonic available");
  }
  return decryptSecret(data.crypto, PASSPHRASE);
}

// ─── Public API ───

export function initVault(): void {
  ensureVault();
  console.log(`[wallet] Vault initialized at ${VAULT_PATH}`);
}

export function generateMnemonic(words: number = 12): string {
  return bip39.generateMnemonic(words === 24 ? 256 : 128);
}

export function deriveAddress(mnemonic: string, chain: string): string {
  const c = chain.toLowerCase();
  if (c === "solana" || c.startsWith("solana:")) {
    return deriveSolanaKeypair(mnemonic).publicKey.toBase58();
  }
  if (c === "evm" || c === "ethereum" || c === "base" || c.startsWith("eip155:")) {
    return deriveEvmWallet(mnemonic).address;
  }
  throw new Error(`Chain "${chain}" not supported`);
}

// Wallet CRUD ──────────────────────────────────────────

export function createWallet(name: string, words: number = 12): WalletInfo {
  ensureVault();
  const mnemonic = generateMnemonic(words);
  const id = randomBytes(16).toString("hex");
  const accounts = deriveAllAccounts(mnemonic);

  const file: WalletFile = {
    agentos_version: 1,
    id,
    name,
    accounts,
    crypto: encryptSecret(mnemonic, PASSPHRASE),
    key_type: "mnemonic",
    created_at: new Date().toISOString(),
  };

  writeFileSync(join(VAULT_PATH, "wallets", `${id}.json`), JSON.stringify(file, null, 2));
  return { id, name, accounts, createdAt: file.created_at };
}

export function importWalletMnemonic(name: string, mnemonic: string): WalletInfo {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic");
  ensureVault();
  const id = randomBytes(16).toString("hex");
  const accounts = deriveAllAccounts(mnemonic);

  const file: WalletFile = {
    agentos_version: 1,
    id,
    name,
    accounts,
    crypto: encryptSecret(mnemonic, PASSPHRASE),
    key_type: "mnemonic",
    created_at: new Date().toISOString(),
  };

  writeFileSync(join(VAULT_PATH, "wallets", `${id}.json`), JSON.stringify(file, null, 2));
  return { id, name, accounts, createdAt: file.created_at };
}

export function listWallets(): WalletInfo[] {
  ensureVault();
  const dir = join(VAULT_PATH, "wallets");
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const data = JSON.parse(readFileSync(join(dir, f), "utf8")) as WalletFile;
      return { id: data.id, name: data.name, accounts: data.accounts, createdAt: data.created_at };
    });
}

export function getWallet(nameOrId: string): WalletInfo {
  const { data } = loadWalletFile(nameOrId);
  return { id: data.id, name: data.name, accounts: data.accounts, createdAt: data.created_at };
}

export function deleteWallet(nameOrId: string): void {
  const { path } = loadWalletFile(nameOrId);
  unlinkSync(path);
}

export function exportWallet(nameOrId: string): string {
  return getMnemonic(nameOrId);
}

export function renameWallet(nameOrId: string, newName: string): void {
  const { path, data } = loadWalletFile(nameOrId);
  data.name = newName;
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// Signing ──────────────────────────────────────────────

export function signMessage(walletId: string, chain: string, message: string, encoding: "utf8" | "hex" = "utf8"): SignResult {
  const mnemonic = getMnemonic(walletId);
  const c = chain.toLowerCase();
  const msgBytes = encoding === "hex" ? Buffer.from(message, "hex") : Buffer.from(message, "utf8");

  if (c === "solana" || c.startsWith("solana:")) {
    const kp = deriveSolanaKeypair(mnemonic);
    const { sign } = require("tweetnacl");
    const sig = sign.detached(msgBytes, kp.secretKey);
    return { signature: Buffer.from(sig).toString("hex") };
  }

  if (c === "evm" || c === "base" || c === "ethereum" || c.startsWith("eip155:")) {
    const hd = deriveEvmWallet(mnemonic);
    const sig = hd.signMessageSync(message);
    return { signature: sig.replace("0x", "") };
  }

  throw new Error(`Chain "${chain}" not supported for message signing`);
}

export function signTransaction(walletId: string, chain: string, txHex: string): SignResult {
  const mnemonic = getMnemonic(walletId);
  const c = chain.toLowerCase();

  if (c === "solana" || c.startsWith("solana:")) {
    const kp = deriveSolanaKeypair(mnemonic);
    const txBytes = Buffer.from(txHex, "hex");
    const { sign } = require("tweetnacl");
    const sig = sign.detached(txBytes, kp.secretKey);
    return { signature: Buffer.from(sig).toString("hex") };
  }

  if (c === "evm" || c === "base" || c === "ethereum" || c.startsWith("eip155:")) {
    const { ethers } = require("ethers");
    const hd = deriveEvmWallet(mnemonic);
    const signingKey = new ethers.SigningKey(hd.privateKey);
    const sig = signingKey.sign(Buffer.from(txHex, "hex"));
    return { signature: sig.serialized.replace("0x", ""), recoveryId: sig.v };
  }

  throw new Error(`Chain "${chain}" not supported for transaction signing`);
}

export function signTypedData(walletId: string, _chain: string, typedDataJson: string): SignResult {
  const mnemonic = getMnemonic(walletId);
  const { TypedDataEncoder, SigningKey } = require("ethers");
  const hd = deriveEvmWallet(mnemonic);

  const typed = JSON.parse(typedDataJson);
  const { domain, types, message } = typed;
  const filteredTypes = { ...types };
  delete filteredTypes.EIP712Domain;

  const hash = TypedDataEncoder.hash(domain, filteredTypes, message);
  const signingKey = new SigningKey(hd.privateKey);
  const sig = signingKey.sign(hash);
  return { signature: sig.serialized.replace("0x", ""), recoveryId: sig.v };
}

/**
 * Get the raw Solana keypair for a wallet (used by deposit monitor sweeps).
 * Bypasses the OWS abstraction since sweep operations need full @solana/web3.js Keypair.
 */
export function getSolanaKeypair(walletId: string): Keypair {
  const mnemonic = getMnemonic(walletId);
  return deriveSolanaKeypair(mnemonic);
}

/**
 * Get the raw EVM private key for a wallet (used by deposit monitor sweeps).
 */
export function getEvmPrivateKey(walletId: string): string {
  const mnemonic = getMnemonic(walletId);
  return deriveEvmWallet(mnemonic).privateKey;
}

// Policies ─────────────────────────────────────────────

export function createPolicy(policyJson: string): { id: string } {
  ensureVault();
  const policy = JSON.parse(policyJson);
  const id = policy.id || randomBytes(8).toString("hex");
  writeFileSync(join(VAULT_PATH, "policies", `${id}.json`), JSON.stringify({ id, ...policy }, null, 2));
  return { id };
}

export function listPolicies(): any[] {
  ensureVault();
  const dir = join(VAULT_PATH, "policies");
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

export function getPolicy(id: string): any {
  const fpath = join(VAULT_PATH, "policies", `${id}.json`);
  if (!existsSync(fpath)) throw new Error(`Policy "${id}" not found`);
  return JSON.parse(readFileSync(fpath, "utf8"));
}

export function deletePolicy(id: string): void {
  const fpath = join(VAULT_PATH, "policies", `${id}.json`);
  if (existsSync(fpath)) unlinkSync(fpath);
}

// API keys ─────────────────────────────────────────────

const API_KEY_PREFIX = "agos_key_";

export function createApiKey(
  name: string,
  walletIds: string[],
  policyIds: string[] = [],
  expiresAt?: string,
): ApiKeyResult {
  ensureVault();
  const id = randomBytes(8).toString("hex");
  const token = `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;

  const file = {
    id,
    name,
    token_hash: createHash("sha256").update(token).digest("hex"),
    wallet_ids: walletIds,
    policy_ids: policyIds,
    expires_at: expiresAt || null,
    created_at: new Date().toISOString(),
  };

  writeFileSync(join(VAULT_PATH, "keys", `${id}.json`), JSON.stringify(file, null, 2));
  return { token, id, name };
}

export function listApiKeys(): any[] {
  ensureVault();
  const dir = join(VAULT_PATH, "keys");
  return readdirSync(dir).filter(f => f.endsWith(".json")).map(f => {
    const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return {
      id: d.id,
      name: d.name,
      wallet_ids: d.wallet_ids,
      expires_at: d.expires_at,
      created_at: d.created_at,
    };
  });
}

export function revokeApiKey(id: string): void {
  const fpath = join(VAULT_PATH, "keys", `${id}.json`);
  if (existsSync(fpath)) unlinkSync(fpath);
}

/**
 * Validate an API key token. Returns the accessible wallet IDs and policy IDs,
 * or null if invalid/expired/not found.
 */
export function validateApiKey(token: string): ApiKeyValidation | null {
  if (!token || !token.startsWith(API_KEY_PREFIX)) return null;
  ensureVault();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const dir = join(VAULT_PATH, "keys");
  if (!existsSync(dir)) return null;

  for (const file of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (data.token_hash !== tokenHash) continue;

      if (data.expires_at && Date.now() > new Date(data.expires_at).getTime()) {
        return null;
      }

      return {
        id: data.id,
        name: data.name,
        walletIds: data.wallet_ids || [],
        policyIds: data.policy_ids || [],
      };
    } catch {}
  }
  return null;
}

// ─── Helpers ───

export function getAddressForChain(wallet: WalletInfo, chain: string): string | null {
  const c = chain.toLowerCase();
  for (const a of wallet.accounts) {
    const cid = a.chainId.toLowerCase();
    if (
      cid.includes(c) ||
      (c === "evm" && cid.startsWith("eip155:")) ||
      (c === "base" && cid.startsWith("eip155:")) ||
      (c === "ethereum" && cid.startsWith("eip155:")) ||
      (c === "solana" && cid.startsWith("solana:"))
    ) {
      return a.address;
    }
  }
  return null;
}

export function getDefaultAddresses(wallet: WalletInfo): { solana: string | null; evm: string | null } {
  return {
    solana: getAddressForChain(wallet, "solana"),
    evm: getAddressForChain(wallet, "evm"),
  };
}
