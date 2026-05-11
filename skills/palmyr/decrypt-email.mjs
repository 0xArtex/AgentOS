#!/usr/bin/env node
/**
 * Palmyr Email Decryptor
 * Decrypts E2E encrypted emails from Palmyr using your Solana private key.
 *
 * Usage:
 *   node decrypt-email.mjs <base64-ciphertext> <solana-keypair-path>
 *   echo '<ciphertext>' | node decrypt-email.mjs --stdin <solana-keypair-path>
 *   node decrypt-email.mjs --json '<message-json>' <solana-keypair-path>
 *
 * Examples:
 *   node decrypt-email.mjs "w:ABC123..." ~/.config/solana/id.json
 *   node decrypt-email.mjs --json '{"subject":"w:...","body":"w:..."}' ~/.config/solana/id.json
 */

import { readFileSync } from "fs";
import { createHash } from "crypto";

// Inline minimal NaCl box.open (no deps needed)
// Uses tweetnacl if available, otherwise errors with install hint
let nacl;
try {
  nacl = (await import("tweetnacl")).default;
} catch {
  console.error("Install tweetnacl: npm i tweetnacl tweetnacl-util");
  process.exit(1);
}

function base64Decode(str) {
  return new Uint8Array(Buffer.from(str, "base64"));
}

function ed25519SeedToX25519(seed) {
  const hash = createHash("sha512").update(seed).digest();
  hash[0] &= 248;
  hash[31] &= 127;
  hash[31] |= 64;
  return new Uint8Array(hash.slice(0, 32));
}

function decrypt(ciphertext, x25519Secret) {
  // Strip "w:" prefix if present
  const b64 = ciphertext.startsWith("w:") ? ciphertext.slice(2) : ciphertext;
  const packed = base64Decode(b64);

  if (packed.length < 57) throw new Error("Ciphertext too short");

  const ephemeralPub = packed.slice(0, 32);
  const nonce = packed.slice(32, 56);
  const encrypted = packed.slice(56);

  const plaintext = nacl.box.open(encrypted, nonce, ephemeralPub, x25519Secret);
  if (!plaintext) throw new Error("Decryption failed — wrong key?");

  return new TextDecoder().decode(plaintext);
}

// --- Main ---
const args = process.argv.slice(2);

if (args.length < 1) {
  console.log("Usage: node decrypt-email.mjs <ciphertext> <keypair-path>");
  console.log("       node decrypt-email.mjs --json '<msg>' <keypair-path>");
  process.exit(1);
}

// Find keypair path
let keypairPath = args.find(a => a.endsWith(".json") && !a.startsWith("{"));
if (!keypairPath) keypairPath = "~/.config/solana/id.json".replace("~", process.env.HOME);

// Load keypair and derive X25519 secret
const keyBytes = JSON.parse(readFileSync(keypairPath, "utf8"));
const seed = new Uint8Array(keyBytes.slice(0, 32));
const x25519Secret = ed25519SeedToX25519(seed);

if (args.includes("--json")) {
  // Decrypt a full message JSON
  const jsonStr = args.find(a => a.startsWith("{"));
  if (!jsonStr) { console.error("Pass message JSON after --json"); process.exit(1); }
  const msg = JSON.parse(jsonStr);
  const result = {};
  for (const [key, val] of Object.entries(msg)) {
    if (typeof val === "string" && val.startsWith("w:")) {
      try { result[key] = decrypt(val, x25519Secret); } catch { result[key] = val; }
    } else {
      result[key] = val;
    }
  }
  console.log(JSON.stringify(result, null, 2));
} else if (args.includes("--stdin")) {
  // Read from stdin
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => data += chunk);
  process.stdin.on("end", () => {
    try { console.log(decrypt(data.trim(), x25519Secret)); }
    catch (e) { console.error(e.message); process.exit(1); }
  });
} else {
  // Single ciphertext argument
  const ciphertext = args.find(a => a.startsWith("w:") || a.length > 50);
  if (!ciphertext) { console.error("No ciphertext provided"); process.exit(1); }
  try { console.log(decrypt(ciphertext, x25519Secret)); }
  catch (e) { console.error(e.message); process.exit(1); }
}
