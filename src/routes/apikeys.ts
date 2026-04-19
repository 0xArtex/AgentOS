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

    const key = await apikeysService.generateKey(provider, req.agentId || req.payment?.payer || "unknown", label);
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
    const keys = await apikeysService.listKeys(req.agentId || req.payment?.payer || "unknown");
    res.json({ keys });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /apikeys/:id — Revoke a key
 * Cost: 0.01 USDC. Only the original owner can revoke.
 */
router.delete("/:id", x402(0.01), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = req.payment?.payer || req.agentId;
    if (!owner) {
      return res.status(401).json({ error: "No caller identity — cannot verify ownership" });
    }
    await apikeysService.revokeKey(req.params.id as string, owner);
    res.json({ revoked: true, id: req.params.id });
  } catch (err: any) {
    const status = err?.statusCode === 403 ? 403 : 404;
    res.status(status).json({ error: err.message });
  }
});

export default router;
