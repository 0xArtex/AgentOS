import { Router, Request, Response } from "express";

const router = Router();

const TEMPLATES = [
  {
    id: "trading-bot",
    name: "Trading Bot Starter",
    description: "Autonomous trading agent with market data, position management, and risk controls",
    services: ["compute", "secrets", "cron", "webhooks"],
    setup_steps: [
      "POST /api/agents — register your trading agent",
      "POST /api/agent-secrets — store exchange API keys securely",
      "POST /api/agent-cron — schedule market scans every 5 minutes",
      "POST /api/compute/deploy — deploy your trading logic",
      "GET /api/agent-analytics — monitor P&L and execution stats"
    ],
    estimated_setup: "10 minutes",
    difficulty: "intermediate"
  },
  {
    id: "customer-support",
    name: "Customer Support Agent",
    description: "Multi-channel support agent with phone, email, and knowledge base",
    services: ["phone", "email", "compute", "env"],
    setup_steps: [
      "POST /api/agents — register your support agent",
      "POST /api/phone/provision — get a dedicated support number",
      "POST /api/email — configure support@yourdomain.com",
      "POST /api/agent-env — set greeting messages, escalation rules",
      "POST /api/compute/deploy — deploy your NLP/routing logic"
    ],
    estimated_setup: "15 minutes",
    difficulty: "beginner"
  },
  {
    id: "data-pipeline",
    name: "Data Pipeline Agent",
    description: "Scheduled data collection, transformation, and delivery agent",
    services: ["cron", "compute", "secrets", "webhooks", "email"],
    setup_steps: [
      "POST /api/agents — register your pipeline agent",
      "POST /api/agent-secrets — store data source credentials",
      "POST /api/agent-cron — schedule hourly/daily collection jobs",
      "POST /api/compute/deploy — deploy ETL logic",
      "POST /api/email — send daily digest reports"
    ],
    estimated_setup: "10 minutes",
    difficulty: "beginner"
  },
  {
    id: "social-media-manager",
    name: "Social Media Manager",
    description: "Content scheduling, engagement tracking, and cross-platform posting agent",
    services: ["cron", "secrets", "env", "webhooks", "compute"],
    setup_steps: [
      "POST /api/agents — register your social agent",
      "POST /api/agent-secrets — store platform API tokens",
      "POST /api/agent-env — configure posting schedule, tone, hashtags",
      "POST /api/agent-cron — schedule posts across timezones",
      "POST /api/compute/deploy — deploy content generation logic"
    ],
    estimated_setup: "10 minutes",
    difficulty: "beginner"
  },
  {
    id: "defi-monitor",
    name: "DeFi Monitor & Alerter",
    description: "On-chain monitoring agent with price alerts, whale tracking, and risk scoring",
    services: ["cron", "secrets", "webhooks", "compute", "phone"],
    setup_steps: [
      "POST /api/agents — register your DeFi monitor",
      "POST /api/agent-secrets — store RPC endpoints and wallet keys",
      "POST /api/agent-cron — schedule block scans every 30 seconds",
      "POST /api/webhooks — receive on-chain event callbacks",
      "POST /api/phone/provision — get SMS alerts for high-priority events"
    ],
    estimated_setup: "15 minutes",
    difficulty: "advanced"
  },
  {
    id: "research-agent",
    name: "Research & Report Agent",
    description: "Autonomous research agent that gathers data, synthesizes findings, and delivers reports",
    services: ["compute", "cron", "email", "env", "secrets"],
    setup_steps: [
      "POST /api/agents — register your research agent",
      "POST /api/agent-env — configure research topics, depth, sources",
      "POST /api/agent-secrets — store API keys for data providers",
      "POST /api/agent-cron — schedule weekly research runs",
      "POST /api/email — deliver formatted reports to stakeholders"
    ],
    estimated_setup: "10 minutes",
    difficulty: "intermediate"
  }
];

// GET /api/agent-templates — list all starter templates
router.get("/", (_req: Request, res: Response) => {
  res.json({
    templates: TEMPLATES,
    total: TEMPLATES.length,
    note: "Each template shows which AgentOS services to use and step-by-step setup. All free during hackathon with X-Agent-Id header."
  });
});

// GET /api/agent-templates/:id — get specific template
router.get("/:id", (req: Request, res: Response) => {
  const template = TEMPLATES.find(t => t.id === req.params.id);
  if (!template) {
    return res.status(404).json({ error: "Template not found", available: TEMPLATES.map(t => t.id) });
  }
  res.json(template);
});

export default router;
