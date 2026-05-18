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
  registerAccount,
  unregisterAccount,
  listRegisteredAccounts,
  accountsAccessibleBy,
  getOwnerDecryptedState,
  persistRotatedCreds,
  shareRegistered,
  unshareRegistered,
} from "../services/registered-accounts";
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
  changePassword,
  generateStrongPassword,
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

    const newPassword = generateStrongPassword();
    const rotation = await changePassword({
      account_id: state.row.id,
      proxy_session_id: state.row.proxy_session_id,
      cookies: state.cookies,
      current_password: state.creds.password,
      new_password: newPassword,
      log_out_other_sessions: true,
    });

    if (!rotation.success) {
      // Atomic: no DB change. Old owner keeps the account.
      res.status(502).json({
        error: rotation.error || "Password rotation failed",
        error_code: rotation.error_code,
      });
      return;
    }

    const newCookies = rotation.data?.cookies && rotation.data.cookies.length > 0
      ? rotation.data.cookies
      : state.cookies;
    const newCreds = {
      ...state.creds,
      password: newPassword,
      auth_token: rotation.data?.auth_token || undefined,
      ct0: rotation.data?.ct0 || undefined,
    };

    const updated = persistRotatedCreds(state.row.id, caller, newCreds, newCookies, {
      transferToWallet: to_wallet,
    });
    if (!updated) {
      res.status(409).json({
        error: "Ownership changed during rotation; password was rotated but transfer aborted",
      });
      return;
    }

    res.json({
      success: true,
      message: `Account @${state.row.username} transferred to ${to_wallet}. Credentials rotated; the new owner can claim with: palmyr twitter claim`,
      id: state.row.id,
      username: state.row.username,
      previous_owner: caller,
      new_owner: to_wallet,
      credentials_rotated: true,
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

    // --rotate path: decrypt → changePassword → re-encrypt → persist
    const state = getOwnerDecryptedState(accountId, caller);
    if (!state || state.cookies.length === 0) {
      res.status(200).json({
        success: true,
        message: `${body.wallet} unshared, but rotation skipped — no cached cookies for this account`,
        id: accountId,
        shared_with: afterUnshare,
        rotated: false,
        rotation_skipped_reason: "no_cookies",
      });
      return;
    }

    const newPassword = generateStrongPassword();
    const rotation = await changePassword({
      account_id: state.row.id,
      proxy_session_id: state.row.proxy_session_id,
      cookies: state.cookies,
      current_password: state.creds.password,
      new_password: newPassword,
      log_out_other_sessions: true,
    });

    if (!rotation.success) {
      // Unshare succeeded; rotation didn't. The revoked wallet is out of
      // shared_with, but may still have working cookies until X-side expiry.
      res.status(207).json({
        success: true,
        message: `${body.wallet} unshared. Password rotation failed — retry to fully revoke any cached creds`,
        id: accountId,
        shared_with: afterUnshare,
        rotated: false,
        rotation_error: rotation.error,
        rotation_error_code: rotation.error_code,
      });
      return;
    }

    const newCookies = rotation.data?.cookies && rotation.data.cookies.length > 0
      ? rotation.data.cookies
      : state.cookies;
    const newCreds = {
      ...state.creds,
      password: newPassword,
      auth_token: rotation.data?.auth_token || undefined,
      ct0: rotation.data?.ct0 || undefined,
    };

    const updated = persistRotatedCreds(state.row.id, caller, newCreds, newCookies);
    if (!updated) {
      res.status(207).json({
        success: true,
        message: `${body.wallet} unshared; rotation completed on X but DB write raced — re-resolve session to pick up new state`,
        id: accountId,
        shared_with: afterUnshare,
        rotated: false,
      });
      return;
    }

    res.json({
      success: true,
      message: `${body.wallet} unshared and credentials rotated`,
      id: accountId,
      shared_with: afterUnshare,
      rotated: true,
      // Caller is still the owner — returning fresh creds is safe and
      // necessary so the local vault stays in sync.
      credentials: {
        password: newPassword,
        cookies: newCookies,
        auth_token: rotation.data?.auth_token || null,
      },
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

router.post(
  "/scheduled/post",
  requireXEnabled,
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
