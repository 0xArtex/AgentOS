import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// GET /api/search?q=keyword - Universal search across all resources
router.get("/", (req: Request, res: Response) => {
  const q = (req.query.q as string || "").toLowerCase().trim();
  if (!q) {
    return res.json({
      usage: "GET /api/search?q=<keyword>",
      description: "Search across agents, phones, emails, servers, domains, logs, and more",
      example: "/api/search?q=trading"
    });
  }

  const results: Record<string, any[]> = {};
  const safeSearch = (table: string, columns: string[], label: string) => {
    try {
      const where = columns.map(c => `LOWER(${c}) LIKE ?`).join(" OR ");
      const params = columns.map(() => `%${q}%`);
      const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT 10`).all(...params);
      if (rows.length > 0) results[label] = rows;
    } catch {}
  };

  safeSearch("agents", ["name", "agent_id"], "agents");
  safeSearch("phone_numbers", ["phone_number", "agent_id"], "phones");
  safeSearch("email_inboxes", ["email", "agent_id"], "emails");
  safeSearch("servers", ["name", "agent_id"], "servers");

  // Search logs
  try {
    const rows = db.prepare("SELECT * FROM agent_logs WHERE LOWER(action) LIKE ? OR LOWER(details) LIKE ? ORDER BY created_at DESC LIMIT 10").all(`%${q}%`, `%${q}%`);
    if (rows.length > 0) results["logs"] = rows;
  } catch {}

  // Search marketplace
  try {
    const rows = db.prepare("SELECT * FROM marketplace_listings WHERE LOWER(title) LIKE ? OR LOWER(description) LIKE ? LIMIT 10").all(`%${q}%`, `%${q}%`);
    if (rows.length > 0) results["marketplace"] = rows;
  } catch {}

  const totalResults = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);

  res.json({
    query: q,
    totalResults,
    categories: Object.keys(results).length,
    results
  });
});

export default router;
