import { Response, NextFunction } from "express";
import { config } from "../config";
import { AuthenticatedRequest } from "../types";
import { db } from "../db";

/**
 * Hackathon Mode Middleware
 *
 * Alternative to x402 payment during Colosseum hackathon.
 * Expects header: X-Agent-Id: <colosseum-agent-id-or-name>
 *
 * Rate limits:
 * - Max 5 phone numbers per agent
 * - Max 5 email inboxes per agent  
 * - Max 2 servers per agent
 *
 * Only active if HACKATHON_MODE=true and before HACKATHON_END deadline.
 */

interface HackathonLimits {
  maxPhoneNumbers: number;
  maxEmailInboxes: number;
  maxServers: number;
}

const HACKATHON_LIMITS: HackathonLimits = {
  maxPhoneNumbers: 1,
  maxEmailInboxes: 1,
  maxServers: 1,
};

export interface HackathonRequest extends AuthenticatedRequest {
  agentId?: string;
  isHackathonMode?: boolean;
}

export function hackathonMode(serviceType: 'phone' | 'email' | 'server') {
  return async (req: HackathonRequest, res: Response, next: NextFunction): Promise<void> => {
    // If hackathon mode is not enabled, continue to next middleware (x402)
    if (!config.hackathonMode) {
      next();
      return;
    }

    // Check if hackathon deadline has passed
    const now = new Date();
    const deadline = new Date(config.hackathonEnd);
    if (now > deadline) {
      res.status(403).json({
        error: "Hackathon Expired",
        message: `Hackathon mode ended on ${config.hackathonEnd}. Please use x402 payment.`,
        hint: "Include a Solana USDC transaction signature in the X-Payment header"
      });
      return;
    }

    const agentId = req.headers["x-agent-id"] as string | undefined;

    if (!agentId) {
      res.status(400).json({
        error: "Agent ID Required", 
        message: "During hackathon mode, include your Colosseum agent ID in the X-Agent-Id header",
        hint: "Example: X-Agent-Id: my-trading-bot"
      });
      return;
    }

    try {
      // Check current usage for this agent
      const usage = getAgentUsage(agentId);
      
      // Check rate limits
      const limits = HACKATHON_LIMITS;
      
      if (serviceType === 'phone' && usage.phoneNumbers >= limits.maxPhoneNumbers) {
        res.status(429).json({
          error: "Phone Number Limit Reached",
          message: `Agent "${agentId}" has reached the hackathon limit of ${limits.maxPhoneNumbers} phone numbers`,
          hint: "Delete existing phone numbers or use x402 payment for more",
          usage: usage.phoneNumbers,
          limit: limits.maxPhoneNumbers
        });
        return;
      }
      
      if (serviceType === 'email' && usage.emailInboxes >= limits.maxEmailInboxes) {
        res.status(429).json({
          error: "Email Inbox Limit Reached", 
          message: `Agent "${agentId}" has reached the hackathon limit of ${limits.maxEmailInboxes} email inboxes`,
          hint: "Delete existing inboxes or use x402 payment for more",
          usage: usage.emailInboxes,
          limit: limits.maxEmailInboxes
        });
        return;
      }
      
      if (serviceType === 'server' && usage.servers >= limits.maxServers) {
        res.status(429).json({
          error: "Server Limit Reached",
          message: `Agent "${agentId}" has reached the hackathon limit of ${limits.maxServers} servers`,
          hint: "Delete existing servers or use x402 payment for more", 
          usage: usage.servers,
          limit: limits.maxServers
        });
        return;
      }

      // Set agent context and hackathon flag
      req.agentId = agentId;
      req.isHackathonMode = true;
      
      next();
    } catch (err) {
      console.error("[hackathon] Usage check error:", err);
      res.status(500).json({
        error: "Usage Check Failed",
        message: "Internal error while checking hackathon usage limits",
        hint: "Try again or contact support"
      });
    }
  };
}

export function trackHackathonUsage(agentId: string, serviceType: 'phone' | 'email' | 'server', resourceId: string): void {
  try {
    const stmt = db.prepare(`
      INSERT INTO hackathon_usage (agent_id, service_type, resource_id)
      VALUES (?, ?, ?)
    `);
    stmt.run(agentId, serviceType, resourceId);
  } catch (err) {
    console.error("[hackathon] Failed to track usage:", err);
  }
}

export function getAgentUsage(agentId: string): { phoneNumbers: number; emailInboxes: number; servers: number } {
  try {
    const phoneNumbers = db.prepare(`
      SELECT COUNT(*) as count 
      FROM hackathon_usage 
      WHERE agent_id = ? AND service_type = 'phone'
    `).get(agentId) as { count: number };
    
    const emailInboxes = db.prepare(`
      SELECT COUNT(*) as count 
      FROM hackathon_usage 
      WHERE agent_id = ? AND service_type = 'email'
    `).get(agentId) as { count: number };
    
    const servers = db.prepare(`
      SELECT COUNT(*) as count 
      FROM hackathon_usage 
      WHERE agent_id = ? AND service_type = 'server'
    `).get(agentId) as { count: number };

    return {
      phoneNumbers: phoneNumbers.count,
      emailInboxes: emailInboxes.count,
      servers: servers.count
    };
  } catch (err) {
    console.error("[hackathon] Failed to get usage:", err);
    return { phoneNumbers: 0, emailInboxes: 0, servers: 0 };
  }
}

export function isHackathonActive(): boolean {
  if (!config.hackathonMode) return false;
  
  const now = new Date();
  const deadline = new Date(config.hackathonEnd);
  return now <= deadline;
}