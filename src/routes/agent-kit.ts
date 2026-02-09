import { Router, Request, Response } from "express";
import { getVersion, getHealth } from "../utils/health";
import { isHackathonActive } from "../middleware/hackathon";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const health = getHealth();
  const hackathonActive = isHackathonActive();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 3600000));

  res.json({
    welcome: "Welcome to AgentOS — autonomous infrastructure for AI agents",
    version: getVersion().version,
    status: health.status,
    hackathon: {
      active: hackathonActive,
      free_until: "2026-02-12T17:00:00Z",
      hours_remaining: hoursLeft,
      how_to_get_free_access: "Add header X-Agent-Id: your-agent-name to all requests"
    },
    quick_start: {
      step_1: "curl -X POST http://77.42.89.233:3001/agents/register -H 'Content-Type: application/json' -H 'X-Agent-Id: my-agent' -d '{\"name\":\"my-agent\"}'",
      step_2: "curl -X POST http://77.42.89.233:3001/phone/provision -H 'X-Agent-Id: my-agent' -d '{\"country\":\"US\"}'",
      step_3: "curl -X POST http://77.42.89.233:3001/email/create -H 'X-Agent-Id: my-agent' -d '{\"username\":\"my-agent\"}'",
      step_4: "curl -X POST http://77.42.89.233:3001/compute/servers -H 'X-Agent-Id: my-agent' -d '{\"name\":\"worker-1\",\"size\":\"small\"}'",
    },
    endpoints_by_category: {
      core_services: ["POST /phone/provision", "POST /email/create", "POST /compute/servers", "POST /domains/register"],
      agent_management: ["POST /agents/register", "GET /agents/search", "GET /agents/directory", "GET /api/whoami"],
      discovery: ["GET /api/sdk", "GET /api/examples", "GET /api/quickstart", "GET /api/playground", "GET /api/agent-kit"],
      monitoring: ["GET /api/metrics", "GET /api/health-matrix", "GET /api/logs", "GET /api/alerts", "GET /status/live"],
      ecosystem: ["GET /api/ecosystem", "GET /api/partners", "GET /api/leaderboard", "GET /api/testimonials"],
      platform_info: ["GET /pricing", "GET /api/rate-limits", "GET /api/sla", "GET /api/security", "GET /api/roadmap"],
    },
    total_endpoints: "57+",
    payment: { currency: "USDC", network: "Solana", protocol: "x402" },
    links: {
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/AgentOS",
      skill_md: "http://77.42.89.233:3001/skill.md",
    },
  });
});

export default router;
