/**
 * Social account routes. Phase 2 scope: X (Twitter) login via headless
 * Chromium through an IPRoyal residential proxy, returning session cookies
 * to the client for local caching.
 *
 * Credentials transit the request body only — they are never written to disk,
 * logged, or returned. Only cookies come back.
 */
import { Router, Request, Response, NextFunction } from "express";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { loginTwitter } from "../services/social-login";
import { poolAdd, poolBuy, poolStatus, poolMarkDead } from "../services/social-pool";
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
 * Pool-admin middleware — wallet-signature auth.
 *
 * Server env `POOL_ADMIN_WALLETS` = comma-separated Solana pubkeys allowed
 * to call admin endpoints. Client sends three headers:
 *   X-Admin-Pubkey:    admin's Solana pubkey (base58)
 *   X-Admin-Timestamp: unix ms when the signature was made
 *   X-Admin-Signature: Ed25519 sig (hex) over `<method>:<path>:<timestamp>`
 *
 * The timestamp must be within 60s of server time (prevents replay). The
 * pubkey must be in the whitelist. The signature must verify over the
 * bound message. No shared secrets; multi-admin is just adding a pubkey.
 */
const ADMIN_TIMESTAMP_SKEW_MS = 60_000;

function requirePoolAdmin(req: Request, res: Response, next: NextFunction): void {
  const whitelist = (process.env.POOL_ADMIN_WALLETS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (whitelist.length === 0) {
    res.status(503).json({
      error: "Pool admin not configured",
      message: "POOL_ADMIN_WALLETS env is empty. Add admin Solana pubkey(s) comma-separated.",
    });
    return;
  }

  const pubkey = (req.headers["x-admin-pubkey"] || "") as string;
  const timestamp = (req.headers["x-admin-timestamp"] || "") as string;
  const signature = (req.headers["x-admin-signature"] || "") as string;

  if (!pubkey || !timestamp || !signature) {
    res.status(401).json({
      error: "Missing admin signature headers",
      message: "Required: X-Admin-Pubkey, X-Admin-Timestamp, X-Admin-Signature",
    });
    return;
  }

  if (!whitelist.includes(pubkey)) {
    res.status(403).json({ error: "Pubkey not in admin whitelist" });
    return;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > ADMIN_TIMESTAMP_SKEW_MS) {
    res.status(401).json({
      error: "Timestamp stale or invalid",
      message: `Must be within ${ADMIN_TIMESTAMP_SKEW_MS / 1000}s of server time`,
    });
    return;
  }

  // Message binds the HTTP method and path so a signature for GET /pool-status
  // can't be replayed against POST /pool-add.
  const message = `${req.method}:${req.path}:${timestamp}`;
  try {
    const pubkeyBytes = bs58.decode(pubkey);
    const sigBytes = Buffer.from(signature, "hex");
    const ok = nacl.sign.detached.verify(
      Buffer.from(message, "utf8"),
      sigBytes,
      pubkeyBytes
    );
    if (!ok) {
      res.status(401).json({ error: "Invalid admin signature" });
      return;
    }
  } catch (e: any) {
    res.status(401).json({ error: `Signature verification failed: ${e.message}` });
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
    const { account_id, proxy_session_id, login, password, totp_seed, auth_token, ct0 } = (req.body || {}) as {
      account_id?: string;
      proxy_session_id?: string;
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
        proxy_session_id,
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
  proxy_session_id?: string;
  cookies: any[];
} {
  const { account_id, cookies, proxy_session_id } = (req.body || {}) as {
    account_id?: string;
    proxy_session_id?: string;
    cookies?: any[];
  };
  if (!account_id || !Array.isArray(cookies) || cookies.length === 0) {
    res.status(400).json({
      error: "Missing required fields",
      message: "account_id and a non-empty cookies array are required.",
    });
    return null;
  }
  return { account_id, proxy_session_id, cookies };
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

/* ─── Pool: admin seeding + status ──────────────────────────────────── */

router.post(
  "/twitter/pool-add",
  requireXEnabled,
  requirePoolAdmin,
  async (req: Request, res: Response) => {
    const {
      credentials_line,
      username: explicitUsername,
      login,
      password,
      email,
      email_password,
      totp_seed,
      auth_token,
      ct0,
      profile_url,
      country,
      age_category,
      acquired_cost_usdc,
      sale_price_usdc,
      notes,
    } = (req.body || {}) as Record<string, any>;

    let creds: any = {};
    let username = explicitUsername;

    if (credentials_line && typeof credentials_line === "string") {
      const parts = credentials_line.split(":");
      if (parts.length < 4) {
        res.status(400).json({ error: "credentials_line must have at least 4 colon-separated fields" });
        return;
      }
      creds = {
        login: parts[0],
        password: parts[1],
        email: parts[2],
        email_password: parts[3],
      };
      if (parts[4]) creds.totp_seed = parts[4];
      if (parts[5]) creds.ct0 = parts[5];
      if (parts[6]) creds.auth_token = parts[6];
      if (!username) username = parts[0];
    } else {
      creds = {
        login: login || email,
        password,
        email: email || login,
        email_password,
        totp_seed,
        auth_token,
        ct0,
        profile_url,
      };
    }

    if (!username || !creds.password) {
      res.status(400).json({ error: "username and password (or credentials_line) required" });
      return;
    }
    if (typeof sale_price_usdc !== "number" || sale_price_usdc <= 0) {
      res.status(400).json({ error: "sale_price_usdc must be a positive number" });
      return;
    }

    try {
      const result = await poolAdd({
        platform: "twitter",
        username,
        credentials: creds,
        country,
        age_category,
        acquired_cost_usdc,
        sale_price_usdc,
        notes,
      });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Pool add failed" });
    }
  }
);

router.get(
  "/twitter/pool-status",
  requireXEnabled,
  requirePoolAdmin,
  (_req: Request, res: Response) => {
    res.json(poolStatus());
  }
);

router.post(
  "/twitter/pool-mark-dead",
  requireXEnabled,
  requirePoolAdmin,
  (req: Request, res: Response) => {
    const { id, reason } = (req.body || {}) as { id?: string; reason?: string };
    if (!id) {
      res.status(400).json({ error: "id required" });
      return;
    }
    const updated = poolMarkDead(id, reason || "marked dead by admin");
    res.json({ success: updated });
  }
);

/* ─── Buy: public-facing, paid ─────────────────────────────────────── */

router.post(
  "/twitter/buy",
  requireXEnabled,
  requireAuth(5.0, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const { country, age_category } = (req.body || {}) as {
      country?: string;
      age_category?: string;
    };
    const buyerWallet = req.payment?.payer || req.agentId;
    if (!buyerWallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    try {
      const result = poolBuy({
        platform: "twitter",
        country,
        age_category,
        buyer_wallet: buyerWallet,
      });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Buy failed" });
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
