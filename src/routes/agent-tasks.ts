// @ts-nocheck
import { Router, Request, Response } from "express";

const router = Router();

interface Task {
  id: string;
  agentId: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  priority: "low" | "medium" | "high" | "critical";
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  metadata?: Record<string, any>;
}

const tasks: Map<string, Task> = new Map();

// POST /api/tasks - Create a task
router.post("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const { title, description, priority, dueAt, metadata } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });

  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const task: Task = {
    id, agentId, title,
    description: description || "",
    status: "pending",
    priority: priority || "medium",
    createdAt: now, updatedAt: now,
    dueAt, metadata
  };
  tasks.set(id, task);
  res.status(201).json({ success: true, task });
});

// GET /api/tasks - List tasks for agent
router.get("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const status = String(req.query.status || "") || undefined;
  const priority = String(req.query.priority || "") || undefined;
  let agentTasks = Array.from(tasks.values()).filter(t => t.agentId === agentId);
  if (status) agentTasks = agentTasks.filter(t => t.status === status);
  if (priority) agentTasks = agentTasks.filter(t => t.priority === priority);

  res.json({
    agentId, count: agentTasks.length,
    tasks: agentTasks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  });
});

// PATCH /api/tasks/:id - Update task status
router.patch("/:id", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const task = tasks.get(req.params.id);
  if (!task || task.agentId !== agentId) return res.status(404).json({ error: "Task not found" });

  const { status, priority, title, description, metadata } = req.body;
  if (status) task.status = status;
  if (priority) task.priority = priority;
  if (title) task.title = title;
  if (description !== undefined) task.description = description;
  if (metadata) task.metadata = { ...task.metadata, ...metadata };
  task.updatedAt = new Date().toISOString();

  res.json({ success: true, task });
});

// DELETE /api/tasks/:id
router.delete("/:id", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const task = tasks.get(req.params.id);
  if (!task || task.agentId !== agentId) return res.status(404).json({ error: "Task not found" });
  tasks.delete(req.params.id);
  res.json({ success: true, deleted: req.params.id });
});

// GET /api/tasks/summary - Task stats
router.get("/summary", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const agentTasks = Array.from(tasks.values()).filter(t => t.agentId === agentId);
  const byStatus = { pending: 0, in_progress: 0, completed: 0, failed: 0 };
  agentTasks.forEach(t => byStatus[t.status]++);

  res.json({ agentId, total: agentTasks.length, byStatus });
});

export default router;
