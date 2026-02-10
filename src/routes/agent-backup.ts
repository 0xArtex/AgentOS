import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

function safeAll(table: string, agentId: string): any[] {
  try { return db.prepare(`SELECT * FROM ${table} WHERE agent_id = ?`).all(agentId); }
  catch { return []; }
}

router.get("/:agentId", (req: Request, res: Response) => {
  const agentId = req.params.agentId as string;
  const tables = ["phones","emails","servers","domains","webhooks","escrows","tasks","logs","invoices","notifications","ratings","collaborations","agent_config","agent_secrets","agent_logs","agent_comms","agent_alerts","agent_cron","agent_env"];
  
  const data: Record<string, any[]> = {};
  let total = 0;
  for (const t of tables) {
    const rows = safeAll(t, agentId);
    if (rows.length > 0) { data[t] = rows; total += rows.length; }
  }

  let agent: any = null;
  try { agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId); } catch {}

  res.json({
    version: "1.0",
    exportedAt: new Date().toISOString(),
    agentId,
    registered: !!agent,
    resourceCount: total,
    tableCount: Object.keys(data).length,
    data: { agent, ...data },
    hint: total === 0 ? "No data found. Register first at POST /api/register" : undefined
  });
});

export default router;
