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

const RP_NAME = "Palmyr Wallet";

/**
 * Resolve the WebAuthn RP ID + allowed origin(s) from the environment.
 * Exported so the fail-closed behavior is unit-testable.
 *
 * In genuine multi-tenant production (NODE_ENV=production and not self-hosted)
 * the relying-party id and origin MUST be set explicitly. A silent "localhost"
 * fallback would either break passkey oversight entirely (rpId is not a
 * registrable suffix of the prod origin) or leave a permissive localhost origin
 * allowlist active. Fail closed, mirroring config.ts requiredInProd / email.ts.
 *
 * - Production: requires WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN — throws if either
 *   is unset (no localhost fallback).
 * - Dev/test/self-hosted: defaults to localhost. WebAuthn permits HTTP for
 *   localhost only, so the common dev-port allowlist is safe and is confined
 *   to non-production environments.
 */
export function resolveWebauthnConfig(): { rpId: string; origin: string | string[] } {
  const envRpId = process.env.WEBAUTHN_RP_ID;
  const envOrigin = process.env.WEBAUTHN_ORIGIN;
  const prodRequiresConfig =
    process.env.NODE_ENV === "production" &&
    !(process.env.PALMYR_SELF_HOSTED === "1" || process.env.PALMYR_SELF_HOSTED === "true");

  if (prodRequiresConfig && (!envRpId || !envOrigin)) {
    throw new Error(
      "Refusing to boot: WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN must be set in production. " +
        "There is no localhost fallback outside development — a default rpId would break " +
        "managed-wallet passkey oversight and enable a permissive localhost origin allowlist.",
    );
  }

  const rpId = envRpId || "localhost";
  if (envOrigin) return { rpId, origin: envOrigin };
  if (rpId === "localhost") {
    return {
      rpId,
      origin: [
        "http://localhost",
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3999",
        "http://localhost:8080",
        "http://127.0.0.1",
        "http://127.0.0.1:3000",
        "https://localhost",
      ],
    };
  }
  return { rpId, origin: `https://${rpId}` };
}

// Resolved LAZILY on the first passkey op (not at module load) so a missing
// WEBAUTHN_RP_ID/ORIGIN in prod disables passkey wallet oversight, not the whole
// API at boot. resolveWebauthnConfig() still fails closed in prod when called.
function wa(): { rpId: string; origin: string | string[] } {
  return resolveWebauthnConfig();
}

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
    rpID: wa().rpId,
    userName: `wallet-${walletId}`,
    userDisplayName: "Wallet Owner",
    attestationType: "none",
    excludeCredentials: existingPasskeys.map((p: any) => ({
      id: p.credential_id,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      // Money-oversight flow: require user verification (biometric/PIN) so a
      // silent or cloned authenticator cannot register a passkey without a
      // human physically present.
      userVerification: "required",
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
    expectedOrigin: wa().origin,
    expectedRPID: wa().rpId,
    // Reject any assertion that wasn't user-verified (biometric/PIN).
    requireUserVerification: true,
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
    rpID: wa().rpId,
    allowCredentials: passkeys.map((p: any) => ({
      id: p.credential_id,
      transports: JSON.parse(p.transports || "[]"),
    })),
    // Approving an over-limit spend / policy change is a human-presence gate:
    // require user verification so a non-UV authenticator can't satisfy it.
    userVerification: "required",
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
    expectedOrigin: wa().origin,
    expectedRPID: wa().rpId,
    // Enforce that the approval was actually user-verified (biometric/PIN), not
    // just a silent assertion. Defends the human-oversight property even if the
    // library default ever changes.
    requireUserVerification: true,
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
