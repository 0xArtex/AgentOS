import { Router, Request, Response } from "express";
import { db } from "../db";
import { DashboardRequest } from "../middleware/dashboard-session";

const router = Router();

function getUserId(req: DashboardRequest): string | null {
  return req.dashUserId || (req.headers["x-dashboard-user"] as string) || null;
}

// GET / — list all projects for user
router.get("/", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

  const projects = db.prepare(
    "SELECT id, name, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC"
  ).all(userId);

  // Auto-create a default project if none exist
  if (projects.length === 0) {
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO projects (id, user_id, name, canvas_state, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run(id, userId, "My Project", null);
    const created = db.prepare("SELECT id, name, created_at, updated_at FROM projects WHERE id = ?").get(id);
    return res.json({ projects: [created] });
  }

  res.json({ projects });
});

// POST / — create new project
router.post("/", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });

  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO projects (id, user_id, name, canvas_state, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).run(id, userId, name, null);

  res.json({ id, name, created_at: new Date().toISOString() });
});

// GET /:id — get project with canvas state
router.get("/:id", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

  const project = db.prepare(
    "SELECT * FROM projects WHERE id = ? AND user_id = ?"
  ).get(req.params.id, userId) as any;

  if (!project) return res.status(404).json({ error: "Project not found" });

  let canvasState = null;
  if (project.canvas_state) {
    try { canvasState = JSON.parse(project.canvas_state); } catch {}
  }

  res.json({ id: project.id, name: project.name, canvas_state: canvasState, created_at: project.created_at, updated_at: project.updated_at });
});

// PUT /:id — update project (name and/or canvas state)
router.put("/:id", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

  const project = db.prepare("SELECT id FROM projects WHERE id = ? AND user_id = ?").get(req.params.id, userId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { name, canvas_state } = req.body || {};

  if (name) {
    db.prepare("UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, req.params.id);
  }
  if (canvas_state !== undefined) {
    const stateStr = typeof canvas_state === "string" ? canvas_state : JSON.stringify(canvas_state);
    db.prepare("UPDATE projects SET canvas_state = ?, updated_at = datetime('now') WHERE id = ?").run(stateStr, req.params.id);
  }

  res.json({ success: true });
});

// DELETE /:id — delete project
router.delete("/:id", (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "X-Dashboard-User header required" });

  const result = db.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").run(req.params.id, userId);
  if (result.changes === 0) return res.status(404).json({ error: "Project not found" });

  res.json({ success: true });
});

export default router;
