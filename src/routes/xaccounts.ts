import { Router, Request, Response } from "express";
import { xAccountService, XAccount } from "../services/xaccounts";
import { requirePoolAdmin } from "../middleware/pool-admin";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
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
// Mirrors the domains.ts pattern. Held at 0.01 USDC because the previous
// 0.0001 USDC (= 100 atomic units) tripped Coinbase CDP's "invalid_payload"
// on Base — keep the two constants in lockstep.
const OWNERSHIP_PROOF_USDC = 0.01;

/**
 * Cryptographically PROVEN caller identity. Deliberately does NOT fall back to
 * req.body.wallet / req.query.wallet — those are caller-asserted strings, and
 * since wallet addresses are public on-chain, anyone could pass `?wallet=<owner>`
 * to impersonate an owner and scrape their credentials. Only the x402 payer
 * (proven by the USDC payment signature) or an authenticated agentId counts as
 * identity.
 *
 * Use this for every route where a positive ownership decision releases secrets
 * or mutates ownership. The paid owner-only routes funnel through requireAuth,
 * which always sets payment.payer / agentId on the success path, so dropping the
 * query/body fallback removes a spoofable path without changing legitimate flows.
 */
function provenCallerWallet(req: Request): string | null {
  const r = req as AuthenticatedRequest;
  const w = r.payment?.payer || r.agentId || (req as any).payerAddress;
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
 * POST /x/accounts — DEPRECATED. Was the original $5-flat-rate buy route
 * backed by the x_accounts table. Superseded by POST /social/twitter/buy
 * which supports per-country pricing, source filters, rename-history
 * filters, and the dispute/replacement flow.
 *
 * Hard cutover: returns 410 Gone so callers fail loudly instead of silently
 * paying $5 for a non-country-tagged account from a stale pool. The
 * surrounding ownership routes (GET /x/accounts/mine, transfer, share,
 * admin endpoints) still operate on the x_accounts table so already-bought
 * legacy accounts keep working.
 */
router.post("/accounts", (_req: Request, res: Response) => {
  res.status(410).json({
    error: "Gone",
    code: "endpoint_deprecated",
    message:
      "POST /x/accounts has been retired. Use POST /social/twitter/buy " +
      "(CLI: `palmyr twitter buy [--country US] [--source web] [--max-renames 0]`).",
    successor: {
      route: "POST /social/twitter/buy",
      cli: "palmyr twitter buy",
      pricing: "GET /social/twitter/pool/prices",
    },
  });
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
router.get("/accounts/mine", requireAuth(OWNERSHIP_PROOF_USDC, 'general', {
  description: "List X accounts your wallet owns or has shared access to (returns full credentials).",
  category: "social",
  tags: ["twitter", "x", "accounts", "mine"],
}), async (req: Request, res: Response) => {
  try {
    // PROVEN identity only — this returns full credentials, so an asserted
    // ?wallet= must never satisfy it. requireAuth guarantees payment.payer or
    // agentId is set on the success path, so requiring the proven identity here
    // changes no legitimate flow while staying regression-proof.
    const wallet = provenCallerWallet(req);
    if (!wallet) {
      res.status(401).json({ error: "Unauthorized", message: "Provide a wallet via x402 payment (your signature proves ownership)" });
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
 * GET /x/accounts/:id — Account status (public, non-sensitive view only).
 *
 * This route is UNAUTHENTICATED, so it can NEVER return credentials: a
 * `?wallet=<owner>` param is not proof of identity (wallet addresses are
 * public on-chain), and serving secrets off an asserted wallet let anyone
 * who knew an account id scrape every password/cookie/auth_token. Secrets are
 * released only through the paid, payer-proven GET /x/accounts/mine route,
 * whose x402 signature actually proves the caller controls the wallet.
 *
 * We still honour a PROVEN identity (agent token / x402 payer) if one happens
 * to be present, so an authenticated owner hitting this path gets their own
 * credentials — but an asserted query/body `wallet` never does.
 */
router.get("/accounts/:id", async (req: Request, res: Response) => {
  try {
    const account = await xAccountService.getAccount(req.params.id as string);

    if (!account) {
      res.status(404).json({ error: "Not Found", message: "Account not found" });
      return;
    }

    const wallet = provenCallerWallet(req);
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
router.post("/accounts/:id/transfer", requireAuth(OWNERSHIP_PROOF_USDC, 'general', {
  description: "Transfer an X account to another wallet (rotates the password). Owner-only.",
  category: "social",
  tags: ["twitter", "x", "transfer", "ownership"],
}), async (req: Request, res: Response) => {
  try {
    const caller = provenCallerWallet(req);
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
router.post("/accounts/:id/share", requireAuth(OWNERSHIP_PROOF_USDC, 'general', {
  description: "Grant another wallet shared access to an X account you own.",
  category: "social",
  tags: ["twitter", "x", "share"],
}), async (req: Request, res: Response) => {
  try {
    const caller = provenCallerWallet(req);
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
router.post("/accounts/:id/unshare", requireAuth(OWNERSHIP_PROOF_USDC, 'general', {
  description: "Revoke a wallet's shared access to an X account you own.",
  category: "social",
  tags: ["twitter", "x", "unshare"],
}), async (req: Request, res: Response) => {
  try {
    const caller = provenCallerWallet(req);
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

    // Step 2: rotate credentials in the background. Same async machinery
    // as transfer (Playwright takes longer than Cloudflare's HTTP timeout).
    // We DON'T pre-check for cached cookies here — the background runner
    // handles that and surfaces a clean failure if there's nothing to
    // drive the password-change UI with.
    const transfer = createTransfer("x_accounts", account.id, caller, caller, "unshare_rotate");
    res.status(202).json({
      message: `${targetWallet} unshared. Rotation kicked off — poll /transfers/${transfer.id} for status.`,
      id: account.id,
      username: account.username,
      shared_with: afterUnshare?.shared_with || [],
      rotated: false,
      rotation_in_progress: true,
      transfer_id: transfer.id,
      poll_url: `/transfers/${transfer.id}`,
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
