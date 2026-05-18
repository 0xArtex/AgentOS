import { Router, Request, Response } from "express";
import { xAccountService, XAccount } from "../services/xaccounts";
import { requirePoolAdmin } from "../middleware/pool-admin";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { changePassword, generateStrongPassword } from "../services/social-operations";
import { createTransfer } from "../services/transfers";

const router = Router();

// Initialize table on load
xAccountService.init().catch(console.error);

// Owners are wallet addresses on either chain x402 settles on:
//   Solana: base58, 32–44 chars
//   EVM (Base): 0x + 40 hex chars
const SOL_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const isWalletAddress = (s: string) => typeof s === "string" && (SOL_PUBKEY.test(s) || EVM_ADDR.test(s));

// Symbolic x402 fee on owner-write endpoints. The point is the signature, not
// the dollar amount — paying with USDC cryptographically proves the caller
// controls the wallet they claim, which the routes use to gate transfer/share.
// Mirrors the domains.ts pattern.
const OWNERSHIP_PROOF_USDC = 0.0001;

function callerWallet(req: Request): string | null {
  const r = req as AuthenticatedRequest;
  const w = r.payment?.payer || r.agentId || (req as any).payerAddress || req.body?.wallet || req.query?.wallet;
  return typeof w === "string" && w ? w : null;
}

function serializeAccount(account: XAccount, includeSecrets: boolean) {
  const base = {
    id: account.id,
    username: account.username,
    status: account.status,
    warmed: account.warmed,
    age_days: account.age_days,
    sold_to: account.sold_to,
    shared_with: account.shared_with,
  };
  if (!includeSecrets) return base;
  let cookies: any[] = [];
  try { cookies = JSON.parse(account.cookies || "[]"); } catch { cookies = []; }
  return {
    ...base,
    email: account.email,
    password: account.password,
    cookies,
    auth_token: account.auth_token,
    profile: {
      name: account.profile_name,
      bio: account.profile_bio,
      image: account.profile_image,
    },
  };
}

/**
 * POST /x/accounts — Purchase an X account from the pool
 * 
 * x402 payment: $5.00 USDC
 * 
 * Returns: account credentials (username, email, password, cookies, auth_token)
 */
router.post("/accounts", async (req: Request, res: Response) => {
  try {
    const buyerWallet = (req as any).payerAddress || req.body.wallet || "unknown";

    const account = await xAccountService.purchaseAccount(buyerWallet);

    if (!account) {
      res.status(503).json({
        error: "No Accounts Available",
        message: "All X accounts in the pool are currently sold or reserved. Check back soon.",
      });
      return;
    }

    res.json({
      id: account.id,
      username: account.username,
      email: account.email,
      password: account.password,
      cookies: JSON.parse(account.cookies),
      auth_token: account.auth_token,
      profile: {
        name: account.profile_name,
        bio: account.profile_bio,
        image: account.profile_image,
      },
      warmed: account.warmed,
      age_days: account.age_days,
      status: "ready",
      message: `X account @${account.username} is yours. Login with the email/password or import the cookies.`,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Purchase Failed", message: error.message });
  }
});

/**
 * GET /x/accounts/mine — List every account the caller owns or has shared
 * access to. Returns full credentials for each (so a freshly-onboarded wallet
 * that's been transferred an account can pick it up). Placed BEFORE /:id so
 * the literal "mine" doesn't get matched as an account id.
 *
 * Auth: x402 ownership proof. The payer signature is the only thing keeping
 * this endpoint from leaking every X account's password to anyone with a
 * wallet address.
 */
router.get("/accounts/mine", requireAuth(OWNERSHIP_PROOF_USDC, 'general', { discoverable: false }), async (req: Request, res: Response) => {
  try {
    const wallet = callerWallet(req);
    if (!wallet) {
      res.status(401).json({ error: "Unauthorized", message: "Provide a wallet via x402 payment or ?wallet=…" });
      return;
    }

    const accounts = await xAccountService.accountsAccessibleBy(wallet);
    res.json({
      wallet,
      count: accounts.length,
      accounts: accounts.map(a => ({
        ...serializeAccount(a, true),
        access: a.sold_to === wallet ? "owner" : "shared",
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: "Error", message: error.message });
  }
});

/**
 * GET /x/accounts/:id — Account status. Returns full credentials to the
 * owner and to any wallet in shared_with; otherwise returns public-only info.
 */
router.get("/accounts/:id", async (req: Request, res: Response) => {
  try {
    const account = await xAccountService.getAccount(req.params.id as string);

    if (!account) {
      res.status(404).json({ error: "Not Found", message: "Account not found" });
      return;
    }

    const wallet = callerWallet(req);
    const hasAccess = !!wallet && xAccountService.canAccess(account, wallet);
    res.json(serializeAccount(account, hasAccess));
  } catch (error: any) {
    res.status(500).json({ error: "Error", message: error.message });
  }
});

/**
 * GET /x/accounts — Pool stats (public)
 */
router.get("/accounts", async (_req: Request, res: Response) => {
  try {
    const stats = await xAccountService.getPoolStats();
    res.json({
      available: stats.available,
      total: stats.total,
      message: stats.available > 0
        ? `${stats.available} X accounts ready for purchase`
        : "No accounts currently available",
    });
  } catch (error: any) {
    res.status(500).json({ error: "Error", message: error.message });
  }
});

/**
 * POST /x/accounts/:id/transfer — Atomically hand an X account to another wallet.
 *
 * Body: { to_wallet }
 *
 * Flow: caller must currently own the account. Server rotates the password
 * (and revokes other sessions), then flips sold_to to the new wallet and
 * stores the rotated credentials. New owner picks them up by calling
 * GET /x/accounts/mine — the credentials never leave the server through
 * the response to the *transferring* wallet, so the prior owner can't
 * retain a copy of the post-rotation login.
 */
router.post("/accounts/:id/transfer", requireAuth(OWNERSHIP_PROOF_USDC, 'general', { discoverable: false }), async (req: Request, res: Response) => {
  try {
    const caller = callerWallet(req);
    if (!caller) {
      res.status(401).json({ error: "Unauthorized", message: "Caller wallet required" });
      return;
    }

    const { to_wallet } = req.body || {};
    if (!isWalletAddress(to_wallet)) {
      res.status(400).json({ error: "Bad Request", message: "to_wallet must be a Solana (base58) or EVM (0x…) wallet address" });
      return;
    }
    if (to_wallet === caller) {
      res.status(400).json({ error: "Bad Request", message: "to_wallet is already the current owner" });
      return;
    }

    const account = await xAccountService.getAccount(req.params.id as string);
    if (!account) {
      res.status(404).json({ error: "Not Found", message: "Account not found" });
      return;
    }
    if (account.sold_to !== caller) {
      res.status(403).json({ error: "Forbidden", message: "Caller does not own this account" });
      return;
    }
    if (account.status === "suspended") {
      res.status(409).json({ error: "Conflict", message: "Account is suspended — cannot transfer" });
      return;
    }

    let currentCookies: any[] = [];
    try { currentCookies = JSON.parse(account.cookies || "[]"); } catch { currentCookies = []; }
    if (currentCookies.length === 0) {
      res.status(409).json({
        error: "Conflict",
        message: "Account has no cached cookies — run twitter login first so the server can drive the password-change UI",
      });
      return;
    }

    // Kick off the rotation in the background. We return 202 with the
    // transfer_id immediately — the actual Playwright work takes 30-90s,
    // which is longer than Cloudflare Tunnel's HTTP response budget. Client
    // polls GET /transfers/:transfer_id for status.
    const transfer = createTransfer("x_accounts", account.id, caller, to_wallet);
    res.status(202).json({
      transfer_id: transfer.id,
      status: transfer.status,
      account_id: account.id,
      username: account.username,
      from_wallet: caller,
      to_wallet,
      message: "Transfer accepted. Poll GET /transfers/:transfer_id to see when the rotation completes.",
      poll_url: `/transfers/${transfer.id}`,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Error", message: error.message });
  }
});

/**
 * POST /x/accounts/:id/share — Grant another wallet read access to this account.
 *
 * Body: { with }  — wallet to share with
 *
 * Sharing does NOT rotate credentials. Shared wallets see the same cookies /
 * password / auth_token. Effectively "shared login," same as handing someone
 * your Netflix password. Owner can revoke at any time with /unshare.
 */
router.post("/accounts/:id/share", requireAuth(OWNERSHIP_PROOF_USDC, 'general', { discoverable: false }), async (req: Request, res: Response) => {
  try {
    const caller = callerWallet(req);
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const withWallet = (req.body || {}).with;
    if (!isWalletAddress(withWallet)) {
      res.status(400).json({ error: "Bad Request", message: "`with` must be a wallet address" });
      return;
    }

    const account = await xAccountService.getAccount(req.params.id as string);
    if (!account) {
      res.status(404).json({ error: "Not Found" });
      return;
    }
    if (account.sold_to !== caller) {
      res.status(403).json({ error: "Forbidden", message: "Only the owner can share an account" });
      return;
    }

    const updated = await xAccountService.share(account.id, withWallet);
    res.json({
      message: `@${account.username} shared with ${withWallet}`,
      id: account.id,
      username: account.username,
      shared_with: updated?.shared_with || [],
    });
  } catch (error: any) {
    res.status(500).json({ error: "Error", message: error.message });
  }
});

/**
 * POST /x/accounts/:id/unshare — Revoke a wallet's shared access.
 *
 * Body: { wallet, rotate? }
 *
 * When `rotate: true` is set, the server additionally rotates the account
 * password and revokes other sessions before returning. Use this when the
 * shared wallet may have exported cookies or noted the password — sharing
 * gives them the same login, so simply removing them from `shared_with` on
 * the server doesn't invalidate creds they already captured. The rotated
 * credentials are returned to the caller (still the owner) so the local
 * vault can be updated.
 */
router.post("/accounts/:id/unshare", requireAuth(OWNERSHIP_PROOF_USDC, 'general', { discoverable: false }), async (req: Request, res: Response) => {
  try {
    const caller = callerWallet(req);
    if (!caller) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = req.body || {};
    const targetWallet = body.wallet;
    const rotate = body.rotate === true;
    if (!isWalletAddress(targetWallet)) {
      res.status(400).json({ error: "Bad Request", message: "`wallet` must be a wallet address" });
      return;
    }

    const account = await xAccountService.getAccount(req.params.id as string);
    if (!account) {
      res.status(404).json({ error: "Not Found" });
      return;
    }
    if (account.sold_to !== caller) {
      res.status(403).json({ error: "Forbidden", message: "Only the owner can revoke shares" });
      return;
    }

    // Step 1: remove from shared_with. Fast, can't really fail, and we want
    // it persisted before the slow rotation in case rotation blows up.
    const afterUnshare = await xAccountService.unshare(account.id, targetWallet);

    if (!rotate) {
      res.json({
        message: `${targetWallet} no longer has shared access to @${account.username}`,
        id: account.id,
        username: account.username,
        shared_with: afterUnshare?.shared_with || [],
        rotated: false,
      });
      return;
    }

    // Step 2: rotate credentials. The revoked wallet may have exported
    // cookies / noted the password — the unshare on its own only blocks
    // /mine reads on the server; it doesn't invalidate already-captured
    // creds. Password change + log-out-other-sessions handles that.
    let currentCookies: any[] = [];
    try { currentCookies = JSON.parse(account.cookies || "[]"); } catch { currentCookies = []; }
    if (currentCookies.length === 0) {
      res.status(200).json({
        message: `${targetWallet} unshared, but rotation skipped — no cached cookies for @${account.username}. Run twitter login first, then re-run with --rotate.`,
        id: account.id,
        username: account.username,
        shared_with: afterUnshare?.shared_with || [],
        rotated: false,
        rotation_skipped_reason: "no_cookies",
      });
      return;
    }

    const newPassword = generateStrongPassword();
    const rotation = await changePassword({
      account_id: account.id,
      cookies: currentCookies,
      current_password: account.password,
      new_password: newPassword,
      log_out_other_sessions: true,
    });

    if (!rotation.success) {
      // Unshare succeeded but rotation didn't. The revoked wallet still
      // can't read /mine (they're out of shared_with), but they may still
      // have working cookies. Surface the failure so the caller can retry.
      res.status(207).json({
        message: `${targetWallet} unshared. Password rotation failed — retry with palmyr twitter rotate-password ${account.username} (or assume the revoked wallet may retain cookie access until they expire).`,
        id: account.id,
        username: account.username,
        shared_with: afterUnshare?.shared_with || [],
        rotated: false,
        rotation_error: rotation.error,
        rotation_error_code: rotation.error_code,
      });
      return;
    }

    const newCookiesArr = rotation.data?.cookies && rotation.data.cookies.length > 0
      ? rotation.data.cookies
      : [];
    const updated = await xAccountService.updateCredentials(account.id, {
      password: newPassword,
      cookies: JSON.stringify(newCookiesArr),
      auth_token: rotation.data?.auth_token || null,
    });

    res.json({
      message: `${targetWallet} unshared and credentials rotated for @${account.username}.`,
      id: account.id,
      username: updated?.username || account.username,
      shared_with: updated?.shared_with || afterUnshare?.shared_with || [],
      rotated: true,
      // Caller is still the owner — returning fresh creds is safe and
      // necessary so the local vault stays in sync.
      credentials: {
        password: newPassword,
        cookies: newCookiesArr,
        auth_token: rotation.data?.auth_token || null,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: "Error", message: error.message });
  }
});

/**
 * POST /x/accounts/add — Add account to pool (admin only)
 *
 * Auth: pool-admin signature (X-Admin-Pubkey/Timestamp/Signature).
 * Body: { username, email, password, cookies?, auth_token?, profile_name?, profile_bio?, warmed? }
 */
router.post("/accounts/add", requirePoolAdmin, async (req: Request, res: Response) => {
  try {
    const { username, email, password, cookies, auth_token, profile_name, profile_bio, profile_image, warmed } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({
        error: "Missing Fields",
        message: "username, email, and password are required",
      });
      return;
    }

    // Check if username already exists
    const existing = await xAccountService.getByUsername(username);
    if (existing) {
      res.status(409).json({
        error: "Duplicate",
        message: `Account @${username} already exists in the pool`,
      });
      return;
    }

    const account = await xAccountService.addAccount({
      username,
      email,
      password,
      cookies: cookies ? JSON.stringify(cookies) : undefined,
      auth_token,
      profile_name,
      profile_bio,
      profile_image,
      warmed: !!warmed,
    });

    res.status(201).json({
      id: account.id,
      username: account.username,
      status: account.status,
      message: `@${username} added to the pool`,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Error", message: error.message });
  }
});

/**
 * PATCH /x/accounts/:id/status — Update account status (admin only)
 *
 * Auth: pool-admin signature.
 * Body: { status: "available" | "suspended" }
 */
router.patch("/accounts/:id/status", requirePoolAdmin, async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!["available", "reserved", "sold", "suspended"].includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }

    const account = await xAccountService.getAccount(req.params.id as string);
    if (!account) {
      res.status(404).json({ error: "Not Found" });
      return;
    }

    await xAccountService.updateStatus(req.params.id as string, status);
    res.json({ id: req.params.id as string, status, message: `Account status updated to ${status}` });
  } catch (error: any) {
    res.status(500).json({ error: "Error", message: error.message });
  }
});

/**
 * PATCH /x/accounts/:id/cookies — Refresh account cookies (admin only)
 *
 * Auth: pool-admin signature.
 * Body: { cookies: [...] }
 */
router.patch("/accounts/:id/cookies", requirePoolAdmin, async (req: Request, res: Response) => {
  try {
    const { cookies } = req.body;
    if (!cookies) {
      res.status(400).json({ error: "Missing cookies" });
      return;
    }

    await xAccountService.updateCookies(req.params.id as string, JSON.stringify(cookies));
    res.json({ id: req.params.id as string, message: "Cookies updated" });
  } catch (error: any) {
    res.status(500).json({ error: "Error", message: error.message });
  }
});

export default router;
