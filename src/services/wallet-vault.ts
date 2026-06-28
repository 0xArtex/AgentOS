/**
 * Palmyr Wallet Vault — non-custodial HD wallet management.
 *
 * Two modes:
 *   1. Unmanaged — agent has full control, no limits, session secret in OS cred store
 *   2. Managed — policy engine enforces spending limits, human approves via passkey
 *
 * Decryption requires either:
 *   - A session secret (stored in OS credential store, never on disk)
 *   - An agent API key (HKDF-derived key)
 *
 * Vault layout (default `~/.palmyr/wallet/`):
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

const DEFAULT_VAULT_PATH = join(homedir(), ".palmyr", "wallet");
const VAULT_PATH = process.env.PALMYR_WALLET_PATH || DEFAULT_VAULT_PATH;
const HKDF_INFO = "palmyr-api-key-v1";

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

// ─── Solana program ids (used for spending limit decoding) ───

const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Programs that legitimately appear in a USDC-transfer transaction but cannot
// themselves move USDC (compute budget, memo, ATA creation, system). When a
// wallet has spending limits, every other top-level program is treated as an
// opaque value mover and the transaction is denied.
const SOLANA_BENIGN_PROGRAMS = new Set([
  "11111111111111111111111111111111",            // System
  "ComputeBudget111111111111111111111111111111", // ComputeBudget
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",  // Memo (v2)
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",  // Memo (v1)
]);

// EIP-712 primary types that authorize a USDC spend (and so must be metered).
const EVM_SPEND_AUTH_TYPES = new Set([
  "Permit",                   // ERC-2612 allowance
  "TransferWithAuthorization", // EIP-3009 (x402 Base payment)
  "ReceiveWithAuthorization",  // EIP-3009
]);

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

/**
 * Result of inspecting a payload against the spend decoders:
 *   - "spend": a fully metered USDC spend (amount is the TOTAL across the tx)
 *   - "none":  not a recognized USDC spend — undecodable
 *   - "deny":  contains an instruction that could move value but cannot be
 *              metered (e.g. a second SPL token transfer, an opaque program).
 *              Must be refused outright when limits are set.
 */
type SpendDecode =
  | { status: "spend"; spend: DecodedSpend }
  | { status: "none" }
  | { status: "deny"; reason: string };

/**
 * Deserialize a Solana payload into a message we can walk. Accepts a full
 * (possibly partially-signed) transaction or a bare compiled message — the
 * latter is exactly the byte string an attacker would smuggle through
 * `signMessage`. Returns null if the bytes are not a Solana transaction/message.
 */
function deserializeSolanaMessage(bytes: Uint8Array): { message: any; accountKeys: any } | null {
  const web3 = require("@solana/web3.js");
  const buf = Buffer.from(bytes);
  const attempts: Array<() => { message: any; accountKeys: any }> = [
    () => {
      const vtx = web3.VersionedTransaction.deserialize(buf);
      return { message: vtx.message, accountKeys: vtx.message.staticAccountKeys || vtx.message.getAccountKeys?.() };
    },
    () => {
      const tx = web3.Transaction.from(buf);
      const message = tx.compileMessage();
      return { message, accountKeys: message.accountKeys };
    },
    () => {
      const message = web3.VersionedMessage.deserialize(buf);
      return { message, accountKeys: message.staticAccountKeys || message.getAccountKeys?.() };
    },
    () => {
      const message = web3.Message.from(buf);
      return { message, accountKeys: message.accountKeys };
    },
  ];
  for (const attempt of attempts) {
    try {
      const out = attempt();
      const compiled = out.message?.compiledInstructions || out.message?.instructions || [];
      if (compiled.length > 0) return out;
    } catch { /* try next shape */ }
  }
  return null;
}

/**
 * Scan a Solana transaction for USDC spends.
 *
 * Sums the amounts of ALL recognized USDC `TransferChecked` instructions (a
 * single decode that returned on the first match would let a $1 first transfer
 * mask a $50,000 second one). Any token-program instruction that is not a
 * recognized USDC transfer, and any non-benign program, is treated as an
 * un-meterable value mover → "deny".
 */
function scanSolanaSpend(txHex: string): SpendDecode {
  let parsed: { message: any; accountKeys: any } | null;
  try {
    parsed = deserializeSolanaMessage(Buffer.from(txHex, "hex"));
  } catch {
    parsed = null;
  }
  if (!parsed) return { status: "none" };

  const { message, accountKeys } = parsed;
  const keyAt = (i: number): string | undefined =>
    (accountKeys?.get ? accountKeys.get(i) : accountKeys?.[i])?.toString();

  const compiled = message.compiledInstructions || message.instructions || [];
  const transfers: DecodedSpend[] = [];

  for (const ix of compiled) {
    const programId = keyAt(ix.programIdIndex);

    // Scaffolding that cannot move USDC — ignore.
    if (programId && SOLANA_BENIGN_PROGRAMS.has(programId)) continue;

    // Any non-token program at the top level could move value via CPI; we can't
    // bound it, so under spending limits it must be denied.
    if (programId !== SPL_TOKEN && programId !== SPL_TOKEN_2022) {
      return {
        status: "deny",
        reason: `transaction invokes program ${programId ?? "<unknown>"} which could move funds but cannot be metered`,
      };
    }

    const dataBytes: Uint8Array = ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data, "base64");
    const accIdxs: number[] = ix.accountKeyIndexes || ix.accounts || [];

    // The ONLY token-program instruction we can bound is a USDC TransferChecked
    // (opcode 12): its accounts carry the mint (must be USDC) and the data carry
    // the checked decimals. Everything else — plain Transfer (3), Approve (4),
    // ApproveChecked (13), TransferChecked of another mint, SetAuthority, … —
    // moves or authorizes value we cannot price in USDC → deny.
    const isUsdcTransferChecked =
      dataBytes[0] === 12 &&
      dataBytes.length >= 10 &&
      dataBytes[9] === USDC_DECIMALS &&
      accIdxs.length >= 4 &&
      keyAt(accIdxs[1]) === USDC_SOLANA_MINT;

    if (!isUsdcTransferChecked) {
      return {
        status: "deny",
        reason: `transaction contains an SPL token instruction (opcode ${dataBytes[0]}) that cannot be metered against USDC limits`,
      };
    }

    const amountRaw = Buffer.from(dataBytes.slice(1, 9)).readBigUInt64LE();
    transfers.push({
      amount_usdc: Number(amountRaw) / 10 ** USDC_DECIMALS,
      destination: keyAt(accIdxs[2]) ?? "",
      mint: USDC_SOLANA_MINT,
    });
  }

  if (transfers.length === 0) return { status: "none" };

  const total = transfers.reduce((sum, t) => sum + t.amount_usdc, 0);
  return {
    status: "spend",
    spend: { amount_usdc: total, destination: transfers[0].destination, mint: USDC_SOLANA_MINT },
  };
}

/**
 * True if the raw bytes parse as a Solana transaction or compiled message with
 * at least one instruction. Used to stop managed wallets from smuggling a
 * transaction through `signMessage` (where no policy would run).
 */
function looksLikeSolanaTransaction(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 32) return false; // too short to be a real tx/message
  try {
    return deserializeSolanaMessage(bytes) !== null;
  } catch {
    return false;
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

function decodeSpend(chain: string, txHex: string): SpendDecode {
  const c = chain.toLowerCase();
  if (c === "solana" || c.startsWith("solana:")) return scanSolanaSpend(txHex);
  if (c === "evm" || c === "base" || c === "ethereum" || c.startsWith("eip155:")) {
    // An EVM transaction carries a single call — there is no multi-instruction
    // summation to do. Either it decodes to a USDC transfer or it doesn't.
    const decoded = decodeEvmUsdcTransfer(txHex);
    return decoded ? { status: "spend", spend: decoded } : { status: "none" };
  }
  return { status: "none" };
}

/**
 * Decode an EIP-712 typed-data payload into the USDC spend it authorizes.
 *
 * A `permit` / `transferWithAuthorization` is a spend authorization every bit as
 * powerful as a transfer — it must be metered, or refused, like one. Only USDC
 * (the policy's unit of account) authorizations are decodable; anything else
 * returns null and is handled by the caller. An unlimited allowance (value =
 * MaxUint256) decodes to an astronomically large amount that exceeds any finite
 * limit, so it is caught by the normal per-tx check.
 */
function decodeEvmTypedDataSpend(typed: any): DecodedSpend | null {
  try {
    const domain = typed?.domain || {};
    const message = typed?.message || {};
    const verifying = String(domain.verifyingContract || "").toLowerCase();
    if (verifying !== USDC_BASE_ADDRESS) return null; // only meter USDC spend authorizations

    const types = typed?.types || {};
    const primary: string | undefined =
      typed?.primaryType || Object.keys(types).find((k) => k !== "EIP712Domain");
    if (!primary || !EVM_SPEND_AUTH_TYPES.has(primary)) return null;

    const rawVal = message.value ?? message.allowance ?? message.amount;
    if (rawVal === undefined || rawVal === null) return null;
    const amount = BigInt(rawVal);

    return {
      amount_usdc: Number(amount) / 10 ** USDC_DECIMALS,
      destination: String(message.to || message.spender || ""),
      mint: USDC_BASE_ADDRESS,
    };
  } catch {
    return null;
  }
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

/** Throw if the policy has a chain allowlist that does not admit `chain`. */
function enforceChainAllowlist(policy: WalletPolicy, chain: string): void {
  if (!policy.allowed_chains || policy.allowed_chains.length === 0) return;
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

/**
 * Apply the per-tx and 24h daily USDC limits to a decoded spend. Throws
 * PolicyApprovalRequired for managed wallets (human can approve) and a plain
 * Error for unmanaged wallets. Shared by transaction and typed-data signing so
 * EVERY spend path is metered identically.
 */
function applySpendLimits(data: WalletFile, policy: WalletPolicy, decoded: DecodedSpend): void {
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
}

function enforcePolicy(walletId: string, chain: string, txHex: string): DecodedSpend | null {
  const { data } = loadWalletFile(walletId);
  const policy = data.policy;
  if (!policy) return null;

  enforceChainAllowlist(policy, chain);

  // If neither limit set, no need to decode
  if (policy.per_tx_usdc == null && policy.daily_usdc == null) return null;

  // Decode the transaction — sums ALL recognized USDC transfers and denies any
  // instruction that could move value but cannot be metered.
  const dec = decodeSpend(chain, txHex);
  if (dec.status === "deny") {
    throw new Error(
      `Policy denied: ${dec.reason}. The wallet has spending limits set; refusing to sign.`,
    );
  }
  if (dec.status === "none") {
    throw new Error(
      `Policy denied: cannot decode transaction. The wallet has spending limits set but the transaction does not match a recognized USDC transfer pattern.`,
    );
  }

  applySpendLimits(data, policy, dec.spend);
  return dec.spend;
}

/**
 * Enforce policy on an EIP-712 typed-data signature. An allowance `permit` or an
 * EIP-3009 `transferWithAuthorization` authorizes a USDC spend, so it is metered
 * exactly like a transaction. Managed wallets may ONLY sign typed data that
 * decodes to a bounded USDC spend authorization when limits are set — anything
 * else (an opaque order, a non-USDC permit, an unlimited approval on a contract
 * we can't price) is refused. Returns the decoded spend to record, or null when
 * there is nothing to meter.
 */
function enforceTypedDataPolicy(data: WalletFile, chain: string, typedDataJson: string): DecodedSpend | null {
  const policy = data.policy;
  if (!policy) return null;

  enforceChainAllowlist(policy, chain);

  const hasAmountLimits = policy.per_tx_usdc != null || policy.daily_usdc != null;
  if (!hasAmountLimits) return null;

  let typed: any = null;
  try { typed = JSON.parse(typedDataJson); } catch { /* handled below */ }
  const decoded = typed ? decodeEvmTypedDataSpend(typed) : null;

  if (decoded) {
    applySpendLimits(data, policy, decoded);
    return decoded;
  }

  // Not a bounded USDC spend authorization. For managed wallets this is a
  // refusal: a typed-data signature can authorize an unbounded spend (an
  // unlimited approval, an off-chain order) that would never hit the limits.
  if (data.mode === "managed") {
    throw new Error(
      `Policy denied: managed wallets with spending limits may only sign EIP-712 payloads that decode to a bounded USDC spend authorization (permit / transferWithAuthorization). Refusing to sign this payload.`,
    );
  }
  return null;
}

// ─── Signing ───

export function signMessage(
  walletId: string,
  chain: string,
  message: string,
  auth: { sessionSecret?: string; token?: string },
  encoding: "utf8" | "hex" = "utf8",
): SignResult {
  const { data } = loadWalletFile(walletId);
  const c = chain.toLowerCase();
  const msgBytes = encoding === "hex" ? Buffer.from(message, "hex") : Buffer.from(message, "utf8");

  // Managed wallets are policy-gated. Raw Solana message signing produces a bare
  // Ed25519 signature over the given bytes — identical to a transaction
  // signature — so a serialized transaction (or its compiled message) submitted
  // here would be signed with ZERO limit enforcement and could then be
  // broadcast. Refuse any payload that parses as a Solana transaction. (EVM
  // `signMessage` is EIP-191 prefixed and can never yield a valid tx or permit
  // signature, so it needs no such guard.)
  const isSolana = c === "solana" || c.startsWith("solana:");
  if (data.mode === "managed" && isSolana && looksLikeSolanaTransaction(msgBytes)) {
    throw new Error(
      `Policy denied: managed wallets cannot sign a raw payload that decodes to a Solana transaction. ` +
      `Submit it through the transaction signing path so spending limits are enforced.`,
    );
  }

  const mnemonic = resolveMnemonic(walletId, auth);

  if (c === "solana" || c.startsWith("solana:")) {
    const kp = deriveSolanaKeypair(mnemonic);
    const { sign } = require("tweetnacl");
    const sig = sign.detached(msgBytes, kp.secretKey);
    return { signature: Buffer.from(sig).toString("hex") };
  }

  if (c === "evm" || c === "base" || c === "ethereum" || c.startsWith("eip155:")) {
    const hd = deriveEvmWallet(mnemonic);
    // Sign the decoded bytes (honoring `encoding`), not the raw string —
    // otherwise an encoding:"hex" request signs the literal hex text and the
    // signature won't verify against the intended payload (Solana already does this).
    const sig = hd.signMessageSync(msgBytes);
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
  chain: string,
  typedDataJson: string,
  auth: { sessionSecret?: string; token?: string },
): SignResult {
  const { data } = loadWalletFile(walletId);
  // EIP-712 is EVM-only. Fail loudly instead of silently returning an EVM
  // signature for a chain:"solana" request the caller asked to sign elsewhere.
  const c = chain.toLowerCase();
  if (!(c === "evm" || c === "base" || c === "ethereum" || c.startsWith("eip155:"))) {
    throw new Error("signTypedData (EIP-712) is only supported on EVM chains");
  }

  // Enforce spending policy BEFORE decryption. A permit / transferWithAuthorization
  // is a spend authorization and is metered exactly like a transaction.
  const decoded = enforceTypedDataPolicy(data, chain, typedDataJson);

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

  // Record the authorized spend so it counts toward the daily limit.
  if (decoded) {
    appendSpend(data.id, {
      amount_usdc: decoded.amount_usdc,
      chain,
      destination: decoded.destination,
      timestamp: Date.now(),
    });
  }

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
