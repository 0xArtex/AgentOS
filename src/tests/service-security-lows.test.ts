/**
 * Regression tests for the service-layer "low" security fixes:
 *  - self-hosted bypass no longer engages from a missing/mistyped NODE_ENV, and
 *    is hard-disabled by any multi-tenant signal (treasury wallet, etc).
 *  - WebAuthn RP_ID/ORIGIN fail closed in production and require user
 *    verification ("required") for the money-oversight flows.
 *  - VPS root passwords are encrypted at rest (with legacy plaintext passthrough).
 *  - SQLite foreign-key enforcement is enabled.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { db } from "../db";
import { isSelfHosted } from "../services/self-hosted";
import {
  resolveWebauthnConfig,
  generateSetupOptions,
  generateApprovalOptions,
} from "../services/wallet-passkey";
import { storage } from "../services/storage";

// ── env snapshot/restore ──────────────────────────────────────
const ENV_KEYS = [
  "PALMYR_SELF_HOSTED",
  "PALMYR_SELF_HOSTED_FORCE",
  "PALMYR_MULTI_TENANT",
  "NODE_ENV",
  "TREASURY_WALLET",
  "TREASURY_EVM_WALLET",
  "WEBAUTHN_RP_ID",
  "WEBAUTHN_ORIGIN",
  "SERVER_PASSWORD_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});
afterEach(() => clearEnv());

describe("isSelfHosted — hardened bypass gate", () => {
  it("requires the explicit PALMYR_SELF_HOSTED=1 opt-in", () => {
    process.env.NODE_ENV = "development";
    assert.equal(isSelfHosted(), false);
  });

  it("engages only with a positive non-production marker", () => {
    process.env.PALMYR_SELF_HOSTED = "1";
    process.env.NODE_ENV = "development";
    assert.equal(isSelfHosted(), true);
    process.env.NODE_ENV = "test";
    assert.equal(isSelfHosted(), true);
  });

  it("does NOT engage when NODE_ENV is unset/ambiguous (the core fix)", () => {
    process.env.PALMYR_SELF_HOSTED = "1";
    // NODE_ENV deliberately unset — the old gate returned true here.
    assert.equal(isSelfHosted(), false);
  });

  it("never engages in production without the FORCE override", () => {
    process.env.PALMYR_SELF_HOSTED = "1";
    process.env.NODE_ENV = "production";
    assert.equal(isSelfHosted(), false);
  });

  it("is hard-disabled by a multi-tenant signal even in a non-prod env", () => {
    process.env.PALMYR_SELF_HOSTED = "1";
    process.env.NODE_ENV = "development";
    process.env.TREASURY_WALLET = "SomeTreasuryWallet";
    assert.equal(isSelfHosted(), false);

    delete process.env.TREASURY_WALLET;
    process.env.PALMYR_MULTI_TENANT = "1";
    assert.equal(isSelfHosted(), false);
  });

  it("FORCE=1 overrides production and ambiguous env", () => {
    process.env.PALMYR_SELF_HOSTED = "1";
    process.env.PALMYR_SELF_HOSTED_FORCE = "1";
    process.env.NODE_ENV = "production";
    assert.equal(isSelfHosted(), true);
    delete process.env.NODE_ENV;
    assert.equal(isSelfHosted(), true);
  });
});

describe("WebAuthn config — fail closed in prod", () => {
  it("throws in production when RP_ID/ORIGIN are unset", () => {
    process.env.NODE_ENV = "production";
    assert.throws(() => resolveWebauthnConfig(), /WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN/);
  });

  it("uses the explicit values in production (no localhost)", () => {
    process.env.NODE_ENV = "production";
    process.env.WEBAUTHN_RP_ID = "palmyr.ai";
    process.env.WEBAUTHN_ORIGIN = "https://palmyr.ai";
    const cfg = resolveWebauthnConfig();
    assert.equal(cfg.rpId, "palmyr.ai");
    assert.equal(cfg.origin, "https://palmyr.ai");
  });

  it("a deliberate production self-host is not forced to set them", () => {
    process.env.NODE_ENV = "production";
    process.env.PALMYR_SELF_HOSTED = "1";
    const cfg = resolveWebauthnConfig();
    assert.equal(cfg.rpId, "localhost");
  });

  it("defaults to a localhost allowlist outside production", () => {
    process.env.NODE_ENV = "development";
    const cfg = resolveWebauthnConfig();
    assert.equal(cfg.rpId, "localhost");
    assert.ok(Array.isArray(cfg.origin) && cfg.origin.includes("http://localhost:3000"));
  });
});

describe("WebAuthn options — user verification required", () => {
  it("setup options require user verification", async () => {
    const opts = await generateSetupOptions("wallet-uv-setup");
    assert.equal(opts.authenticatorSelection.userVerification, "required");
  });

  it("approval options require user verification", async () => {
    const walletId = "wallet-uv-approve-" + crypto.randomBytes(4).toString("hex");
    // generateApprovalOptions needs at least one registered passkey.
    db.prepare(
      "INSERT INTO wallet_passkeys (id, wallet_id, credential_id, public_key, counter, transports) VALUES (?, ?, ?, ?, 0, '[]')",
    ).run(crypto.randomBytes(6).toString("hex"), walletId, "cred-" + crypto.randomBytes(6).toString("hex"), "pk");
    const opts = await generateApprovalOptions(walletId);
    assert.equal(opts.userVerification, "required");
  });
});

describe("VPS root password — encrypted at rest", () => {
  function makeServer(id: string, rootPassword: string | null): any {
    return {
      id,
      name: "test-box",
      serverType: "cpx11",
      image: "ubuntu-24.04",
      status: "running",
      ipv4: "1.2.3.4",
      ipv6: null,
      owner: "owner-wallet",
      priceMonthly: "7.00",
      createdAt: new Date().toISOString(),
      rootPassword,
    };
  }

  it("stores ciphertext, not plaintext, and round-trips on read", () => {
    process.env.SERVER_PASSWORD_KEY = crypto.randomBytes(32).toString("hex");
    const id = "srv-enc-" + crypto.randomBytes(4).toString("hex");
    const secret = "hunter2-r00t-" + crypto.randomBytes(4).toString("hex");
    storage.setServer(id, makeServer(id, secret));

    const raw = db.prepare("SELECT root_password FROM servers WHERE id = ?").get(id) as any;
    assert.notEqual(raw.root_password, secret, "raw column must not be plaintext");
    assert.ok(String(raw.root_password).startsWith("enc:v1:"), "raw column must be encrypted");

    assert.equal(storage.getServer(id)!.rootPassword, secret);
    assert.equal(storage.listServers("owner-wallet").find(s => s.id === id)!.rootPassword, secret);
  });

  it("passes through legacy plaintext rows unchanged", () => {
    const id = "srv-legacy-" + crypto.randomBytes(4).toString("hex");
    // Simulate a pre-encryption row written directly.
    db.prepare(
      "INSERT INTO servers (id, name, server_type, image, status, ipv4, ipv6, owner, price_monthly, created_at, root_password) VALUES (?, 'b','cpx11','img','running',null,null,'o','7.00',?,?)",
    ).run(id, new Date().toISOString(), "legacy-plaintext-pw");
    assert.equal(storage.getServer(id)!.rootPassword, "legacy-plaintext-pw");
  });

  it("handles a null root password", () => {
    process.env.SERVER_PASSWORD_KEY = crypto.randomBytes(32).toString("hex");
    const id = "srv-null-" + crypto.randomBytes(4).toString("hex");
    storage.setServer(id, makeServer(id, null));
    assert.equal(storage.getServer(id)!.rootPassword, null);
  });
});

describe("SQLite foreign-key enforcement", () => {
  it("is enabled on the connection", () => {
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  });
});
