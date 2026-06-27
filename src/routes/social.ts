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
import { refundAndRespond } from "../services/refund";
import { AuthenticatedRequest } from "../types";
import { loginTwitter } from "../services/social-login";
import { isSelfHosted } from "../services/self-hosted";
import {
  poolAdd,
  poolBuy,
  availablePoolCountries,
  poolStatus,
  poolMarkDead,
  poolShare,
  poolUnshare,
  poolAccountsAccessibleBy,
} from "../services/social-pool";
import {
  setCountryPrice,
  getCountryPrice,
  listCountryPrices,
  deleteCountryPrice,
} from "../services/country-prices";
import {
  setSourceMultiplier,
  getSourceMultiplier,
  listSourceMultipliers,
  deleteSourceMultiplier,
} from "../services/source-multipliers";
import {
  createDispute,
  getDispute,
  listDisputes,
  resolveDisputeAdmin,
} from "../services/disputes";
import {
  registerAccount,
  unregisterAccount,
  listRegisteredAccounts,
  accountsAccessibleBy,
  getOwnerDecryptedState,
  shareRegistered,
  unshareRegistered,
} from "../services/registered-accounts";
import { createTransfer } from "../services/transfers";
import {
  createScheduled,
  listScheduled,
  cancelScheduled,
} from "../services/scheduled-posts";
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
import { putQr } from "../services/qr-handoff";
import {
  followUser as tiktokFollow,
  likeVideo as tiktokLike,
  deleteVideo as tiktokDelete,
  updateProfile as tiktokUpdateProfile,
  updateAvatar as tiktokUpdateAvatar,
  analyzePosts as tiktokAnalyzePosts,
} from "../services/tiktok-operations";
import { createPostJob, getPostJob } from "../services/tiktok-post-jobs";
import { createOpJob, getOpJob } from "../services/tiktok-ops-jobs";
import { stashSession, claimSession } from "../services/tiktok-session-transfer";
import { rateLimit } from "../middleware/rateLimit";

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
    const { text, community_id } = req.body as { text?: string; community_id?: string };
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    try {
      const result = await postTweet({ ...common, text, community_id });
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
    const { texts, community_id } = req.body as { texts?: string[]; community_id?: string };
    if (!Array.isArray(texts) || texts.length === 0) {
      res.status(400).json({ error: "texts must be a non-empty array of strings" });
      return;
    }
    try {
      const result = await postTweetThread({ ...common, texts, community_id });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Post thread failed" });
    }
  }
);

// Post with attached media (1-4 images OR 1 video). Priced at the same 5x
// tier as avatar/banner because it transfers up to 512 MB and X's compose
// keeps the post button disabled until upload completes (videos can take 60s).
// Text-only posts should keep using /twitter/post for the cheaper rate.
router.post(
  "/twitter/post-media",
  requireXEnabled,
  requireAuth(0.005, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateOpBody(req, res);
    if (!common) return;
    const { text, media, community_id } = req.body as {
      text?: string;
      community_id?: string;
      media?: Array<{ image_base64?: string; image_url?: string; video_base64?: string; video_url?: string }>;
    };
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (!Array.isArray(media) || media.length === 0) {
      res.status(400).json({
        error: "media must be a non-empty array (1-4 images OR 1 video). For text-only, use /twitter/post.",
      });
      return;
    }
    try {
      const result = await postTweet({ ...common, text, media, community_id });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Post with media failed" });
    }
  }
);

router.post(
  "/twitter/list-my-tweets",
  requireXEnabled,
  requireAuth(0.005, "general", { description: "List recent tweets from an X account you control.", category: "social", tags: ["twitter","x","tweets","list"] }),
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
  requireAuth(0.001, "general", { description: "Delete a tweet from an X account you control.", category: "social", tags: ["twitter","x","delete"] }),
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
  requireAuth(0.001, "general", { description: "Update the profile (name/bio/location/url) of an X account you control.", category: "social", tags: ["twitter","x","profile"] }),
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
  requireAuth(0.005, "general", { description: "Update the avatar image of an X account you control.", category: "social", tags: ["twitter","x","avatar"] }),
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
  requireAuth(0.005, "general", { description: "Update the banner image of an X account you control.", category: "social", tags: ["twitter","x","banner"] }),
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
      // Strip trailing empty fields — marketplaces routinely export with a
      // trailing colon (so `…:auth_token:` parses to 6 fields with an empty
      // last). Don't penalize that.
      const raw = credentials_line.split(":");
      while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
      const parts = raw;

      if (![4, 5, 7].includes(parts.length)) {
        res.status(400).json({
          error: "credentials_line must have 4, 5, or 7 colon-separated fields (trailing empty fields are tolerated)",
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

      const TOTP_RE = /^[A-Z2-7]{16,64}$/;       // RFC 4648 base32
      const CT0_RE = /^[0-9a-f]{16,64}$/i;       // X `ct0` cookie
      const AUTH_TOKEN_RE = /^[0-9a-f]{32,80}$/i; // X `auth_token` cookie

      if (parts.length === 5) {
        // The 5th field is ambiguous across marketplace conventions: some
        // sellers put `totp_seed` there (base32), others put `auth_token`
        // (hex). Pattern-match to figure out which.
        const f5 = parts[4];
        if (TOTP_RE.test(f5)) {
          creds.totp_seed = f5;
        } else if (AUTH_TOKEN_RE.test(f5)) {
          creds.auth_token = f5;
        } else {
          res.status(400).json({
            error: "credentials_line: 5th field must be either a base32 TOTP seed (16-64 chars A-Z/2-7) or a hex auth_token (32-80 hex chars)",
            hint: "Your password probably contains ':' — use explicit body fields instead.",
            got_length: f5.length,
          });
          return;
        }
      } else if (parts.length === 7) {
        // 7-field canonical: login:password:email:email_pw:2fa:ct0:auth_token
        if (parts[4]) creds.totp_seed = parts[4];
        if (parts[5]) creds.ct0 = parts[5];
        if (parts[6]) creds.auth_token = parts[6];

        if (creds.totp_seed !== undefined && !TOTP_RE.test(creds.totp_seed)) {
          res.status(400).json({
            error: "credentials_line: 5th field must be an RFC 4648 base32 TOTP seed (16-64 chars of A-Z 2-7)",
            hint: "Your password probably contains ':' — use explicit body fields instead.",
          });
          return;
        }
        if (creds.ct0 !== undefined && !CT0_RE.test(creds.ct0)) {
          res.status(400).json({
            error: "credentials_line: 6th field must be the X `ct0` cookie (16-64 hex chars)",
            hint: "Your password probably contains ':' — use explicit body fields instead.",
          });
          return;
        }
        if (creds.auth_token !== undefined && !AUTH_TOKEN_RE.test(creds.auth_token)) {
          res.status(400).json({
            error: "credentials_line: 7th field must be the X `auth_token` cookie (32-80 hex chars)",
            hint: "Your password probably contains ':' — use explicit body fields instead.",
          });
          return;
        }
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

/* ─── Wallet-registered accounts: BYO credentials, server holds them ─
   Foundation for server-side scheduling. The wallet uploads its X
   credentials once; the server encrypts at rest and re-uses them to
   refresh cookies whenever needed (so scheduled posts can fire even when
   the user's machine is off). All routes are wallet-scoped — no caller
   can see or revoke another wallet's accounts.
*/

router.post(
  "/twitter/register",
  requireXEnabled,
  requireAuth(0.01, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    const {
      username,
      login,
      password,
      email,
      email_password,
      totp_seed,
      auth_token,
      ct0,
      country,
    } = (req.body || {}) as Record<string, any>;

    if (!username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    try {
      const result = await registerAccount({
        wallet,
        platform: "twitter",
        username,
        country: country || undefined,
        credentials: {
          login: login || username,
          password,
          email,
          email_password,
          totp_seed,
          auth_token,
          ct0,
        },
      });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Register failed" });
    }
  }
);

router.delete(
  "/twitter/register/:id",
  requireXEnabled,
  // Tiny fee instead of $0 — CDP facilitator rejects $0 payments as
  // "invalid_payload", so wallet-only callers (no API key) can't hit free
  // routes today. Workaround until middleware learns to short-circuit
  // minUsdc===0 + wallet-auth without round-tripping CDP.
  requireAuth(0.001, "general", { description: "Unregister an X account from the server (removes stored credentials). Owner-only.", category: "social", tags: ["twitter","x","unregister"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    const id = String(req.params.id || "");
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    try {
      const result = unregisterAccount(wallet, id);
      res.status(result.success ? 200 : 404).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Unregister failed" });
    }
  }
);

router.get(
  "/twitter/registered",
  requireXEnabled,
  // See note on /twitter/register/:id above — $0.001 instead of free
  // until the middleware free-route + x402-wallet bug is fixed properly.
  requireAuth(0.001, "general", { description: "List X accounts registered on the server.", category: "social", tags: ["twitter","x","registered","list"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    try {
      const accounts = listRegisteredAccounts(wallet, "twitter");
      res.json({ success: true, accounts });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "List registered failed" });
    }
  }
);

// ── Transfer / share / unshare / claim for registered accounts ──────────
//
// Mirrors /x/accounts/:id/{transfer,share,unshare} but operates on the
// social_registered_accounts table (BYO/wallet-bound accounts) instead of
// the admin-seeded pool. Credentials live encrypted server-side; the
// rotation flow decrypts → drives the X password-change UI → re-encrypts.

// ── Wallet validators reused inside this section ──
const SOL_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const isWalletAddr = (s: any) => typeof s === "string" && (SOL_PUBKEY_RE.test(s) || EVM_ADDR_RE.test(s));

/**
 * GET /social/twitter/registered/mine — Full credential bundle for every
 * registered account the caller owns or has shared access to. Used by
 * `palmyr twitter claim` so a wallet that just received a transferred
 * account can pull it into the local vault.
 *
 * Mirrored on /x/accounts/mine for pool-bought accounts. The CLI claim
 * command queries both endpoints and merges the results.
 */
router.get(
  "/twitter/registered/mine",
  requireXEnabled,
  requireAuth(0.001, "general", { description: "List registered X accounts your wallet owns or has shared access to.", category: "social", tags: ["twitter","x","registered","mine"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    try {
      const accounts = accountsAccessibleBy(wallet, "twitter");
      res.json({ success: true, wallet, count: accounts.length, accounts });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "List failed" });
    }
  }
);

/**
 * POST /social/twitter/registered/:id/transfer — Atomically hand a registered
 * X account to another wallet. Server rotates the password and revokes other
 * sessions before flipping the `wallet` column, so the previous owner's
 * exported cookies / password become useless. Symmetric with
 * /x/accounts/:id/transfer for pool accounts.
 */
router.post(
  "/twitter/registered/:id/transfer",
  requireXEnabled,
  requireAuth(0.0001, "general", { description: "Transfer a registered X account to another wallet (rotates the password). Owner-only.", category: "social", tags: ["twitter","x","transfer","ownership"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { to_wallet } = (req.body || {}) as { to_wallet?: string };
    if (!isWalletAddr(to_wallet)) {
      res.status(400).json({ error: "to_wallet must be a Solana (base58) or EVM (0x…) wallet address" });
      return;
    }
    if (to_wallet === caller) {
      res.status(400).json({ error: "to_wallet is already the current owner" });
      return;
    }

    const accountId = String(req.params.id || "");
    const state = getOwnerDecryptedState(accountId, caller);
    if (!state) {
      res.status(404).json({ error: "Registered account not found or not owned by you" });
      return;
    }
    if (state.cookies.length === 0) {
      res.status(409).json({
        error: "No cached cookies for this account — re-run register so the server has a session before transferring",
      });
      return;
    }

    // Kick off rotation in the background — Playwright takes 30-90s, longer
    // than Cloudflare Tunnel's HTTP timeout. Client polls /transfers/:id.
    const transfer = createTransfer("registered", state.row.id, caller, to_wallet!);
    res.status(202).json({
      success: true,
      transfer_id: transfer.id,
      operation_id: transfer.id,
      status: transfer.status,
      account_id: state.row.id,
      username: state.row.username,
      from_wallet: caller,
      to_wallet,
      message: "Transfer accepted. Poll GET /transfers/:transfer_id to see when the rotation completes.",
      poll_url: `/transfers/${transfer.id}`,
    });
  }
);

/**
 * POST /social/twitter/registered/:id/share — Grant another wallet shared
 * access. Same encrypted credentials; the shared wallet can post / etc.
 * exactly like the owner. Owner-only.
 */
router.post(
  "/twitter/registered/:id/share",
  requireXEnabled,
  requireAuth(0.0001, "general", { description: "Grant another wallet shared access to a registered X account. Owner-only.", category: "social", tags: ["twitter","x","share"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const withWallet = (req.body || {}).with;
    if (!isWalletAddr(withWallet)) {
      res.status(400).json({ error: "`with` must be a wallet address" });
      return;
    }

    const result = shareRegistered(String(req.params.id || ""), caller, withWallet);
    if (result === null) {
      res.status(404).json({ error: "Registered account not found or not owned by you" });
      return;
    }
    res.json({
      success: true,
      message: `Shared with ${withWallet}`,
      id: req.params.id,
      shared_with: result,
    });
  }
);

/**
 * POST /social/twitter/registered/:id/unshare — Revoke shared access. With
 * `rotate: true` in the body, the server also rotates the password + revokes
 * other sessions and returns the new credentials so the caller (still the
 * owner) can update their local vault. Without `rotate`, only `shared_with`
 * is updated; previously captured creds on the revoked wallet remain valid
 * until X-side expiry.
 */
router.post(
  "/twitter/registered/:id/unshare",
  requireXEnabled,
  requireAuth(0.0001, "general", { description: "Revoke a wallet's shared access to a registered X account. Owner-only.", category: "social", tags: ["twitter","x","unshare"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = (req.body || {}) as { wallet?: string; rotate?: boolean };
    if (!isWalletAddr(body.wallet)) {
      res.status(400).json({ error: "`wallet` must be a wallet address" });
      return;
    }
    const rotate = body.rotate === true;
    const accountId = String(req.params.id || "");

    const afterUnshare = unshareRegistered(accountId, caller, body.wallet!);
    if (afterUnshare === null) {
      res.status(404).json({ error: "Registered account not found or not owned by you" });
      return;
    }

    if (!rotate) {
      res.json({
        success: true,
        message: `${body.wallet} no longer has shared access`,
        id: accountId,
        shared_with: afterUnshare,
        rotated: false,
      });
      return;
    }

    // --rotate path: kick off async rotation. Same async machinery as
    // transfer — Playwright takes longer than Cloudflare's HTTP timeout.
    const transfer = createTransfer("registered", accountId, caller, caller, "unshare_rotate");
    res.status(202).json({
      success: true,
      message: `${body.wallet} unshared. Rotation kicked off — poll /transfers/${transfer.id} for status.`,
      id: accountId,
      shared_with: afterUnshare,
      rotated: false,
      rotation_in_progress: true,
      transfer_id: transfer.id,
      operation_id: transfer.id,
      status: transfer.status,
      poll_url: `/transfers/${transfer.id}`,
    });
  }
);

/* ─── Server-side scheduled posts ──────────────────────────────────────
   Three POST routes, one per action shape, mirroring the direct-post
   pricing scale ($0.001 text / $0.005 thread / $0.005 media). Payment at
   schedule time COMMITS to the eventual fire — the worker (PR 3) calls
   the internal post functions directly with no further paywall. Cancel
   before fire = no refund (Buffer/Hootsuite model).
*/

// Reject the trivially-knowable failures (missing account_id, missing/invalid/
// past post_at) BEFORE the x402 paywall settles — otherwise the wallet is
// charged and nothing is scheduled. Mirrors validateBuyFilters on /twitter/buy.
function validateScheduleBody(req: AuthenticatedRequest, res: Response, next: () => void): void {
  const body = (req.body || {}) as { account_id?: string; post_at?: string };
  if (!body.account_id) {
    res.status(400).json({ error: "account_id is required" });
    return;
  }
  if (!body.post_at) {
    res.status(400).json({ error: "post_at is required" });
    return;
  }
  const ms = Date.parse(body.post_at);
  if (Number.isNaN(ms)) {
    res.status(400).json({ error: `post_at "${body.post_at}" is not a valid ISO 8601 date` });
    return;
  }
  if (ms < Date.now() - 60_000) {
    res.status(400).json({ error: `post_at "${body.post_at}" is in the past` });
    return;
  }
  next();
}

router.post(
  "/scheduled/post",
  requireXEnabled,
  validateScheduleBody,
  requireAuth(0.001, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    const { account_id, text, post_at, community_id } = (req.body || {}) as {
      account_id?: string;
      text?: string;
      post_at?: string;
      community_id?: string;
    };
    if (!account_id || !text || !post_at) {
      res.status(400).json({ error: "account_id, text, and post_at are required" });
      return;
    }
    const result = createScheduled({
      wallet,
      registered_account_id: account_id,
      platform: "twitter",
      action: "post",
      payload: { text, community_id },
      post_at,
      paid_amount_usdc: 0.001,
    });
    res.status(result.success ? 200 : 400).json(result);
  }
);

router.post(
  "/scheduled/thread",
  requireXEnabled,
  validateScheduleBody,
  requireAuth(0.005, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    const { account_id, texts, post_at, community_id } = (req.body || {}) as {
      account_id?: string;
      texts?: string[];
      post_at?: string;
      community_id?: string;
    };
    if (!account_id || !Array.isArray(texts) || texts.length === 0 || !post_at) {
      res.status(400).json({ error: "account_id, non-empty texts array, and post_at are required" });
      return;
    }
    const result = createScheduled({
      wallet,
      registered_account_id: account_id,
      platform: "twitter",
      action: "post_thread",
      payload: { texts, community_id },
      post_at,
      paid_amount_usdc: 0.005,
    });
    res.status(result.success ? 200 : 400).json(result);
  }
);

router.post(
  "/scheduled/media",
  requireXEnabled,
  validateScheduleBody,
  requireAuth(0.005, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    const { account_id, text, media, post_at, community_id } = (req.body || {}) as {
      account_id?: string;
      text?: string;
      media?: any[];
      post_at?: string;
      community_id?: string;
    };
    if (!account_id || !text || !Array.isArray(media) || media.length === 0 || !post_at) {
      res.status(400).json({ error: "account_id, text, non-empty media array, and post_at are required" });
      return;
    }
    const result = createScheduled({
      wallet,
      registered_account_id: account_id,
      platform: "twitter",
      action: "post_media",
      payload: { text, media, community_id },
      post_at,
      paid_amount_usdc: 0.005,
    });
    res.status(result.success ? 200 : 400).json(result);
  }
);

router.get(
  "/scheduled",
  requireXEnabled,
  // See note on /twitter/register/:id above — $0.001 instead of free.
  requireAuth(0.001, "general", { description: "List scheduled posts for X accounts your wallet controls.", category: "social", tags: ["twitter","x","scheduled","list"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    const accountId = (req.query.account_id as string) || undefined;
    const status = (req.query.status as any) || undefined;
    const from = (req.query.from as string) || undefined;
    const to = (req.query.to as string) || undefined;
    // Pagination: ?limit= (default 50, hard-cap 200) + ?cursor= (the `id` of the
    // last scheduled post from the previous page). listScheduled returns a
    // stable post_at ASC ordering with a unique `id` per row, so the row id is a
    // stable continuation cursor. Backward-compatible: with no cursor this still
    // returns the first page under the `items` key (now defaulting to 50).
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;
    const cursor = (req.query.cursor as string) || undefined;
    try {
      // Fetch the full stable-ordered window (service caps at 500) so the cursor
      // row is always in range, then slice the page in-route — no service change.
      const all = listScheduled({ wallet, account_id: accountId, status, from, to, limit: 500 });

      let startIdx = 0;
      if (cursor) {
        const found = all.findIndex(it => it.id === cursor);
        // Unknown cursor → start from the top (defensive, never 500s).
        startIdx = found >= 0 ? found + 1 : 0;
      }

      const pageRows = all.slice(startIdx, startIdx + limit + 1);
      const hasMore = pageRows.length > limit;
      const items = hasMore ? pageRows.slice(0, limit) : pageRows;
      const nextCursor = hasMore ? items[items.length - 1].id : null;

      res.json({ success: true, items, limit, next_cursor: nextCursor });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "List scheduled failed" });
    }
  }
);

router.delete(
  "/scheduled/:id",
  requireXEnabled,
  // See note on /twitter/register/:id above — $0.001 instead of free.
  requireAuth(0.001, "general", { description: "Cancel a scheduled X post you created.", category: "social", tags: ["twitter","x","scheduled","cancel"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    const id = String(req.params.id || "");
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    try {
      const result = cancelScheduled(wallet, id);
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Cancel scheduled failed" });
    }
  }
);

/* ─── Country pricing — admin sets, public reads ──────────────────────
   The buy route below resolves the per-request USDC charge from this table
   so different countries can be priced independently. Admin pubkey (from
   POOL_ADMIN_WALLETS) is the only thing that can write; reads are public
   so buyer agents can see what's available before paying. */

router.get("/twitter/pool/prices", (_req: Request, res: Response) => {
  res.json({
    prices: listCountryPrices(),
    source_multipliers: listSourceMultipliers(),
  });
});

router.put("/twitter/pool/prices/:country", requirePoolAdmin, (req: Request, res: Response) => {
  const { price_usdc } = (req.body || {}) as { price_usdc?: number };
  if (typeof price_usdc !== "number") {
    res.status(400).json({ error: "price_usdc (number) required in body" });
    return;
  }
  try {
    const row = setCountryPrice(String(req.params.country || ""), price_usdc);
    res.json({ success: true, ...row });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/twitter/pool/prices/:country", requirePoolAdmin, (req: Request, res: Response) => {
  const removed = deleteCountryPrice(String(req.params.country || ""));
  res.json({ success: removed });
});

/* ─── Source multipliers — admin sets, public reads ─────────────────────
   When a buy specifies --source <s>, server multiplies the country price by
   source_multipliers[s] (defaults to 1.0 if no row exists). Lets admin tag
   web vs mobile as different price tiers without maintaining an N×M matrix. */

router.put("/twitter/pool/source-multipliers/:source", requirePoolAdmin, (req: Request, res: Response) => {
  const { multiplier } = (req.body || {}) as { multiplier?: number };
  if (typeof multiplier !== "number") {
    res.status(400).json({ error: "multiplier (number) required in body" });
    return;
  }
  try {
    const row = setSourceMultiplier(String(req.params.source || ""), multiplier);
    res.json({ success: true, ...row });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/twitter/pool/source-multipliers/:source", requirePoolAdmin, (req: Request, res: Response) => {
  const removed = deleteSourceMultiplier(String(req.params.source || ""));
  res.json({ success: removed });
});

/* ─── Buy: public-facing, paid ──────────────────────────────────────────
   Price is dynamic: if `--country US` is passed, `country_prices.US` is the
   charge. The pre-middleware below rejects countries with no configured
   price BEFORE the auth/x402 layer runs, so the buyer never gets stuck on a
   402 they can't satisfy. Without --country, falls back to the legacy
   single-tier $5 so existing `palmyr twitter buy` callers keep working. */

const LEGACY_BUY_PRICE_USDC = 5.0;

function readBodyOrQuery(req: Request, key: string): string | undefined {
  const v = (req.body && (req.body as any)[key]) || (req.query && (req.query as any)[key]);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function readCountryFromRequest(req: Request): string | undefined {
  return readBodyOrQuery(req, "country");
}

function readSourceFromRequest(req: Request): string | undefined {
  const s = readBodyOrQuery(req, "source");
  return s ? s.toLowerCase() : undefined;
}

function readMaxRenamesFromRequest(req: Request): number | undefined {
  const raw =
    (req.body && (req.body as any).max_username_changes) ??
    (req.query && (req.query as any).max_username_changes);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function resolveBuyPrice(req: Request): number {
  const country = readCountryFromRequest(req);
  const source = readSourceFromRequest(req);
  const base = country ? (getCountryPrice(country) ?? LEGACY_BUY_PRICE_USDC) : LEGACY_BUY_PRICE_USDC;
  const mult = source ? (getSourceMultiplier(source) ?? 1.0) : 1.0;
  // Round to 6 decimals so the x402 amount (lamports = price * 1e6) stays an
  // integer even when multiplier introduces fractional cents.
  return Math.round(base * mult * 1_000_000) / 1_000_000;
}

function validateBuyFilters(req: Request, res: Response, next: () => void): void {
  const country = readCountryFromRequest(req);
  if (country) {
    if (!/^[A-Za-z]{2}$/.test(country)) {
      res.status(400).json({
        error: "Invalid country",
        message: "country must be a 2-letter ISO 3166-1 alpha-2 code (e.g. US, GB, DE)",
      });
      return;
    }
    if (getCountryPrice(country) == null) {
      res.status(400).json({
        error: "Country not priced",
        message: `No price configured for ${country.toUpperCase()}. Run \`GET /social/twitter/pool/prices\` to see available countries.`,
      });
      return;
    }
  }
  // Source is the legacy raw-string filter — kept for source_multiplier
  // pricing. New filters below cover the common "registered in X" /
  // "android vs ios" cases more cleanly.
  const source = readBodyOrQuery(req, "source");
  if (source && source.length > 64) {
    res.status(400).json({ error: "Invalid source", message: "source string too long" });
    return;
  }
  const registeredCountry = readBodyOrQuery(req, "registered_country");
  if (registeredCountry && !/^[A-Za-z]{2}$/.test(registeredCountry)) {
    res.status(400).json({
      error: "Invalid registered_country",
      message: "registered_country must be a 2-letter ISO 3166-1 alpha-2 code (e.g. GB)",
    });
    return;
  }
  const registeredPlatform = readBodyOrQuery(req, "registered_platform");
  if (registeredPlatform && !/^(android|ios|web)$/i.test(registeredPlatform)) {
    res.status(400).json({
      error: "Invalid registered_platform",
      message: "registered_platform must be one of: android, ios, web",
    });
    return;
  }
  const maxRenamesRaw =
    (req.body && (req.body as any).max_username_changes) ??
    (req.query && (req.query as any).max_username_changes);
  if (maxRenamesRaw != null && maxRenamesRaw !== "") {
    const n = Number(maxRenamesRaw);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({
        error: "Invalid max_username_changes",
        message: "max_username_changes must be a non-negative integer",
      });
      return;
    }
  }
  next();
}

router.post(
  "/twitter/buy",
  requireXEnabled,
  validateBuyFilters,
  requireAuth(resolveBuyPrice, "general"),
  async (req: AuthenticatedRequest, res: Response) => {
    const {
      country,
      age_category,
      source,
      registered_country,
      registered_platform,
      max_username_changes,
    } = (req.body || {}) as {
      country?: string;
      age_category?: string;
      source?: string;
      registered_country?: string;
      registered_platform?: string;
      max_username_changes?: number | string;
    };
    const buyerWallet = req.payment?.payer || req.agentId;
    if (!buyerWallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    try {
      const paidAmount = req.payment
        ? Number(req.payment.amountLamports) / 1_000_000
        : undefined;
      const buyArgs = {
        platform: "twitter" as const,
        country: country ? country.toUpperCase() : undefined,
        age_category,
        source: source ? String(source).toLowerCase() : undefined,
        registered_country: registered_country ? String(registered_country).toUpperCase() : undefined,
        registered_platform: registered_platform
          ? (String(registered_platform).toLowerCase() as "android" | "ios" | "web")
          : undefined,
        max_username_changes:
          max_username_changes == null || max_username_changes === ""
            ? undefined
            : Number(max_username_changes),
        buyer_wallet: buyerWallet,
        payment: req.payment
          ? {
              signature: req.payment.signature,
              chain: req.payment.chain || "solana",
              amount_usdc: paidAmount ?? 0,
            }
          : undefined,
      };
      let result = poolBuy(buyArgs);
      // Pool rows are mostly untagged for age_category, so an `age_category`
      // filter usually matches nothing. If that's the only thing blocking the
      // buy, relax it (price is by country → this stays price-neutral) and try
      // once more before refunding — delivering an available account beats a
      // hard "no match". poolBuy reserves nothing on a miss, so the retry is safe.
      if (!result.success && age_category) {
        result = poolBuy({ ...buyArgs, age_category: undefined });
      }
      if (!result.success) {
        // The x402 paywall settles USDC on-chain BEFORE this handler runs, so a
        // wallet payer has already paid by the time poolBuy reports no matching
        // inventory. Refund them — otherwise it's a charge with no delivery, the
        // exact trust-breaker the treasury rotation was about. Balance/dashboard
        // payers (no req.payment) aren't charged on a 4xx, so just relay the body.
        // Either way, list what IS in stock so the caller can adjust the filter.
        const availableCountries = availablePoolCountries("twitter");
        const optionsHint = availableCountries.length
          ? ` Currently in stock: ${availableCountries.join(", ")} (plus untagged accounts that match when you don't set a country). Drop the filter or pick one of these.`
          : "";
        if (req.payment) {
          await refundAndRespond(req, res, {
            reason: result.error || "No matching accounts in pool",
            userMessage:
              (result.error || "No matching accounts in pool") +
              " — your payment is being refunded." +
              optionsHint,
            errorLabel: "No matching accounts",
            httpStatus: 409,
            extra: { available: false, availableCountries },
          });
        } else {
          res.status(409).json({ ...result, availableCountries });
        }
        return;
      }
      res.status(200).json(result);
    } catch (err: any) {
      // Settlement already happened upstream; refund x402 payers on a hard failure.
      if (req.payment) {
        await refundAndRespond(req, res, {
          reason: `Buy failed: ${err?.message || err}`,
          userMessage: "Could not complete the purchase — your payment is being refunded.",
          errorLabel: "Buy failed",
        });
      } else {
        res.status(500).json({ error: err.message || "Buy failed" });
      }
    }
  }
);

/* ─── Disputes — buyer files, server auto-verifies via twitterapi.io ──
   Per the dispute design: confirmed-suspended within 7 days of purchase →
   try same-country replacement → fall back to USDC refund. Ambiguous
   detection (API down, location unknown) queues for admin review. */

const DISPUTE_PROOF_USDC = 0.01;

router.post(
  "/twitter/dispute",
  requireXEnabled,
  requireAuth(DISPUTE_PROOF_USDC, "general", { description: "File a dispute for a pool-bought X account (e.g. dead/suspended) to request a refund.", category: "social", tags: ["twitter","x","dispute","refund"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { account_id, reason, evidence } = (req.body || {}) as {
      account_id?: string;
      reason?: "suspended" | "other";
      evidence?: string;
    };
    if (!account_id) {
      res.status(400).json({ error: "account_id required" });
      return;
    }
    if (reason && reason !== "suspended" && reason !== "other") {
      res.status(400).json({ error: 'reason must be "suspended" or "other"' });
      return;
    }
    try {
      const result = await createDispute({
        account_id,
        claimant_wallet: wallet,
        reason: reason || "suspended",
        evidence,
      });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Dispute failed" });
    }
  },
);

router.get(
  "/twitter/dispute/:id",
  requireXEnabled,
  requireAuth(0.001, "general", { description: "Check the status of an X account dispute you filed.", category: "social", tags: ["twitter","x","dispute","status"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const dispute = getDispute(String(req.params.id || ""));
    if (!dispute) {
      res.status(404).json({ error: "Dispute not found" });
      return;
    }
    // Buyer sees their own disputes; admin sees all (signature is checked
    // when admin uses the dedicated /pool/disputes list route).
    if (dispute.claimant_wallet !== wallet) {
      res.status(403).json({ error: "Not your dispute" });
      return;
    }
    res.json({ dispute });
  },
);

// Admin: list every dispute. Pool-admin signature required.
router.get(
  "/twitter/pool/disputes",
  requirePoolAdmin,
  (req: Request, res: Response) => {
    const status = (req.query.status as string) || undefined;
    res.json({ disputes: listDisputes({ status }) });
  },
);

// Admin: manually resolve a dispute (overrides auto-verify). Used when the
// queued admin_review queue needs human judgment.
router.post(
  "/twitter/pool/disputes/:id/resolve",
  requirePoolAdmin,
  async (req: Request, res: Response) => {
    const { action, note } = (req.body || {}) as {
      action?: "replace" | "refund" | "reject";
      note?: string;
    };
    if (action !== "replace" && action !== "refund" && action !== "reject") {
      res.status(400).json({ error: 'action must be "replace", "refund", or "reject"' });
      return;
    }
    try {
      const result = await resolveDisputeAdmin(String(req.params.id || ""), action, note);
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Resolve failed" });
    }
  },
);

/* ─── Pool share / unshare / claim ──────────────────────────────────────
   Once a wallet has bought an X account via `palmyr twitter buy` (which
   sets `sold_to_wallet` on the social_account_pool row), they can share
   access with another wallet — same shape as x_accounts and
   social_registered_accounts. Pool-bought accounts were previously
   invisible to share/transfer machinery; these routes close that gap. */

/**
 * GET /social/twitter/pool/mine — full decrypted creds for every pool
 * account the caller owns or has shared access to. Used by `palmyr
 * twitter claim` to merge with the other two tables.
 */
router.get(
  "/twitter/pool/mine",
  requireXEnabled,
  requireAuth(0.001, "general", { description: "List pool-bought X accounts your wallet owns or has shared access to.", category: "social", tags: ["twitter","x","pool","mine"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const wallet = req.payment?.payer || req.agentId;
    if (!wallet) {
      res.status(400).json({ error: "No payer/agent identity" });
      return;
    }
    try {
      const accounts = poolAccountsAccessibleBy(wallet, "twitter");
      res.json({ success: true, wallet, count: accounts.length, accounts });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "List failed" });
    }
  }
);

router.post(
  "/twitter/pool/:id/share",
  requireXEnabled,
  requireAuth(0.0001, "general", { description: "Grant another wallet shared access to a pool-bought X account. Owner-only.", category: "social", tags: ["twitter","x","pool","share"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const withWallet = (req.body || {}).with;
    if (!isWalletAddr(withWallet)) {
      res.status(400).json({ error: "`with` must be a wallet address" });
      return;
    }
    const result = poolShare(String(req.params.id || ""), caller, withWallet);
    if (result === null) {
      res.status(404).json({ error: "Pool account not found or not owned by you (or not yet bought)" });
      return;
    }
    res.json({
      success: true,
      message: `Shared with ${withWallet}`,
      id: req.params.id,
      shared_with: result,
    });
  }
);

router.post(
  "/twitter/pool/:id/unshare",
  requireXEnabled,
  requireAuth(0.0001, "general", { description: "Revoke a wallet's shared access to a pool-bought X account. Owner-only.", category: "social", tags: ["twitter","x","pool","unshare"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const caller = req.payment?.payer || req.agentId;
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const wallet = (req.body || {}).wallet;
    if (!isWalletAddr(wallet)) {
      res.status(400).json({ error: "`wallet` must be a wallet address" });
      return;
    }
    const result = poolUnshare(String(req.params.id || ""), caller, wallet);
    if (result === null) {
      res.status(404).json({ error: "Pool account not found or not owned by you" });
      return;
    }
    res.json({
      success: true,
      message: `${wallet} no longer has shared access`,
      id: req.params.id,
      shared_with: result,
    });
  }
);

router.post(
  "/twitter/username",
  requireXEnabled,
  requireAuth(0.005, "general", { description: "Change the @handle of an X account you control.", category: "social", tags: ["twitter","x","username","handle"] }),
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
  requireAuth(0.02, "general", { description: "Open an authenticated TikTok session for an account you control.", category: "social", tags: ["tiktok","login","session"] }),
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
//
// ASYNC: the browser upload+publish flow takes 2-5 min — longer than
// Cloudflare's tunnel timeout — so this returns a 202 + operation envelope
// immediately (mirrors POST /domains/register) and a background worker does the
// publish, writes the result back, and auto-refunds on definitive failure. Poll
// GET /social/tiktok/operations/:id until status is terminal (posted | failed).
router.post(
  "/tiktok/post",
  requireTikTokEnabled,
  requireAuth(0.01, "general", { description: "Post a video to a TikTok account you control (from video_base64 or video_url). Async: returns an operation to poll.", category: "social", tags: ["tiktok","post","video"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { caption, video_base64, video_url, privacy, allow_comments, allow_duet, allow_stitch, schedule_at } = req.body as any;
    if (!caption) { res.status(400).json({ error: "caption is required" }); return; }
    if (!video_base64 && !video_url) { res.status(400).json({ error: "video_base64 or video_url is required" }); return; }
    try {
      // x402 settled before this handler ran — req.payment is the source of
      // truth for who paid / how to refund if the background post fails.
      const owner = req.payment?.payer || req.agentId || "unknown";
      const job = createPostJob(
        {
          account_id: common.account_id,
          owner,
          caption,
          privacy: privacy ?? null,
          schedule_at: schedule_at ?? null,
          paymentSignature: req.payment?.signature ?? null,
          paymentChain: (req.payment?.chain as "solana" | "base") ?? null,
          chargedUsdc: req.payment ? Number(req.payment.amountLamports) / 1_000_000 : null,
        },
        { ...common, caption, video_base64, video_url, privacy, allow_comments, allow_duet, allow_stitch, schedule_at }
      );
      res.status(202).json({
        operation_id: job.id,
        status: job.status,
        poll_url: `/social/tiktok/operations/${job.id}`,
        poll_after_seconds: 20,
        message:
          "TikTok post started. Browser automation typically lands in ~2-5 minutes. " +
          `Poll GET /social/tiktok/operations/${job.id} until status is 'posted' (carries video_url) or 'failed' (auto-refunded). ` +
          "Do not resubmit — payment is already captured for this operation.",
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok post failed" });
    }
  }
);

/**
 * GET /social/tiktok/operations/:id
 * Poll an async TikTok operation (post / follow / like / delete / profile /
 * avatar). FREE and unauthenticated: the operation_id is a 122-bit random v4
 * UUID handed back ONLY to the creator in the 202, so it acts as an unguessable
 * capability — and the response carries only non-sensitive status (the caller's
 * own caption, the post's own soon-to-be-public URL, error + refund state). A
 * paid+settled poll would dwarf the op's own price (an op polls 10-30x) and add
 * an on-chain settlement round-trip to every status check, so polling is free.
 * Unknown id → 404. status: pending → publishing/running → posted/done | failed.
 */
router.get(
  "/tiktok/operations/:id",
  (req: AuthenticatedRequest, res: Response) => {
    const id = String(req.params.id || "");
    const poll_url = `/social/tiktok/operations/${id}`;

    // Posts (tiktok_post_jobs) and simple ops (tiktok_op_jobs) share this one
    // poll endpoint. Both responses carry a `done` boolean so a client can poll
    // uniformly; `status` is 'posted'/'done' on success vs 'failed'.
    const post = getPostJob(id);
    if (post) {
      res.json({
        operation_id: post.id,
        op: "post",
        status: post.status,
        done: post.status === "posted" || post.status === "failed",
        account_id: post.account_id,
        caption: post.caption,
        poll_url,
        video_url: post.video_url,
        video_id: post.video_id,
        scheduled_at: post.schedule_at,
        cost: post.charged_usdc,
        error: post.error,
        error_code: post.error_code,
        refund_status: post.refund_status,
        created_at: post.created_at,
        started_at: post.started_at,
        completed_at: post.completed_at,
      });
      return;
    }

    const op = getOpJob(id);
    if (op) {
      res.json({
        operation_id: op.id,
        op: op.op,
        status: op.status,
        done: op.status === "done" || op.status === "failed",
        account_id: op.account_id,
        poll_url,
        result: op.result_json ? JSON.parse(op.result_json) : null,
        cost: op.charged_usdc,
        error: op.error,
        error_code: op.error_code,
        refund_status: op.refund_status,
        created_at: op.created_at,
        started_at: op.started_at,
        completed_at: op.completed_at,
      });
      return;
    }

    // Unknown id (or guessed UUID) → 404.
    res.status(404).json({ error: "Operation not found" });
  }
);

// ── Session transfer relay (tiktok-session-transfer.ts) ──
// Move a session logged in on a trusted machine (real browser/home IP, where
// `tiktok connect` works) to the machine that runs the ops — TikTok won't
// authorize a server-side login, so the login must happen on the trusted side.
// `stash` holds the jar IN MEMORY under a one-time code; `claim` redeems it once.
router.post(
  "/tiktok/session/stash",
  rateLimit(20, 60_000),
  (req: AuthenticatedRequest, res: Response) => {
    const { cookies, label } = (req.body || {}) as { cookies?: any[]; label?: string };
    if (!Array.isArray(cookies) || cookies.length === 0) { res.status(400).json({ error: "cookies (non-empty array) required" }); return; }
    try {
      const { transfer_code, expires_in_sec } = stashSession(cookies, typeof label === "string" ? label : undefined);
      res.json({
        transfer_code,
        expires_in_sec,
        message: `Session stashed. On the target machine run: palmyr tiktok pull <handle> --code ${transfer_code}  (valid ~${Math.round(expires_in_sec / 60)} min, one-time).`,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || "stash failed" });
    }
  }
);

router.post(
  "/tiktok/session/claim",
  rateLimit(30, 60_000),
  (req: AuthenticatedRequest, res: Response) => {
    const { transfer_code } = (req.body || {}) as { transfer_code?: string };
    if (!transfer_code) { res.status(400).json({ error: "transfer_code required" }); return; }
    const claimed = claimSession(transfer_code);
    if (!claimed) { res.status(404).json({ error: "transfer code not found or expired" }); return; }
    res.json({ ok: true, cookies: claimed.cookies, label: claimed.label, captured_at: new Date().toISOString() });
  }
);

// Ephemeral QR hand-off for `connect --qr`. Free + unauthenticated (it stores a
// tiny, short-TTL login QR so an agent can forward a /connect/<token> link to a
// human). No proxy/browser, so no requireTikTokEnabled.
router.post(
  "/tiktok/qr",
  (req: AuthenticatedRequest, res: Response) => {
    try {
      // No body → create a QR session up front (agent gets the link immediately).
      // { qr_data_url, token } → refresh that session's QR as TikTok rotates it.
      // { token, done } → mark the login captured so the page confirms.
      const { qr_data_url, token, done } = (req.body || {}) as { qr_data_url?: string; token?: string; done?: boolean };
      const r = putQr({ dataUrl: qr_data_url, token, done: !!done });
      res.json({ token: r.token, expires_in_sec: r.expiresInSec });
    } catch (err: any) {
      res.status(400).json({ error: err.message || "qr host failed" });
    }
  }
);

// follow / like / delete / profile / avatar are ASYNC for the same reason as
// post: each drives a headless browser that can brush Cloudflare's ~100s tunnel
// timeout (a delete measured ~60s in prod). Each returns a 202 operation
// envelope and runs in the background, auto-refunding on failure. They share the
// poll endpoint (GET /social/tiktok/operations/:id) and the simple-op runner
// (no reconcile — these ops are safe to retry). Helper keeps the 5 handlers DRY.
function paymentCtx(req: AuthenticatedRequest) {
  return {
    owner: req.payment?.payer || req.agentId || "unknown",
    paymentSignature: req.payment?.signature ?? null,
    paymentChain: (req.payment?.chain as "solana" | "base") ?? null,
    chargedUsdc: req.payment ? Number(req.payment.amountLamports) / 1_000_000 : null,
  };
}
function respondOpAccepted(res: Response, job: { id: string; status: string }, opLabel: string) {
  res.status(202).json({
    operation_id: job.id,
    status: job.status,
    poll_url: `/social/tiktok/operations/${job.id}`,
    poll_after_seconds: 10,
    message:
      `TikTok ${opLabel} started. Browser automation can take up to ~1-2 minutes. ` +
      `Poll GET /social/tiktok/operations/${job.id} until status is 'done' or 'failed' (auto-refunded). ` +
      "Do not resubmit — payment is already captured for this operation.",
  });
}

router.post(
  "/tiktok/follow",
  requireTikTokEnabled,
  requireAuth(0.001, "general", { description: "Follow a TikTok user from an account you control. Async: returns an operation to poll.", category: "social", tags: ["tiktok","follow"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { target_user } = req.body as { target_user?: string };
    if (!target_user) { res.status(400).json({ error: "target_user required" }); return; }
    try {
      const job = createOpJob({ op: "follow", account_id: common.account_id, ...paymentCtx(req) }, () => tiktokFollow({ ...common, target_user }));
      respondOpAccepted(res, job, "follow");
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok follow failed" });
    }
  }
);

router.post(
  "/tiktok/like",
  requireTikTokEnabled,
  requireAuth(0.001, "general", { description: "Like a TikTok video from an account you control. Async: returns an operation to poll.", category: "social", tags: ["tiktok","like"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { video_url } = req.body as { video_url?: string };
    if (!video_url) { res.status(400).json({ error: "video_url required" }); return; }
    try {
      const job = createOpJob({ op: "like", account_id: common.account_id, ...paymentCtx(req) }, () => tiktokLike({ ...common, video_url }));
      respondOpAccepted(res, job, "like");
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok like failed" });
    }
  }
);

router.post(
  "/tiktok/delete",
  requireTikTokEnabled,
  requireAuth(0.001, "general", { description: "Delete a video from a TikTok account you control. Async: returns an operation to poll.", category: "social", tags: ["tiktok","delete"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { video_url } = req.body as { video_url?: string };
    if (!video_url) { res.status(400).json({ error: "video_url required" }); return; }
    try {
      const job = createOpJob({ op: "delete", account_id: common.account_id, ...paymentCtx(req) }, () => tiktokDelete({ ...common, video_url }));
      respondOpAccepted(res, job, "delete");
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok delete failed" });
    }
  }
);

router.post(
  "/tiktok/profile",
  requireTikTokEnabled,
  requireAuth(0.001, "general", { description: "Update the bio/display name of a TikTok account you control. Async: returns an operation to poll.", category: "social", tags: ["tiktok","profile"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { bio, display_name } = req.body as { bio?: string; display_name?: string };
    try {
      const job = createOpJob({ op: "profile", account_id: common.account_id, ...paymentCtx(req) }, () => tiktokUpdateProfile({ ...common, bio, display_name }));
      respondOpAccepted(res, job, "profile update");
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok profile update failed" });
    }
  }
);

router.post(
  "/tiktok/avatar",
  requireTikTokEnabled,
  requireAuth(0.005, "general", { description: "Update the avatar of a TikTok account you control. Async: returns an operation to poll.", category: "social", tags: ["tiktok","avatar"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    const { image_base64, image_url } = req.body as { image_base64?: string; image_url?: string };
    if (!image_base64 && !image_url) { res.status(400).json({ error: "image_base64 or image_url required" }); return; }
    try {
      const job = createOpJob({ op: "avatar", account_id: common.account_id, ...paymentCtx(req) }, () => tiktokUpdateAvatar({ ...common, image_base64, image_url }));
      respondOpAccepted(res, job, "avatar update");
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok avatar update failed" });
    }
  }
);

router.post(
  "/tiktok/analytics",
  requireTikTokEnabled,
  requireAuth(0.005, "general", { description: "Fetch post analytics for a TikTok account you control.", category: "social", tags: ["tiktok","analytics"] }),
  async (req: AuthenticatedRequest, res: Response) => {
    const common = validateTikTokOpBody(req, res);
    if (!common) return;
    try {
      const result = await tiktokAnalyzePosts({ ...common });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok analytics failed" });
    }
  }
);

export default router;
