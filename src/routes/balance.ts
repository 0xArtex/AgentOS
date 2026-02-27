import { Router, Request, Response } from "express";
import * as balanceService from "../services/balance";
import { getOrCreateWallet } from "../services/deposit-wallets";

const router = Router();

function getUserId(req: Request): string | null {
  return (req.headers["x-dashboard-user"] as string) || null;
}

// GET / — balance + deposit addresses
router.get("/", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

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
router.get("/transactions", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

  const limit = parseInt(req.query.limit as string) || 50;
  const transactions = balanceService.getTransactions(userId, limit);
  res.json({ transactions });
});

// GET /deposit-address
router.get("/deposit-address", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

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

// POST /deposit/crypto — manual deposit notification (with tx hash)
router.post("/deposit/crypto", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

  const { txHash, chain, amount } = req.body || {};
  if (!txHash || !amount || !chain) {
    return res.status(400).json({ error: "txHash, chain, and amount required" });
  }

  try {
    // TODO: Verify on-chain that this tx actually sent USDC to our deposit wallet
    // For now, log and credit (deposit monitor will also catch it)
    const balance = balanceService.deposit(userId, amount, txHash, `${chain} USDC deposit`);
    res.json({ success: true, ...balance });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /deposit/test — TESTING ONLY: fake deposit
// ⚠️ REMOVE IN PRODUCTION
router.post("/deposit/test", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

  const { amount } = req.body || {};
  if (!amount || amount <= 0) return res.status(400).json({ error: "amount required (positive number)" });

  const balance = balanceService.deposit(userId, amount, `test_${Date.now()}`, "Test deposit");
  res.json({ success: true, ...balance });
});

export default router;
