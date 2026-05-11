import { Router, Response } from "express";
import {
  requireDashboardOnly,
  requireWalletAuth,
  resolveWalletAccess,
  WalletAuthRequest,
} from "../middleware/wallet-auth";
import * as walletService from "../services/wallet";
import { PolicyApprovalRequired } from "../services/wallet-vault";

const router = Router();

/**
 * Resolve auth credentials for signing:
 *   - Authorization: Bearer agos_key_... → agent API key mode
 *   - Otherwise empty (session secret resolved automatically from OS cred store)
 */
function getAuthCreds(req: WalletAuthRequest): walletService.AuthCreds {
  if (req.agentApiKey) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    return { token };
  }
  return {};
}

// ─── Public routes — no auth required ───

/**
 * POST /wallet/register-managed — Register a CLI-created managed wallet for passkey setup.
 *
 * Used when an agent runs `palmyr wallet create --managed`. The wallet is created
 * locally on the agent's machine; this endpoint just stores the metadata needed
 * for the human's passkey setup page. The setup token in the returned link is the
 * only secret — whoever has it can register a passkey for this wallet.
 *
 * Body: { walletId, name, solanaAddress?, evmAddress? }
 */
router.post("/register-managed", async (req: WalletAuthRequest, res: Response) => {
  try {
    const { walletId, name, solanaAddress, evmAddress } = req.body || {};

    // Validation
    if (!walletId || !/^[0-9a-f]{32}$/i.test(walletId)) {
      return res.status(400).json({ error: "walletId must be a 32-char hex string" });
    }
    if (!name || typeof name !== "string" || !/^[a-zA-Z0-9 _\-\.]{1,128}$/.test(name.trim())) {
      return res.status(400).json({ error: "Invalid name" });
    }
    if (solanaAddress && typeof solanaAddress !== "string") {
      return res.status(400).json({ error: "solanaAddress must be a string" });
    }
    if (evmAddress && (typeof evmAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(evmAddress))) {
      return res.status(400).json({ error: "evmAddress must be a valid Ethereum address" });
    }

    const result = await walletService.registerManagedWallet(walletId, name.trim(), solanaAddress || null, evmAddress || null);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Management routes — dashboard auth only ───

/**
 * POST /wallet — Create a new wallet
 * Body: { label?, chains?, mode? }
 * mode: 'unmanaged' (default) | 'managed'
 */
router.post("/", requireDashboardOnly, async (req: WalletAuthRequest, res: Response) => {
  try {
    const { label, chains, mode } = req.body || {};
    const walletMode = mode === "managed" ? "managed" : "unmanaged";
    const { walletInfo, sessionSecret, setupLink } = await walletService.createWallet(
      req.dashUserId!, label, chains, walletMode,
    );
    res.json({
      success: true,
      wallet: walletInfo,
      sessionSecret,
      setupLink,
      message: walletMode === "managed"
        ? "Managed wallet created. Send the setup link to the human to register their passkey and set limits."
        : "Wallet created. Store the session secret in the OS credential store.",
    });
  } catch (err: any) {
    console.error("[wallet] Create error:", err);
    res.status(500).json({ error: "Failed to create wallet", message: err.message });
  }
});

/**
 * POST /wallet/import — Import wallet from mnemonic
 * Body: { mnemonic, label?, mode? }
 */
router.post("/import", requireDashboardOnly, async (req: WalletAuthRequest, res: Response) => {
  try {
    const { mnemonic, label, mode } = req.body || {};
    if (!mnemonic) return res.status(400).json({ error: "mnemonic is required" });
    const walletMode = mode === "managed" ? "managed" : "unmanaged";
    const { walletInfo, sessionSecret } = await walletService.importWallet(
      req.dashUserId!, mnemonic, label, walletMode,
    );
    res.json({ success: true, wallet: walletInfo, sessionSecret });
  } catch (err: any) {
    console.error("[wallet] Import error:", err);
    res.status(500).json({ error: "Failed to import wallet", message: err.message });
  }
});

/**
 * GET /wallet — List all wallets
 */
router.get("/", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  const wallets = walletService.getWallets(req.dashUserId!);
  res.json({ wallets });
});

/**
 * DELETE /wallet/:id — Delete a wallet
 */
router.delete("/:id", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  const deleted = walletService.deleteWallet(req.dashUserId!, String(req.params.id));
  if (!deleted) return res.status(404).json({ error: "Wallet not found" });
  res.json({ success: true, message: "Wallet deleted" });
});

/**
 * POST /wallet/:id/api-key — Create scoped API key (requires session secret)
 * Body: { name, sessionSecret, policyIds?, expiresAt? }
 */
router.post("/:id/api-key", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  try {
    const { name, sessionSecret, policyIds, expiresAt } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!sessionSecret) return res.status(400).json({ error: "sessionSecret is required" });
    const result = walletService.createApiKeyForWallet(
      req.dashUserId!, String(req.params.id), name, sessionSecret, policyIds, expiresAt,
    );
    res.json({ success: true, apiKey: result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /wallet/:id/api-key — Revoke API key
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
 * POST /wallet/:id/config — Get agent config + issue API key
 * Body: { sessionSecret }
 */
router.post("/:id/config", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  try {
    const { sessionSecret } = req.body || {};
    if (!sessionSecret) return res.status(400).json({ error: "sessionSecret is required" });
    const config = walletService.getAgentConfig(req.dashUserId!, String(req.params.id), sessionSecret);
    if (!config) return res.status(404).json({ error: "Wallet not found" });
    res.json({ config });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /wallet/:id/policy — Set spending policy (dashboard only)
 * Body: { policy: { per_tx_usdc?, daily_usdc?, allowed_chains?: string[] } }
 */
router.post("/:id/policy", requireDashboardOnly, (req: WalletAuthRequest, res: Response) => {
  try {
    const { policy } = req.body || {};
    if (!policy || typeof policy !== "object") {
      return res.status(400).json({ error: "policy object is required" });
    }
    walletService.updatePolicy(req.dashUserId!, String(req.params.id), policy);
    res.json({ success: true, message: "Policy updated" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /wallet/:id/request-approval — Request human approval (managed wallets)
 * Body: { action, daily_usdc?, per_tx_usdc?, allowed_chains? }
 */
router.post("/:id/request-approval", async (req: WalletAuthRequest, res: Response) => {
  const { db } = await import("../db");
  const walletRow = db.prepare("SELECT user_id FROM agent_wallets WHERE id = ?").get(String(req.params.id)) as any;
  if (!walletRow) return res.status(404).json({ error: "Wallet not found" });

  // Public path: CLI-managed wallets — agent can request human approval without dashboard auth.
  // Approval still requires passkey authentication via the human in the browser.
  if (walletRow.user_id === "cli-managed") {
    try {
      const { action, ...params } = req.body || {};
      const result = walletService.requestApproval(walletRow.user_id, String(req.params.id), action || "limits", params);
      return res.json({ success: true, ...result });
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  }

  // Dashboard-owned: require auth
  return requireWalletAuth(req, res, () => {
    const wallet = resolveWalletAccess(req, String(req.params.id));
    if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
    try {
      const { action, ...params } = req.body || {};
      const result = walletService.requestApproval(wallet.user_id, String(req.params.id), action || "limits", params);
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
});

// ─── Read routes — dashboard OR agent API key ───

/**
 * GET /wallet/:id/policy — Get current policy
 *
 * For CLI-managed wallets (user_id = 'cli-managed'), this route is public —
 * the policy is non-secret metadata the agent needs to know its spending limits.
 * For dashboard-owned wallets, normal auth applies.
 */
router.get("/:id/policy", async (req: WalletAuthRequest, res: Response) => {
  const { db } = await import("../db");
  const walletRow = db.prepare("SELECT user_id FROM agent_wallets WHERE id = ?").get(String(req.params.id)) as any;
  if (!walletRow) return res.status(404).json({ error: "Wallet not found" });

  // Public path: CLI-managed wallets have no dashboard owner; policy is non-secret metadata
  if (walletRow.user_id === "cli-managed") {
    try {
      const policy = walletService.getPolicy(walletRow.user_id, String(req.params.id));
      return res.json({ policy });
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  }

  // Dashboard-owned: require auth
  return requireWalletAuth(req, res, () => {
    const wallet = resolveWalletAccess(req, String(req.params.id));
    if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
    try {
      const policy = walletService.getPolicy(wallet.user_id, String(req.params.id));
      res.json({ policy });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
});

/**
 * GET /wallet/:id/spending — Get spend log + 24h total
 *
 * Public for CLI-managed wallets (agent needs to read its own spend tracking).
 */
router.get("/:id/spending", async (req: WalletAuthRequest, res: Response) => {
  const { db } = await import("../db");
  const walletRow = db.prepare("SELECT user_id FROM agent_wallets WHERE id = ?").get(String(req.params.id)) as any;
  if (!walletRow) return res.status(404).json({ error: "Wallet not found" });

  if (walletRow.user_id === "cli-managed") {
    try {
      const data = walletService.getSpending(walletRow.user_id, String(req.params.id));
      return res.json(data);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  }

  return requireWalletAuth(req, res, () => {
    const wallet = resolveWalletAccess(req, String(req.params.id));
    if (!wallet) return res.status(404).json({ error: "Wallet not found or no access" });
    try {
      const data = walletService.getSpending(wallet.user_id, String(req.params.id));
      res.json(data);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
});

/**
 * GET /wallet/:id — Get wallet details
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

// ─── Signing routes — session secret (auto) OR agent API key ───

/**
 * POST /wallet/:id/sign — Sign a transaction
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
    if (err instanceof PolicyApprovalRequired) {
      // Generate approval request for managed wallets
      try {
        const approval = walletService.requestApproval(wallet.user_id, String(req.params.id), "approve_tx", {
          amount_usdc: err.decoded.amount_usdc,
          destination: err.decoded.destination,
          chain: req.body.chain,
        });
        return res.status(403).json({
          error: "approval_required",
          code: "REQUIRES_APPROVAL",
          message: err.message,
          ...approval,
        });
      } catch {}
    }
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
