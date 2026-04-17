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
import {
  postTweet,
  replyToTweet,
  likeTweet,
  retweetTweet,
  followUser,
  deleteTweet,
  unfollowUser,
  updateProfile,
  updateAvatar,
  updateBanner,
  changeUsername,
} from "../services/social-operations";

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
  requireAuth(0.005, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const { account_id, login, password, totp_seed, auth_token, ct0 } = (req.body || {}) as {
      account_id?: string;
      login?: string;
      password?: string;
      totp_seed?: string;
      auth_token?: string;
      ct0?: string;
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
        auth_token,
        ct0,
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

/* ─── Operations: post / reply / like / retweet / follow ──────────── */

function validateOpBody(req: AuthenticatedRequest, res: Response): null | {
  account_id: string;
  cookies: any[];
} {
  const { account_id, cookies } = (req.body || {}) as {
    account_id?: string;
    cookies?: any[];
  };
  if (!account_id || !Array.isArray(cookies) || cookies.length === 0) {
    res.status(400).json({
      error: "Missing required fields",
      message: "account_id and a non-empty cookies array are required.",
    });
    return null;
  }
  return { account_id, cookies };
}

router.post(
  "/twitter/post",
  requireXEnabled,
  requireAuth(0.001, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { text } = req.body as { text?: string };
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    try {
      const result = await postTweet({ ...common, text });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Post failed" });
    }
  }
);

router.post(
  "/twitter/reply",
  requireXEnabled,
  requireAuth(0.001, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { tweet_url, text } = req.body as { tweet_url?: string; text?: string };
    if (!tweet_url || !text) {
      res.status(400).json({ error: "tweet_url and text are required" });
      return;
    }
    try {
      const result = await replyToTweet({ ...common, tweet_url, text });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Reply failed" });
    }
  }
);

router.post(
  "/twitter/like",
  requireXEnabled,
  requireAuth(0.001, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { tweet_url } = req.body as { tweet_url?: string };
    if (!tweet_url) {
      res.status(400).json({ error: "tweet_url is required" });
      return;
    }
    try {
      const result = await likeTweet({ ...common, tweet_url });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Like failed" });
    }
  }
);

router.post(
  "/twitter/retweet",
  requireXEnabled,
  requireAuth(0.001, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { tweet_url } = req.body as { tweet_url?: string };
    if (!tweet_url) {
      res.status(400).json({ error: "tweet_url is required" });
      return;
    }
    try {
      const result = await retweetTweet({ ...common, tweet_url });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Retweet failed" });
    }
  }
);

router.post(
  "/twitter/follow",
  requireXEnabled,
  requireAuth(0.001, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { target_user } = req.body as { target_user?: string };
    if (!target_user) {
      res.status(400).json({ error: "target_user is required" });
      return;
    }
    try {
      const result = await followUser({ ...common, target_user });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Follow failed" });
    }
  }
);

router.post(
  "/twitter/unfollow",
  requireXEnabled,
  requireAuth(0.001, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { target_user } = req.body as { target_user?: string };
    if (!target_user) {
      res.status(400).json({ error: "target_user is required" });
      return;
    }
    try {
      const result = await unfollowUser({ ...common, target_user });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Unfollow failed" });
    }
  }
);

router.post(
  "/twitter/delete",
  requireXEnabled,
  requireAuth(0.001, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { tweet_url } = req.body as { tweet_url?: string };
    if (!tweet_url) {
      res.status(400).json({ error: "tweet_url is required" });
      return;
    }
    try {
      const result = await deleteTweet({ ...common, tweet_url });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Delete failed" });
    }
  }
);

router.post(
  "/twitter/profile",
  requireXEnabled,
  requireAuth(0.001, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { bio, display_name, location, website } = req.body as {
      bio?: string;
      display_name?: string;
      location?: string;
      website?: string;
    };
    try {
      const result = await updateProfile({ ...common, bio, display_name, location, website });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Profile update failed" });
    }
  }
);

// Profile images cost slightly more because they transfer a file (up to 10 MB)
// plus a 2-step upload+crop+save UI flow that takes ~20s of browser time.
router.post(
  "/twitter/avatar",
  requireXEnabled,
  requireAuth(0.005, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { image_base64, image_url } = req.body as { image_base64?: string; image_url?: string };
    if (!image_base64 && !image_url) {
      res.status(400).json({ error: "image_base64 or image_url is required" });
      return;
    }
    try {
      const result = await updateAvatar({ ...common, image_base64, image_url });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Avatar update failed" });
    }
  }
);

router.post(
  "/twitter/banner",
  requireXEnabled,
  requireAuth(0.005, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { image_base64, image_url } = req.body as { image_base64?: string; image_url?: string };
    if (!image_base64 && !image_url) {
      res.status(400).json({ error: "image_base64 or image_url is required" });
      return;
    }
    try {
      const result = await updateBanner({ ...common, image_base64, image_url });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Banner update failed" });
    }
  }
);

router.post(
  "/twitter/username",
  requireXEnabled,
  requireAuth(0.005, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { new_username, password } = req.body as { new_username?: string; password?: string };
    if (!new_username || !password) {
      res.status(400).json({ error: "new_username and password are required" });
      return;
    }
    try {
      const result = await changeUsername({ ...common, new_username, password });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Username change failed" });
    }
  }
);

export default router;
