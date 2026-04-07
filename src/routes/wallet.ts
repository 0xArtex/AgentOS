import { Router, Response } from "express";
import {
  requireDashboardOnly,
  requireWalletAuth,
  resolveWalletAccess,
  WalletAuthRequest,
} from "../middleware/wallet-auth";
import * as walletService from "../services/wallet";

const router = Router();

// ─── Management routes — dashboard auth only ───

/**
 * POST /wallet — Create a new vault-backed wallet (dashboard users only)
 * Body: { label?, chains?: string[] }
 */
router.post("/", requireDashboardOnly, async (req: WalletAuthRequest, res: Response) => {
  try {
    const { label, chains } = req.body || {};
    const wallet = await walletService.createWallet(req.dashUserId!, label, chains);
    res.json({
      success: true,
      wallet,
      message: "Wallet created via Open Wallet Standard",
    });
  } catch (err: any) {
    console.error("[wallet] Create error:", err);
    res.status(500).json({ error: "Failed to create wallet", message: err.message });
  }
});

/**
 * POST /wallet/import — Import wallet from mnemonic (dashboard only)
 */
router.post("/import", requireDashboardOnly, async (req: WalletAuthRequest, res: Response) => {
  try {
    const { mnemonic, label } = req.body || {};
    if (!mnemonic) return res.status(400).json({ error: "mnemonic is required" });
    const wallet = await walletService.importWallet(req.dashUserId!, mnemonic, label);
    res.json({ success: true, wallet });
  } catch (err: any) {
    console.error("[wallet] Import error:", err);
    res.status(500).json({ error: "Failed to import wallet", message: err.message });
  }
});

/**
 * GET /wallet — List all wallets for the authenticated user (dashboard only)
 */
router.get("/", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  const wallets = walletService.getWallets(req.dashUserId!);
  res.json({ wallets });
});

/**
 * DELETE /wallet/:id — Delete a wallet (dashboard only)
 */
router.delete("/:id", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  const deleted = walletService.deleteWallet(req.dashUserId!, String(req.params.id));
  if (!deleted) return res.status(404).json({ error: "Wallet not found" });
  res.json({ success: true, message: "Wallet deleted" });
});

/**
 * POST /wallet/:id/api-key — Create AgentOS API key (dashboard only — sensitive)
 */
router.post("/:id/api-key", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  try {
    const { name, policyIds, expiresAt } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const result = walletService.createApiKeyForWallet(
      req.dashUserId!,
      String(req.params.id),
      name,
      policyIds,
      expiresAt,
    );
    res.json({ success: true, apiKey: result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /wallet/:id/api-key — Revoke API key (dashboard only)
 */
router.delete("/:id/api-key", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  try {
    const { keyId } = req.body || {};
    if (!keyId) return res.status(400).json({ error: "keyId is required" });
    walletService.revokeWalletApiKey(req.dashUserId!, String(req.params.id), keyId);
    res.json({ success: true, message: "API key revoked" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /wallet/:id/config — Get agent config (dashboard only — returns new API key)
 */
router.get("/:id/config", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  const config = walletService.getAgentConfig(req.dashUserId!, String(req.params.id));
  if (!config) return res.status(404).json({ error: "Wallet not found" });
  res.json({ config });
});

/**
 * POST /wallet/:id/policy — Update wallet policy (dashboard only)
 */
router.post("/:id/policy", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  try {
    const { policy } = req.body || {};
    if (!policy) return res.status(400).json({ error: "policy is required" });
    const json = typeof policy === "string" ? policy : JSON.stringify(policy);
    walletService.updatePolicy(req.dashUserId!, String(req.params.id), json);
    res.json({ success: true, message: "Policy updated" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Read + signing routes — dashboard OR agent API key ───

/**
 * GET /wallet/:id — Get wallet details (dashboard OR agent with API key)
 */
router.get("/:id", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });

  // Return the full wallet info (map from DB row to service format)
  const walletInfo = req.dashUserId
    ? walletService.getWallet(req.dashUserId, String(req.params.id))
    : walletService.getWallet(wallet.user_id, String(req.params.id));
  res.json({ wallet: walletInfo });
});

/**
 * GET /wallet/:id/addresses — List all chain addresses
 */
router.get("/:id/addresses", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
  try {
    const addresses = walletService.getAddresses(wallet.user_id, String(req.params.id));
    res.json({ addresses });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /wallet/:id/derive — Derive address for additional chain
 */
router.post("/:id/derive", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
  try {
    const { chain } = req.body || {};
    if (!chain) return res.status(400).json({ error: "chain is required" });
    const address = walletService.deriveChainAddress(wallet.user_id, String(req.params.id), chain);
    res.json({ chain, address });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /wallet/:id/sign — Sign a transaction (agent or dashboard)
 */
router.post("/:id/sign", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
  try {
    const { chain, transaction } = req.body || {};
    if (!chain || !transaction) return res.status(400).json({ error: "chain and transaction are required" });
    const result = walletService.signTransaction(wallet.user_id, String(req.params.id), chain, transaction);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: "Signing failed", message: err.message });
  }
});

/**
 * POST /wallet/:id/sign-message — Sign a message (agent or dashboard)
 */
router.post("/:id/sign-message", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
  try {
    const { chain, message, encoding } = req.body || {};
    if (!chain || !message) return res.status(400).json({ error: "chain and message are required" });
    const result = walletService.signMessage(wallet.user_id, String(req.params.id), chain, message, encoding);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: "Signing failed", message: err.message });
  }
});

/**
 * POST /wallet/:id/sign-typed — Sign EIP-712 typed data (agent or dashboard)
 */
router.post("/:id/sign-typed", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
  try {
    const { chain, typedData } = req.body || {};
    if (!chain || !typedData) return res.status(400).json({ error: "chain and typedData are required" });
    const json = typeof typedData === "string" ? typedData : JSON.stringify(typedData);
    const result = walletService.signTypedData(wallet.user_id, String(req.params.id), chain, json);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: "Signing failed", message: err.message });
  }
});

export default router;
