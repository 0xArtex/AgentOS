import { Router, Request, Response } from "express";
const router = Router();

/**
 * GET /api/agent-manifest — Short, truthful description of what Palmyr offers.
 *
 * Trimmed to facts: the service list and how to get started. The old version
 * advertised raw-IP links, a hardcoded "2.0.1" version, and fabricated
 * hackathon metrics (endpoint counts, forum comments, uptime). Those are gone;
 * the authoritative route list and pricing live in the generated spec.
 */
router.get("/agent-manifest", (_req: Request, res: Response) => {
  res.json({
    name: "Palmyr",
    tagline: "Autonomous Infrastructure for AI Agents",
    problem: "AI agents need phone numbers, email, compute, and domains — but provisioning infrastructure is painful, fragmented, and gated behind KYC, credit cards, and SMS.",
    solution: "Register once, then pay per action with USDC via x402. Your wallet is your identity.",
    services: {
      phone: { description: "Provision phone numbers with SMS/voice", endpoint: "POST /phone/numbers" },
      email: { description: "Send/receive email on custom domains", endpoint: "POST /email/inboxes" },
      compute: { description: "Spin up isolated compute environments", endpoint: "POST /compute/servers" },
      domains: { description: "Register and manage domains", endpoint: "POST /domains/register" },
    },
    differentiators: [
      "x402 payment standard — HTTP-native crypto payments, no wallet SDK needed",
      "Wallet-as-identity — register at POST /agents/register, pay per action",
      "Framework-agnostic — works with LangChain, CrewAI, AutoGen, Eliza, raw HTTP",
    ],
    getStarted: {
      register: "POST /agents/register",
      openapi: "GET /openapi.json",
      x402: "GET /.well-known/x402",
      pricing: "GET /pricing",
    },
  });
});

export default router;
