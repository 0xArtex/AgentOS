import { Response, NextFunction } from "express";
import { hackathonMode, HackathonRequest, isHackathonActive } from "./hackathon";
import { x402 } from "./x402";
import { config } from "../config";

/**
 * Combined authentication middleware for AgentOS
 * 
 * During hackathon mode: tries X-Agent-Id first, falls back to x402 payment
 * After hackathon: requires x402 payment only
 */
export function requireAuth(minUsdc: number, serviceType: 'phone' | 'email' | 'server' | 'general' = 'general') {
  return async (req: HackathonRequest, res: Response, next: NextFunction): Promise<void> => {
    // If hackathon mode is active and agent provides X-Agent-Id, try hackathon auth
    if (isHackathonActive() && req.headers["x-agent-id"]) {
      const hackathonAuth = hackathonMode(serviceType as 'phone' | 'email' | 'server');
      
      return hackathonAuth(req, res, (hackathonErr?: any) => {
        if (hackathonErr) {
          // Hackathon auth failed, fall back to x402
          const paymentAuth = x402(minUsdc);
          return paymentAuth(req, res, next);
        } else {
          // Hackathon auth succeeded
          next();
        }
      });
    }
    
    // Use x402 payment authentication
    const paymentAuth = x402(minUsdc);
    return paymentAuth(req, res, next);
  };
}