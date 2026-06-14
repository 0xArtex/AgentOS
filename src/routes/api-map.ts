import { Router, Request, Response } from "express";

const router = Router();

/**
 * GET /api/api-map — Pointer to the canonical, machine-readable API surfaces.
 *
 * The authoritative route list and pricing live in the generated OpenAPI spec
 * and the x402 discovery document, not in a hand-curated map. This endpoint
 * just directs agents there instead of advertising a stale category list,
 * a raw-IP base URL, or "free during hackathon" pricing.
 */
router.get("/api/api-map", (_req: Request, res: Response) => {
  res.json({
    name: "Palmyr API Map",
    description: "Use the machine-readable surfaces below for the authoritative route list and pricing.",
    discovery: {
      openapi: "GET /openapi.json — full OpenAPI 3.1 spec with x-payment-info per route",
      x402: "GET /.well-known/x402 — x402 payable-resource discovery",
      pricing: "GET /pricing — per-action USDC pricing",
      registration: "POST /agents/register — register an agent, receive an aos_ token",
    },
    auth: "Authenticate with Authorization: Bearer <aos_ token>. Pay per action with USDC via x402 — your wallet is your identity.",
  });
});

export default router;
