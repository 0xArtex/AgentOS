/**
 * AgentOS Wallet Vault — non-custodial HD wallet management.
 *
 * The server stores encrypted wallets but cannot decrypt them on its own.
 * Decryption requires either:
 *   1. The owner passphrase (Scrypt-derived key) — for human owner access
 *   2. An agent API key (HKDF-derived key) — for scoped autonomous access
 *
 * Vault layout (default `~/.agentos/wallet/`):
 *   wallets/   — encrypted wallet files (mnemonic encrypted with owner passphrase)
 *   keys/      — agent API keys (each holds an HKDF-encrypted copy of the mnemonic)
 *   policies/  — declarative policy rules
 *
 * Wallet file format (v2):
 *   {
 *     agentos_version: 2,
 *     id, name, accounts,
 *     owner_crypto: { iv, salt, ciphertext, tag }   // Scrypt(passphrase) → AES-256-GCM
 *     created_at
 *   }
 *
 * API key file format:
 *   {
 *     id, name,
 *     token_hash: SHA256(token),                    // for lookup only
 *     wallet_ids: ["wid1", ...],
 *     policy_ids: [...],
 *     encrypted_mnemonics: {                         // HKDF(token) → AES-256-GCM
 *       wid1: { iv, salt, ciphertext, tag }
 *     },
 *     expires_at, created_at
 *   }
 */
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
  createHash,
  hkdfSync,
} from "crypto";
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
const VAULT_VERSION = 2;
const HKDF_INFO = "agentos-api-key-v1";

function ensureVault(): string {
  if (!existsSync(VAULT_PATH)) mkdirSync(VAULT_PATH, { recursive: true });
  for (const sub of ["wallets", "keys", "policies", "spends"]) {
    const p = join(VAULT_PATH, sub);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
  return VAULT_PATH;
}

// ─── USDC mints (used for spending limit decoding) ───

const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_BASE_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_DECIMALS = 6;

// ─── Encryption primitives ───

interface EncryptedBlob {
  iv: string;
  salt: string;
  ciphertext: string;
  tag: string;
}

function encryptWithKey(plaintext: string, key: Buffer, salt: Buffer): EncryptedBlob {
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

function decryptWithKey(blob: EncryptedBlob, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  let decrypted = decipher.update(blob.ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function encryptWithPassphrase(plaintext: string, passphrase: string): EncryptedBlob {
  if (!passphrase) throw new Error("Passphrase is required");
  const salt = randomBytes(32);
  const key = scryptSync(passphrase, salt, 32);
  return encryptWithKey(plaintext, key, salt);
}

function decryptWithPassphrase(blob: EncryptedBlob, passphrase: string): string {
  if (!passphrase) throw new Error("Passphrase is required");
  const key = scryptSync(passphrase, Buffer.from(blob.salt, "hex"), 32);
  return decryptWithKey(blob, key);
}

function encryptWithToken(plaintext: string, token: string): EncryptedBlob {
  const salt = randomBytes(32);
  const key = Buffer.from(hkdfSync("sha256", token, salt, HKDF_INFO, 32));
  return encryptWithKey(plaintext, key, salt);
}

function decryptWithToken(blob: EncryptedBlob, token: string): string {
  const salt = Buffer.from(blob.salt, "hex");
  const key = Buffer.from(hkdfSync("sha256", token, salt, HKDF_INFO, 32));
  return decryptWithKey(blob, key);
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

  // Bitcoin (secp256k1, BIP-84) — placeholder address
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

/**
 * Spending policy enforced at sign time.
 *   per_tx_usdc      — reject if a single tx transfers more than this
 *   daily_usdc       — reject if 24h cumulative spend (including this tx) exceeds this
 *   allowed_chains   — only sign for chains in this list (e.g. ["solana", "evm"])
 *
 * All fields optional; null/undefined = unlimited / unrestricted.
 */
export interface WalletPolicy {
  per_tx_usdc?: number | null;
  daily_usdc?: number | null;
  allowed_chains?: string[] | null;
}

export interface SpendEntry {
  amount_usdc: number;
  chain: string;
  destination: string;
  timestamp: number;
}

interface WalletFile {
  agentos_version: number;
  id: string;
  name: string;
  accounts: AccountInfo[];
  owner_crypto: EncryptedBlob;
  key_type: "mnemonic" | "private_key";
  policy?: WalletPolicy;
  created_at: string;
}

interface ApiKeyFile {
  id: string;
  name: string;
  token_hash: string;
  wallet_ids: string[];
  policy_ids: string[];
  encrypted_mnemonics: Record<string, EncryptedBlob>;
  expires_at: string | null;
  created_at: string;
}

function loadWalletFile(nameOrId: string): { path: string; data: WalletFile } {
  ensureVault();
  const dir = join(VAULT_PATH, "wallets");
  for (const f of readdirSync(dir).filter(x => x.endsWith(".json"))) {
    const fpath = join(dir, f);
    const data = JSON.parse(readFileSync(fpath, "utf8")) as WalletFile;
    if (data.id === nameOrId || data.name === nameOrId) {
      if (data.agentos_version !== VAULT_VERSION) {
        throw new Error(
          `Wallet "${nameOrId}" is in vault format v${data.agentos_version}, but the current code requires v${VAULT_VERSION}. Re-create the wallet.`,
        );
      }
      return { path: fpath, data };
    }
  }
  throw new Error(`Wallet "${nameOrId}" not found`);
}

function loadApiKeyFileById(id: string): { path: string; data: ApiKeyFile } | null {
  ensureVault();
  const dir = join(VAULT_PATH, "keys");
  for (const f of readdirSync(dir).filter(x => x.endsWith(".json"))) {
    const fpath = join(dir, f);
    const data = JSON.parse(readFileSync(fpath, "utf8")) as ApiKeyFile;
    if (data.id === id) return { path: fpath, data };
  }
  return null;
}

function loadApiKeyFileByToken(token: string): { path: string; data: ApiKeyFile } | null {
  if (!token || !token.startsWith("agos_key_")) return null;
  ensureVault();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const dir = join(VAULT_PATH, "keys");
  for (const f of readdirSync(dir).filter(x => x.endsWith(".json"))) {
    const fpath = join(dir, f);
    const data = JSON.parse(readFileSync(fpath, "utf8")) as ApiKeyFile;
    if (data.token_hash === tokenHash) return { path: fpath, data };
  }
  return null;
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

// ─── Wallet CRUD ───

/**
 * Create a new wallet. The owner passphrase is required and never stored.
 */
export function createWallet(name: string, passphrase: string, words: number = 12): WalletInfo {
  if (!passphrase) throw new Error("Owner passphrase is required");
  ensureVault();
  const mnemonic = generateMnemonic(words);
  const id = randomBytes(16).toString("hex");
  const accounts = deriveAllAccounts(mnemonic);

  const file: WalletFile = {
    agentos_version: VAULT_VERSION,
    id,
    name,
    accounts,
    owner_crypto: encryptWithPassphrase(mnemonic, passphrase),
    key_type: "mnemonic",
    created_at: new Date().toISOString(),
  };

  writeFileSync(join(VAULT_PATH, "wallets", `${id}.json`), JSON.stringify(file, null, 2));
  return { id, name, accounts, createdAt: file.created_at };
}

export function importWalletMnemonic(name: string, mnemonic: string, passphrase: string): WalletInfo {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic");
  if (!passphrase) throw new Error("Owner passphrase is required");
  ensureVault();
  const id = randomBytes(16).toString("hex");
  const accounts = deriveAllAccounts(mnemonic);

  const file: WalletFile = {
    agentos_version: VAULT_VERSION,
    id,
    name,
    accounts,
    owner_crypto: encryptWithPassphrase(mnemonic, passphrase),
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
  const { path, data } = loadWalletFile(nameOrId);
  unlinkSync(path);
  // Also clean up any API keys that referenced this wallet
  ensureVault();
  const keysDir = join(VAULT_PATH, "keys");
  for (const f of readdirSync(keysDir).filter(x => x.endsWith(".json"))) {
    const fpath = join(keysDir, f);
    const key = JSON.parse(readFileSync(fpath, "utf8")) as ApiKeyFile;
    if (key.wallet_ids.includes(data.id)) {
      key.wallet_ids = key.wallet_ids.filter(id => id !== data.id);
      delete key.encrypted_mnemonics[data.id];
      if (key.wallet_ids.length === 0) {
        unlinkSync(fpath);
      } else {
        writeFileSync(fpath, JSON.stringify(key, null, 2));
      }
    }
  }
}

/**
 * Export the mnemonic for owner backup. Requires the owner passphrase.
 */
export function exportWallet(nameOrId: string, passphrase: string): string {
  const { data } = loadWalletFile(nameOrId);
  return decryptWithPassphrase(data.owner_crypto, passphrase);
}

export function renameWallet(nameOrId: string, newName: string): void {
  const { path, data } = loadWalletFile(nameOrId);
  data.name = newName;
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ─── Mnemonic resolution ───

/**
 * Resolve the mnemonic for a wallet using either the owner passphrase
 * or an API key token. The server holds neither — both must be provided
 * by the caller for each operation.
 */
function resolveMnemonic(walletId: string, opts: { passphrase?: string; token?: string }): string {
  // Owner mode
  if (opts.passphrase) {
    const { data } = loadWalletFile(walletId);
    return decryptWithPassphrase(data.owner_crypto, opts.passphrase);
  }

  // Agent mode (HKDF via API key)
  if (opts.token) {
    const keyFile = loadApiKeyFileByToken(opts.token);
    if (!keyFile) throw new Error("Invalid API key token");
    if (keyFile.data.expires_at && Date.now() > new Date(keyFile.data.expires_at).getTime()) {
      throw new Error("API key has expired");
    }
    // Resolve wallet ID from name if needed
    const { data: walletData } = loadWalletFile(walletId);
    if (!keyFile.data.wallet_ids.includes(walletData.id)) {
      throw new Error("API key does not have access to this wallet");
    }
    const blob = keyFile.data.encrypted_mnemonics[walletData.id];
    if (!blob) throw new Error("API key has no encrypted secret for this wallet");
    return decryptWithToken(blob, opts.token);
  }

  throw new Error("Either passphrase or API key token is required to sign");
}

// ─── Policy management ───

export function setWalletPolicy(walletId: string, policy: WalletPolicy): void {
  const { path, data } = loadWalletFile(walletId);
  data.policy = policy;
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function getWalletPolicy(walletId: string): WalletPolicy | null {
  const { data } = loadWalletFile(walletId);
  return data.policy || null;
}

// ─── Spend log ───

function spendLogPath(vaultWalletId: string): string {
  return join(VAULT_PATH, "spends", `${vaultWalletId}.json`);
}

function readSpendLog(vaultWalletId: string): SpendEntry[] {
  const fpath = spendLogPath(vaultWalletId);
  if (!existsSync(fpath)) return [];
  try {
    return JSON.parse(readFileSync(fpath, "utf8")) as SpendEntry[];
  } catch {
    return [];
  }
}

function appendSpend(vaultWalletId: string, entry: SpendEntry): void {
  ensureVault();
  const log = readSpendLog(vaultWalletId);
  log.push(entry);
  writeFileSync(spendLogPath(vaultWalletId), JSON.stringify(log, null, 2));
}

export function getSpendLog(walletId: string): SpendEntry[] {
  const { data } = loadWalletFile(walletId);
  return readSpendLog(data.id);
}

export function getDailySpend(walletId: string): number {
  const { data } = loadWalletFile(walletId);
  const entries = readSpendLog(data.id);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return entries.filter(e => e.timestamp >= cutoff).reduce((sum, e) => sum + e.amount_usdc, 0);
}

// ─── Transaction decoders ───

interface DecodedSpend {
  amount_usdc: number;
  destination: string;
  mint: string;
}

/**
 * Decode a Solana VersionedTransaction (or legacy Transaction) and extract
 * USDC SPL TransferChecked details. Returns null if the tx is not a USDC
 * transfer that we can recognize.
 */
function decodeSolanaUsdcTransfer(txHex: string): DecodedSpend | null {
  try {
    const { VersionedTransaction, Transaction } = require("@solana/web3.js");
    const txBytes = Buffer.from(txHex, "hex");

    let message: any;
    let accountKeys: any;
    try {
      const vtx = VersionedTransaction.deserialize(txBytes);
      message = vtx.message;
      accountKeys = message.staticAccountKeys || message.getAccountKeys?.();
    } catch {
      const tx = Transaction.from(txBytes);
      message = tx.compileMessage();
      accountKeys = message.accountKeys;
    }

    const compiled = message.compiledInstructions || message.instructions || [];
    const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const SPL_TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

    for (const ix of compiled) {
      const programIdIdx = ix.programIdIndex;
      const programId = (accountKeys.get ? accountKeys.get(programIdIdx) : accountKeys[programIdIdx])?.toString();
      if (programId !== SPL_TOKEN && programId !== SPL_TOKEN_2022) continue;

      // Get instruction data bytes (versioned uses Uint8Array, legacy uses Buffer)
      const dataBytes: Uint8Array = ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data, "base64");

      // TransferChecked discriminator = 12, data: [12, amount(u64 LE), decimals(u8)]
      if (dataBytes[0] !== 12 || dataBytes.length < 10) continue;

      const amountRaw = Buffer.from(dataBytes.slice(1, 9)).readBigUInt64LE();
      const decimals = dataBytes[9];
      if (decimals !== USDC_DECIMALS) continue;

      // accountKeyIndexes = [source, mint, destination, authority, ...]
      const accIdxs: number[] = ix.accountKeyIndexes || ix.accounts || [];
      if (accIdxs.length < 4) continue;
      const mintKey = (accountKeys.get ? accountKeys.get(accIdxs[1]) : accountKeys[accIdxs[1]])?.toString();
      const destKey = (accountKeys.get ? accountKeys.get(accIdxs[2]) : accountKeys[accIdxs[2]])?.toString();
      if (mintKey !== USDC_SOLANA_MINT) continue;

      return {
        amount_usdc: Number(amountRaw) / 10 ** USDC_DECIMALS,
        destination: destKey,
        mint: mintKey,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode an unsigned EVM transaction (RLP serialized) and extract a USDC ERC-20
 * transfer if it's calling Base USDC. Returns null otherwise.
 *
 * EVM ERC-20 transfer selector: 0xa9059cbb
 * Calldata layout: [4-byte selector] [32-byte address] [32-byte uint256]
 */
function decodeEvmUsdcTransfer(txHex: string): DecodedSpend | null {
  try {
    const { ethers } = require("ethers");
    const tx = ethers.Transaction.from(txHex.startsWith("0x") ? txHex : "0x" + txHex);
    const to = (tx.to || "").toLowerCase();
    if (to !== USDC_BASE_ADDRESS) return null;

    const data = (tx.data || "").toLowerCase();
    if (!data.startsWith("0xa9059cbb") || data.length < 138) return null;

    const destHex = "0x" + data.substring(34, 74);  // 12 bytes pad + 20 bytes addr
    const amountHex = "0x" + data.substring(74, 138);
    const amount = BigInt(amountHex);

    return {
      amount_usdc: Number(amount) / 10 ** USDC_DECIMALS,
      destination: ethers.getAddress(destHex),
      mint: USDC_BASE_ADDRESS,
    };
  } catch {
    return null;
  }
}

function decodeUsdcTransfer(chain: string, txHex: string): DecodedSpend | null {
  const c = chain.toLowerCase();
  if (c === "solana" || c.startsWith("solana:")) return decodeSolanaUsdcTransfer(txHex);
  if (c === "evm" || c === "base" || c === "ethereum" || c.startsWith("eip155:")) return decodeEvmUsdcTransfer(txHex);
  return null;
}

// ─── Policy enforcement ───

function enforcePolicy(walletId: string, chain: string, txHex: string): DecodedSpend | null {
  const { data } = loadWalletFile(walletId);
  const policy = data.policy;
  if (!policy) return null;

  // Chain allowlist
  if (policy.allowed_chains && policy.allowed_chains.length > 0) {
    const c = chain.toLowerCase();
    const allowed = policy.allowed_chains.some(a => {
      const al = a.toLowerCase();
      return c === al || c.startsWith(al + ":") || al.startsWith(c + ":");
    });
    if (!allowed) {
      throw new Error(`Policy denied: chain "${chain}" not in allowed_chains [${policy.allowed_chains.join(", ")}]`);
    }
  }

  // If neither limit set, no need to decode
  if (policy.per_tx_usdc == null && policy.daily_usdc == null) return null;

  // Decode the transaction
  const decoded = decodeUsdcTransfer(chain, txHex);
  if (!decoded) {
    throw new Error(
      `Policy denied: cannot decode transaction. The wallet has spending limits set but the transaction does not match a recognized USDC transfer pattern. Either remove the limits or use a supported transaction shape.`,
    );
  }

  // Per-tx limit
  if (policy.per_tx_usdc != null && decoded.amount_usdc > policy.per_tx_usdc) {
    throw new Error(
      `Policy denied: transaction amount $${decoded.amount_usdc} exceeds per-tx limit $${policy.per_tx_usdc}`,
    );
  }

  // 24h daily limit
  if (policy.daily_usdc != null) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const spentLast24h = readSpendLog(data.id)
      .filter(e => e.timestamp >= cutoff)
      .reduce((sum, e) => sum + e.amount_usdc, 0);
    const newTotal = spentLast24h + decoded.amount_usdc;
    if (newTotal > policy.daily_usdc) {
      throw new Error(
        `Policy denied: this transaction ($${decoded.amount_usdc.toFixed(6)}) would bring 24h spend to $${newTotal.toFixed(6)}, exceeding daily limit of $${policy.daily_usdc}`,
      );
    }
  }

  return decoded;
}

// ─── Signing ───

export function signMessage(
  walletId: string,
  chain: string,
  message: string,
  auth: { passphrase?: string; token?: string },
  encoding: "utf8" | "hex" = "utf8",
): SignResult {
  const mnemonic = resolveMnemonic(walletId, auth);
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

export function signTransaction(
  walletId: string,
  chain: string,
  txHex: string,
  auth: { passphrase?: string; token?: string },
): SignResult {
  // Enforce spending policy BEFORE decryption — fail-closed if decode fails
  // and policy has limits set.
  const decoded = enforcePolicy(walletId, chain, txHex);

  const mnemonic = resolveMnemonic(walletId, auth);
  const c = chain.toLowerCase();

  let result: SignResult;
  if (c === "solana" || c.startsWith("solana:")) {
    const kp = deriveSolanaKeypair(mnemonic);
    const txBytes = Buffer.from(txHex, "hex");
    const { sign } = require("tweetnacl");
    const sig = sign.detached(txBytes, kp.secretKey);
    result = { signature: Buffer.from(sig).toString("hex") };
  } else if (c === "evm" || c === "base" || c === "ethereum" || c.startsWith("eip155:")) {
    const { ethers } = require("ethers");
    const hd = deriveEvmWallet(mnemonic);
    const signingKey = new ethers.SigningKey(hd.privateKey);
    const sig = signingKey.sign(Buffer.from(txHex, "hex"));
    result = { signature: sig.serialized.replace("0x", ""), recoveryId: sig.v };
  } else {
    throw new Error(`Chain "${chain}" not supported for transaction signing`);
  }

  // Record the spend if we successfully decoded one
  if (decoded) {
    const { data } = loadWalletFile(walletId);
    appendSpend(data.id, {
      amount_usdc: decoded.amount_usdc,
      chain,
      destination: decoded.destination,
      timestamp: Date.now(),
    });
  }

  return result;
}

export function signTypedData(
  walletId: string,
  _chain: string,
  typedDataJson: string,
  auth: { passphrase?: string; token?: string },
): SignResult {
  const mnemonic = resolveMnemonic(walletId, auth);
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
 * Get the raw Solana keypair for a wallet — requires owner passphrase.
 * Used by the deposit monitor for sweeps. NOT exposed via the API.
 */
export function getSolanaKeypair(walletId: string, passphrase: string): Keypair {
  const mnemonic = resolveMnemonic(walletId, { passphrase });
  return deriveSolanaKeypair(mnemonic);
}

/**
 * Get the raw EVM private key for a wallet — requires owner passphrase.
 * Used by the deposit monitor for sweeps. NOT exposed via the API.
 */
export function getEvmPrivateKey(walletId: string, passphrase: string): string {
  const mnemonic = resolveMnemonic(walletId, { passphrase });
  return deriveEvmWallet(mnemonic).privateKey;
}

// ─── Policies ───

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

// ─── API keys ───

const API_KEY_PREFIX = "agos_key_";

/**
 * Create a scoped API key. Requires the owner passphrase to encrypt the
 * mnemonic copies for each wallet. The passphrase is used transiently
 * (in this single call) and never stored.
 *
 * Returns the token — show it to the user once. We only store SHA256(token)
 * for lookup and HKDF(token)-encrypted mnemonics.
 */
export function createApiKey(
  name: string,
  walletIds: string[],
  passphrase: string,
  policyIds: string[] = [],
  expiresAt?: string,
): ApiKeyResult {
  if (!passphrase) throw new Error("Owner passphrase is required to create an API key");
  if (walletIds.length === 0) throw new Error("At least one wallet ID is required");

  ensureVault();
  const id = randomBytes(8).toString("hex");
  const token = `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;

  // Decrypt each wallet with the owner passphrase, re-encrypt with HKDF(token)
  const encryptedMnemonics: Record<string, EncryptedBlob> = {};
  for (const wid of walletIds) {
    const { data } = loadWalletFile(wid);
    const mnemonic = decryptWithPassphrase(data.owner_crypto, passphrase);
    encryptedMnemonics[data.id] = encryptWithToken(mnemonic, token);
  }

  const file: ApiKeyFile = {
    id,
    name,
    token_hash: createHash("sha256").update(token).digest("hex"),
    wallet_ids: walletIds.map(wid => loadWalletFile(wid).data.id), // canonicalize to IDs
    policy_ids: policyIds,
    encrypted_mnemonics: encryptedMnemonics,
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
    const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as ApiKeyFile;
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
  const found = loadApiKeyFileById(id);
  if (found) unlinkSync(found.path);
}

/**
 * Validate an API key token. Returns the accessible wallet IDs and policy IDs,
 * or null if invalid/expired/not found.
 */
export function validateApiKey(token: string): ApiKeyValidation | null {
  const found = loadApiKeyFileByToken(token);
  if (!found) return null;

  if (found.data.expires_at && Date.now() > new Date(found.data.expires_at).getTime()) {
    return null;
  }

  return {
    id: found.data.id,
    name: found.data.name,
    walletIds: found.data.wallet_ids,
    policyIds: found.data.policy_ids,
  };
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
