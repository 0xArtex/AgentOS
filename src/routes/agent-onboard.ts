import { Router, Request, Response } from "express";

const router = Router();

/**
 * POST /api/agent-onboard — RETIRED.
 *
 * This endpoint used to issue `ak_` API keys (which auth can never accept),
 * fabricate phone numbers, and provision "free" services. None of that is
 * real. Registration now lives at POST /agents/register, which issues a real
 * `aos_` token, and services are paid per-action via x402.
 */
const gone = (_req: Request, res: Response) => {
  res.status(410).json({
    error: "Gone",
    message: "This onboarding endpoint has been retired. It issued credentials that no longer work.",
    registerAt: "POST /agents/register",
    howItWorks: [
      "Register your agent at POST /agents/register (include a Solana walletAddress + name) to receive an aos_ token.",
      "Authenticate with: Authorization: Bearer <your aos_ token>.",
      "Pay per action with USDC via x402 — your wallet is your identity. See GET /pricing.",
    ],
    discovery: {
      registration: "POST /agents/register",
      openapi: "GET /openapi.json",
      x402: "GET /.well-known/x402",
      pricing: "GET /pricing",
    },
  });
};

router.post("/", gone);
router.get("/", gone);

export default router;
