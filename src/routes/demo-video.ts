import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

function safeCount(table: string): number {
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c; } catch { return 0; }
}

router.get("/demo-video", (_req: Request, res: Response) => {
  const now = Date.now();
  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, (deadline - now) / 3600000).toFixed(1);
  const agents = safeCount("agents");
  const phones = safeCount("phones");
  const emails = safeCount("emails");
  const servers = safeCount("servers");

  const status = parseFloat(hoursLeft) <= 0 ? "SUBMITTED" : parseFloat(hoursLeft) <= 6 ? "FINAL_PUSH" : "BUILDING";

  res.json({
    title: "AgentOS Demo Walkthrough",
    tagline: "Autonomous infrastructure for AI agents",
    duration: "3 minutes",
    scenes: [
      { step: 1, title: "Register an Agent", description: "One POST creates agent identity with API key", endpoint: "POST /api/agents/register", responseTime: "< 50ms" },
      { step: 2, title: "Provision Phone", description: "Real phone number for SMS/voice", endpoint: "POST /api/phone/provision", responseTime: "< 200ms" },
      { step: 3, title: "Set Up Email", description: "Dedicated email for your agent", endpoint: "POST /api/email/provision", responseTime: "< 100ms" },
      { step: 4, title: "Spin Up Compute", description: "On-demand server provisioning", endpoint: "POST /api/compute/provision", responseTime: "< 500ms" },
      { step: 5, title: "Check Analytics", description: "Real-time per-agent metrics", endpoint: "GET /api/agent-snapshot", responseTime: "< 10ms" },
      { step: 6, title: "Agent-to-Agent Comms", description: "Direct messaging with priority routing", endpoint: "POST /api/agent-comms/send", responseTime: "< 20ms" }
    ],
    liveStats: { agents, phones, emails, servers, endpoints: "187+", hoursToDeadline: parseFloat(hoursLeft) },
    links: {
      dashboard: "http://77.42.89.233:3001/dashboard",
      docs: "http://77.42.89.233:3001/docs",
      apiMap: "http://77.42.89.233:3001/api/api-map",
      skill: "http://77.42.89.233:3001/skill.md",
      github: "https://github.com/0xArtex/AgentOS"
    },
    hackathon: { status, freeAccess: true, hoursRemaining: parseFloat(hoursLeft) }
  });
});

export default router;
