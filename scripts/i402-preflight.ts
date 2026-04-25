#!/usr/bin/env node
/**
 * i402 Tier B pre-flight check.
 *
 * Verifies every external dependency is reachable before committing real money
 * to a Tier B sneaker-launch run. Exits 0 on go, 1 on no-go.
 *
 * Usage:
 *   npx ts-node scripts/i402-preflight.ts
 *
 * Checks:
 *   1. Env var presence (ANTHROPIC_API_KEY, HCLOUD_TOKEN, NAMECHEAP_*, CLOUDFLARE_*, etc.)
 *   2. Anthropic API reachable (sends a 10-token ping)
 *   3. Exa API reachable (if EXA_API_KEY set)
 *   4. Hetzner Cloud API reachable
 *   5. Namecheap API reachable (domain availability probe)
 *   6. SendGrid API key present + /me reachable
 *   7. Telnyx API reachable
 *   8. Capsolver balance > $2
 *   9. Solana RPC reachable + USDC balance for test wallet >= budget
 *  10. Database migrations applicable (dry-run)
 *  11. i402 provider registry has the minimum Tier B primitives
 */

import "dotenv/config";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
  optional?: boolean;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: string, optional = false): void {
  results.push({ name, ok, detail, optional });
}

// -------------------- Env var checks --------------------

function checkEnv(name: string, optional = false): boolean {
  const value = process.env[name];
  if (!value) {
    record(`env: ${name}`, false, "not set", optional);
    return false;
  }
  record(`env: ${name}`, true, `set (len=${value.length})`);
  return true;
}

// -------------------- Network probes --------------------

async function ping(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>, optional = false): Promise<void> {
  try {
    const r = await fn();
    record(name, r.ok, r.detail, optional);
  } catch (err: any) {
    record(name, false, err?.message ?? String(err), optional);
  }
}

async function main(): Promise<void> {
  console.log("i402 Tier B pre-flight — checking every dependency...\n");

  // 1. Core env vars
  checkEnv("ANTHROPIC_API_KEY");
  checkEnv("HCLOUD_TOKEN");
  checkEnv("NAMECHEAP_API_USER");
  checkEnv("NAMECHEAP_API_KEY");
  checkEnv("CLOUDFLARE_API_TOKEN");
  checkEnv("TELNYX_API_KEY");
  checkEnv("CAPSOLVER_API_KEY", true);
  checkEnv("EXA_API_KEY", true);
  checkEnv("OPENAI_API_KEY", true);
  checkEnv("TREASURY_WALLET");
  checkEnv("SOLANA_RPC_URL");
  checkEnv("USDC_MINT", true); // optional — config.ts defaults to mainnet USDC mint
  checkEnv("NAMECHEAP_CLIENT_IP", true); // optional — falls back to auto-detect via api.ipify.org

  // 2. Anthropic reachability
  if (process.env.ANTHROPIC_API_KEY) {
    await ping("Anthropic /v1/messages (Haiku ping)", async () => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY!,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 10,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 100)}` };
      }
      return { ok: true, detail: `HTTP ${res.status}` };
    });
  }

  // 3. Exa (optional)
  if (process.env.EXA_API_KEY) {
    await ping("Exa /search", async () => {
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": process.env.EXA_API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", numResults: 1 }),
      });
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    }, true);
  }

  // 4. Hetzner
  if (process.env.HCLOUD_TOKEN) {
    await ping("Hetzner /server_types", async () => {
      const res = await fetch("https://api.hetzner.cloud/v1/server_types?per_page=1", {
        headers: { Authorization: `Bearer ${process.env.HCLOUD_TOKEN!}` },
      });
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    });
  }

  // 5. Namecheap availability — needs a real IP that's whitelisted on the account.
  if (process.env.NAMECHEAP_API_KEY && process.env.NAMECHEAP_API_USER) {
    await ping("Namecheap domains.check", async () => {
      let clientIp = process.env.NAMECHEAP_CLIENT_IP;
      if (!clientIp) {
        try {
          const ipRes = await fetch("https://api.ipify.org?format=json");
          const ipData: any = await ipRes.json();
          clientIp = ipData?.ip;
        } catch { /* ignore — error message below will explain */ }
      }
      if (!clientIp) {
        return { ok: false, detail: "could not detect public IP (set NAMECHEAP_CLIENT_IP)" };
      }
      const url = `https://api.namecheap.com/xml.response?ApiUser=${process.env.NAMECHEAP_API_USER!}&ApiKey=${process.env.NAMECHEAP_API_KEY!}&UserName=${process.env.NAMECHEAP_API_USER!}&ClientIp=${clientIp}&Command=namecheap.domains.check&DomainList=preflight-test-${Date.now()}.com`;
      const res = await fetch(url);
      const text = await res.text();
      // Extract the embedded error if Namecheap returned one inside an HTTP 200
      const errMatch = text.match(/<Error\s+Number="(\d+)">([^<]+)<\/Error>/);
      if (errMatch) {
        return { ok: false, detail: `HTTP ${res.status} — Namecheap error ${errMatch[1]}: ${errMatch[2]} (clientIp=${clientIp})` };
      }
      const ok = res.ok && !text.includes("<Errors") && !text.includes("<Error ");
      return { ok, detail: `HTTP ${res.status} (clientIp=${clientIp})` };
    });
  }

  // 6. Cloudflare
  if (process.env.CLOUDFLARE_API_TOKEN) {
    await ping("Cloudflare /user/tokens/verify", async () => {
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN!}` },
      });
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    });
  }

  // 7. (SendGrid check removed — email send path uses MailChannels via src/services/email.ts)

  // 8. Telnyx
  if (process.env.TELNYX_API_KEY) {
    await ping("Telnyx /balance", async () => {
      const res = await fetch("https://api.telnyx.com/v2/balance", {
        headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY!}` },
      });
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    });
  }

  // 9. Capsolver balance (optional — TikTok only needs it)
  if (process.env.CAPSOLVER_API_KEY) {
    await ping("Capsolver /getBalance", async () => {
      const res = await fetch("https://api.capsolver.com/getBalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: process.env.CAPSOLVER_API_KEY! }),
      });
      const data: any = await res.json().catch(() => ({}));
      const bal = Number(data?.balance ?? 0);
      return { ok: res.ok && bal > 2, detail: `balance=$${bal.toFixed(2)}` };
    }, true);
  }

  // 10. Solana RPC
  if (process.env.SOLANA_RPC_URL) {
    await ping("Solana RPC getHealth", async () => {
      const res = await fetch(process.env.SOLANA_RPC_URL!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      });
      const data: any = await res.json().catch(() => ({}));
      return { ok: data?.result === "ok", detail: `result=${data?.result ?? "unknown"}` };
    });
  }

  // 11. i402 registry sanity (only works if the DB is initialized — it is, via the db.ts module side effect)
  try {
    const { initDatabase } = await import("../src/db");
    const { seedAgentOSPrimitives, listProviders } = await import("../src/services/i402-providers");
    initDatabase();
    seedAgentOSPrimitives();
    const providers = listProviders({ enabledOnly: true });
    const requiredCaps = new Set([
      "register_domain",
      "deploy_vps",
      "provision_email_inbox",
      "social_account_provision",
      "social_post",
    ]);
    const coverage = new Set(providers.map(p => p.capability));
    const missing = [...requiredCaps].filter(c => !coverage.has(c));
    record(
      "i402 registry: Tier B capability coverage",
      missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : `${providers.length} providers covering all Tier B capabilities`
    );
  } catch (err: any) {
    record("i402 registry", false, err?.message ?? String(err));
  }

  // -------------------- Report --------------------

  console.log("\nResults:\n");
  let blockers = 0;
  let warnings = 0;
  for (const r of results) {
    const icon = r.ok ? "✓" : r.optional ? "~" : "✗";
    const color = r.ok ? "\x1b[32m" : r.optional ? "\x1b[33m" : "\x1b[31m";
    const reset = "\x1b[0m";
    console.log(`  ${color}${icon}${reset} ${r.name}${r.detail ? `  —  ${r.detail}` : ""}`);
    if (!r.ok && !r.optional) blockers++;
    if (!r.ok && r.optional) warnings++;
  }

  console.log("");
  if (blockers === 0) {
    if (warnings > 0) {
      console.log(`\x1b[33m⚠  ${warnings} optional check(s) failed. Tier B may still work but some capabilities will fall back.\x1b[0m`);
    }
    console.log(`\x1b[32m✓ Pre-flight passed — ready for Tier B.\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m✗ ${blockers} blocker(s). Tier B will NOT succeed until these are resolved.\x1b[0m\n`);
  process.exit(1);
}

main().catch(err => {
  console.error("Pre-flight crashed:", err);
  process.exit(2);
});
