import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import os from "os";

const router = Router();
const dbPath = path.join(__dirname, "../../data/agentos.db");

router.get("/api/agent-snapshot", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  
  try {
    const db = new Database(dbPath, { readonly: true });
    
    // Platform-wide snapshot
    const tables = ["agents","phones","emails","servers","domains","webhooks","escrows","tasks","logs","invoices","collaborations","notifications","ratings"];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      try { counts[t] = (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as any).c; } catch { counts[t] = 0; }
    }
    
    // Traffic
    let totalRequests = 0, last24h = 0;
    try {
      totalRequests = (db.prepare("SELECT COUNT(*) as c FROM request_log").get() as any).c;
      last24h = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE timestamp > datetime(now, -24 hours)").get() as any).c;
    } catch {}
    
    // Agent-specific if header present
    let agentData: any = null;
    if (agentId) {
      try {
        agentData = {
          phones: (db.prepare("SELECT COUNT(*) as c FROM phones WHERE agent_id = ?").get(agentId) as any).c,
          emails: (db.prepare("SELECT COUNT(*) as c FROM emails WHERE agent_id = ?").get(agentId) as any).c,
          servers: (db.prepare("SELECT COUNT(*) as c FROM servers WHERE agent_id = ?").get(agentId) as any).c,
          domains: (db.prepare("SELECT COUNT(*) as c FROM domains WHERE agent_id = ?").get(agentId) as any).c,
        };
      } catch {}
    }
    
    const deadline = new Date("2026-02-12T17:00:00Z");
    const now = new Date();
    const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);
    
    db.close();
    
    res.json({
      snapshot: {
        timestamp: now.toISOString(),
        platform: {
          resources: counts,
          traffic: { total: totalRequests, last24h, rpm: Math.round(last24h / 1440) },
          system: {
            uptime: `${Math.floor(os.uptime() / 3600)}h`,
            memory: `${Math.round(process.memoryUsage().heapUsed / 1048576)}MB`,
            cpu_load: os.loadavg()[0].toFixed(2)
          }
        },
        agent: agentData,
        hackathon: {
          hours_remaining: Math.round(hoursLeft * 10) / 10,
          deadline: "2026-02-12T17:00:00Z",
          status: hoursLeft > 48 ? "building" : hoursLeft > 24 ? "crunch" : hoursLeft > 6 ? "final-sprint" : "submit-now"
        },
        links: {
          docs: "http://77.42.89.233:3001/docs",
          skill: "http://77.42.89.233:3001/skill.md",
          github: "https://github.com/0xArtex/AgentOS"
        }
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
