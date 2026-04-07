import { Router, Response } from "express";
import {
  requireDashboardOnly,
  requireWalletAuth,
  resolveWalletAccess,
  WalletAuthRequest,
} from "../middleware/wallet-auth";
import * as walletService from "../services/wallet";

const router = Router();

/**
 * Resolve auth credentials for signing/sensitive ops:
 *   - X-Wallet-Passphrase header (or body.passphrase) → owner mode
 *   - Authorization: Bearer agos_key_... → agent mode (already on req.agentApiKey)
 */
function getAuthCreds(req: WalletAuthRequest): walletService.AuthCreds {
  const passphrase = (req.headers["x-wallet-passphrase"] as string) || req.body?.passphrase;
  if (passphrase) return { passphrase };
  if (req.agentApiKey) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    return { token };
  }
  return {};
}

// ─── Management routes — dashboard auth only ───

/**
 * POST /wallet — Create a new wallet (owner passphrase required)
 * Body: { label?, chains?, passphrase }
 */
router.post("/", requireDashboardOnly, async (req: WalletAuthRequest, res: Response) => {
  try {
    const { label, chains, passphrase } = req.body || {};
    if (!passphrase) return res.status(400).json({ error: "passphrase is required" });
    const wallet = await walletService.createWallet(req.dashUserId!, passphrase, label, chains);
    res.json({
      success: true,
      wallet,
      message: "Wallet created. The server cannot decrypt this wallet without your passphrase or an issued API key.",
    });
  } catch (err: any) {
    console.error("[wallet] Create error:", err);
    res.status(500).json({ error: "Failed to create wallet", message: err.message });
  }
});

/**
 * POST /wallet/import — Import wallet from mnemonic (passphrase required)
 * Body: { mnemonic, passphrase, label? }
 */
router.post("/import", requireDashboardOnly, async (req: WalletAuthRequest, res: Response) => {
  try {
    const { mnemonic, passphrase, label } = req.body || {};
    if (!mnemonic) return res.status(400).json({ error: "mnemonic is required" });
    if (!passphrase) return res.status(400).json({ error: "passphrase is required" });
    const wallet = await walletService.importWallet(req.dashUserId!, mnemonic, passphrase, label);
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
 * POST /wallet/:id/api-key — Create scoped API key (requires owner passphrase)
 * Body: { name, passphrase, policyIds?, expiresAt? }
 */
router.post("/:id/api-key", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  try {
    const { name, passphrase, policyIds, expiresAt } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!passphrase) return res.status(400).json({ error: "passphrase is required" });
    const result = walletService.createApiKeyForWallet(
      req.dashUserId!,
      String(req.params.id),
      name,
      passphrase,
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
 * POST /wallet/:id/config — Get agent config + issue API key (requires passphrase)
 * Body: { passphrase }
 *
 * NOTE: changed from GET → POST because the body must carry the passphrase.
 */
router.post("/:id/config", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  try {
    const { passphrase } = req.body || {};
    if (!passphrase) return res.status(400).json({ error: "passphrase is required" });
    const config = walletService.getAgentConfig(req.dashUserId!, String(req.params.id), passphrase);
    if (!config) return res.status(404).json({ error: "Wallet not found" });
    res.json({ config });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
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

// ─── Read routes — dashboard OR agent API key (no decryption) ───

/**
 * GET /wallet/:id — Get wallet details (no decryption needed)
 */
router.get("/:id", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });

  const walletInfo = req.dashUserId
    ? walletService.getWallet(req.dashUserId, String(req.params.id))
    : walletService.getWallet(wallet.user_id, String(req.params.id));
  res.json({ wallet: walletInfo });
});

/**
 * GET /wallet/:id/addresses — List all chain addresses (no decryption)
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

// ─── Signing routes — owner passphrase OR agent API key ───

/**
 * POST /wallet/:id/sign — Sign a transaction
 * Body: { chain, transaction, passphrase? }   (passphrase only when not using agent token)
 */
router.post("/:id/sign", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
  try {
    const { chain, transaction } = req.body || {};
    if (!chain || !transaction) return res.status(400).json({ error: "chain and transaction are required" });
    const auth = getAuthCreds(req);
    const result = walletService.signTransaction(wallet.user_id, String(req.params.id), chain, transaction, auth);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: "Signing failed", message: err.message });
  }
});

/**
 * POST /wallet/:id/sign-message — Sign a message
 */
router.post("/:id/sign-message", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
  try {
    const { chain, message, encoding } = req.body || {};
    if (!chain || !message) return res.status(400).json({ error: "chain and message are required" });
    const auth = getAuthCreds(req);
    const result = walletService.signMessage(wallet.user_id, String(req.params.id), chain, message, auth, encoding);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: "Signing failed", message: err.message });
  }
});

/**
 * POST /wallet/:id/sign-typed — Sign EIP-712 typed data
 */
router.post("/:id/sign-typed", requireWalletAuth, (req: WalletAuthRequest, res: Response) => {
  const wallet = resolveWalletAccess(req, String(req.params.id));
  if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
  try {
    const { chain, typedData } = req.body || {};
    if (!chain || !typedData) return res.status(400).json({ error: "chain and typedData are required" });
    const json = typeof typedData === "string" ? typedData : JSON.stringify(typedData);
    const auth = getAuthCreds(req);
    const result = walletService.signTypedData(wallet.user_id, String(req.params.id), chain, json, auth);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: "Signing failed", message: err.message });
  }
});

export default router;
