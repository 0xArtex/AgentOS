import { Response, NextFunction } from "express";
import { HackathonRequest, isHackathonActive } from "./hackathon";
import { trackHackathonUsage } from "./hackathon";
import { requireX402Payment, send402Response } from "./x402";
import { db } from "../db";

/**
 * Combined authentication middleware for AgentOS
 * 
 * Flow:
 * 1. API key (aos_*) from registered agent → check free tier if hackathon verified
 * 2. Legacy agent token (agt_*) → look up agent, same logic
 * 3. x402 USDC payment → always works, no registration needed
 * 4. No auth → tell them to register
 */
export function requireAuth(minUsdc: number, serviceType: 'phone' | 'email' | 'server' | 'general' = 'general') {
  return async (req: HackathonRequest, res: Response, next: NextFunction): Promise<void> => {
    
    // Extract token from various headers
    const authHeader = req.headers["authorization"]?.toString().replace("Bearer ", "");
    const apiKey = authHeader || req.headers["x-api-key"] as string || req.headers["x-agent-token"] as string;
    
    // Method 1: Registered agent token
    if (apiKey && (apiKey.startsWith("aos_") || apiKey.startsWith("agt_"))) {
      const agent = db.prepare("SELECT * FROM agents WHERE token = ?").get(apiKey) as any;
      if (agent) {
        const agentIdentifier = agent.colosseum_id || agent.wallet_address || agent.id;
        req.agentId = agentIdentifier;
        
        // 'general' service type = always allowed for registered agents (reading inbox, etc.)
        if (serviceType === 'general') {
          req.isHackathonMode = isHackathonActive() && agent.hackathon_verified;
          next();
          return;
        }

        // Check hackathon free tier for provisioning services
        if (agent.hackathon_verified && isHackathonActive()) {
          const usage = db.prepare(
            "SELECT COUNT(*) as c FROM hackathon_usage WHERE agent_id = ? AND service_type = ?"
          ).get(agentIdentifier, serviceType) as any;
          
          if (usage.c < 1) {
            req.isHackathonMode = true;
            next();
            return;
          }
          // Free tier exhausted — need payment
        }
        
        // Check x402 payment header (standard protocol)
        if (req.headers["payment-signature"] || req.headers["x-payment"]) {
          const paymentAuth = requireX402Payment(minUsdc);
          return paymentAuth(req, res, next);
        }

        // No payment, free tier used
        send402Response(res, req, minUsdc,
          agent.hackathon_verified 
            ? "Free tier exhausted (1 per service). Pay with USDC via x402."
            : "This service requires USDC payment via x402."
        );
        return;
      }
    }

    // Method 2: Legacy X-Agent-Id header — must be registered
    if (req.headers["x-agent-id"]) {
      const agentId = req.headers["x-agent-id"] as string;
      
      // Look up by colosseum_id or name
      const agent = db.prepare(
        "SELECT * FROM agents WHERE colosseum_id = ? OR name = ? OR id = ?"
      ).get(agentId, agentId, agentId) as any;
      
      if (agent) {
        const agentIdentifier = agent.colosseum_id || agent.wallet_address || agent.id;
        req.agentId = agentIdentifier;
        
        if (agent.hackathon_verified && isHackathonActive() && serviceType !== 'general') {
          const usage = db.prepare(
            "SELECT COUNT(*) as c FROM hackathon_usage WHERE agent_id = ? AND service_type = ?"
          ).get(agentIdentifier, serviceType) as any;
          
          if (usage.c < 1) {
            req.isHackathonMode = true;
            next();
            return;
          }
        }

        send402Response(res, req, minUsdc, "Free tier exhausted or not available. Pay with USDC via x402.");
        return;
      }
      
      // Not found — register first
      res.status(401).json({
        error: "Agent Not Registered",
        message: "Register your agent first",
        register: {
          endpoint: "POST /agents/register",
          body: { name: "your-agent-name", walletAddress: "<solana-pubkey>", agentId: "<optional-colosseum-id>" },
          note: "Colosseum hackathon agents get 1 free email, phone, and server.",
        },
      });
      return;
    }

    // Method 3: x402 payment only (no registration needed)
    if (req.headers["payment-signature"] || req.headers["x-payment"]) {
      const paymentAuth = requireX402Payment(minUsdc);
      return paymentAuth(req, res, next);
    }

    // No auth
    res.status(401).json({
      error: "Authentication Required",
      message: "Register your agent or pay with USDC to use AgentOS",
      register: {
        endpoint: "POST /agents/register",
        body: { name: "your-agent-name", walletAddress: "<solana-pubkey>", agentId: "<optional-colosseum-id>" },
      },
      payment: {
        method: "x402",
        header: "X-Payment: <solana-usdc-transaction-signature>",
      },
    });
  };
}
