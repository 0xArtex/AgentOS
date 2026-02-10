import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";

const router = Router();
const dbPath = path.join(process.cwd(), "data", "agentos.db");

function getDb() {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_cron_jobs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    method TEXT DEFAULT 'GET',
    payload TEXT,
    enabled INTEGER DEFAULT 1,
    last_run TEXT,
    next_run TEXT,
    run_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  return db;
}

router.get("/", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const db = getDb();
  const jobs = db.prepare("SELECT * FROM agent_cron_jobs WHERE agent_id = ? ORDER BY created_at DESC").all(agentId);
  db.close();
  res.json({
    agent_id: agentId,
    jobs,
    total: (jobs as any[]).length,
    description: "Scheduled task automation for agents. Create recurring jobs that hit any endpoint on a cron schedule."
  });
});

router.post("/", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const { name, schedule, endpoint, method, payload } = req.body || {};
  if (!name || !schedule || !endpoint) {
    return res.status(400).json({ error: "name, schedule, and endpoint are required" });
  }
  const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const db = getDb();
  db.prepare("INSERT INTO agent_cron_jobs (id, agent_id, name, schedule, endpoint, method, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, agentId, name, schedule, endpoint, method || "GET", payload ? JSON.stringify(payload) : null);
  db.close();
  res.status(201).json({ id, name, schedule, endpoint, method: method || "GET", enabled: true, message: "Cron job created" });
});

router.get("/:id", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const db = getDb();
  const job = db.prepare("SELECT * FROM agent_cron_jobs WHERE id = ? AND agent_id = ?").get(req.params.id, agentId);
  db.close();
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

router.patch("/:id", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const { enabled, schedule, name } = req.body || {};
  const db = getDb();
  const job = db.prepare("SELECT * FROM agent_cron_jobs WHERE id = ? AND agent_id = ?").get(req.params.id, agentId);
  if (!job) { db.close(); return res.status(404).json({ error: "Job not found" }); }
  if (enabled !== undefined) db.prepare("UPDATE agent_cron_jobs SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, req.params.id);
  if (schedule) db.prepare("UPDATE agent_cron_jobs SET schedule = ? WHERE id = ?").run(schedule, req.params.id);
  if (name) db.prepare("UPDATE agent_cron_jobs SET name = ? WHERE id = ?").run(name, req.params.id);
  const updated = db.prepare("SELECT * FROM agent_cron_jobs WHERE id = ?").get(req.params.id);
  db.close();
  res.json(updated);
});

router.delete("/:id", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const db = getDb();
  const result = db.prepare("DELETE FROM agent_cron_jobs WHERE id = ? AND agent_id = ?").run(req.params.id, agentId);
  db.close();
  if (result.changes === 0) return res.status(404).json({ error: "Job not found" });
  res.json({ deleted: true });
});

export default router;
