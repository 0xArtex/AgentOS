/**
 * Wallet passkey service — WebAuthn-based human oversight for managed wallets.
 *
 * Humans register a passkey (FaceID/fingerprint/YubiKey) via a setup link.
 * The passkey is used to:
 *   - Set spending limits during initial setup
 *   - Approve over-limit transactions
 *   - Update wallet policies
 */
import { db } from "../db";
import { randomBytes } from "crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

// ─── Config ───

const RP_NAME = "AgentOS Wallet";
const RP_ID = process.env.WEBAUTHN_RP_ID || "localhost";

/**
 * Allowed origins for WebAuthn responses.
 * - Production: set WEBAUTHN_ORIGIN to your HTTPS origin (e.g. https://agntos.dev)
 * - Localhost (default): accept HTTP on common dev ports + HTTPS — WebAuthn spec
 *   permits HTTP for localhost only, so this is safe.
 */
const ORIGIN: string | string[] = process.env.WEBAUTHN_ORIGIN
  ? process.env.WEBAUTHN_ORIGIN
  : RP_ID === "localhost"
    ? [
        "http://localhost",
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3999",
        "http://localhost:8080",
        "http://127.0.0.1",
        "http://127.0.0.1:3000",
        "https://localhost",
      ]
    : `https://${RP_ID}`;

// ─── DB schema ───

db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_passkeys (
    id TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    transports TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Challenge store (short-lived, in-memory is fine for single-instance)
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

function setChallenge(key: string, challenge: string): void {
  challenges.set(key, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 min
}

function getChallenge(key: string): string | null {
  const entry = challenges.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    challenges.delete(key);
    return null;
  }
  challenges.delete(key);
  return entry.challenge;
}

// ─── Setup token validation ───

export function validateSetupToken(token: string): { walletId: string } | null {
  const row = db.prepare(
    "SELECT wallet_id FROM wallet_setup_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')",
  ).get(token) as any;
  if (!row) return null;
  return { walletId: row.wallet_id };
}

export function markSetupTokenUsed(token: string): void {
  db.prepare("UPDATE wallet_setup_tokens SET used = 1 WHERE token = ?").run(token);
}

// ─── Registration (setup) ───

export async function generateSetupOptions(walletId: string): Promise<any> {
  const existingPasskeys = db.prepare("SELECT credential_id FROM wallet_passkeys WHERE wallet_id = ?").all(walletId) as any[];

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: `wallet-${walletId}`,
    userDisplayName: "Wallet Owner",
    attestationType: "none",
    excludeCredentials: existingPasskeys.map((p: any) => ({
      id: p.credential_id,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  setChallenge(`reg:${walletId}`, options.challenge);
  return options;
}

export async function verifySetup(
  walletId: string,
  response: RegistrationResponseJSON,
): Promise<boolean> {
  const expectedChallenge = getChallenge(`reg:${walletId}`);
  if (!expectedChallenge) throw new Error("Challenge expired or not found");

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey verification failed");
  }

  const { credential } = verification.registrationInfo;
  const id = randomBytes(8).toString("hex");

  db.prepare(
    "INSERT INTO wallet_passkeys (id, wallet_id, credential_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    walletId,
    credential.id,
    Buffer.from(credential.publicKey).toString("base64"),
    credential.counter,
    JSON.stringify(response.response.transports || []),
  );

  return true;
}

// ─── Authentication (approval) ───

export async function generateApprovalOptions(walletId: string): Promise<any> {
  const passkeys = db.prepare("SELECT credential_id, transports FROM wallet_passkeys WHERE wallet_id = ?").all(walletId) as any[];

  if (passkeys.length === 0) {
    throw new Error("No passkey registered for this wallet. Complete setup first.");
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: passkeys.map((p: any) => ({
      id: p.credential_id,
      transports: JSON.parse(p.transports || "[]"),
    })),
    userVerification: "preferred",
  });

  setChallenge(`auth:${walletId}`, options.challenge);
  return options;
}

export async function verifyApproval(
  walletId: string,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  const expectedChallenge = getChallenge(`auth:${walletId}`);
  if (!expectedChallenge) throw new Error("Challenge expired or not found");

  const passkey = db.prepare(
    "SELECT id, credential_id, public_key, counter, transports FROM wallet_passkeys WHERE wallet_id = ? AND credential_id = ?",
  ).get(walletId, response.id) as any;

  if (!passkey) throw new Error("Passkey not found for this wallet");

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: passkey.credential_id,
      publicKey: Buffer.from(passkey.public_key, "base64"),
      counter: passkey.counter,
      transports: JSON.parse(passkey.transports || "[]"),
    },
  });

  if (!verification.verified) {
    throw new Error("Passkey authentication failed");
  }

  // Update counter
  db.prepare("UPDATE wallet_passkeys SET counter = ? WHERE id = ?").run(
    verification.authenticationInfo.newCounter,
    passkey.id,
  );

  return true;
}

// ─── Helpers ───

export function hasPasskey(walletId: string): boolean {
  const row = db.prepare("SELECT COUNT(*) as c FROM wallet_passkeys WHERE wallet_id = ?").get(walletId) as any;
  return row.c > 0;
}
