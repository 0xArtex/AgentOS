import { Router, Request, Response } from "express";

const router = Router();

/**
 * POST /api/quicksetup — RETIRED.
 *
 * This endpoint used to insert fake +1555… phone numbers and placeholder
 * inboxes into the real tables and hand back throwaway tokens. It no longer
 * writes anything. Register at POST /agents/register for a real aos_ token,
 * then provision real resources and pay per action via x402.
 */
const gone = (_req: Request, res: Response) => {
  res.status(410).json({
    error: "Gone",
    message: "This quicksetup endpoint has been retired. It provisioned placeholder resources that were never real.",
    registerAt: "POST /agents/register",
    howItWorks: [
      "Register your agent at POST /agents/register (include a Solana walletAddress + name) to receive an aos_ token.",
      "Authenticate with: Authorization: Bearer <your aos_ token>.",
      "Provision real phone/email/compute and pay per action with USDC via x402. See GET /pricing.",
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
