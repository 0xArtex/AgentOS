import { validate } from "../middleware/validate";
import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { AuthenticatedRequest, ServerType } from "../types";
import * as computeService from "../services/compute";
import { trackHackathonUsage } from "../middleware/hackathon";

const router = Router();

/**
 * POST /compute/servers — Create a server
 * Cost: 5.00 USDC (or free during hackathon with agent limits)
 */
router.post("/servers", rateLimit(5, 60_000), requireAuth(5.0, 'server'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, serverType, image, sshKeyIds } = req.body as {
      name: string;
      serverType: ServerType;
      image?: string;
      sshKeyIds?: number[];
    };

    if (!name || !serverType) {
      res.status(400).json({ 
        error: "Missing Required Fields",
        message: "Both 'name' and 'serverType' are required",
        hint: "Include 'name' (server name) and 'serverType' (cx22, cx32, cx42, cx52) in your request"
      });
      return;
    }

    // Get owner - either from payment or hackathon mode
    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;

    const server = await computeService.createServer(
      name,
      serverType,
      image ?? "ubuntu-24.04",
      owner,
      sshKeyIds
    );

    // Track hackathon usage if applicable
    if (req.isHackathonMode && req.agentId) {
      trackHackathonUsage(req.agentId, 'server', server.id);
    }

    res.status(201).json(server);
  } catch (err: any) {
    console.error("[compute] Create error:", err);
    res.status(500).json({ 
      error: "Server Creation Failed",
      message: err.message || "Failed to create server",
      hint: "Check your server type and try again. Available types: cx22, cx32, cx42, cx52"
    });
  }
});

/**
 * GET /compute/servers — List all servers
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.get("/servers", requireAuth(0.01, 'server'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;
    const servers = await computeService.listServers(owner);
    res.json({ servers });
  } catch (err: any) {
    res.status(500).json({ 
      error: "Server List Failed",
      message: err.message || "Failed to retrieve server list",
      hint: "Try again or contact support if the issue persists"
    });
  }
});

/**
 * GET /compute/servers/:id — Get server status
 * Cost: 0.01 USDC (or free during hackathon)
 */
router.get("/servers/:id", requireAuth(0.01, 'server'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = req.params.id as string;
    
    if (!serverId) {
      res.status(400).json({
        error: "Missing Server ID",
        message: "Server ID is required in the URL path",
        hint: "Use format: GET /compute/servers/{id}"
      });
      return;
    }

    const server = await computeService.getServer(serverId);
    res.json(server);
  } catch (err: any) {
    res.status(404).json({ 
      error: "Server Not Found",
      message: err.message || "Could not find server with this ID",
      hint: "Check the server ID and ensure you own this server"
    });
  }
});

/**
 * DELETE /compute/servers/:id — Terminate a server
 * Cost: 0.10 USDC (or free during hackathon)
 */
router.delete("/servers/:id", requireAuth(0.10, 'server'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = req.params.id as string;
    
    if (!serverId) {
      res.status(400).json({
        error: "Missing Server ID",
        message: "Server ID is required in the URL path",
        hint: "Use format: DELETE /compute/servers/{id}"
      });
      return;
    }

    await computeService.deleteServer(serverId);
    res.json({ deleted: true, id: serverId });
  } catch (err: any) {
    res.status(404).json({ 
      error: "Server Deletion Failed",
      message: err.message || "Could not delete server with this ID",
      hint: "Check the server ID and ensure you own this server"
    });
  }
});

/**
 * POST /compute/ssh-keys — Upload an SSH key
 * Cost: 0.10 USDC (or free during hackathon)
 */
router.post("/ssh-keys", requireAuth(0.10, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, publicKey } = req.body as { name: string; publicKey: string };
    
    if (!name || !publicKey) {
      res.status(400).json({ 
        error: "Missing Required Fields",
        message: "Both 'name' and 'publicKey' are required",
        hint: "Include 'name' (key name) and 'publicKey' (SSH public key) in your request"
      });
      return;
    }
    
    const id = await computeService.uploadSshKey(name, publicKey);
    res.status(201).json({ id, name });
  } catch (err: any) {
    res.status(500).json({ 
      error: "SSH Key Upload Failed",
      message: err.message || "Failed to upload SSH key",
      hint: "Check your SSH key format and try again"
    });
  }
});

export default router;
