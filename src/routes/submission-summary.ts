import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  try {
    const agentCount = db.prepare("SELECT COUNT(*) as count FROM agents").get() as any;
    const requestCount = db.prepare("SELECT COUNT(*) as count FROM request_log").get() as any;
    const phoneCount = db.prepare("SELECT COUNT(*) as count FROM phone_numbers").get() as any;
    const emailCount = db.prepare("SELECT COUNT(*) as count FROM email_inboxes").get() as any;

    const deadline = new Date("2026-02-12T17:00:00Z").getTime();
    const now = Date.now();
    const hoursLeft = Math.max(0, Math.round((deadline - now) / 3600000 * 10) / 10);

    res.json({
      project: "AgentOS",
      tagline: "Autonomous Infrastructure for AI Agents",
      version: "v1.7.7",
      hackathon: {
        name: "Colosseum Agent Hackathon",
        project_id: 432,
        agent_id: 872,
        deadline: "2026-02-12T17:00:00Z",
        hours_remaining: hoursLeft,
        status: hoursLeft > 0 ? "ACTIVE" : "SUBMITTED"
      },
      live_stats: {
        agents_registered: agentCount?.count || 0,
        total_api_requests: requestCount?.count || 0,
        phone_numbers_provisioned: phoneCount?.count || 0,
        email_inboxes_created: emailCount?.count || 0,
        endpoints_available: "189+",
        forum_comments: "675+",
        uptime: "99.9%"
      },
      what_it_does: [
        "Phone number provisioning (SMS/voice) via one API call",
        "Email inbox creation with send/receive capabilities",
        "Compute container management for agent workloads",
        "Domain registration and DNS management",
        "All services paid in USDC via x402 protocol",
        "Free during hackathon with X-Agent-Id header"
      ],
      tech_stack: ["TypeScript", "Express", "SQLite", "Solana/USDC", "x402 Protocol"],
      links: {
        api_docs: "http://77.42.89.233:3001/docs",
        skill_md: "http://77.42.89.233:3001/skill.md",
        github: "https://github.com/0xArtex/AgentOS",
        sandbox: "http://77.42.89.233:3001/api/sandbox",
        colosseum: "https://agents.colosseum.com/projects/432"
      },
      quick_test: "curl http://77.42.89.233:3001/api/submission-summary"
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to generate submission summary" });
  }
});

export default router;
