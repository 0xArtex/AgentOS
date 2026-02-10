import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  try {
    const agents = db
      .prepare(
        `SELECT a.id, a.name,
          (SELECT COUNT(*) FROM phone_numbers WHERE owner = a.id) as phones,
          (SELECT COUNT(*) FROM email_inboxes WHERE owner = a.id) as emails,
          (SELECT COUNT(*) FROM servers WHERE owner = a.id) as servers
        FROM agents a`
      )
      .all() as any[];

    const nodes: any[] = agents.map((a: any) => ({
      id: "agent-" + a.id,
      label: a.name,
      type: "agent",
      resources: { phones: a.phones, emails: a.emails, servers: a.servers }
    }));

    ["phone", "email", "compute"].forEach(r => {
      nodes.push({ id: "resource-" + r, label: r.toUpperCase(), type: "resource" });
    });

    const edges: any[] = [];
    agents.forEach((a: any) => {
      if (a.phones > 0) edges.push({ from: "agent-" + a.id, to: "resource-phone", weight: a.phones });
      if (a.emails > 0) edges.push({ from: "agent-" + a.id, to: "resource-email", weight: a.emails });
      if (a.servers > 0) edges.push({ from: "agent-" + a.id, to: "resource-compute", weight: a.servers });
    });

    res.json({
      graph: { nodes, edges },
      meta: { total_agents: agents.length, total_connections: edges.length, generated_at: new Date().toISOString() }
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate graph", detail: err.message });
  }
});

export default router;
