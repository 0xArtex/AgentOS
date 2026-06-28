import { Router, Request, Response } from "express";
import * as balanceService from "../services/balance";
import { getOrCreateWallet } from "../services/deposit-wallets";
import { requireDashboardAuth, DashboardRequest } from "../middleware/dashboard-session";

const router = Router();

function getUserId(req: DashboardRequest): string | null {
  // Only the validated dashboard session (via requireDashboardAuth →
  // resolveDashboardSession) sets req.dashUserId. NEVER fall back to the raw
  // X-Dashboard-User header — it is attacker-controlled and trusting it let any
  // anonymous caller read another tenant's balance, ledger, and deposit
  // addresses just by guessing their user_id.
  return req.dashUserId || null;
}

// GET / — balance + deposit addresses
router.get("/", requireDashboardAuth, (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Authentication required" });

  const balance = balanceService.getBalance(userId);
  const wallet = getOrCreateWallet(userId);

  res.json({
    ...balance,
    deposit_addresses: {
      solana: wallet.solanaAddress,
      evm: wallet.evmAddress,
    },
  });
});

// GET /transactions
router.get("/transactions", requireDashboardAuth, (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Authentication required" });

  const limit = parseInt(req.query.limit as string) || 50;
  const transactions = balanceService.getTransactions(userId, limit);
  res.json({ transactions });
});

// GET /deposit-address
router.get("/deposit-address", requireDashboardAuth, (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Authentication required" });

  const wallet = getOrCreateWallet(userId);
  res.json({
    solana: wallet.solanaAddress,
    evm: wallet.evmAddress,
    instructions: {
      solana: "Send USDC (SPL) to the Solana address. Balance credits automatically within 60 seconds.",
      evm: "Send USDC on Base to the EVM address. Balance credits automatically within 60 seconds.",
    },
  });
});

// POST /debit — debit balance for service
router.post("/debit", requireDashboardAuth, (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Auth required" });

  const { amount, serviceType, description } = req.body || {};
  if (!amount || amount <= 0) return res.status(400).json({ error: "amount required (positive number)" });

  try {
    const balance = balanceService.debit(userId, amount, serviceType || "service", description || "Service provisioning");
    res.json({ success: true, ...balance });
  } catch (e: any) {
    res.status(402).json({ error: e.message });
  }
});

// POST /deposit/test — TESTING ONLY: fake deposit
// Gated by ALLOW_TEST_DEPOSITS=true. Without the flag the route is not
// registered at all, so prod can't be tricked into crediting fake balances
// even if NODE_ENV is misconfigured.
if (process.env.ALLOW_TEST_DEPOSITS === "true") {
  router.post("/deposit/test", requireDashboardAuth, (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const { amount } = req.body || {};
    if (!amount || amount <= 0) return res.status(400).json({ error: "amount required (positive number)" });

    const balance = balanceService.deposit(userId, amount, `test_${Date.now()}`, "Test deposit");
    res.json({ success: true, ...balance });
  });
}

export default router;
