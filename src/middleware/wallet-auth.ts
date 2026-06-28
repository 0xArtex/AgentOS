/**
 * Wallet auth middleware — accepts either:
 *   1. Dashboard session token (Bearer) — for human users
 *   2. Palmyr API key (agos_key_...) — for agents
 *
 * Sets on req:
 *   - req.dashUserId (string) — if dashboard auth
 *   - req.agentApiKey ({ id, walletIds, policyIds }) — if API key auth
 *
 * Routes should call resolveWalletAccess(req, walletId) to check access.
 */
import { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { validateApiKey } from "../services/wallet-vault";

export interface WalletAuthRequest extends Request {
  dashUserId?: string;
  dashUser?: any;
  agentApiKey?: {
    id: string;
    name: string;
    walletIds: string[];   // OWS wallet IDs the agent can access
    policyIds: string[];
  };
}

/**
 * Resolve auth from either dashboard session OR OWS API key.
 * Does not reject — routes decide what they need.
 */
export function resolveWalletAuth(req: WalletAuthRequest, _res: Response, next: NextFunction): void {
  // Never trust an inbound X-Dashboard-User: downstream balance metering / auth
  // keys off this header, so a forged one would let a caller act as another user.
  // Strip it up front and only re-set it below from a VALIDATED session, so the
  // only X-Dashboard-User that survives is one this middleware vouched for (this
  // mirrors resolveDashboardSession, which strips the same header).
  delete req.headers["x-dashboard-user"];

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  // Try Palmyr API key first (prefix match)
  if (token.startsWith("agos_key_")) {
    const keyInfo = validateApiKey(token);
    if (keyInfo) {
      req.agentApiKey = keyInfo;
    }
    return next();
  }

  // Otherwise, try dashboard session
  if (token) {
    const session = db.prepare(
      "SELECT s.user_id, u.email, u.wallet_address, u.display_name FROM dashboard_sessions s JOIN dashboard_users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')",
    ).get(token) as any;

    if (session) {
      req.dashUserId = session.user_id;
      req.dashUser = session;
      req.headers["x-dashboard-user"] = session.user_id;
    }
  }

  next();
}

/**
 * Require EITHER dashboard auth OR OWS API key auth.
 * Returns 401 if neither is present.
 */
export function requireWalletAuth(req: WalletAuthRequest, res: Response, next: NextFunction): void {
  resolveWalletAuth(req, res, () => {
    if (!req.dashUserId && !req.agentApiKey) {
      res.status(401).json({
        error: "Authentication required",
        message: "Provide a dashboard session token or Palmyr API key (agos_key_...) in the Authorization header",
      });
      return;
    }
    next();
  });
}

/**
 * Require dashboard auth only (no API key).
 * Used for wallet management operations (create, delete, create API key).
 */
export function requireDashboardOnly(req: WalletAuthRequest, res: Response, next: NextFunction): void {
  resolveWalletAuth(req, res, () => {
    if (!req.dashUserId) {
      res.status(401).json({
        error: "Dashboard authentication required",
        message: "This operation requires a dashboard session token (not an agent API key)",
      });
      return;
    }
    next();
  });
}

/**
 * Check if the current request has access to a specific wallet (by Palmyr wallet ID).
 *
 * - Dashboard users: verify wallet.user_id matches req.dashUserId
 * - Agent API keys: verify wallet.vault_wallet_id is in req.agentApiKey.walletIds
 *
 * Returns the wallet row if access granted, null otherwise.
 */
export function resolveWalletAccess(req: WalletAuthRequest, walletId: string): any | null {
  const wallet = db.prepare("SELECT * FROM agent_wallets WHERE id = ?").get(walletId) as any;
  if (!wallet) return null;

  // Dashboard user — verify ownership
  if (req.dashUserId) {
    if (wallet.user_id === req.dashUserId) return wallet;
  }

  // Agent API key — verify vault wallet ID is in scope
  if (req.agentApiKey) {
    if (req.agentApiKey.walletIds.includes(wallet.vault_wallet_id)) return wallet;
  }

  return null;
}
