import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { AuthenticatedRequest, ServerAction } from "../types";
import * as computeService from "../services/compute";
import { trackHackathonUsage } from "../middleware/hackathon";

const router = Router();

// ── Plans (free, no auth) ─────────────────────────────────────

/**
 * GET /compute/plans — List available server types with specs and pricing
 * Free — no auth required
 */
router.get("/plans", (_req, res: Response) => {
  const plans = computeService.getPlans();
  res.json({
    plans,
    currency: "USDC",
    billingPeriod: "monthly",
    note: "Pay via x402 protocol (Solana or Base USDC). Price includes setup.",
  });
});

// ── SSH Keys ──────────────────────────────────────────────────

/**
 * POST /compute/ssh-keys — Upload an SSH public key
 * Cost: 0.10 USDC
 */
router.post("/ssh-keys", rateLimit(10, 60_000), requireAuth(0.10, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, publicKey } = req.body as { name: string; publicKey: string };

    if (!name || !publicKey) {
      res.status(400).json({
        error: "Missing Required Fields",
        message: "Both 'name' and 'publicKey' are required",
        hint: "Include 'name' (key label) and 'publicKey' (your SSH public key, e.g. ssh-ed25519 AAAA...)"
      });
      return;
    }

    if (!publicKey.startsWith("ssh-") && !publicKey.startsWith("ecdsa-")) {
      res.status(400).json({
        error: "Invalid SSH Key",
        message: "publicKey must be a valid SSH public key",
        hint: "Format: ssh-ed25519 AAAA... or ssh-rsa AAAA..."
      });
      return;
    }

    const id = await computeService.uploadSshKey(name, publicKey);
    res.status(201).json({ id, name, message: "SSH key uploaded. Use this ID when creating servers." });
  } catch (err: any) {
    res.status(500).json({
      error: "SSH Key Upload Failed",
      message: err.message || "Failed to upload SSH key",
    });
  }
});

/**
 * GET /compute/ssh-keys — List SSH keys
 * Cost: 0.01 USDC
 */
router.get("/ssh-keys", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const keys = await computeService.listSshKeys();
    res.json({ sshKeys: keys.map((k: any) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint })) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list SSH keys", message: err.message });
  }
});

/**
 * DELETE /compute/ssh-keys/:id — Delete an SSH key
 * Cost: 0.01 USDC
 */
router.delete("/ssh-keys/:id", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await computeService.deleteSshKey(Number(String(req.params.id)));
    res.json({ deleted: true, id: String(req.params.id) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete SSH key", message: err.message });
  }
});

// ── Servers ───────────────────────────────────────────────────

/**
 * POST /compute/servers — Create a server
 * Cost: varies by plan (6-50 USDC)
 */
router.post("/servers", rateLimit(5, 60_000), requireAuth(6.0, 'server'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, serverType, image, sshKeyIds, location } = req.body as {
      name: string;
      serverType: string;
      image?: string;
      sshKeyIds?: number[];
      location?: string;
    };

    if (!name || !serverType) {
      res.status(400).json({
        error: "Missing Required Fields",
        message: "Both 'name' and 'serverType' are required",
        hint: "GET /compute/plans for available types. Include sshKeyIds from POST /compute/ssh-keys."
      });
      return;
    }

    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;

    const server = await computeService.createServer(
      name,
      serverType as any,
      image ?? "ubuntu-24.04",
      owner,
      sshKeyIds
    );

    if (req.isHackathonMode && req.agentId) {
      trackHackathonUsage(req.agentId, 'server', server.id);
    }

    res.status(201).json({
      ...server,
      message: "Server created. SSH in with: ssh root@" + (server.ipv4 || "<ip>"),
      note: server.rootPassword
        ? "Root password provided below. Save it — we don't store it."
        : "Use your SSH key to connect.",
    });
  } catch (err: any) {
    console.error("[compute] Create error:", err);
    res.status(500).json({
      error: "Server Creation Failed",
      message: err.message || "Failed to create server",
      hint: "GET /compute/plans for valid server types"
    });
  }
});

/**
 * GET /compute/servers — List your servers
 * Cost: 0.01 USDC
 */
router.get("/servers", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;
    const servers = await computeService.listServers(owner);
    res.json({ servers, count: servers.length });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list servers", message: err.message });
  }
});

/**
 * GET /compute/servers/:id — Get server details + live status
 * Cost: 0.01 USDC
 */
router.get("/servers/:id", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await computeService.getServer(String(req.params.id));
    res.json(server);
  } catch (err: any) {
    res.status(404).json({ error: "Server Not Found", message: err.message });
  }
});

/**
 * POST /compute/servers/:id/actions — Perform server action (reboot, poweron, poweroff, rebuild, reset)
 * Cost: 0.05 USDC
 */
router.post("/servers/:id/actions", requireAuth(0.05, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, image } = req.body as { action: string; image?: string };
    const validActions: ServerAction[] = ["reboot", "poweron", "poweroff", "rebuild", "reset"];

    if (!action || !validActions.includes(action as ServerAction)) {
      res.status(400).json({
        error: "Invalid Action",
        message: `Action must be one of: ${validActions.join(", ")}`,
        hint: "reboot = graceful restart, reset = hard restart, rebuild = reinstall OS (data lost!)"
      });
      return;
    }

    const result = await computeService.serverAction(String(req.params.id), action as ServerAction, image);
    res.json({
      action: action,
      serverId: String(req.params.id),
      status: result?.status || "running",
      message: action === "rebuild"
        ? "Server is being rebuilt. All data will be lost."
        : `Server ${action} initiated.`,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Action Failed", message: err.message });
  }
});

/**
 * POST /compute/servers/:id/resize — Resize server (change plan)
 * Cost: 0.10 USDC (+ price difference on next billing)
 */
router.post("/servers/:id/resize", requireAuth(0.10, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { serverType, upgradeDisk } = req.body as { serverType: string; upgradeDisk?: boolean };

    if (!serverType) {
      res.status(400).json({
        error: "Missing serverType",
        message: "Specify the target server type",
        hint: "GET /compute/plans for available types. Server must be powered off to resize."
      });
      return;
    }

    const result = await computeService.resizeServer(String(req.params.id), serverType as any, upgradeDisk ?? false);
    res.json({
      action: "resize",
      serverId: String(req.params.id),
      newType: serverType,
      status: result?.status || "running",
      message: "Server resize initiated. Server must be off first.",
    });
  } catch (err: any) {
    res.status(500).json({ error: "Resize Failed", message: err.message });
  }
});

/**
 * DELETE /compute/servers/:id — Destroy server permanently
 * Cost: 0.05 USDC
 */
router.delete("/servers/:id", requireAuth(0.05, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await computeService.deleteServer(String(req.params.id));
    res.json({ deleted: true, id: String(req.params.id), message: "Server permanently destroyed." });
  } catch (err: any) {
    res.status(404).json({ error: "Deletion Failed", message: err.message });
  }
});

export default router;
