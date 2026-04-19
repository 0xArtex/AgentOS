import { Response, NextFunction } from "express";
import { requireX402Payment, send402Response } from "./x402";
import { db } from "../db";
import { AuthenticatedRequest } from "../types";
import * as balanceService from "../services/balance";
import { getOrCreateWallet } from "../services/deposit-wallets";

/**
 * Authentication middleware for AgentOS
 * 
 * Flow:
 * 1. Agent token (aos_*) → identified, check for x402 payment if needed
 * 2. X-Agent-Id header → look up agent, same logic
 * 3. x402 USDC payment → always works, no registration needed
 * 4. No auth → 401
 */
export function requireAuth(minUsdc: number, serviceType: 'phone' | 'email' | 'server' | 'general' = 'general') {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    
    const authHeader = req.headers["authorization"]?.toString().replace("Bearer ", "");
    const apiKey = authHeader || req.headers["x-api-key"] as string || req.headers["x-agent-token"] as string;
    const hasPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);
    
    // Method 1: Registered agent token
    if (apiKey && (apiKey.startsWith("aos_") || apiKey.startsWith("agt_"))) {
      const agent = db.prepare("SELECT * FROM agents WHERE token = ?").get(apiKey) as any;
      if (agent) {
        req.agentId = agent.colosseum_id || agent.wallet_address || agent.id;

        // Free endpoints (minUsdc === 0) — identified agents pass through.
        // Paid endpoints ALWAYS require x402 payment, regardless of serviceType.
        if (minUsdc === 0) {
          next();
          return;
        }

        if (hasPayment) {
          const paymentAuth = requireX402Payment(minUsdc);
          return paymentAuth(req, res, next);
        }

        send402Response(res, req, minUsdc, "Pay with USDC to use this service. Your wallet = your identity.");
        return;
      }
    }

    // Method 2: X-Agent-Id header
    if (req.headers["x-agent-id"]) {
      const agentId = req.headers["x-agent-id"] as string;
      const agent = db.prepare(
        "SELECT * FROM agents WHERE colosseum_id = ? OR name = ? OR id = ?"
      ).get(agentId, agentId, agentId) as any;

      if (agent) {
        req.agentId = agent.colosseum_id || agent.wallet_address || agent.id;

        if (minUsdc === 0) {
          next();
          return;
        }

        if (hasPayment) {
          const paymentAuth = requireX402Payment(minUsdc);
          return paymentAuth(req, res, next);
        }

        send402Response(res, req, minUsdc, "Pay with USDC to use this service. Your wallet = your identity.");
        return;
      }

      // Not found but has payment — let x402 handle it
      if (hasPayment) {
        const paymentAuth = requireX402Payment(minUsdc);
        return paymentAuth(req, res, next);
      }

      send402Response(res, req, minUsdc, "Pay with USDC to use this service. Your wallet address becomes the owner.");
      return;
    }

    // Method 3: x402 payment only (no registration needed)
    if (hasPayment) {
      const paymentAuth = requireX402Payment(minUsdc);
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
      // Dashboard users must have sufficient balance for any paid service.
      if (minUsdc > 0) {
        const bal = balanceService.getBalance(dashboardUser);
        if (bal.balance_usdc < minUsdc) {
          res.status(402).json({ error: "Insufficient balance", required: minUsdc, balance: bal.balance_usdc });
          return;
        }
      }
      req.agentId = `dashboard:${dashboardUser}`;
      next();
      return;
    }

    // No auth at all — send 402 so x402-compatible agents can pay
    send402Response(res, req, minUsdc, "Pay with USDC to use this service. Your wallet address becomes the owner.");
  };
}
