import { Router, Request, Response } from "express";

const router = Router();

const templates = [
  {
    id: "trading-bot",
    name: "DeFi Trading Agent",
    description: "Autonomous trading agent with email alerts, phone notifications, and dedicated compute",
    services: ["email", "phone", "compute"],
    estimatedCostUSDC: 7.05,
    period: "monthly",
    setup: {
      email: { prefix: "trading-alerts", purpose: "Trade confirmations & portfolio reports" },
      phone: { purpose: "Urgent liquidation alerts via SMS/voice" },
      compute: { image: "node:20-slim", purpose: "Strategy execution engine" },
    },
    integrations: ["Jupiter", "Raydium", "Pyth", "Birdeye"],
    curl: 'curl -X POST https://palmyr.ai/api/agent-onboard -H "Content-Type: application/json" -d \'{"name":"my-trading-bot","services":["email","phone","compute"]}\''
  },
  {
    id: "social-agent",
    name: "Social Media Agent",
    description: "Agent that monitors social channels, responds to mentions, and manages community",
    services: ["email", "compute", "domain"],
    estimatedCostUSDC: 5.05,
    period: "monthly",
    setup: {
      email: { prefix: "social", purpose: "Email notifications & digest reports" },
      compute: { image: "python:3.12-slim", purpose: "NLP processing & content generation" },
      domain: { purpose: "Custom landing page for agent profile" },
    },
    integrations: ["Twitter/X", "Discord", "Telegram"],
    curl: 'curl -X POST https://palmyr.ai/api/agent-onboard -H "Content-Type: application/json" -d \'{"name":"my-social-agent","services":["email","compute","domain"]}\''
  },
  {
    id: "data-pipeline",
    name: "Data Pipeline Agent",
    description: "Agent that collects, processes, and serves data with scheduled compute jobs",
    services: ["compute", "email"],
    estimatedCostUSDC: 2.05,
    period: "monthly",
    setup: {
      compute: { image: "python:3.12-slim", purpose: "Data collection & ETL processing" },
      email: { prefix: "data-reports", purpose: "Automated report delivery" },
    },
    integrations: ["Helius", "DexScreener", "CoinGecko", "The Graph"],
    curl: 'curl -X POST https://palmyr.ai/api/agent-onboard -H "Content-Type: application/json" -d \'{"name":"my-data-agent","services":["compute","email"]}\''
  },
  {
    id: "insurance-agent", 
    name: "Risk & Insurance Agent",
    description: "Agent for risk assessment, claims processing, and insurance pool management",
    services: ["email", "phone", "compute"],
    estimatedCostUSDC: 7.05,
    period: "monthly",
    setup: {
      email: { prefix: "claims", purpose: "Claim submissions & policy documents" },
      phone: { purpose: "Urgent claim notifications" },
      compute: { image: "node:20-slim", purpose: "Risk scoring & actuarial models" },
    },
    integrations: ["Chainlink", "Pyth", "MutualAgent"],
    curl: 'curl -X POST https://palmyr.ai/api/agent-onboard -H "Content-Type: application/json" -d \'{"name":"my-insurance-agent","services":["email","phone","compute"]}\''
  },
  {
    id: "full-stack",
    name: "Full-Stack Autonomous Agent",
    description: "Everything — phone, email, compute, domain, storage. Maximum autonomy.",
    services: ["phone", "email", "compute", "domain", "storage"],
    estimatedCostUSDC: 12.10,
    period: "monthly",
    setup: {
      phone: { purpose: "Voice & SMS for human interaction" },
      email: { prefix: "agent", purpose: "Full email communication" },
      compute: { image: "ubuntu:22.04", purpose: "General-purpose compute" },
      domain: { purpose: "Agent's web presence" },
      storage: { purpose: "Persistent data & file storage" },
    },
    integrations: ["Any — full HTTP access from compute container"],
    curl: 'curl -X POST https://palmyr.ai/api/agent-onboard -H "Content-Type: application/json" -d \'{"name":"my-agent","services":["phone","email","compute","domain","storage"]}\''
  }
];

router.get("/api/templates", (_req: Request, res: Response) => {
  res.json({
    title: "Palmyr Agent Templates",
    description: "Pre-configured infrastructure templates for common agent types. Pick one and deploy in seconds.",
    templates: templates.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      services: t.services,
      estimatedCostUSDC: t.estimatedCostUSDC,
      period: t.period,
    })),
    total: templates.length,
    usage: "GET /api/templates/:id for full setup details and curl commands",
  });
});

router.get("/api/templates/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const template = templates.find(t => t.id === id);
  if (!template) {
    return res.status(404).json({ 
      error: "Template not found",
      available: templates.map(t => t.id)
    });
  }
  res.json(template);
});

export default router;
