import { Request, Response, NextFunction } from "express";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { requireX402Payment, send402Response, X402Metadata } from "./x402";
import { db } from "../db";
import { AuthenticatedRequest } from "../types";
import * as balanceService from "../services/balance";
import { getOrCreateWallet } from "../services/deposit-wallets";
import { isSelfHosted, selfHostedIdentity } from "../services/self-hosted";

// ─────────────────────────────────────────────────────────────────────────────
// Wallet-control proofs
//
// "Your wallet is your identity" — so a caller may only assume a wallet's
// identity by PROVING control of it. Palmyr accepts that proof in two forms:
//   • an on-chain x402 payment (the on-chain payer IS the identity), or
//   • a detached signature over a fresh, deterministic message (this module).
// A publicly-enumerable identifier (agent name / id / wallet) is NEVER proof.
//
// Two chains are supported, matching the rest of Palmyr (Solana + Base):
//   • Solana — Ed25519 over the raw UTF-8 message, base58 address (tweetnacl).
//   • EVM    — secp256k1 / EIP-191 personal_sign, 0x address (@noble/curves).
// Pure verification only; freshness (the timestamp window) is enforced by the
// caller via `walletProofFresh` plus a message that embeds the timestamp.
// ─────────────────────────────────────────────────────────────────────────────

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isSolanaAddress(addr: unknown): boolean {
  return typeof addr === "string" && SOLANA_ADDRESS_RE.test(addr);
}
export function isEvmAddress(addr: unknown): boolean {
  return typeof addr === "string" && EVM_ADDRESS_RE.test(addr);
}

// Max age of a wallet-control signature: long enough to absorb clock skew and a
// retry, short enough that a captured signature is only briefly replayable.
export const WALLET_PROOF_SKEW_MS = 5 * 60 * 1000;

export function walletProofFresh(timestamp: string | number | undefined | null): boolean {
  const ts = Number(timestamp);
  return Number.isFinite(ts) && Math.abs(Date.now() - ts) <= WALLET_PROOF_SKEW_MS;
}

// Deterministic messages the client signs. Exported so the CLI/tests sign the
// EXACT bytes the server verifies. The wallet + timestamp are bound in so a
// signature can't be lifted onto a different wallet or replayed past the window.
export function registerAuthMessage(wallet: string, timestamp: string | number): string {
  return `palmyr-register:${wallet}:${timestamp}`;
}
export function agentIdAuthMessage(wallet: string, timestamp: string | number): string {
  return `palmyr-agent-auth:${wallet}:${timestamp}`;
}

function hexToBytes(s: string): Buffer | null {
  const hex = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

// Coerce a signature string to raw bytes of the expected length, accepting the
// encodings our clients/tests actually use: hex (CLI signMessageLocal), base58
// (dashboard-auth), and base64 (email proofs).
function decodeSignature(signature: string, expectedLen: number): Buffer | null {
  if (typeof signature !== "string" || signature.length === 0) return null;
  const asHex = hexToBytes(signature);
  if (asHex && asHex.length === expectedLen) return asHex;
  try { const b = Buffer.from(bs58.decode(signature)); if (b.length === expectedLen) return b; } catch { /* not base58 */ }
  try { const b = Buffer.from(signature, "base64"); if (b.length === expectedLen) return b; } catch { /* not base64 */ }
  return null;
}

function eip191Hash(message: string): Uint8Array {
  const msg = Buffer.from(message, "utf8");
  const prefix = Buffer.from("\x19Ethereum Signed Message:\n" + msg.length, "utf8");
  return keccak_256(Buffer.concat([prefix, msg]));
}

/**
 * Verify that `signature` over `message` proves control of `address`.
 * Solana (Ed25519, base58 address) or EVM (secp256k1 / EIP-191, 0x address).
 * Returns true ONLY for a cryptographically valid signature; never throws.
 */
export function verifyWalletControl(address: string, message: string, signature: string): boolean {
  try {
    if (isSolanaAddress(address)) {
      const pub = bs58.decode(address);
      if (pub.length !== 32) return false;
      const sig = decodeSignature(signature, 64);
      if (!sig) return false;
      return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
    }
    if (isEvmAddress(address)) {
      const sig = decodeSignature(signature, 65);
      if (!sig) return false;
      let v = sig[64];
      if (v >= 27) v -= 27;
      if (v !== 0 && v !== 1) return false;
      const recovered = secp256k1.Signature
        .fromBytes(sig.subarray(0, 64))
        .addRecoveryBit(v)
        .recoverPublicKey(eip191Hash(message));
      const pub = recovered.toBytes(false); // 65-byte uncompressed: 0x04 || X || Y
      const derived = "0x" + Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString("hex");
      return derived.toLowerCase() === address.toLowerCase();
    }
    return false;
  } catch {
    return false;
  }
}

// A signed X-Agent-Id proves control of the agent's wallet without a token or a
// payment — the only way the raw header can establish a trusted identity.
function verifyAgentIdProof(req: AuthenticatedRequest, wallet: string): boolean {
  const signature = req.headers["x-agent-signature"] as string | undefined;
  const timestamp = req.headers["x-agent-timestamp"] as string | undefined;
  if (!signature || !timestamp || !walletProofFresh(timestamp)) return false;
  return verifyWalletControl(wallet, agentIdAuthMessage(wallet, timestamp), signature);
}

/**
 * Authentication middleware for Palmyr
 *
 * Flow:
 * 1. Agent token (aos_*) → identified, check for x402 payment if needed
 * 2. X-Agent-Id header → look up agent, same logic
 * 3. x402 USDC payment → always works, no registration needed
 * 4. No auth → 401
 *
 * `minUsdc` can be a static number OR a function `(req) => number`. The
 * function form lets routes price dynamically from request data — used by
 * `/social/twitter/buy` to charge the per-country price from country_prices.
 * The function MUST be deterministic for the same request (it gets called
 * twice in the no-payment-yet branch: once to advertise in 402, once to
 * verify on the retry).
 */
export function requireAuth(
  minUsdc: number | ((req: Request) => number),
  serviceType: 'phone' | 'email' | 'server' | 'general' = 'general',
  metadata?: X402Metadata,
) {
  const resolvePrice = (req: Request): number =>
    typeof minUsdc === "function" ? minUsdc(req) : minUsdc;

  const handler = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    // Self-hosted single-operator instance: the operator owns the server, so
    // there's no paywall — pass everything through free. Hard-gated so it can
    // never engage on the hosted multi-tenant production deployment (see
    // isSelfHosted); identity is the operator's wallet so ownership still works.
    if (isSelfHosted()) {
      req.agentId = req.agentId || selfHostedIdentity();
      next();
      return;
    }
    const price = resolvePrice(req);

    const authHeader = req.headers["authorization"]?.toString().replace("Bearer ", "");
    const apiKey = authHeader || req.headers["x-api-key"] as string || req.headers["x-agent-token"] as string;
    const hasPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);

    // Method 1: Registered agent token
    if (apiKey && (apiKey.startsWith("aos_") || apiKey.startsWith("agt_"))) {
      const agent = db.prepare("SELECT * FROM agents WHERE token = ?").get(apiKey) as any;
      if (agent) {
        // Identity is the wallet address (your wallet = your identity).
        // Fall back to the agent row id only if the row has no wallet for some
        // legacy reason — new rows always have one.
        req.agentId = agent.wallet_address || agent.id;

        // Free endpoints (price === 0) — identified agents pass through.
        // Paid endpoints ALWAYS require x402 payment, regardless of serviceType.
        if (price === 0) {
          next();
          return;
        }

        if (hasPayment) {
          const paymentAuth = requireX402Payment(price, metadata);
          return paymentAuth(req, res, next);
        }

        send402Response(res, req, price, "Pay with USDC to use this service. Your wallet = your identity.", metadata);
        return;
      }
    }

    // Method 2: X-Agent-Id header. The header by itself is NOT proof of identity
    // — agent names/ids/wallets are publicly enumerable (GET /agents/*), so
    // trusting it would let anyone assume a victim's wallet for free. We only
    // grant the claimed identity when the caller ALSO proves control of that
    // wallet, by either:
    //   (a) a wallet-control signature (X-Agent-Signature + X-Agent-Timestamp)
    //       over a fresh agentIdAuthMessage, verified against wallet_address, or
    //   (b) an on-chain x402 payment — handled by the payment branch below, where
    //       the on-chain PAYER (never the unverified header) becomes the identity.
    // Absent a proof, the header can never establish another wallet's identity,
    // on free routes included.
    if (req.headers["x-agent-id"]) {
      const agentId = req.headers["x-agent-id"] as string;
      const agent = db.prepare(
        "SELECT * FROM agents WHERE wallet_address = ? OR name = ? OR id = ?"
      ).get(agentId, agentId, agentId) as any;

      // (a) Signed proof of wallet control → trusted identity (same as a token).
      if (agent && agent.wallet_address && verifyAgentIdProof(req, agent.wallet_address)) {
        req.agentId = agent.wallet_address;

        if (price === 0) {
          next();
          return;
        }

        if (hasPayment) {
          const paymentAuth = requireX402Payment(price, metadata);
          return paymentAuth(req, res, next);
        }

        send402Response(res, req, price, "Pay with USDC to use this service. Your wallet = your identity.", metadata);
        return;
      }

      // (b) No valid signature. If the caller is paying, fall through to the
      // payment path so the on-chain payer becomes the identity — we deliberately
      // do NOT set req.agentId from the unverified header here. Otherwise we
      // cannot establish identity: 402 so an x402-capable agent can pay.
      if (hasPayment) {
        const paymentAuth = requireX402Payment(price, metadata);
        return paymentAuth(req, res, next);
      }

      send402Response(
        res,
        req,
        price,
        "Unverified X-Agent-Id. Prove wallet control with X-Agent-Signature + X-Agent-Timestamp, present an agent token, or pay with USDC.",
        metadata,
      );
      return;
    }

    // Method 3: x402 payment only (no registration needed)
    if (hasPayment) {
      const paymentAuth = requireX402Payment(price, metadata);
      return paymentAuth(req, res, next);
    }

    // Method 4: Dashboard balance-based auth (validate session token)
    const dashboardUser = req.headers["x-dashboard-user"] as string;
    if (dashboardUser) {
      // Validate session token matches the claimed user
      const sessionToken = (req.headers["authorization"] || "").toString().replace("Bearer ", "");
      if (!sessionToken) {
        res.status(401).json({ error: "Authorization token required" });
        return;
      }
      const session = db.prepare(
        "SELECT user_id FROM dashboard_sessions WHERE token = ? AND expires_at > datetime('now')"
      ).get(sessionToken) as any;
      if (!session || session.user_id !== dashboardUser) {
        res.status(401).json({ error: "Invalid session for dashboard user" });
        return;
      }
      // Dashboard users pay from their deposited balance instead of settling
      // on-chain via x402. Unlike wallet payers (Methods 1-3) — who are charged
      // by the x402 middleware's on-chain settlement BEFORE the handler runs —
      // the dashboard identity is never debited by any route handler. So we
      // meter it HERE: verify sufficient balance up front, then debit on a
      // successful response via a res.on('finish') hook below.
      //
      // Mutual exclusivity with the wallet/x402 path is guaranteed by ordering:
      // Method 3 (hasPayment) returns before we ever reach here, so a request
      // that settled on-chain can never also be debited from a balance, and a
      // dashboard request never has req.payment set. No double-charge.
      if (price > 0) {
        const endpoint = `${req.method} ${req.originalUrl.split("?")[0]}`;

        // RESERVE the funds atomically BEFORE the handler runs. A single
        // conditional debit (UPDATE ... WHERE balance_usdc >= price) serializes
        // concurrent dashboard requests at the DB so they can't all pass an
        // up-front check and over-provision real paid infra — the previous
        // check-then-debit was a TOCTOU that let parallel requests through while
        // only some were billed. `changes === 0` ⇒ insufficient balance ⇒ 402,
        // with no reservation made.
        //
        // Dynamic-price routes: the resolved `price` is exactly what a wallet
        // payer would settle on-chain for this same request (deterministic for
        // /social/twitter/buy via resolveBuyPrice; a concrete per-TLD number for
        // /domains/register via requireDomainPayment). A handler that ends up
        // charging less can signal it with `res.locals.x402ActualCharge` and the
        // difference is refunded on success.
        const reserved = balanceService.reserve(dashboardUser, price, serviceType, endpoint);
        if (!reserved) {
          const bal = balanceService.getBalance(dashboardUser);
          res.status(402).json({
            error: "Insufficient balance",
            code: "insufficient_balance",
            required: price,
            balance: bal.balance_usdc,
          });
          return;
        }

        // The reservation is already debited. REFUND it (exactly once) when the
        // operation does not succeed — a 4xx/5xx handler response, or a client
        // abort before the response completes — so we never bill for failed
        // operations, mirroring how wallet payers are made whole on failure. On
        // success, if the handler actually charged less than reserved, refund the
        // difference (net charge == actual). `settled` guards the finish/close
        // double-fire so a debit is refunded at most once.
        let settled = false;
        const settle = (aborted: boolean): void => {
          if (settled) return;
          settled = true;
          try {
            const failed = aborted || res.statusCode >= 400;
            if (failed) {
              balanceService.refund(dashboardUser, price, `refund ${endpoint}`);
              return;
            }
            const localCharge = res.locals && (res.locals as any).x402ActualCharge;
            const actual = typeof localCharge === "number" && localCharge >= 0 ? localCharge : price;
            if (actual < price) {
              balanceService.refund(dashboardUser, price - actual, `partial refund ${endpoint}`);
            }
          } catch (err: any) {
            // Refund is the only operation that can fail here and the response is
            // already gone; log for reconciliation (refund() never over-credits).
            console.error(
              `[auth] dashboard refund failed for ${dashboardUser} on ${endpoint}:`,
              err?.message ?? err,
            );
          }
        };
        res.on("finish", () => settle(false));
        res.on("close", () => settle(!res.writableFinished));
      }
      req.agentId = `dashboard:${dashboardUser}`;
      next();
      return;
    }

    // No auth at all — send 402 so x402-compatible agents can pay
    send402Response(res, req, price, "Pay with USDC to use this service. Your wallet address becomes the owner.", metadata);
  };
  // Discovery markers — read by route-discovery.ts (which walks the live router
  // and reads these off each route layer's `handle`) to enumerate paid routes
  // for /.well-known/x402 and /openapi.json. Free endpoints (minUsdc=0) are also
  // identified-only and don't belong in the discoverable list.
  //
  // Dynamic-priced routes (function form) can't advertise a single honest amount
  // — the price depends on request data resolved at call time. We still tag them
  // as paid (so the walker enumerates them) with a sentinel `_x402PaidMin = 0`,
  // and additionally set `_x402DynamicPrice = true`. route-discovery.ts mirrors
  // this onto `PaidRoute.dynamicPrice`, and well-known.ts uses it to emit
  // `x-payment-info: {mode:"dynamic"}` (probe the 402 for the live amount)
  // instead of a misleading `{mode:"fixed", amount:"0"}`. The marker lives on
  // this `handler` object, which is exactly what becomes the route layer's
  // `handle`, so the walker reads it the same way it reads `_x402PaidMin`.
  if (typeof minUsdc === "function") {
    (handler as any)._x402PaidMin = 0;
    (handler as any)._x402ServiceType = serviceType;
    (handler as any)._x402Metadata = metadata;
    (handler as any)._x402DynamicPrice = true;
  } else if (minUsdc > 0) {
    (handler as any)._x402PaidMin = minUsdc;
    (handler as any)._x402ServiceType = serviceType;
    (handler as any)._x402Metadata = metadata;
  }
  return handler;
}
