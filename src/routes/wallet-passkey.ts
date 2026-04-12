/**
 * Wallet passkey routes — WebAuthn setup and approval for managed wallets.
 *
 * Setup flow:  Human opens setup link → registers passkey → sets limits
 * Approve flow: Human opens approval link → authenticates with passkey → action approved
 */
import { Router, Request, Response } from "express";
import * as passkey from "../services/wallet-passkey";
import * as walletService from "../services/wallet";
import path from "path";

const router = Router();

// ─── Setup routes ───

/**
 * GET /wallet/:id/setup?token=... — Serve setup page
 */
router.get("/:id/setup", (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) return res.status(400).json({ error: "Setup token required" });

  const valid = passkey.validateSetupToken(token);
  if (!valid) return res.status(403).json({ error: "Invalid or expired setup token" });

  res.sendFile(path.join(__dirname, "..", "..", "public", "wallet-setup.html"));
});

/**
 * POST /wallet/:id/setup/options — Get WebAuthn registration options
 */
router.post("/:id/setup/options", (req: Request, res: Response) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Setup token required" });

  const valid = passkey.validateSetupToken(token);
  if (!valid) return res.status(403).json({ error: "Invalid or expired setup token" });

  passkey.generateSetupOptions(String(req.params.id))
    .then(options => res.json(options))
    .catch(err => res.status(500).json({ error: err.message }));
});

/**
 * POST /wallet/:id/setup/verify — Verify registration + store passkey + set policy
 * Body: { token, credential: RegistrationResponseJSON, policy?: { per_tx_usdc, daily_usdc } }
 */
router.post("/:id/setup/verify", async (req: Request, res: Response) => {
  try {
    const { token, credential, policy } = req.body || {};
    if (!token || !credential) {
      return res.status(400).json({ error: "token and credential are required" });
    }

    const valid = passkey.validateSetupToken(token);
    if (!valid) return res.status(403).json({ error: "Invalid or expired setup token" });

    const walletId = String(req.params.id);
    await passkey.verifySetup(walletId, credential);

    // Mark token as used
    passkey.markSetupTokenUsed(token);

    // Set policy if provided
    if (policy && typeof policy === "object") {
      // Find the wallet's user_id to call updatePolicy
      const wallet = (await import("../db")).db.prepare("SELECT user_id FROM agent_wallets WHERE id = ?").get(walletId) as any;
      if (wallet) {
        walletService.updatePolicy(wallet.user_id, walletId, policy);
      }
    }

    res.json({ success: true, message: "Passkey registered and policy set" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Approval routes ───

/**
 * GET /wallet/:id/approve/:reqId — Serve approval page
 */
router.get("/:id/approve/:reqId", (req: Request, res: Response) => {
  const approval = walletService.getApprovalRequest(String(req.params.reqId));
  if (!approval) return res.status(404).json({ error: "Approval request not found or expired" });

  res.sendFile(path.join(__dirname, "..", "..", "public", "wallet-approve.html"));
});

/**
 * GET /wallet/:id/approve/:reqId/details — Get approval request details
 */
router.get("/:id/approve/:reqId/details", (req: Request, res: Response) => {
  const approval = walletService.getApprovalRequest(String(req.params.reqId));
  if (!approval) return res.status(404).json({ error: "Approval request not found or expired" });

  res.json({
    id: approval.id,
    walletId: approval.wallet_id,
    action: approval.action,
    params: JSON.parse(approval.params),
    status: approval.status,
    expiresAt: approval.expires_at,
  });
});

/**
 * POST /wallet/:id/approve/:reqId/options — Get WebAuthn auth options
 */
router.post("/:id/approve/:reqId/options", async (req: Request, res: Response) => {
  try {
    const approval = walletService.getApprovalRequest(String(req.params.reqId));
    if (!approval) return res.status(404).json({ error: "Approval request not found or expired" });

    const options = await passkey.generateApprovalOptions(String(req.params.id));
    res.json(options);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /wallet/:id/approve/:reqId/verify — Verify passkey + execute approval
 * Body: { credential: AuthenticationResponseJSON }
 */
router.post("/:id/approve/:reqId/verify", async (req: Request, res: Response) => {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: "credential is required" });

    const approval = walletService.getApprovalRequest(String(req.params.reqId));
    if (!approval) return res.status(404).json({ error: "Approval request not found or expired" });

    const walletId = String(req.params.id);
    await passkey.verifyApproval(walletId, credential);

    // Execute the approved action
    const params = JSON.parse(approval.params);
    const wallet = (await import("../db")).db.prepare("SELECT user_id FROM agent_wallets WHERE id = ?").get(walletId) as any;

    if (approval.action === "limits" && wallet) {
      walletService.updatePolicy(wallet.user_id, walletId, {
        per_tx_usdc: params.per_tx_usdc,
        daily_usdc: params.daily_usdc,
        allowed_chains: params.allowed_chains,
      });
    }

    walletService.completeApproval(approval.id);

    res.json({ success: true, action: approval.action, message: "Approved" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
