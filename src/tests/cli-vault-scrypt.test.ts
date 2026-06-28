/**
 * Unit tests for the CLI passphrase-blob KDF hardening (cli/vault.ts +
 * cli/credential-store.ts).
 *
 * The crypto is replicated here rather than imported, because the CLI modules
 * are ESM and the server test runner is CommonJS (same approach as
 * credential-store.test.ts). What matters is the WIRE FORMAT and the
 * backward-compatibility rule, both of which are reproduced exactly:
 *
 *   - New passphrase blobs raise the scrypt cost to N=2^17 (matching the
 *     trading keystore, wallet-trading-keystore.ts) and record the params in a
 *     per-blob `kdf` field.
 *   - Blobs WITHOUT a `kdf` field (written before the bump) must still decrypt,
 *     using the old Node default N=16384 — no recoverable wallet gets bricked.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";

interface ScryptParams { N: number; r: number; p: number; keyLen: number }
interface Blob { iv: string; salt: string; ciphertext: string; tag: string; kdf?: ScryptParams }

// Matches the trading keystore (SCRYPT_N = 131_072) — the alignment target.
const NEW = { N: 131_072, r: 8, p: 1, keyLen: 32 } as const;
const LEGACY_N = 16_384; // Node's scryptSync default — pre-1.13.9 blobs
const MAXMEM = 256 * 1024 * 1024;

// Exact mirror of cli/vault.ts `deriveScryptKey` /
// cli/credential-store.ts `deriveSealKey`: honor the blob's stored params, else
// fall back to the legacy default.
function deriveKey(passphrase: string, salt: Buffer, kdf?: ScryptParams): Buffer {
  const N = kdf?.N ?? LEGACY_N;
  const r = kdf?.r ?? 8;
  const p = kdf?.p ?? 1;
  const keyLen = kdf?.keyLen ?? 32;
  return scryptSync(passphrase, salt, keyLen, { N, r, p, maxmem: MAXMEM });
}

// New-format encrypt: records `kdf`.
function encryptNew(plaintext: string, passphrase: string): Blob {
  const iv = randomBytes(12);
  const salt = randomBytes(32);
  const kdf: ScryptParams = { ...NEW };
  const key = deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let ct = cipher.update(plaintext, "utf8", "hex");
  ct += cipher.final("hex");
  return { iv: iv.toString("hex"), salt: salt.toString("hex"), ciphertext: ct, tag: cipher.getAuthTag().toString("hex"), kdf };
}

// Legacy-format encrypt: NO `kdf` field, default N (simulates an old vault).
function encryptLegacy(plaintext: string, passphrase: string): Blob {
  const iv = randomBytes(12);
  const salt = randomBytes(32);
  const key = scryptSync(passphrase, salt, 32); // old code path: Node default N=16384
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let ct = cipher.update(plaintext, "utf8", "hex");
  ct += cipher.final("hex");
  return { iv: iv.toString("hex"), salt: salt.toString("hex"), ciphertext: ct, tag: cipher.getAuthTag().toString("hex") };
}

// Single decrypt path (mirrors the CLI): always keyed off the blob's params.
function decrypt(blob: Blob, passphrase: string): string {
  const key = deriveKey(passphrase, Buffer.from(blob.salt, "hex"), blob.kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  let pt = decipher.update(blob.ciphertext, "hex", "utf8");
  pt += decipher.final("utf8");
  return pt;
}

describe("CLI passphrase-blob KDF hardening", () => {
  const SECRET = "correct horse battery staple mnemonic words here twelve total now";
  const PASS = "a-strong-passphrase";

  it("uses the keystore-grade scrypt cost (N=2^17) for new blobs", () => {
    const blob = encryptNew(SECRET, PASS);
    assert.equal(blob.kdf?.N, 131_072, "new blobs must align with the trading keystore N");
    assert.equal(blob.kdf?.r, 8);
    assert.equal(blob.kdf?.keyLen, 32);
  });

  it("round-trips a new (hardened) blob", () => {
    const blob = encryptNew(SECRET, PASS);
    assert.equal(decrypt(blob, PASS), SECRET);
  });

  it("still decrypts a LEGACY blob with no kdf field (no brick)", () => {
    const legacy = encryptLegacy(SECRET, PASS);
    assert.equal(legacy.kdf, undefined, "legacy blob must not carry kdf params");
    assert.equal(decrypt(legacy, PASS), SECRET, "legacy blob must open via the default-N fallback");
  });

  it("rejects the wrong passphrase on both formats", () => {
    const fresh = encryptNew(SECRET, PASS);
    const legacy = encryptLegacy(SECRET, PASS);
    assert.throws(() => decrypt(fresh, "wrong"), /Unsupported state|Invalid tag|unable to authenticate/i);
    assert.throws(() => decrypt(legacy, "wrong"), /Unsupported state|Invalid tag|unable to authenticate/i);
  });

  it("a hardened blob fails if the stored params are ignored (params are load-bearing)", () => {
    const blob = encryptNew(SECRET, PASS);
    // Decrypt while pretending there were no kdf params → wrong N → wrong key.
    const stripped: Blob = { ...blob, kdf: undefined };
    assert.throws(() => decrypt(stripped, PASS), /Unsupported state|Invalid tag|unable to authenticate/i);
  });
});
