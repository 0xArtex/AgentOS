/**
 * Social account routes. Phase 2 scope: X (Twitter) login via headless
 * Chromium through an IPRoyal residential proxy, returning session cookies
 * to the client for local caching.
 *
 * Credentials transit the request body only — they are never written to disk,
 * logged, or returned. Only cookies come back.
 */
import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { loginTwitter } from "../services/social-login";

const router = Router();

function requireXEnabled(
  _req: AuthenticatedRequest,
  res: Response,
  next: () => void
): void {
  if (process.env.SOCIAL_X_ENABLED !== "true") {
    res.status(503).json({
      error: "Social X is not enabled",
      message:
        "Set SOCIAL_X_ENABLED=true along with IPROYAL_* env vars on the server to enable X login/post flows.",
    });
    return;
  }
  next();
}

/**
 * POST /social/twitter/login
 * Body: { account_id, login, password, totp_seed? }
 * Returns: { success, cookies, captured_at } on success, else an error code.
 */
router.post(
  "/twitter/login",
  requireXEnabled,
  requireAuth(0.02, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const { account_id, login, password, totp_seed } = (req.body || {}) as {
      account_id?: string;
      login?: string;
      password?: string;
      totp_seed?: string;
    };

    if (!account_id || !login || !password) {
      res.status(400).json({
        error: "Missing required fields",
        message: "account_id, login, and password are required in the body.",
      });
      return;
    }

    try {
      const result = await loginTwitter({
        account_id,
        login,
        password,
        totp_seed,
      });

      // Never reflect the credentials back to the caller.
      if (!result.success) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (err: any) {
      console.error("[social/twitter] login error:", err?.message || err);
      res.status(500).json({
        error: "Login failed",
        message: err?.message || "Unexpected error during login",
      });
    }
  }
);

export default router;
