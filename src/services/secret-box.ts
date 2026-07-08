/**
 * Shared AES-256-GCM secret box for the cards feature.
 *
 * Same master key, same `enc:v1:<iv>.<ct>.<tag>` wire format, and same
 * dev-fallback policy as routes/agent-secrets.ts — deliberately, so prod needs
 * no new key material (SECRETS_MASTER_KEY is already required there) and a
 * future consolidation of the three copy-pasted crypto blocks (agent-secrets,
 * deposit-wallets, social-pool) can converge here without a data migration.
 *
 * Recoverable by design: ciphertext lives in SQLite, the key lives in env —
 * the server can always decrypt while it holds the key, and a stolen DB file
 * alone is useless.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const MASTER_KEY_ENV = "SECRETS_MASTER_KEY";
const ENC_PREFIX = "enc:v1:";

function getMasterKey(): Buffer {
  const hex = process.env[MASTER_KEY_ENV];
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Never silently fall back to a publicly-known all-zero key. The dev key
    // requires the same explicit opt-in agent-secrets uses.
    if (process.env.ALLOW_INSECURE_SECRETS_KEY !== "1") {
      throw new Error(
        `${MASTER_KEY_ENV} must be a 64-char hex string (32 bytes). Set ALLOW_INSECURE_SECRETS_KEY=1 only for local dev.`
      );
    }
    return Buffer.from("00".repeat(32), "hex");
  }
  return Buffer.from(hex, "hex");
}

export function sealSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}.${ct.toString("hex")}.${tag.toString("hex")}`;
}

export function openSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    throw new Error("secret stored under an unknown format");
  }
  const [iv, ct, tag] = stored.slice(ENC_PREFIX.length).split(".");
  const key = getMasterKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let pt = decipher.update(ct, "hex", "utf8");
  pt += decipher.final("utf8");
  return pt;
}
