import { Response } from "express";
import { AuthenticatedRequest } from "../types";
import { isSelfHosted } from "../services/self-hosted";

/**
 * Gate account routes on the one thing that actually has to be configured:
 * the residential proxy. Without it, Playwright can't route any request and
 * every operation would fail anyway. One clear precondition, no feature flag.
 *
 * Shared by the social router and the marketplace router (both drive/transfer
 * proxy-bound sessions), so it lives here rather than inside either one.
 */
export function requireSocialReady(
  _req: AuthenticatedRequest,
  res: Response,
  next: () => void
): void {
  // Self-hosted single-operator mode runs on the operator's own IP with no
  // residential proxy — skip the IPROYAL requirement. Hard-gated off production.
  if (isSelfHosted()) { next(); return; }
  if (!process.env.IPROYAL_HOST || !process.env.IPROYAL_USERNAME || !process.env.IPROYAL_PASSWORD) {
    res.status(503).json({
      error: "Social operations not configured",
      message:
        "Server is missing IPROYAL_* env vars. Set IPROYAL_HOST, IPROYAL_PORT, IPROYAL_USERNAME, IPROYAL_PASSWORD to enable X and TikTok flows.",
    });
    return;
  }
  next();
}
