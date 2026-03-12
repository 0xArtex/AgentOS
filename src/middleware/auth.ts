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
        
        // 'general' service type = always allowed for registered agents
        if (serviceType === 'general') {
          next();
          return;
        }

        // For provisioning services, require x402 payment
        if (hasPayment) {
          const paymentAuth = requireX402Payment(minUsdc);
          return paymentAuth(req, res, next);
        }

        send402Response(res, req, minUsdc, "This service requires USDC payment via x402.");
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

        if (serviceType === 'general') {
          next();
          return;
        }

        if (hasPayment) {
          const paymentAuth = requireX402Payment(minUsdc);
          return paymentAuth(req, res, next);
        }

        send402Response(res, req, minUsdc, "This service requires USDC payment via x402.");
        return;
      }
      
      // Not found but has payment — let x402 handle it
      if (hasPayment) {
        const paymentAuth = requireX402Payment(minUsdc);
        return paymentAuth(req, res, next);
      }

      res.status(401).json({
        error: "Agent Not Registered",
        message: "Register your agent first, or pay with x402",
        register: {
          endpoint: "POST /agents/register",
          body: { name: "your-agent-name", walletAddress: "<solana-pubkey>" },
        },
      });
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
      if (sessionToken) {
        const session = db.prepare(
          "SELECT user_id FROM dashboard_sessions WHERE token = ? AND expires_at > datetime('now')"
        ).get(sessionToken) as any;
        if (!session || session.user_id !== dashboardUser) {
          res.status(401).json({ error: "Invalid session for dashboard user" });
          return;
        }
      }
      // Dashboard handles its own balance check + debit via /balance/debit — just authorize here
      req.agentId = `dashboard:${dashboardUser}`;
      next();
      return;
    }

    // No auth at all
    res.status(401).json({
      error: "Authentication Required",
      message: "Register your agent or pay with USDC to use AgentOS",
      register: {
        endpoint: "POST /agents/register",
        body: { name: "your-agent-name", walletAddress: "<solana-pubkey>" },
      },
      payment: {
        method: "x402",
        header: "Payment-Signature: <base64-encoded-payment>",
      },
    });
  };
}
