import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";

const router = Router();
const dbPath = path.join(__dirname, "../../data/agentos.db");

function getDb() {
  return new Database(dbPath, { readonly: true });
}

function safeCount(db: Database.Database, table: string, where?: string): number {
  try {
    const q = where ? `SELECT COUNT(*) as c FROM ${table} WHERE ${where}` : `SELECT COUNT(*) as c FROM ${table}`;
    const row = db.prepare(q).get() as any;
    return row?.c || 0;
  } catch { return 0; }
}

router.get("/", (req: Request, res: Response) => {
  const { agent1, agent2 } = req.query;
  if (!agent1 || !agent2) {
    return res.json({
      endpoint: "/api/agent-compare",
      description: "Compare two agents side-by-side",
      usage: "GET /api/agent-compare?agent1=alice&agent2=bob",
      metrics: ["phones", "emails", "servers", "domains", "api_calls", "reputation"]
    });
  }

  const db = getDb();
  try {
    const getAgentStats = (agentId: string) => ({
      agentId,
      phones: safeCount(db, "phones", `agent_id=`),
      emails: safeCount(db, "emails", `agent_id=`),
      servers: safeCount(db, "servers", `agent_id=`),
      domains: safeCount(db, "domains", `agent_id=`),
      api_calls: safeCount(db, "request_log", `agent_id=`),
      webhooks: safeCount(db, "webhooks", `agent_id=`),
    });

    const a1 = getAgentStats(agent1 as string);
    const a2 = getAgentStats(agent2 as string);

    const score = (s: any) => s.phones * 10 + s.emails * 5 + s.servers * 20 + s.domains * 15 + s.api_calls * 0.1;

    res.json({
      comparison: { agent1: a1, agent2: a2 },
      scores: {
        [agent1 as string]: Math.round(score(a1)),
        [agent2 as string]: Math.round(score(a2))
      },
      winner: score(a1) > score(a2) ? agent1 : score(a2) > score(a1) ? agent2 : "tie",
      timestamp: new Date().toISOString()
    });
  } finally { db.close(); }
});

export default router;
