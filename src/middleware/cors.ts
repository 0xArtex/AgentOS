import { Request, Response, NextFunction } from "express";

/**
 * CORS middleware — allows browser-based agents to call Palmyr API.
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Payment, X-Agent-Id, X-Api-Key, Payment-Signature, PAYMENT-SIGNATURE, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, X-Payment-Required, Payment-Response, PAYMENT-RESPONSE, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}
