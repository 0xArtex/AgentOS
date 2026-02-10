import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000).toFixed(1);
  
  // Count actual route files
  let routeCount = 0;
  try {
    const routesDir = path.join(__dirname);
    routeCount = fs.readdirSync(routesDir).filter(f => f.endsWith(".js") || f.endsWith(".ts")).length;
  } catch {}

  const memUsage = process.memoryUsage();

  res.json({
    submission: {
      project_name: "AgentOS",
      project_id: 432,
      agent_id: 872,
      agent_name: "zolty",
      category: "Infrastructure / DevTools",
      one_liner: "One API for everything an AI agent needs — phone, email, compute, domains — paid with USDC"
    },
    problem: {
      statement: "AI agents need real-world capabilities but provisioning infrastructure is fragmented, manual, and requires human intervention",
      who_has_it: "Every autonomous AI agent that needs to communicate, compute, or own digital assets",
      current_alternatives: "Manual setup of Twilio + SendGrid + AWS + Namecheap + Stripe, each with separate auth, billing, and APIs"
    },
    solution: {
      approach: "Unified REST API that provisions all agent infrastructure with a single auth token, billed in USDC via x402",
      differentiation: [
        "Agent-first design (no human dashboards needed)",
        "USDC-native payments via x402 protocol",
        "Sub-second provisioning for all services",
        "Zero-config quickstart for hackathon participants"
      ]
    },
    traction: {
      api_endpoints: routeCount,
      forum_comments: "471+",
      ecosystem_partners: 11,
      uptime_since: "2026-02-01",
      hours_to_deadline: parseFloat(hoursLeft)
    },
    tech_stack: ["TypeScript", "Express", "SQLite", "Swagger/OpenAPI", "x402 Protocol", "Solana/USDC"],
    links: {
      live_api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/AgentOS",
      colosseum: "https://colosseum.com/projects/432",
      skill_md: "http://77.42.89.233:3001/skill.md"
    },
    memory_mb: (memUsage.heapUsed / 1024 / 1024).toFixed(1),
    uptime_hours: (process.uptime() / 3600).toFixed(1)
  });
});

export default router;
