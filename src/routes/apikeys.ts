import { Router, Response } from "express";
import { x402 } from "../middleware/x402";
import { rateLimit } from "../middleware/rateLimit";
import { AuthenticatedRequest, ApiKeyProvider } from "../types";
import * as apikeysService from "../services/apikeys";

const router = Router();

/**
 * POST /apikeys — Provision a new API key
 * Cost: 1.00 USDC
 */
router.post("/", rateLimit(10, 60_000), x402(1.0), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { provider, label } = req.body as { provider: ApiKeyProvider; label?: string };

    if (!provider) {
      res.status(400).json({ error: "provider is required" });
      return;
    }

    const key = await apikeysService.generateKey(provider, req.payment!.payer, label);
    res.status(201).json(key);
  } catch (err: any) {
    console.error("[apikeys] Generate error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /apikeys — List active keys
 * Cost: 0.01 USDC
 */
router.get("/", x402(0.01), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const keys = await apikeysService.listKeys(req.payment!.payer);
    res.json({ keys });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /apikeys/:id — Revoke a key
 * Cost: 0.01 USDC
 */
router.delete("/:id", x402(0.01), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await apikeysService.revokeKey(req.params.id as string);
    res.json({ revoked: true, id: req.params.id });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

export default router;
