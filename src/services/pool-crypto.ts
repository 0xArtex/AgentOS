/**
 * Shared AES-256-GCM encryption for pooled-account secrets.
 *
 * Used by both the twitter credential pool (social-pool.ts) and the TikTok
 * account registry (tiktok-accounts.ts) so there is ONE key and ONE blob
 * format — the same `POOL_ENCRYPTION_KEY` (64-char hex / 32 bytes) already set
 * on prod for the X pool. Extracted verbatim from social-pool.ts; the blob
 * format is unchanged, so rows encrypted before the extraction still decrypt.
 */
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

interface EncryptedBlob {
  iv: string;
  ciphertext: string;
  tag: string;
}

export function getPoolKey(): Buffer {
  const hex = process.env.POOL_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "POOL_ENCRYPTION_KEY must be set to a 64-char hex string (32 bytes). " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getPoolKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: EncryptedBlob = {
    iv: iv.toString("hex"),
    ciphertext: ct.toString("hex"),
    tag: tag.toString("hex"),
  };
  return JSON.stringify(blob);
}

export function decrypt(stored: string): string {
  const key = getPoolKey();
  const blob = JSON.parse(stored) as EncryptedBlob;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  let pt = decipher.update(blob.ciphertext, "hex", "utf8");
  pt += decipher.final("utf8");
  return pt;
}
