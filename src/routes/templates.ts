import { Router, Request, Response } from "express";

const router = Router();

const templates = [
  {
    id: "trading-bot",
    name: "Trading Bot",
    description: "Autonomous trading agent with alerts, execution logs, and market monitoring",
    difficulty: "intermediate",
    services: ["phone", "email", "compute"],
    config: {
      phone: { purpose: "Price alerts & margin call notifications" },
      email: { purpose: "Trade confirmations & daily P&L reports" },
      compute: { purpose: "Strategy execution & backtesting", recommended_specs: "2 vCPU, 4GB RAM" }
    },
    setup_steps: [
      "POST /api/agents/register — register your agent",
      "POST /api/compute/provision — spin up compute for strategy execution",
      "POST /api/phone/provision — get a number for SMS alerts",
      "POST /api/email/provision — get email for trade confirmations",
      "Configure your trading strategy on the compute instance"
    ],
    example_curl: "curl -X POST http://77.42.89.233:3001/api/agents/register -H Content-Type:application/json -H X-Agent-Id:YOUR_ID"
  },
  {
    id: "customer-support",
    name: "Customer Support Agent",
    description: "Handle customer inquiries via phone and email with compute for NLP processing",
    difficulty: "beginner",
    services: ["phone", "email", "compute"],
    config: {
      phone: { purpose: "Inbound/outbound customer calls" },
      email: { purpose: "Ticket management & follow-ups" },
      compute: { purpose: "NLP inference & response generation", recommended_specs: "2 vCPU, 2GB RAM" }
    },
    setup_steps: [
      "POST /api/agents/register — register your agent",
      "POST /api/phone/provision — get a phone number for customer calls",
      "POST /api/email/provision — get email for ticket management",
      "POST /api/compute/provision — spin up NLP inference server"
    ]
  },
  {
    id: "social-media-manager",
    name: "Social Media Manager",
    description: "Content scheduling, engagement monitoring, and cross-platform posting",
    difficulty: "beginner",
    services: ["email", "compute", "domain"],
    config: {
      email: { purpose: "Notifications & content approval workflows" },
      compute: { purpose: "Content generation & scheduling", recommended_specs: "1 vCPU, 2GB RAM" },
      domain: { purpose: "Custom branded link shortener" }
    },
    setup_steps: [
      "POST /api/agents/register — register your agent",
      "POST /api/compute/provision — spin up content engine",
      "POST /api/email/provision — set up notification pipeline",
      "POST /api/domains/register — get a branded domain for links"
    ]
  },
  {
    id: "defi-monitor",
    name: "DeFi Monitor",
    description: "Track on-chain events, liquidation risks, yield opportunities across protocols",
    difficulty: "advanced",
    services: ["phone", "email", "compute"],
    config: {
      phone: { purpose: "Urgent liquidation warnings & whale alerts" },
      email: { purpose: "Daily yield reports & portfolio summaries" },
      compute: { purpose: "RPC node access & on-chain analysis", recommended_specs: "4 vCPU, 8GB RAM" }
    },
    setup_steps: [
      "POST /api/agents/register — register your agent",
      "POST /api/compute/provision — spin up with RPC access",
      "POST /api/phone/provision — get SMS for urgent alerts",
      "POST /api/email/provision — set up daily digest pipeline",
      "Connect to Solana/EVM RPCs from your compute instance"
    ]
  },
  {
    id: "research-agent",
    name: "Research Agent",
    description: "Web scraping, data analysis, and report generation",
    difficulty: "beginner",
    services: ["email", "compute"],
    config: {
      email: { purpose: "Report delivery & source notifications" },
      compute: { purpose: "Scraping & analysis workloads", recommended_specs: "2 vCPU, 4GB RAM" }
    },
    setup_steps: [
      "POST /api/agents/register — register your agent",
      "POST /api/compute/provision — spin up analysis environment",
      "POST /api/email/provision — set up report delivery"
    ]
  },
  {
    id: "multi-agent-orchestrator",
    name: "Multi-Agent Orchestrator",
    description: "Coordinate multiple sub-agents with shared communication and compute pool",
    difficulty: "advanced",
    services: ["phone", "email", "compute", "domain"],
    config: {
      phone: { purpose: "Inter-agent voice coordination & human escalation" },
      email: { purpose: "Task assignment & status reporting" },
      compute: { purpose: "Orchestration engine & sub-agent hosting", recommended_specs: "4 vCPU, 8GB RAM" },
      domain: { purpose: "Unified API gateway for sub-agents" }
    },
    setup_steps: [
      "POST /api/agents/register — register orchestrator agent",
      "POST /api/compute/provision — spin up orchestration engine",
      "POST /api/phone/provision — get shared communication line",
      "POST /api/email/provision — set up task pipeline",
      "POST /api/domains/register — unified endpoint for sub-agents",
      "Register sub-agents and configure routing"
    ]
  }
];

router.get("/", (_req: Request, res: Response) => {
  res.json({
    templates: templates.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      difficulty: t.difficulty,
      services: t.services
    })),
    total: templates.length,
    usage: "GET /api/templates/:id for full config and setup steps"
  });
});

router.get("/:id", (req: Request, res: Response) => {
  const template = templates.find(t => t.id === req.params.id);
  if (!template) {
    return res.status(404).json({ error: "Template not found", available: templates.map(t => t.id) });
  }
  res.json(template);
});

export default router;
