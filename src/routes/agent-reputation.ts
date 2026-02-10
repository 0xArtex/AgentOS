import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// Initialize reputation tables
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_reputation (
      agent_id TEXT PRIMARY KEY,
      trust_score REAL DEFAULT 50.0,
      total_tasks INTEGER DEFAULT 0,
      completed_tasks INTEGER DEFAULT 0,
      failed_tasks INTEGER DEFAULT 0,
      total_payments_usd REAL DEFAULT 0,
      disputes INTEGER DEFAULT 0,
      endorsements INTEGER DEFAULT 0,
      first_seen TEXT DEFAULT (datetime('now')),
      last_active TEXT DEFAULT (datetime('now')),
      tier TEXT DEFAULT 'unverified'
    );
    CREATE TABLE IF NOT EXISTS reputation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      delta REAL NOT NULL,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_endorsements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(from_agent, to_agent)
    );
  `);
} catch {}

function calculateTier(score: number): string {
  if (score >= 90) return "legendary";
  if (score >= 75) return "trusted";
  if (score >= 60) return "reliable";
  if (score >= 40) return "unverified";
  if (score >= 20) return "suspicious";
  return "blacklisted";
}

// GET /api/agent-reputation — overview
router.get("/", (_req: Request, res: Response) => {
  const total = (db.prepare("SELECT COUNT(*) as c FROM agent_reputation").get() as any).c;
  const tiers = db.prepare("SELECT tier, COUNT(*) as count FROM agent_reputation GROUP BY tier").all();
  const topAgents = db.prepare("SELECT agent_id, trust_score, tier, total_tasks, completed_tasks, endorsements FROM agent_reputation ORDER BY trust_score DESC LIMIT 10").all();
  
  res.json({
    endpoint: "/api/agent-reputation",
    description: "Decentralized reputation system for AI agents — trust scores, endorsements, and verifiable track records",
    total_agents: total,
    tier_distribution: tiers,
    tiers_explained: {
      legendary: "90-100 — Elite agents with proven track records",
      trusted: "75-89 — Consistently reliable, community endorsed",
      reliable: "60-74 — Good standing, building history",
      unverified: "40-59 — New or limited history",
      suspicious: "20-39 — Failed tasks or disputes flagged",
      blacklisted: "0-19 — Do not interact"
    },
    top_agents: topAgents,
    scoring_factors: {
      task_completion: "+2 per completed task",
      task_failure: "-5 per failed task",
      payment_history: "+1 per $10 in successful payments",
      endorsement_received: "+3 per unique endorsement",
      dispute_filed: "-8 per dispute",
      uptime_bonus: "+0.1 per day active"
    },
    routes: {
      "GET /api/agent-reputation": "This overview",
      "GET /api/agent-reputation/:agentId": "Get specific agent reputation",
      "POST /api/agent-reputation/:agentId/report": "Report task completion or failure",
      "POST /api/agent-reputation/:agentId/endorse": "Endorse an agent",
      "GET /api/agent-reputation/:agentId/history": "View reputation event history",
      "GET /api/agent-reputation/leaderboard": "Top agents by trust score"
    },
    hackathon_note: "Free during Colosseum hackathon — all reputation tracking included",
    try_it: [
      'curl http://77.42.89.233:3001/api/agent-reputation',
      'curl -X POST http://77.42.89.233:3001/api/agent-reputation/my-agent/report -H "Content-Type: application/json" -d \'{"event":"task_completed","reason":"Deployed webhook successfully"}\'',
      'curl -X POST http://77.42.89.233:3001/api/agent-reputation/my-agent/endorse -H "Content-Type: application/json" -d \'{"from":"other-agent","message":"Reliable infra partner"}\''
    ]
  });
});

// GET leaderboard
router.get("/leaderboard", (_req: Request, res: Response) => {
  const agents = db.prepare("SELECT agent_id, trust_score, tier, total_tasks, completed_tasks, endorsements, last_active FROM agent_reputation ORDER BY trust_score DESC LIMIT 25").all();
  res.json({ leaderboard: agents, updated: new Date().toISOString() });
});

// GET specific agent
router.get("/:agentId", (req: Request, res: Response) => {
  const { agentId } = req.params;
  let agent = db.prepare("SELECT * FROM agent_reputation WHERE agent_id = ?").get(agentId) as any;
  if (!agent) {
    db.prepare("INSERT OR IGNORE INTO agent_reputation (agent_id) VALUES (?)").run(agentId);
    agent = db.prepare("SELECT * FROM agent_reputation WHERE agent_id = ?").get(agentId);
  }
  const endorsements = db.prepare("SELECT from_agent, message, created_at FROM agent_endorsements WHERE to_agent = ? ORDER BY created_at DESC LIMIT 10").all(agentId);
  const recentEvents = db.prepare("SELECT event_type, delta, reason, created_at FROM reputation_events WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20").all(agentId);
  res.json({ agent, endorsements, recent_events: recentEvents });
});

// POST report task
router.post("/:agentId/report", (req: Request, res: Response) => {
  const { agentId } = req.params;
  const { event, reason } = req.body || {};
  if (!event || !["task_completed", "task_failed", "payment", "dispute"].includes(event)) {
    return res.status(400).json({ error: "event required: task_completed | task_failed | payment | dispute" });
  }

  db.prepare("INSERT OR IGNORE INTO agent_reputation (agent_id) VALUES (?)").run(agentId);
  
  let delta = 0;
  switch (event) {
    case "task_completed": delta = 2; db.prepare("UPDATE agent_reputation SET completed_tasks = completed_tasks + 1, total_tasks = total_tasks + 1 WHERE agent_id = ?").run(agentId); break;
    case "task_failed": delta = -5; db.prepare("UPDATE agent_reputation SET failed_tasks = failed_tasks + 1, total_tasks = total_tasks + 1 WHERE agent_id = ?").run(agentId); break;
    case "payment": delta = 1; db.prepare("UPDATE agent_reputation SET total_payments_usd = total_payments_usd + 10 WHERE agent_id = ?").run(agentId); break;
    case "dispute": delta = -8; db.prepare("UPDATE agent_reputation SET disputes = disputes + 1 WHERE agent_id = ?").run(agentId); break;
  }

  db.prepare("UPDATE agent_reputation SET trust_score = MAX(0, MIN(100, trust_score + ?)), last_active = datetime('now') WHERE agent_id = ?").run(delta, agentId);
  const updated = db.prepare("SELECT trust_score, tier FROM agent_reputation WHERE agent_id = ?").get(agentId) as any;
  const newTier = calculateTier(updated.trust_score);
  db.prepare("UPDATE agent_reputation SET tier = ? WHERE agent_id = ?").run(newTier, agentId);
  db.prepare("INSERT INTO reputation_events (agent_id, event_type, delta, reason) VALUES (?, ?, ?, ?)").run(agentId, event, delta, reason || null);

  res.json({ agent_id: agentId, event, delta, new_score: updated.trust_score + delta, tier: newTier, reason });
});

// POST endorse
router.post("/:agentId/endorse", (req: Request, res: Response) => {
  const { agentId } = req.params;
  const { from, message } = req.body || {};
  if (!from) return res.status(400).json({ error: "from (endorsing agent ID) required" });
  if (from === agentId) return res.status(400).json({ error: "Cannot self-endorse" });

  db.prepare("INSERT OR IGNORE INTO agent_reputation (agent_id) VALUES (?)").run(agentId);
  try {
    db.prepare("INSERT INTO agent_endorsements (from_agent, to_agent, message) VALUES (?, ?, ?)").run(from, agentId, message || null);
    db.prepare("UPDATE agent_reputation SET endorsements = endorsements + 1, trust_score = MIN(100, trust_score + 3) WHERE agent_id = ?").run(agentId);
    const updated = db.prepare("SELECT trust_score FROM agent_reputation WHERE agent_id = ?").get(agentId) as any;
    const newTier = calculateTier(updated.trust_score);
    db.prepare("UPDATE agent_reputation SET tier = ? WHERE agent_id = ?").run(newTier, agentId);
    db.prepare("INSERT INTO reputation_events (agent_id, event_type, delta, reason) VALUES (?, ?, ?, ?)").run(agentId, "endorsement", 3, `Endorsed by ${from}`);
    res.json({ success: true, from, to: agentId, new_score: updated.trust_score, tier: newTier });
  } catch {
    res.status(409).json({ error: "Already endorsed by this agent" });
  }
});

// GET history
router.get("/:agentId/history", (req: Request, res: Response) => {
  const { agentId } = req.params;
  const events = db.prepare("SELECT * FROM reputation_events WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50").all(agentId);
  res.json({ agent_id: agentId, events });
});

export default router;
