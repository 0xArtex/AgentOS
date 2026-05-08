/**
 * Social account routes. Phase 2 scope: X (Twitter) login via headless
 * Chromium through an IPRoyal residential proxy, returning session cookies
 * to the client for local caching.
 *
 * Credentials transit the request body only — they are never written to disk,
 * logged, or returned. Only cookies come back.
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { requirePoolAdmin } from "../middleware/pool-admin";
import { AuthenticatedRequest } from "../types";
import { loginTwitter } from "../services/social-login";
import { poolAdd, poolBuy, poolStatus, poolMarkDead } from "../services/social-pool";
import {
  postTweet,
  postTweetThread,
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
  listMyTweets,
} from "../services/social-operations";
import { loginTikTok } from "../services/tiktok-login";
import {
  postVideo as tiktokPostVideo,
  followUser as tiktokFollow,
  likeVideo as tiktokLike,
  deleteVideo as tiktokDelete,
  updateProfile as tiktokUpdateProfile,
  updateAvatar as tiktokUpdateAvatar,
} from "../services/tiktok-operations";

const router = Router();

/**
 * Gate social routes on the one thing that actually has to be configured:
 * the residential proxy. Without it, Playwright can't route any request and
 * every operation would fail anyway. One clear precondition, no feature flag.
 */
function requireSocialReady(
  _req: AuthenticatedRequest,
  res: Response,
  next: () => void
): void {
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

// Back-compat aliases so all existing handler wiring keeps working.
const requireXEnabled = requireSocialReady;
const requireTikTokEnabled = requireSocialReady;

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

// Thread is one composed-and-submitted browser session covering up to 25
// tweets, so it costs the same flat 5x rate as multi-step ops like avatar —
// not 25x a single post. Volume and rate-limit headroom are bounded server-side.
router.post(
  "/twitter/post-thread",
  requireXEnabled,
  requireAuth(0.005, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { texts } = req.body as { texts?: string[] };
    if (!Array.isArray(texts) || texts.length === 0) {
      res.status(400).json({ error: "texts must be a non-empty array of strings" });
      return;
    }
    try {
      const result = await postTweetThread({ ...common, texts });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Post thread failed" });
    }
  }
);

router.post(
  "/twitter/list-my-tweets",
  requireXEnabled,
  requireAuth(0.005, "general", { discoverable: false }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { limit } = req.body as { limit?: number };
    try {
      const result = await listMyTweets({ ...common, limit });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "List tweets failed" });
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
  requireAuth(0.001, "general", { discoverable: false }),
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
  requireAuth(0.001, "general", { discoverable: false }),
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
  requireAuth(0.005, "general", { discoverable: false }),
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
  requireAuth(0.005, "general", { discoverable: false }),
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
      // Only accept the documented 4 / 5 / 7-field formats exactly. Anything
      // else indicates a password containing `:` — the caller must use the
      // explicit-flag path instead to avoid a silent mis-split.
      if (![4, 5, 7].includes(parts.length)) {
        res.status(400).json({
          error: "credentials_line must have exactly 4, 5, or 7 colon-separated fields",
          hint: "If your password contains ':', use explicit body fields instead of credentials_line.",
          got: parts.length,
        });
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

      // Validate typed fields. A mis-split will almost always fail one of
      // these checks — fail fast rather than storing garbage credentials.
      if (creds.totp_seed !== undefined && !/^[A-Z2-7]{16,64}$/.test(creds.totp_seed)) {
        res.status(400).json({
          error: "credentials_line: 5th field must be an RFC 4648 base32 TOTP seed (16-64 chars of A-Z 2-7)",
          hint: "Your password probably contains ':' — use explicit body fields instead.",
        });
        return;
      }
      if (creds.ct0 !== undefined && !/^[0-9a-f]{16,64}$/i.test(creds.ct0)) {
        res.status(400).json({
          error: "credentials_line: 6th field must be the X `ct0` cookie (16-64 hex chars)",
          hint: "Your password probably contains ':' — use explicit body fields instead.",
        });
        return;
      }
      if (creds.auth_token !== undefined && !/^[0-9a-f]{32,80}$/i.test(creds.auth_token)) {
        res.status(400).json({
          error: "credentials_line: 7th field must be the X `auth_token` cookie (32-80 hex chars)",
          hint: "Your password probably contains ':' — use explicit body fields instead.",
        });
        return;
      }

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
  requireAuth(0.005, "general", { discoverable: false }),
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

/* ═══════════════════════════════════════════════════════════════════════
   TikTok routes — same shape as Twitter: cookies travel in the body,
   the server opens a Playwright session through the per-account proxy,
   and the response carries the captured cookies or the operation result.
   ═══════════════════════════════════════════════════════════════════════ */

function validateTikTokOpBody(req: AuthenticatedRequest, res: Response): null | {
  account_id: string;
  proxy_session_id?: string;
  country?: string;
  cookies: any[];
} {
  const { account_id, cookies, proxy_session_id, country } = (req.body || {}) as {
    account_id?: string;
    proxy_session_id?: string;
    country?: string;
    cookies?: any[];
  };
  if (!account_id || !Array.isArray(cookies) || cookies.length === 0) {
    res.status(400).json({
      error: "Missing required fields",
      message: "account_id and a non-empty cookies array are required.",
    });
    return null;
  }
  return { account_id, proxy_session_id, country, cookies };
}

// Login is priced higher when it has to solve a captcha (~$0.02 vs $0.005).
// We charge the higher rate up front and don't refund on captcha-less logins,
// since the browser spin-up cost dominates either way.
router.post(
  "/tiktok/login",
  requireTikTokEnabled,
  requireAuth(0.02, "general", { discoverable: false }),
  async (req: AuthenticatedRequest, res: Response) => {
    const {
      account_id,
      proxy_session_id,
      country,
      sessionid,
      tt_csrf_token,
      tt_webid_v2,
      extra_cookies,
      login,
      password,
      email,
      email_password,
    } = (req.body || {}) as {
      account_id?: string;
      proxy_session_id?: string;
      country?: string;
      sessionid?: string;
      tt_csrf_token?: string;
      tt_webid_v2?: string;
      extra_cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>;
      login?: string;
      password?: string;
      email?: string;
      email_password?: string;
    };

    if (!account_id) {
      res.status(400).json({ error: "account_id required" });
      return;
    }
    if (!sessionid && !(login && password)) {
      res.status(400).json({
        error: "Missing credentials",
        message: "Provide either { sessionid } for cookie-injection login, or { login, password } for form login.",
      });
      return;
    }

    try {
      const result = await loginTikTok({
        account_id,
        proxy_session_id,
        country,
        sessionid,
        tt_csrf_token,
        tt_webid_v2,
        extra_cookies,
        login,
        password,
        email,
        email_password,
      });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok login failed" });
    }
  }
);

// Post is priced higher than other ops because the video upload takes longer
// (and uses more proxy bandwidth). Follow / like / profile stay at $0.001.
router.post(
  "/tiktok/post",
  requireTikTokEnabled,
  requireAuth(0.01, "general", { discoverable: false }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { caption, video_base64, video_url, privacy, allow_comments, allow_duet, allow_stitch } = req.body as any;
    if (!caption) { res.status(400).json({ error: "caption is required" }); return; }
    if (!video_base64 && !video_url) { res.status(400).json({ error: "video_base64 or video_url is required" }); return; }
    try {
      const result = await tiktokPostVideo({
        ...common, caption, video_base64, video_url, privacy, allow_comments, allow_duet, allow_stitch,
      });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok post failed" });
    }
  }
);

router.post(
  "/tiktok/follow",
  requireTikTokEnabled,
  requireAuth(0.001, "general", { discoverable: false }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { target_user } = req.body as { target_user?: string };
    if (!target_user) { res.status(400).json({ error: "target_user required" }); return; }
    try {
      const result = await tiktokFollow({ ...common, target_user });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok follow failed" });
    }
  }
);

router.post(
  "/tiktok/like",
  requireTikTokEnabled,
  requireAuth(0.001, "general", { discoverable: false }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { video_url } = req.body as { video_url?: string };
    if (!video_url) { res.status(400).json({ error: "video_url required" }); return; }
    try {
      const result = await tiktokLike({ ...common, video_url });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok like failed" });
    }
  }
);

router.post(
  "/tiktok/delete",
  requireTikTokEnabled,
  requireAuth(0.001, "general", { discoverable: false }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { video_url } = req.body as { video_url?: string };
    if (!video_url) { res.status(400).json({ error: "video_url required" }); return; }
    try {
      const result = await tiktokDelete({ ...common, video_url });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok delete failed" });
    }
  }
);

router.post(
  "/tiktok/profile",
  requireTikTokEnabled,
  requireAuth(0.001, "general", { discoverable: false }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { bio, display_name } = req.body as { bio?: string; display_name?: string };
    try {
      const result = await tiktokUpdateProfile({ ...common, bio, display_name });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok profile update failed" });
    }
  }
);

router.post(
  "/tiktok/avatar",
  requireTikTokEnabled,
  requireAuth(0.005, "general", { discoverable: false }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { image_base64, image_url } = req.body as { image_base64?: string; image_url?: string };
    if (!image_base64 && !image_url) { res.status(400).json({ error: "image_base64 or image_url required" }); return; }
    try {
      const result = await tiktokUpdateAvatar({ ...common, image_base64, image_url });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok avatar update failed" });
    }
  }
);

export default router;
