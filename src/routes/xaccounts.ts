import { Router, Request, Response } from "express";
import { xAccountService } from "../services/xaccounts";

const router = Router();

// Initialize table on load
xAccountService.init().catch(console.error);

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
 * GET /x/accounts/:id — Check account status
 */
router.get("/accounts/:id", async (req: Request, res: Response) => {
  try {
    const account = await xAccountService.getAccount(req.params.id as string);

    if (!account) {
      res.status(404).json({ error: "Not Found", message: "Account not found" });
      return;
    }

    // Only return full details if the requester is the buyer
    const wallet = (req as any).payerAddress || req.query.wallet;
    if (account.sold_to && account.sold_to === wallet) {
      res.json({
        id: account.id,
        username: account.username,
        email: account.email,
        password: account.password,
        cookies: JSON.parse(account.cookies),
        auth_token: account.auth_token,
        status: account.status,
        age_days: account.age_days,
      });
    } else {
      // Public info only
      res.json({
        id: account.id,
        username: account.username,
        status: account.status,
        warmed: account.warmed,
        age_days: account.age_days,
      });
    }
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
 * POST /x/accounts/add — Add account to pool (admin only)
 * 
 * Body: { username, email, password, cookies?, auth_token?, profile_name?, profile_bio?, warmed? }
 */
router.post("/accounts/add", async (req: Request, res: Response) => {
  try {
    // TODO: Add admin auth check
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
 * Body: { status: "available" | "suspended" }
 */
router.patch("/accounts/:id/status", async (req: Request, res: Response) => {
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
 * Body: { cookies: [...] }
 */
router.patch("/accounts/:id/cookies", async (req: Request, res: Response) => {
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
