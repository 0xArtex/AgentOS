/**
 * Register + email verification + login round-trip through the real
 * dashboard-auth router.
 *
 * Regression for a prod 500 on sign-up: password hashing used scryptSync with
 * N=2^15, r=8 — whose ~128·N·r ≈ 32 MB working set meets/exceeds Node's DEFAULT
 * maxmem (32 MB) and throws "memory limit exceeded" on OpenSSL 3, and register
 * had no try/catch so it surfaced as a 500. Fixed with an explicit maxmem. This
 * drives the whole path (hash into a pending registration, activate via the
 * emailed token, verify on login) so it fails loudly if the scrypt params ever
 * exceed the ceiling again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, initDatabase } from "../db";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authRoutes = require("../routes/dashboard-auth").default;

initDatabase();

test("register + verify email + login round-trip works (scrypt maxmem)", async () => {
  const originalFetch = global.fetch;
  const savedEnv = {
    MAILGUN_API_KEY: process.env.MAILGUN_API_KEY,
    TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    TURNSTILE_EXPECTED_HOSTNAME: process.env.TURNSTILE_EXPECTED_HOSTNAME,
  };
  process.env.MAILGUN_API_KEY = "key-test";
  process.env.TURNSTILE_SITE_KEY = "test-site-key";
  process.env.TURNSTILE_SECRET_KEY = "test-secret-key";
  process.env.TURNSTILE_EXPECTED_HOSTNAME = "palmyr.ai";
  let verificationToken = "";
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/turnstile/v0/siteverify")) {
      return new Response(JSON.stringify({ success: true, action: "register", hostname: "palmyr.ai" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("api.mailgun.net")) {
      const form = new URLSearchParams(String(init?.body || ""));
      verificationToken = /[?&]token=([a-f0-9]{64})/i.exec(form.get("text") || "")?.[1] || "";
      return new Response(JSON.stringify({ id: "<verification-test@palmyr.ai>" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input as any, init);
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes);
  const srv: any = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const port = srv.address().port;
  const email = `scrypt-diag-${Date.now().toString(36)}@example.com`;
  const password = "diagpassword123"; // ≥10 chars
  const call = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.41" }, body: JSON.stringify(body) });
  try {
    const reg = await call("/auth/register", { email, password, name: "Diag", turnstileToken: "valid-turnstile-token", continuePath: "/dashboard.html" });
    const regBody: any = await reg.json().catch(() => ({}));
    assert.equal(reg.status, 202, `register should be pending, got ${reg.status}: ${JSON.stringify(regBody)}`);
    assert.equal(regBody.verification_required, true);
    assert.equal(db.prepare("SELECT 1 FROM dashboard_users WHERE email = ?").get(email), undefined, "unverified address is not an active user");
    const pending: any = db.prepare("SELECT token_hash FROM dashboard_pending_registrations WHERE email = ?").get(email);
    assert.ok(pending, "pending registration is stored");
    assert.match(verificationToken, /^[a-f0-9]{64}$/i, "Mailgun message contains a high-entropy verification token");
    assert.notEqual(pending.token_hash, verificationToken, "only a hash of the emailed token is stored");

    const beforeVerify = await call("/auth/login", { email, password });
    assert.equal(beforeVerify.status, 401, "pending registration cannot log in");

    const verify = await fetch(`http://127.0.0.1:${port}/auth/verify-email?token=${verificationToken}&next=%2Fdashboard.html`, { redirect: "manual" });
    assert.equal(verify.status, 303);
    assert.equal(verify.headers.get("location"), "/dashboard.html?email_verified=1");
    assert.equal(db.prepare("SELECT email_verified_at FROM dashboard_users WHERE email = ?").get(email) != null, true);
    assert.equal(db.prepare("SELECT 1 FROM dashboard_pending_registrations WHERE email = ?").get(email), undefined);
    const replay = await fetch(`http://127.0.0.1:${port}/auth/verify-email?token=${verificationToken}`, { redirect: "manual" });
    assert.equal(replay.status, 400, "verification token is single-use");

    const login = await call("/auth/login", { email, password });
    const loginBody: any = await login.json().catch(() => ({}));
    assert.equal(login.status, 200, `login should succeed, got ${login.status}: ${JSON.stringify(loginBody)}`);
    assert.ok(loginBody.token);

    const bad = await call("/auth/login", { email, password: "wrong-password-xyz" });
    assert.equal(bad.status, 401, "a wrong password is rejected, not 500");
  } finally {
    db.prepare("DELETE FROM dashboard_sessions WHERE user_id IN (SELECT id FROM dashboard_users WHERE email = ?)").run(email.toLowerCase());
    db.prepare("DELETE FROM dashboard_users WHERE email = ?").run(email.toLowerCase());
    db.prepare("DELETE FROM dashboard_pending_registrations WHERE email = ?").run(email.toLowerCase());
    await new Promise<void>((r) => srv.close(() => r()));
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
