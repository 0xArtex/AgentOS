#!/usr/bin/env node
/**
 * Seed a batch of BOUGHT TikTok accounts (accsmarket & co.) into the deployable
 * pool. Reads a file of supplier credential lines and, for each, calls the
 * admin-only server route that logs the account in SERVER-SIDE through its pinned
 * residential proxy — your machine never touches TikTok — and bakes the session
 * into the account's profile so it becomes leasable.
 *
 * Auth: this signs the same admin envelope the server's pool-admin middleware
 * expects (Ed25519 over `<METHOD>:<path>:<timestamp>`). Provide your admin
 * Solana secret key via PALMYR_ADMIN_SECRET — either a base58 string (Phantom
 * "export private key") or a JSON array of 64 numbers (solana-keygen id.json).
 * The pubkey it derives must be in the server's POOL_ADMIN_WALLETS.
 *
 * Usage:
 *   PALMYR_ADMIN_SECRET=<base58-or-json-array> \
 *   node scripts/seed-tiktok-pool.mjs \
 *     --file accounts.txt \
 *     --format "login:password:email:email_password" \
 *     --country US \
 *     --server https://palmyr.ai
 *
 * accounts.txt: one credential line per row (blank lines and lines starting with
 * '#' are ignored). --format is the colon template naming each field; common
 * supplier shapes:
 *   login:password:email:email_password   (default)
 *   login:password:email_password         (login IS the email)
 *   login::password:email:email_password  (empty second field)
 */
import { readFileSync } from "fs";
import nacl from "tweetnacl";
import bs58 from "bs58";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

function loadAdminKey() {
  const raw = process.env.PALMYR_ADMIN_SECRET;
  if (!raw) {
    console.error("PALMYR_ADMIN_SECRET is not set. Export your admin Solana secret key (base58 or JSON array).");
    process.exit(1);
  }
  let secret;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    secret = Uint8Array.from(JSON.parse(trimmed));
  } else {
    secret = bs58.decode(trimmed);
  }
  // Accept a 64-byte full secret key, or a 32-byte seed.
  const kp = secret.length === 64 ? nacl.sign.keyPair.fromSecretKey(secret) : nacl.sign.keyPair.fromSeed(secret);
  return { secretKey: kp.secretKey, pubkey: bs58.encode(Buffer.from(kp.publicKey)) };
}

function adminHeaders(key, method, path) {
  const timestamp = Date.now().toString();
  const message = `${method.toUpperCase()}:${path}:${timestamp}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(message), key.secretKey);
  return {
    "X-Admin-Pubkey": key.pubkey,
    "X-Admin-Timestamp": timestamp,
    "X-Admin-Signature": Buffer.from(sig).toString("hex"),
    "Content-Type": "application/json",
  };
}

async function seedOne(server, key, line, format, country, tag) {
  const path = "/social/tiktok/pool/seed-credentials";
  const res = await fetch(server + path, {
    method: "POST",
    headers: adminHeaders(key, "POST", path),
    body: JSON.stringify({ credentials_line: line, format, country, tag }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 202) {
    return { ok: false, error: body.error || `HTTP ${res.status}`, code: body.error_code };
  }
  const id = body.account_id;
  // Poll until active (leasable) or dead. Each seed's browser login can take
  // 1-3 min (captcha + email-OTP), so allow ~5 min.
  const deadline = Date.now() + 5 * 60 * 1000;
  const pollPath = `/social/tiktok/pool/seed/${id}`;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const pr = await fetch(server + pollPath, { headers: adminHeaders(key, "GET", pollPath) });
    const ps = await pr.json().catch(() => ({}));
    if (ps.done) {
      return ps.leasable
        ? { ok: true, id, handle: ps.handle }
        : { ok: false, id, error: `seed failed (${ps.last_error_code || "unknown"})`, code: ps.last_error_code };
    }
  }
  return { ok: false, id, error: "timed out waiting for the seed to finish (still running server-side)" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("Missing --file <path> (one credential line per row).");
    process.exit(1);
  }
  const server = (args.server || process.env.PALMYR_API || "https://palmyr.ai").replace(/\/+$/, "");
  const format = args.format || "login:password:email:email_password";
  const country = args.country;
  const tag = args.tag;
  const key = loadAdminKey();

  const lines = readFileSync(args.file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (lines.length === 0) {
    console.error("No credential lines found in " + args.file);
    process.exit(1);
  }

  console.log(`Seeding ${lines.length} account(s) → ${server}  (country=${country || "any"}, format="${format}")\n`);
  let ok = 0;
  for (let i = 0; i < lines.length; i++) {
    const label = `[${i + 1}/${lines.length}]`;
    process.stdout.write(`${label} seeding… `);
    try {
      const r = await seedOne(server, key, lines[i], format, country, tag);
      if (r.ok) {
        ok++;
        console.log(`✅ live${r.handle ? " @" + r.handle : ""} (${r.id})`);
      } else {
        console.log(`❌ ${r.error}${r.id ? " (" + r.id + ")" : ""}`);
      }
    } catch (e) {
      console.log(`❌ ${e?.message || e}`);
    }
  }
  console.log(`\nDone: ${ok}/${lines.length} live in the pool.`);
  process.exit(ok === lines.length ? 0 : 1);
}

main();
