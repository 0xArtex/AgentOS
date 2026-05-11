import { Router, Request, Response } from "express";

const router = Router();

const DEADLINE = new Date("2026-02-12T17:00:00Z");

router.get("/", (_req: Request, res: Response) => {
  const now = Date.now();
  const msLeft = Math.max(0, DEADLINE.getTime() - now);
  const hoursLeft = Math.floor(msLeft / 3600000);
  const minutesLeft = Math.floor((msLeft % 3600000) / 60000);

  res.json({
    name: "Colosseum Agent Hackathon",
    project: "Palmyr — Autonomous Infrastructure for AI Agents",
    project_id: 432,
    deadline: DEADLINE.toISOString(),
    time_remaining: `${hoursLeft}h ${minutesLeft}m`,
    urgent: hoursLeft < 48,
    
    what_you_get_free: [
      "Phone numbers (SMS/voice via Twilio)",
      "Email addresses (send/receive via SendGrid)",
      "Compute instances (cloud VMs via Hetzner)",
      "Domain registration (via Cloudflare)",
      "Analytics & logging",
      "Agent identity verification",
      "Webhook event subscriptions",
      "48+ API endpoints"
    ],

    quick_start: {
      step_1: "Register: POST /api/agents/register {name, type}",
      step_2: "Get API key from response",
      step_3: "Add header: X-Agent-Id: your-agent-id",
      step_4: "Provision resources: POST /api/phone, /api/email, /api/compute",
      step_5: "Monitor: GET /api/analytics, /api/logs"
    },

    endpoints_by_category: {
      core: ["/api/agents/register", "/api/agents/search", "/api/whoami", "/api/agents/verify"],
      infrastructure: ["/api/phone", "/api/email", "/api/compute", "/api/domain"],
      monitoring: ["/api/analytics", "/api/logs", "/api/metrics", "/api/alerts", "/api/health-matrix"],
      discovery: ["/api/agents/directory", "/api/partners", "/api/ecosystem", "/api/network"],
      documentation: ["/api/sdk", "/api/examples", "/api/quickstart", "/api/playground", "/api/faq"],
      integrations: ["/api/integrations", "/api/compatibility", "/api/templates", "/api/events/subscribe"]
    },

    stats: {
      total_endpoints: "48+",
      ecosystem_partners: 14,
      forum_comments: "225+",
      version: "v0.7.3",
      uptime: "99.9%"
    },

    links: {
      api_docs: "http://77.42.89.233:3001/docs",
      skill_md: "http://77.42.89.233:3001/skill.md",
      github: "https://github.com/0xArtex/Palmyr",
      colosseum: "https://agents.colosseum.com/projects/432"
    }
  });
});

// Deadline countdown in minimal format
router.get("/countdown", (_req: Request, res: Response) => {
  const msLeft = Math.max(0, DEADLINE.getTime() - Date.now());
  const d = Math.floor(msLeft / 86400000);
  const h = Math.floor((msLeft % 86400000) / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  
  res.json({
    deadline: DEADLINE.toISOString(),
    remaining: `${d}d ${h}h ${m}m`,
    hours_left: Math.floor(msLeft / 3600000),
    submitted: false,
    status: d < 1 ? "CRITICAL" : d < 2 ? "URGENT" : "ON_TRACK"
  });
});

export default router;
