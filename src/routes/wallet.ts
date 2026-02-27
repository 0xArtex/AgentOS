import { Router, Response } from "express";
import { requireDashboardAuth, DashboardRequest } from "../middleware/dashboard-session";
import * as walletService from "../services/wallet";

const router = Router();

// All wallet routes require dashboard auth
router.use(requireDashboardAuth as any);

/**
 * POST /wallet — Create a new wallet (Solana + Base pair)
 * Free — no charge
 */
router.post("/", (req: DashboardRequest, res: Response) => {
  try {
    const { label } = req.body || {};
    const wallet = walletService.createWallet(req.dashUserId!, label);
    res.json({
      success: true,
      wallet,
      message: "Wallet created with Solana + Base addresses",
    });
  } catch (err: any) {
    console.error("[wallet] Create error:", err);
    res.status(500).json({ error: "Failed to create wallet", message: err.message });
  }
});

/**
 * GET /wallet — List all wallets for this user
 */
router.get("/", (req: DashboardRequest, res: Response) => {
  const wallets = walletService.getWallets(req.dashUserId!);
  res.json({ wallets });
});

/**
 * GET /wallet/:id — Get a specific wallet
 */
router.get("/:id", (req: DashboardRequest, res: Response) => {
  const wallet = walletService.getWallet(req.dashUserId!, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });
  res.json({ wallet });
});

/**
 * GET /wallet/:id/config — Get agent config for this wallet
 * Returns the config snippet to inject into an agent's setup
 */
router.get("/:id/config", (req: DashboardRequest, res: Response) => {
  const config = walletService.getAgentConfig(req.dashUserId!, String(req.params.id));
  if (!config) return res.status(404).json({ error: "Wallet not found" });
  res.json({ config });
});

/**
 * DELETE /wallet/:id — Delete a wallet
 */
router.delete("/:id", (req: DashboardRequest, res: Response) => {
  const deleted = walletService.deleteWallet(req.dashUserId!, String(req.params.id));
  if (!deleted) return res.status(404).json({ error: "Wallet not found" });
  res.json({ success: true, message: "Wallet deleted" });
});

export default router;
