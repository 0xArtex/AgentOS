/**
 * AgentOS Wallet Vault — non-custodial HD wallet management.
 *
 * Two modes:
 *   1. Unmanaged — agent has full control, no limits, session secret in OS cred store
 *   2. Managed — policy engine enforces spending limits, human approves via passkey
 *
 * Decryption requires either:
 *   - A session secret (stored in OS credential store, never on disk)
 *   - An agent API key (HKDF-derived key)
 *
 * Vault layout (default `~/.agentos/wallet/`):
 *   wallets/   — encrypted wallet files
 *   keys/      — agent API keys (HKDF-encrypted mnemonic copies)
 *   policies/  — declarative policy rules
 *   spends/    — spend log entries
 */
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
} from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, openSync, closeSync, statSync } from "fs";
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
  mode: "unmanaged" | "managed";
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
const HKDF_INFO = "agentos-api-key-v1";

function ensureVault(): string {
  if (!existsSync(VAULT_PATH)) mkdirSync(VAULT_PATH, { recursive: true });
  for (const sub of ["wallets", "keys", "policies", "spends"]) {
    const p = join(VAULT_PATH, sub);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
  return VAULT_PATH;
}

// ─── Atomic writes & file locks ───
// Prevents data corruption from concurrent CLI/server processes.

const LOCK_STALE_MS = 30_000; // locks older than 30s are considered stale
const LOCK_RETRY_MS = 50;     // retry interval
const LOCK_TIMEOUT_MS = 5_000; // give up after 5s

/**
 * Write a file atomically: write to a temp sibling, then rename.
 * Rename is atomic on the same filesystem — readers never see partial data.
 */
function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + `.tmp.${process.pid}`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
}

/**
 * Acquire an exclusive lock on a file path. Returns a release function.
 * Uses O_CREAT|O_EXCL (the 'wx' flag) which atomically creates a file
 * only if it doesn't exist — the standard cross-platform lockfile pattern.
 * Stale locks (>30s) are automatically broken.
 */
function acquireLock(targetPath: string): () => void {
  const lockPath = targetPath + ".lock";
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      // Write our PID so stale detection can log who held it
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);
      closeSync(fd);
      return () => {
        try { unlinkSync(lockPath); } catch {}
      };
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      // Lock file exists — check if stale
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch {}
          continue; // retry immediately after breaking stale lock
        }
      } catch {
        continue; // lock file vanished between check and stat
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock on ${targetPath}. Another process may be stuck.`);
      }

      // Busy-wait with small sleep (sync context — no async available)
      const waitUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
}

/**
 * Run a function while holding an exclusive lock on a file.
 * The lock is always released, even if fn throws.
 */
function withLock<T>(targetPath: string, fn: () => T): T {
  const release = acquireLock(targetPath);
  try {
    return fn();
  } finally {
    release();
  }
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

// Session secret: raw 32-byte hex key → AES-256-GCM
function encryptWithSessionSecret(plaintext: string, sessionSecretHex: string): EncryptedBlob {
  const key = Buffer.from(sessionSecretHex, "hex");
  const salt = randomBytes(32);
  return encryptWithKey(plaintext, key, salt);
}

function decryptWithSessionSecret(blob: EncryptedBlob, sessionSecretHex: string): string {
  const key = Buffer.from(sessionSecretHex, "hex");
  return decryptWithKey(blob, key);
}

// HKDF(token) for API keys
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

  // EVM / Base (secp256k1, BIP-44)
  try {
    const { HDNodeWallet } = require("ethers");
    const hd = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0");
    accounts.push({
      chainId: "eip155:1",
      address: hd.address,
      derivationPath: "m/44'/60'/0'/0/0",
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
  id: string;
  name: string;
  mode: "unmanaged" | "managed";
  accounts: AccountInfo[];
  session_crypto: EncryptedBlob;
  key_type: "mnemonic";
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

// ─── Input validation ───

const SAFE_NAME_RE = /^[a-zA-Z0-9 _\-\.]{1,128}$/;

function validateName(name: string): string {
  if (!name || typeof name !== "string") throw new Error("Wallet name is required");
  const trimmed = name.trim();
  if (!SAFE_NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid wallet name: must be 1-128 characters, alphanumeric/spaces/hyphens/underscores/dots only. Got: "${trimmed.slice(0, 30)}"`,
    );
  }
  return trimmed;
}

function validateHex(value: string, label: string): void {
  if (!value || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`${label} must be a non-empty hex string`);
  }
}

// ─── Wallet CRUD ───

/**
 * Create a new wallet. Returns the wallet info and the session secret
 * (which the caller must store in the OS credential store).
 */
export function createWallet(
  name: string,
  mode: "unmanaged" | "managed" = "unmanaged",
  words: number = 12,
): { wallet: WalletInfo; sessionSecret: string } {
  const safeName = validateName(name);
  ensureVault();
  const mnemonic = generateMnemonic(words);
  const id = randomBytes(16).toString("hex");
  const accounts = deriveAllAccounts(mnemonic);
  const sessionSecret = randomBytes(32).toString("hex");

  const file: WalletFile = {
    id,
    name: safeName,
    mode,
    accounts,
    session_crypto: encryptWithSessionSecret(mnemonic, sessionSecret),
    key_type: "mnemonic",
    created_at: new Date().toISOString(),
  };

  atomicWriteFileSync(join(VAULT_PATH, "wallets", `${id}.json`), JSON.stringify(file, null, 2));
  return {
    wallet: { id, name: safeName, mode, accounts, createdAt: file.created_at },
    sessionSecret,
  };
}

export function importWalletMnemonic(
  name: string,
  mnemonic: string,
  mode: "unmanaged" | "managed" = "unmanaged",
): { wallet: WalletInfo; sessionSecret: string } {
  const safeName = validateName(name);
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic");
  ensureVault();
  const id = randomBytes(16).toString("hex");
  const accounts = deriveAllAccounts(mnemonic);
  const sessionSecret = randomBytes(32).toString("hex");

  const file: WalletFile = {
    id,
    name: safeName,
    mode,
    accounts,
    session_crypto: encryptWithSessionSecret(mnemonic, sessionSecret),
    key_type: "mnemonic",
    created_at: new Date().toISOString(),
  };

  atomicWriteFileSync(join(VAULT_PATH, "wallets", `${id}.json`), JSON.stringify(file, null, 2));
  return {
    wallet: { id, name: safeName, mode, accounts, createdAt: file.created_at },
    sessionSecret,
  };
}

export function listWallets(): WalletInfo[] {
  ensureVault();
  const dir = join(VAULT_PATH, "wallets");
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const data = JSON.parse(readFileSync(join(dir, f), "utf8")) as WalletFile;
      return { id: data.id, name: data.name, mode: data.mode, accounts: data.accounts, createdAt: data.created_at };
    });
}

export function getWallet(nameOrId: string): WalletInfo {
  const { data } = loadWalletFile(nameOrId);
  return { id: data.id, name: data.name, mode: data.mode, accounts: data.accounts, createdAt: data.created_at };
}

export function deleteWallet(nameOrId: string): void {
  const { path, data } = loadWalletFile(nameOrId);
  withLock(path, () => {
    unlinkSync(path);
  });
  // Clean up API keys that referenced this wallet
  ensureVault();
  const keysDir = join(VAULT_PATH, "keys");
  for (const f of readdirSync(keysDir).filter(x => x.endsWith(".json"))) {
    const fpath = join(keysDir, f);
    withLock(fpath, () => {
      // Re-read inside lock to get fresh state
      if (!existsSync(fpath)) return;
      const key = JSON.parse(readFileSync(fpath, "utf8")) as ApiKeyFile;
      if (key.wallet_ids.includes(data.id)) {
        key.wallet_ids = key.wallet_ids.filter(id => id !== data.id);
        delete key.encrypted_mnemonics[data.id];
        if (key.wallet_ids.length === 0) {
          unlinkSync(fpath);
        } else {
          atomicWriteFileSync(fpath, JSON.stringify(key, null, 2));
        }
      }
    });
  }
}

export function renameWallet(nameOrId: string, newName: string): void {
  const safeName = validateName(newName);
  const { path } = loadWalletFile(nameOrId);
  withLock(path, () => {
    const fresh = JSON.parse(readFileSync(path, "utf8")) as WalletFile;
    fresh.name = safeName;
    atomicWriteFileSync(path, JSON.stringify(fresh, null, 2));
  });
}

// ─── File integrity verification ───

/**
 * Verify that the addresses stored in the wallet file match what the mnemonic
 * actually derives. Catches tampering: if an attacker edits the JSON to swap
 * addresses (e.g., to redirect funds), this check catches it at sign time.
 *
 * GCM protects the mnemonic, but the accounts array is plaintext in the file.
 */
function verifyWalletIntegrity(walletId: string, mnemonic: string): void {
  const { data } = loadWalletFile(walletId);
  const derived = deriveAllAccounts(mnemonic);

  // Bidirectional check: file ↔ mnemonic must match exactly.
  // Forward: every stored account must be derivable (catches swaps + injected fake accounts)
  for (const stored of data.accounts) {
    const match = derived.find(d => d.chainId === stored.chainId);
    if (!match) {
      throw new Error(
        `SECURITY: wallet file integrity check failed. ` +
        `Chain ${stored.chainId} present in file but not derivable from mnemonic. ` +
        `The wallet file may have been tampered with. Refusing to sign.`,
      );
    }
    if (match.address !== stored.address) {
      throw new Error(
        `SECURITY: wallet file integrity check failed. ` +
        `Stored address for ${stored.chainId} does not match derived address. ` +
        `Expected ${match.address}, found ${stored.address}. ` +
        `The wallet file may have been tampered with. Refusing to sign.`,
      );
    }
  }

  // Reverse: every derived account must be present in the file (catches deletions)
  for (const der of derived) {
    const match = data.accounts.find(s => s.chainId === der.chainId);
    if (!match) {
      throw new Error(
        `SECURITY: wallet file integrity check failed. ` +
        `Chain ${der.chainId} derivable from mnemonic but missing from file. ` +
        `The wallet file may have been tampered with. Refusing to sign.`,
      );
    }
  }
}

// ─── Mnemonic resolution ───

/**
 * Resolve the mnemonic for a wallet using either:
 *   1. A session secret (from OS credential store)
 *   2. An API key token (HKDF-derived)
 *
 * After decryption, verifies wallet file integrity by re-deriving addresses
 * from the mnemonic and comparing against stored values.
 */
function resolveMnemonic(walletId: string, opts: { sessionSecret?: string; token?: string }): string {
  let mnemonic: string;

  // Session secret path
  if (opts.sessionSecret) {
    const { data } = loadWalletFile(walletId);
    mnemonic = decryptWithSessionSecret(data.session_crypto, opts.sessionSecret);
  }
  // API key path (HKDF)
  else if (opts.token) {
    const keyFile = loadApiKeyFileByToken(opts.token);
    if (!keyFile) throw new Error("Invalid API key token");
    if (keyFile.data.expires_at && Date.now() > new Date(keyFile.data.expires_at).getTime()) {
      throw new Error("API key has expired");
    }
    const { data: walletData } = loadWalletFile(walletId);
    if (!keyFile.data.wallet_ids.includes(walletData.id)) {
      throw new Error("API key does not have access to this wallet");
    }
    const blob = keyFile.data.encrypted_mnemonics[walletData.id];
    if (!blob) throw new Error("API key has no encrypted secret for this wallet");
    mnemonic = decryptWithToken(blob, opts.token);
  } else {
    throw new Error("Either session secret or API key token is required to sign");
  }

  // Verify file integrity — re-derive addresses from the mnemonic and compare
  verifyWalletIntegrity(walletId, mnemonic);

  return mnemonic;
}

// ─── Policy management ───

export function setWalletPolicy(walletId: string, policy: WalletPolicy): void {
  const { path } = loadWalletFile(walletId);
  withLock(path, () => {
    const fresh = JSON.parse(readFileSync(path, "utf8")) as WalletFile;
    fresh.policy = policy;
    atomicWriteFileSync(path, JSON.stringify(fresh, null, 2));
  });
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
  const fpath = spendLogPath(vaultWalletId);
  withLock(fpath, () => {
    const log = readSpendLog(vaultWalletId);
    log.push(entry);
    atomicWriteFileSync(fpath, JSON.stringify(log, null, 2));
  });
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

      const dataBytes: Uint8Array = ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data, "base64");
      if (dataBytes[0] !== 12 || dataBytes.length < 10) continue;

      const amountRaw = Buffer.from(dataBytes.slice(1, 9)).readBigUInt64LE();
      const decimals = dataBytes[9];
      if (decimals !== USDC_DECIMALS) continue;

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

function decodeEvmUsdcTransfer(txHex: string): DecodedSpend | null {
  try {
    const { ethers } = require("ethers");
    const tx = ethers.Transaction.from(txHex.startsWith("0x") ? txHex : "0x" + txHex);
    const to = (tx.to || "").toLowerCase();
    if (to !== USDC_BASE_ADDRESS) return null;

    const data = (tx.data || "").toLowerCase();
    if (!data.startsWith("0xa9059cbb") || data.length < 138) return null;

    const destHex = "0x" + data.substring(34, 74);
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

/**
 * Error thrown when a managed wallet exceeds spending limits.
 * The caller should present an approval link to the human.
 */
export class PolicyApprovalRequired extends Error {
  code = "REQUIRES_APPROVAL" as const;
  decoded: DecodedSpend;
  constructor(msg: string, decoded: DecodedSpend) {
    super(msg);
    this.name = "PolicyApprovalRequired";
    this.decoded = decoded;
  }
}

function enforcePolicy(walletId: string, chain: string, txHex: string): DecodedSpend | null {
  const { data } = loadWalletFile(walletId);
  const policy = data.policy;
  if (!policy) return null;

  // Chain allowlist
  if (policy.allowed_chains && policy.allowed_chains.length > 0) {
    const c = chain.toLowerCase();
    const EVM_ALIASES = ["evm", "base", "ethereum"];
    const normalizeChain = (ch: string) => EVM_ALIASES.includes(ch) ? "evm" : ch.split(":")[0];
    const normalizedC = normalizeChain(c);
    const allowed = policy.allowed_chains.some(a => {
      const al = a.toLowerCase();
      return normalizedC === normalizeChain(al) || c === al || c.startsWith(al + ":") || al.startsWith(c + ":");
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
      `Policy denied: cannot decode transaction. The wallet has spending limits set but the transaction does not match a recognized USDC transfer pattern.`,
    );
  }

  // Per-tx limit
  if (policy.per_tx_usdc != null && decoded.amount_usdc > policy.per_tx_usdc) {
    if (data.mode === "managed") {
      throw new PolicyApprovalRequired(
        `Transaction amount $${decoded.amount_usdc} exceeds per-tx limit $${policy.per_tx_usdc}. Human approval required.`,
        decoded,
      );
    }
    throw new Error(`Policy denied: transaction amount $${decoded.amount_usdc} exceeds per-tx limit $${policy.per_tx_usdc}`);
  }

  // 24h daily limit
  if (policy.daily_usdc != null) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const spentLast24h = readSpendLog(data.id)
      .filter(e => e.timestamp >= cutoff)
      .reduce((sum, e) => sum + e.amount_usdc, 0);
    const newTotal = spentLast24h + decoded.amount_usdc;
    if (newTotal > policy.daily_usdc) {
      if (data.mode === "managed") {
        throw new PolicyApprovalRequired(
          `This transaction ($${decoded.amount_usdc.toFixed(6)}) would bring 24h spend to $${newTotal.toFixed(6)}, exceeding daily limit of $${policy.daily_usdc}. Human approval required.`,
          decoded,
        );
      }
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
  auth: { sessionSecret?: string; token?: string },
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
  auth: { sessionSecret?: string; token?: string },
): SignResult {
  // Enforce spending policy BEFORE decryption
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

  // Record the spend
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
  auth: { sessionSecret?: string; token?: string },
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
 * Get raw Solana keypair — requires session secret.
 * Used by deposit monitor for sweeps.
 */
export function getSolanaKeypair(walletId: string, sessionSecret: string): Keypair {
  const mnemonic = resolveMnemonic(walletId, { sessionSecret });
  return deriveSolanaKeypair(mnemonic);
}

/**
 * Get raw EVM private key — requires session secret.
 * Used by deposit monitor for sweeps.
 */
export function getEvmPrivateKey(walletId: string, sessionSecret: string): string {
  const mnemonic = resolveMnemonic(walletId, { sessionSecret });
  return deriveEvmWallet(mnemonic).privateKey;
}

// ─── API keys ───

const API_KEY_PREFIX = "agos_key_";

/**
 * Create a scoped API key. Requires a session secret to decrypt the mnemonic,
 * then re-encrypts with HKDF(token).
 */
export function createApiKey(
  name: string,
  walletIds: string[],
  sessionSecret: string,
  policyIds: string[] = [],
  expiresAt?: string,
): ApiKeyResult {
  const safeName = validateName(name);
  validateHex(sessionSecret, "sessionSecret");
  if (walletIds.length === 0) throw new Error("At least one wallet ID is required");
  for (const wid of walletIds) validateHex(wid, "walletId");

  ensureVault();
  const id = randomBytes(8).toString("hex");
  const token = `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;

  // Decrypt each wallet with session secret, re-encrypt with HKDF(token)
  const encryptedMnemonics: Record<string, EncryptedBlob> = {};
  for (const wid of walletIds) {
    const { data } = loadWalletFile(wid);
    const mnemonic = decryptWithSessionSecret(data.session_crypto, sessionSecret);
    encryptedMnemonics[data.id] = encryptWithToken(mnemonic, token);
  }

  const file: ApiKeyFile = {
    id,
    name: safeName,
    token_hash: createHash("sha256").update(token).digest("hex"),
    wallet_ids: walletIds.map(wid => loadWalletFile(wid).data.id),
    policy_ids: policyIds,
    encrypted_mnemonics: encryptedMnemonics,
    expires_at: expiresAt || null,
    created_at: new Date().toISOString(),
  };

  atomicWriteFileSync(join(VAULT_PATH, "keys", `${id}.json`), JSON.stringify(file, null, 2));
  return { token, id, name: safeName };
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
