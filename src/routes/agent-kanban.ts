import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

const initKanban = () => {
  
  db.exec(`CREATE TABLE IF NOT EXISTS agent_kanban (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'todo',
    priority TEXT DEFAULT 'medium',
    assignee TEXT,
    due_date TEXT,
    tags TEXT DEFAULT '[]',
    created_at TEXT,
    updated_at TEXT
  )`);
};

router.post("/", (req: Request, res: Response) => {
  initKanban();
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  const { title, description, status, priority, assignee, due_date, tags } = req.body;
  if (!title) return res.status(400).json({ error: "title required" });
  const now = new Date().toISOString();
  
  const result = db.prepare(`INSERT INTO agent_kanban (agent_id, title, description, status, priority, assignee, due_date, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(agentId, title, description || "", status || "todo", priority || "medium", assignee || null, due_date || null, JSON.stringify(tags || []), now, now);
  res.json({ id: result.lastInsertRowid, agentId, title, status: status || "todo", priority: priority || "medium" });
});

router.get("/", (req: Request, res: Response) => {
  initKanban();
  const agentId = req.headers["x-agent-id"] as string;
  const { status, priority } = req.query;
  
  let query = "SELECT * FROM agent_kanban WHERE 1=1";
  const params: any[] = [];
  if (agentId) { query += " AND agent_id = ?"; params.push(agentId); }
  if (status) { query += " AND status = ?"; params.push(status); }
  if (priority) { query += " AND priority = ?"; params.push(priority); }
  query += " ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, created_at DESC";
  const tasks = db.prepare(query).all(...params) as any[];
  const board: Record<string, any[]> = { todo: [], in_progress: [], review: [], done: [], blocked: [] };
  tasks.forEach((t) => { t.tags = JSON.parse(t.tags || "[]"); (board[t.status] || board.todo).push(t); });
  res.json({ board, summary: { total: tasks.length, todo: board.todo.length, in_progress: board.in_progress.length, review: board.review.length, done: board.done.length, blocked: board.blocked.length } });
});

router.patch("/:id", (req: Request, res: Response) => {
  initKanban();
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  const { id } = req.params;
  const updates = req.body;
  
  const allowed = ["title", "description", "status", "priority", "assignee", "due_date", "tags"];
  const sets: string[] = [];
  const params: any[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (allowed.includes(key)) { sets.push(`${key} = ?`); params.push(key === "tags" ? JSON.stringify(val) : val); }
  }
  if (sets.length === 0) return res.status(400).json({ error: "no valid fields" });
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id, agentId);
  db.prepare(`UPDATE agent_kanban SET ${sets.join(", ")} WHERE id = ? AND agent_id = ?`).run(...params);
  res.json({ updated: true, id });
});

router.delete("/:id", (req: Request, res: Response) => {
  initKanban();
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  db.prepare("DELETE FROM agent_kanban WHERE id = ? AND agent_id = ?").run(req.params.id, agentId);
  res.json({ deleted: true });
});

export default router;
