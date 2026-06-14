import { Request, Response, NextFunction } from "express";
import { requireX402Payment, send402Response, X402Metadata } from "./x402";
import { db } from "../db";
import { AuthenticatedRequest } from "../types";
import * as balanceService from "../services/balance";
import { getOrCreateWallet } from "../services/deposit-wallets";
import { isSelfHosted, selfHostedIdentity } from "../services/self-hosted";

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

    // Method 2: X-Agent-Id header. Accept any identifier the caller has for the
    // agent row (wallet, name, or id) but resolve the effective identity to the
    // wallet address so downstream ownership checks are consistent.
    if (req.headers["x-agent-id"]) {
      const agentId = req.headers["x-agent-id"] as string;
      const agent = db.prepare(
        "SELECT * FROM agents WHERE wallet_address = ? OR name = ? OR id = ?"
      ).get(agentId, agentId, agentId) as any;

      if (agent) {
        req.agentId = agent.wallet_address || agent.id;

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

      // Not found but has payment — let x402 handle it
      if (hasPayment) {
        const paymentAuth = requireX402Payment(price, metadata);
        return paymentAuth(req, res, next);
      }

      send402Response(res, req, price, "Pay with USDC to use this service. Your wallet address becomes the owner.", metadata);
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
        const bal = balanceService.getBalance(dashboardUser);
        if (bal.balance_usdc < price) {
          res.status(402).json({
            error: "Insufficient balance",
            code: "insufficient_balance",
            required: price,
            balance: bal.balance_usdc,
          });
          return;
        }

        // Charge on SUCCESS only (statusCode < 400), exactly once, after the
        // handler finishes. Charging on success avoids billing for failed
        // operations (e.g. no inventory → 400, domain taken → 409, provider
        // error → 5xx) and mirrors how wallet payers are made whole on failure
        // by the refund path.
        //
        // Dynamic-price routes: the `price` resolved above is the amount a
        // wallet payer would settle on-chain for this same request — it is
        // deterministic for /social/twitter/buy (resolveBuyPrice) and already a
        // concrete per-TLD number for /domains/register (requireDomainPayment
        // resolves it before delegating here). A handler that computes a
        // different actual charge can override the metered amount by setting
        // `res.locals.x402ActualCharge`; absent that, we charge the resolved
        // `price`, which is exact for every paid route today.
        let debited = false;
        res.on("finish", () => {
          if (debited) return; // guard against double-debit
          debited = true;
          if (res.statusCode >= 400) return; // only charge successful responses
          const localCharge = (res.locals && (res.locals as any).x402ActualCharge);
          const amount = typeof localCharge === "number" && localCharge >= 0 ? localCharge : price;
          if (amount <= 0) return;
          try {
            balanceService.debit(
              dashboardUser,
              amount,
              serviceType,
              `${req.method} ${req.originalUrl.split("?")[0]}`,
            );
          } catch (err: any) {
            // Response already sent — we can't change it. This only happens if
            // a concurrent dashboard request drained the balance between the
            // up-front check and here; debit() refuses to go negative, so the
            // platform never over-refunds and the balance never desyncs. Log
            // for reconciliation.
            console.error(
              `[auth] dashboard debit failed for ${dashboardUser} ($${amount} ${serviceType} on ${req.method} ${req.originalUrl.split("?")[0]}):`,
              err?.message ?? err,
            );
          }
        });
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
