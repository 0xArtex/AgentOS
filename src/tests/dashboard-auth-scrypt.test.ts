/**
 * Register + login round-trip through the real dashboard-auth router.
 *
 * Regression for a prod 500 on sign-up: password hashing used scryptSync with
 * N=2^15, r=8 — whose ~128·N·r ≈ 32 MB working set meets/exceeds Node's DEFAULT
 * maxmem (32 MB) and throws "memory limit exceeded" on OpenSSL 3, and register
 * had no try/catch so it surfaced as a 500. Fixed with an explicit maxmem. This
 * drives the whole path (hash on register, verify on login) so it fails loudly
 * if the scrypt params ever exceed the ceiling again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, initDatabase } from "../db";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authRoutes = require("../routes/dashboard-auth").default;

initDatabase();

test("register + login round-trip works (scrypt maxmem)", async () => {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes);
  const srv: any = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const port = srv.address().port;
  const email = `scrypt-diag-${Date.now().toString(36)}@example.com`;
  const password = "diagpassword123"; // ≥10 chars
  const call = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const reg = await call("/auth/register", { email, password, name: "Diag" });
    const regBody: any = await reg.json().catch(() => ({}));
    assert.equal(reg.status, 200, `register should succeed, got ${reg.status}: ${JSON.stringify(regBody)}`);
    assert.ok(regBody.token, "register returns a session token");

    const login = await call("/auth/login", { email, password });
    const loginBody: any = await login.json().catch(() => ({}));
    assert.equal(login.status, 200, `login should succeed, got ${login.status}: ${JSON.stringify(loginBody)}`);
    assert.ok(loginBody.token);

    const bad = await call("/auth/login", { email, password: "wrong-password-xyz" });
    assert.equal(bad.status, 401, "a wrong password is rejected, not 500");
  } finally {
    db.prepare("DELETE FROM dashboard_sessions WHERE user_id IN (SELECT id FROM dashboard_users WHERE email = ?)").run(email.toLowerCase());
    db.prepare("DELETE FROM dashboard_users WHERE email = ?").run(email.toLowerCase());
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
