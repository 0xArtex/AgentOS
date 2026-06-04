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
import { isSelfHosted } from "../services/self-hosted";
import {
  poolAdd,
  poolBuy,
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
  postVideo as tiktokPostVideo,
  followUser as tiktokFollow,
  likeVideo as tiktokLike,
  deleteVideo as tiktokDelete,
  updateProfile as tiktokUpdateProfile,
  updateAvatar as tiktokUpdateAvatar,
  analyzePosts as tiktokAnalyzePosts,
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
  requireAuth(0.001, "general", { discoverable: false }),
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
  requireAuth(0.001, "general", { discoverable: false }),
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
  requireAuth(0.001, "general", { discoverable: false }),
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
  requireAuth(0.0001, "general", { discoverable: false }),
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
  requireAuth(0.0001, "general", { discoverable: false }),
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
  requireAuth(0.0001, "general", { discoverable: false }),
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
  requireAuth(0.001, "general", { discoverable: false }),
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
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    try {
      const items = listScheduled({ wallet, account_id: accountId, status, from, to, limit });
      res.json({ success: true, items });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "List scheduled failed" });
    }
  }
);

router.delete(
  "/scheduled/:id",
  requireXEnabled,
  // See note on /twitter/register/:id above — $0.001 instead of free.
  requireAuth(0.001, "general", { discoverable: false }),
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
      const result = poolBuy({
        platform: "twitter",
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
      });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Buy failed" });
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
  requireAuth(DISPUTE_PROOF_USDC, "general", { discoverable: false }),
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
  requireAuth(0.001, "general", { discoverable: false }),
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
  requireAuth(0.001, "general", { discoverable: false }),
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
  requireAuth(0.0001, "general", { discoverable: false }),
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
  requireAuth(0.0001, "general", { discoverable: false }),
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
    const { caption, video_base64, video_url, privacy, allow_comments, allow_duet, allow_stitch, schedule_at } = req.body as any;
    if (!caption) { res.status(400).json({ error: "caption is required" }); return; }
    if (!video_base64 && !video_url) { res.status(400).json({ error: "video_base64 or video_url is required" }); return; }
    try {
      const result = await tiktokPostVideo({
        ...common, caption, video_base64, video_url, privacy, allow_comments, allow_duet, allow_stitch, schedule_at,
      });
      res.status(result.success ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "TikTok post failed" });
    }
  }
);

// Ephemeral QR hand-off for `connect --qr`. Free + unauthenticated (it stores a
// tiny, short-TTL login QR so an agent can forward a /connect/<token> link to a
// human). No proxy/browser, so no requireTikTokEnabled.
router.post(
  "/tiktok/qr",
  (req: AuthenticatedRequest, res: Response) => {
    try {
      // No body → create a session up front (agent gets the link immediately).
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

router.post(
  "/tiktok/analytics",
  requireTikTokEnabled,
  requireAuth(0.005, "general", { discoverable: false }),
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
