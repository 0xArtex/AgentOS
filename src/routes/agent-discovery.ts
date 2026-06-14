import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

/**
 * POST /api/agent-discovery/register — RETIRED (never persisted).
 *
 * This used to return `registered: true` without writing anything. The real,
 * persistent registry is POST /agents/register, which stores the agent and
 * issues an aos_ token.
 */
router.post("/register", (_req: Request, res: Response) => {
  res.status(410).json({
    error: "Gone",
    message: "This discovery endpoint never persisted registrations. Use the real registry.",
    registerAt: "POST /agents/register",
    hint: "POST /agents/register with a Solana walletAddress + name to receive an aos_ token.",
  });
});

/**
 * GET /api/agent-discovery/search — Search the REAL agents table.
 *
 * Previously returned a hardcoded list of other projects. Now queries the
 * same `agents` table the rest of the server uses.
 */
router.get("/search", (req: Request, res: Response) => {
  const q = (req.query.q as string) || "";

  const rows = q
    ? db
        .prepare(
          "SELECT id, name, description, created_at FROM agents WHERE name LIKE ? OR description LIKE ? LIMIT 50"
        )
        .all(`%${q}%`, `%${q}%`)
    : db.prepare("SELECT id, name, description, created_at FROM agents LIMIT 50").all();

  res.json({ query: { q }, results: rows, total: rows.length });
});

export default router;
