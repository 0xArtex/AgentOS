/**
 * Abuse controls around human email/password signup:
 * - Turnstile is mandatory and action-bound
 * - production fails closed when keys are absent
 * - the dedicated signup bucket allows five attempts/hour/IP
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, initDatabase } from "../db";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authRoutes = require("../routes/dashboard-auth").default;

initDatabase();

test("dashboard signup enforces Turnstile and a five-per-hour IP cap", async () => {
  const originalFetch = global.fetch;
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    TURNSTILE_EXPECTED_HOSTNAME: process.env.TURNSTILE_EXPECTED_HOSTNAME,
    TURNSTILE_BYPASS: process.env.TURNSTILE_BYPASS,
  };
  process.env.NODE_ENV = "test";
  process.env.TURNSTILE_SITE_KEY = "public-test-site-key";
  process.env.TURNSTILE_SECRET_KEY = "private-test-secret";
  process.env.TURNSTILE_EXPECTED_HOSTNAME = "palmyr.ai";
  delete process.env.TURNSTILE_BYPASS;

  let siteverifyCalls = 0;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/turnstile/v0/siteverify")) {
      siteverifyCalls++;
      const form = new URLSearchParams(String(init?.body || ""));
      const response = form.get("response");
      const payload = response === "wrong-action-token"
        ? { success: true, action: "login", hostname: "palmyr.ai" }
        : { success: false, "error-codes": ["invalid-input-response"] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input as any, init);
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes);
  const server: any = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const port = server.address().port;
  const post = (body: unknown, ip: string) => fetch(`http://127.0.0.1:${port}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });

  try {
    const config = await fetch(`http://127.0.0.1:${port}/auth/config`);
    assert.deepEqual(await config.json(), { turnstileSiteKey: "public-test-site-key", signupAvailable: true });

    const email = `turnstile-${Date.now().toString(36)}@example.com`;
    const base = { email, password: "long-enough-password", name: "Bot Check" };

    const missing = await post(base, "198.51.100.51");
    assert.equal(missing.status, 400);
    assert.equal((await missing.json() as any).code, "TURNSTILE_FAILED");

    const wrongAction = await post({ ...base, turnstileToken: "wrong-action-token" }, "198.51.100.52");
    assert.equal(wrongAction.status, 400, "a token minted for another action is rejected");
    assert.equal(db.prepare("SELECT 1 FROM dashboard_pending_registrations WHERE email = ?").get(email), undefined);
    assert.equal(siteverifyCalls, 1, "missing tokens are rejected locally; only a shaped token reaches siteverify");

    const limitedIp = "198.51.100.53";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await post({}, limitedIp);
      assert.equal(response.status, 400, `attempt ${attempt} remains inside the signup allowance`);
    }
    const sixth = await post({}, limitedIp);
    assert.equal(sixth.status, 429, "sixth signup attempt in an hour is throttled");

    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    process.env.NODE_ENV = "production";
    const unavailable = await post({ ...base, turnstileToken: "well-shaped-but-unverifiable" }, "198.51.100.54");
    assert.equal(unavailable.status, 503, "production signup fails closed without Turnstile keys");
    assert.equal((await unavailable.json() as any).code, "TURNSTILE_UNAVAILABLE");
  } finally {
    db.prepare("DELETE FROM dashboard_pending_registrations WHERE email LIKE 'turnstile-%@example.com'").run();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
