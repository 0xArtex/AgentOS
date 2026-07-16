import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);

    const agents = db
      .prepare(
        `SELECT 
          a.id, a.name, a.created_at,
          (SELECT COUNT(*) FROM phone_numbers WHERE owner = a.id) as phones,
          (SELECT COUNT(*) FROM email_inboxes WHERE owner = a.id) as emails,
          (SELECT COUNT(*) FROM servers WHERE owner = a.id) as servers,
          (SELECT COUNT(*) FROM domains WHERE owner = a.id) as domains
        FROM agents a
        ORDER BY phones + emails + servers + domains DESC
        LIMIT ?`
      )
      .all(limit);

    const totalAgents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any)?.c || 0;

    res.json({
      leaderboard: agents,
      meta: {
        total_agents: totalAgents,
        generated_at: new Date().toISOString()
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate leaderboard", detail: err.message });
  }
});

export default router;
