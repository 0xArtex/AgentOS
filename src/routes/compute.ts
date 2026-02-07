import { Router, Response } from "express";
import { x402 } from "../middleware/x402";
import { rateLimit } from "../middleware/rateLimit";
import { AuthenticatedRequest, ServerType } from "../types";
import * as computeService from "../services/compute";

const router = Router();

/**
 * POST /compute/servers — Create a server
 * Cost: 5.00 USDC (provisioning fee)
 */
router.post("/servers", rateLimit(5, 60_000), x402(5.0), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, serverType, image, sshKeyIds } = req.body as {
      name: string;
      serverType: ServerType;
      image?: string;
      sshKeyIds?: number[];
    };

    if (!name || !serverType) {
      res.status(400).json({ error: "name and serverType are required" });
      return;
    }

    const server = await computeService.createServer(
      name,
      serverType,
      image ?? "ubuntu-24.04",
      req.payment!.payer,
      sshKeyIds
    );

    res.status(201).json(server);
  } catch (err: any) {
    console.error("[compute] Create error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /compute/servers — List all servers
 * Cost: 0.01 USDC
 */
router.get("/servers", x402(0.01), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const servers = await computeService.listServers(req.payment!.payer);
    res.json({ servers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /compute/servers/:id — Get server status
 * Cost: 0.01 USDC
 */
router.get("/servers/:id", x402(0.01), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await computeService.getServer(req.params.id as string);
    res.json(server);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * DELETE /compute/servers/:id — Terminate a server
 * Cost: 0.10 USDC
 */
router.delete("/servers/:id", x402(0.10), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await computeService.deleteServer(req.params.id as string);
    res.json({ deleted: true, id: req.params.id });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /compute/ssh-keys — Upload an SSH key
 * Cost: 0.10 USDC
 */
router.post("/ssh-keys", x402(0.10), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, publicKey } = req.body as { name: string; publicKey: string };
    if (!name || !publicKey) {
      res.status(400).json({ error: "name and publicKey are required" });
      return;
    }
    const id = await computeService.uploadSshKey(name, publicKey);
    res.status(201).json({ id, name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
