import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";

const router = Router();
const db = new Database(path.join(__dirname, "../../data/agent-queue.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS task_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    payload TEXT,
    status TEXT DEFAULT "pending",
    priority INTEGER DEFAULT 0,
    result TEXT,
    created_at TEXT DEFAULT "",
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_queue_agent ON task_queue(agent_id);
  CREATE INDEX IF NOT EXISTS idx_queue_status ON task_queue(status);
`);

// POST /api/queue - Submit a task
router.post("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  const { task_type, payload, priority } = req.body;
  if (!task_type) return res.status(400).json({ error: "task_type required" });

  const stmt = db.prepare("INSERT INTO task_queue (agent_id, task_type, payload, priority, created_at) VALUES (?, ?, ?, ?, datetime(now))");
  const result = stmt.run(agentId, task_type, JSON.stringify(payload || {}), priority || 0);

  res.json({ id: result.lastInsertRowid, status: "queued", task_type, priority: priority || 0 });
});

// GET /api/queue - Get pending tasks (optionally claim next)
router.get("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  const { status, limit } = req.query;

  const tasks = db.prepare(
    "SELECT * FROM task_queue WHERE agent_id = ? AND status = ? ORDER BY priority DESC, id ASC LIMIT ?"
  ).all(agentId, status || "pending", Number(limit) || 10);

  res.json({ agent_id: agentId, tasks, count: tasks.length });
});

// POST /api/queue/claim - Claim next pending task (atomic)
router.post("/claim", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";

  const task: any = db.prepare(
    "SELECT * FROM task_queue WHERE agent_id = ? AND status = pending ORDER BY priority DESC, id ASC LIMIT 1"
  ).get(agentId);

  if (!task) return res.json({ message: "No pending tasks", task: null });

  db.prepare("UPDATE task_queue SET status = processing WHERE id = ?").run(task.id);
  res.json({ ...task, status: "processing" });
});

// POST /api/queue/:id/complete - Complete a task with result
router.post("/:id/complete", (req: Request, res: Response) => {
  const { result } = req.body;
  db.prepare("UPDATE task_queue SET status = completed, result = ?, completed_at = datetime(now) WHERE id = ?")
    .run(JSON.stringify(result || {}), req.params.id);
  res.json({ id: req.params.id, status: "completed" });
});

// GET /api/queue/stats - Queue statistics
router.get("/stats", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  const where = agentId ? "WHERE agent_id = ?" : "";
  const params = agentId ? [agentId] : [];

  const stats: any = db.prepare(`SELECT status, COUNT(*) as count FROM task_queue ${where} GROUP BY status`).all(...params);
  const total: any = db.prepare(`SELECT COUNT(*) as count FROM task_queue ${where}`).get(...params);

  res.json({
    total: total.count,
    byStatus: Object.fromEntries(stats.map((s: any) => [s.status, s.count])),
    description: "Agent task queue — submit, claim, and complete tasks asynchronously"
  });
});

export default router;
