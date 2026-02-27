import { Request, Response, NextFunction } from "express";
import { db } from "../db";

export interface DashboardRequest extends Request {
  dashUserId?: string;
  dashUser?: any;
}

/**
 * Middleware that resolves a Bearer token to a dashboard user.
 * Sets req.dashUserId and req.dashUser if valid session exists.
 * Does NOT reject — routes decide if auth is required.
 */
export function resolveDashboardSession(req: DashboardRequest, _res: Response, next: NextFunction): void {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return next();

  const session = db.prepare(
    "SELECT s.user_id, u.email, u.wallet_address, u.display_name FROM dashboard_sessions s JOIN dashboard_users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).get(token) as any;

  if (session) {
    req.dashUserId = session.user_id;
    req.dashUser = session;
    // Also set X-Dashboard-User header so balance middleware picks it up
    req.headers["x-dashboard-user"] = session.user_id;
  }

  next();
}

/**
 * Require dashboard auth — returns 401 if not authenticated.
 */
export function requireDashboardAuth(req: DashboardRequest, res: Response, next: NextFunction): void {
  resolveDashboardSession(req, res, () => {
    if (!req.dashUserId) {
      res.status(401).json({ error: "Authentication required", login: "/auth/login or /auth/wallet" });
      return;
    }
    next();
  });
}
