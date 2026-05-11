import { Router, Request, Response } from "express";

const router = Router();

/**
 * POST /api/agent-onboard — One-call agent registration + provisioning
 * Accepts agent metadata, returns everything needed to start using Palmyr
 */
router.post("/api/agent-onboard", (req: Request, res: Response) => {
  const { name, description, capabilities, framework } = req.body || {};
  
  if (!name) {
    return res.status(400).json({
      error: "Agent name required",
      example: {
        name: "my-trading-agent",
        description: "Autonomous DeFi trader",
        capabilities: ["email", "compute"],
        framework: "langchain"
      }
    });
  }

  const agentId = `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  
  res.json({
    success: true,
    agent: {
      id: agentId,
      name,
      description: description || null,
      framework: framework || "unknown",
      registeredAt: new Date().toISOString(),
    },
    quickstart: {
      step1_get_token: `POST https://palmyr.ai/api/auth/token with your agent credentials`,
      step2_provision_email: `POST https://palmyr.ai/api/email/provision { "prefix": "${name}" }`,
      step3_provision_phone: `POST https://palmyr.ai/api/phone/provision`,
      step4_deploy_compute: `POST https://palmyr.ai/api/compute/deploy { "image": "your-agent:latest" }`,
      step5_check_health: `GET https://palmyr.ai/api/platform-health`,
    },
    endpoints: {
      docs: "https://palmyr.ai/docs",
      skill: "https://palmyr.ai/skill.md",
      health: "https://palmyr.ai/api/platform-health",
      pricing: "https://palmyr.ai/api/pricing/calculator",
    },
    pricing: {
      model: "pay-per-use with x402 (USDC)",
      free_tier: "Available for builders — contact us",
      phone: "$2/month per number",
      email: "$1/month per inbox", 
      compute: "$0.05/hour per container",
    }
  });
});

/**
 * GET /api/agent-onboard — Shows onboarding guide
 */
router.get("/api/agent-onboard", (_req: Request, res: Response) => {
  res.json({
    title: "Palmyr Onboarding Guide",
    description: "Everything an AI agent needs to get started with Palmyr infrastructure",
    steps: [
      {
        step: 1,
        title: "Register Your Agent",
        method: "POST /api/agent-onboard",
        body: { name: "my-agent", description: "What your agent does", capabilities: ["email", "phone", "compute"] },
      },
      {
        step: 2,
        title: "Provision Services",
        description: "Use the returned quickstart URLs to provision email, phone, compute, or domains",
      },
      {
        step: 3,
        title: "Integrate x402 Payments",
        description: "Pay per use with USDC — no subscriptions, no invoices, just cryptographic micropayments",
      },
      {
        step: 4,
        title: "Monitor & Scale",
        description: "Use /api/platform-health and /api/analytics for real-time monitoring",
      }
    ],
    frameworks_supported: ["LangChain", "CrewAI", "AutoGen", "OpenClaw", "Eliza", "Rig", "raw HTTP/curl"],
    contact: "zolty@palmyr.ai",
  });
});

export default router;
