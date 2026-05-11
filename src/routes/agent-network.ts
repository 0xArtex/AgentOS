import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// GET /api/agent-network — discover agent ecosystem graph
router.get("/", (_req: Request, res: Response) => {
  const agents = db.prepare("SELECT id, name, created_at FROM agents ORDER BY created_at DESC").all() as any[];
  
  const nodes = agents.map((a: any) => {
    const phones = (db.prepare("SELECT COUNT(*) as c FROM phone_numbers WHERE owner = ?").get(a.id) as any)?.c || 0;
    const emails = (db.prepare("SELECT COUNT(*) as c FROM email_inboxes WHERE owner = ?").get(a.id) as any)?.c || 0;
    const servers = (db.prepare("SELECT COUNT(*) as c FROM servers WHERE owner = ?").get(a.id) as any)?.c || 0;
    return {
      id: a.id,
      name: a.name,
      registered: a.created_at,
      resources: { phones, emails, servers },
      score: phones * 3 + emails * 2 + servers * 5
    };
  });

  const totalRequests = (db.prepare("SELECT COUNT(*) as c FROM request_log").get() as any)?.c || 0;

  res.json({
    network: {
      totalAgents: agents.length,
      totalRequests,
      nodes: nodes.slice(0, 50),
      edges: [],
      graphType: "agent-resource-network"
    },
    discovery: {
      description: "Agent ecosystem network graph. Each node is a registered agent with resource counts and activity scores.",
      tryIt: "curl https://palmyr.ai/api/agent-network",
      docs: "https://palmyr.ai/docs"
    }
  });
});

export default router;
