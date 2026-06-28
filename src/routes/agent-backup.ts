import { Router, Response } from "express";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";

const router = Router();

// Auth required: only the VERIFIED owner may export their data. requireAuth(0)
// sets req.agentId to the verified wallet identity (never the raw header, never
// a guessable path param), so this export can no longer dump any agent's
// config/env/comms/webhooks by guessing a wallet. We do NOT rely on a swallowed
// column-mismatch as a guard — every query is keyed on the authenticated id.
router.use(requireAuth(0, "general"));

function safeAll(table: string, agentId: string): any[] {
  try { return db.prepare(`SELECT * FROM ${table} WHERE agent_id = ?`).all(agentId); }
  catch { return []; }
}

// Accept any identifier the caller uses for THEIR OWN agent (wallet / name /
// id) in the optional path param, but only ever after confirming it resolves
// to the authenticated identity. Returns true iff `claimed` belongs to `me`.
function ownsIdentity(me: string, claimed: string): boolean {
  if (claimed === me) return true;
  try {
    const row = db.prepare(
      "SELECT id, wallet_address FROM agents WHERE wallet_address = ? OR name = ? OR id = ?"
    ).get(claimed, claimed, claimed) as any;
    if (!row) return false;
    return row.wallet_address === me || row.id === me;
  } catch { return false; }
}

// GET /api/agent-backup            → export the authenticated agent's data
// GET /api/agent-backup/:agentId   → same, but the param MUST be the caller
router.get("/:agentId?", (req: AuthenticatedRequest, res: Response) => {
  const me = req.agentId || req.payment?.payer;
  if (!me) { res.status(401).json({ error: "authentication required" }); return; }

  // The path param is advisory. If present it MUST refer to the authenticated
  // agent; we NEVER export data for any identity other than the caller's.
  const claimed = typeof req.params.agentId === "string" ? req.params.agentId : undefined;
  if (claimed && !ownsIdentity(me, claimed)) {
    res.status(403).json({ error: "forbidden", message: "You can only export your own agent data." });
    return;
  }

  const agentId = me;
  const tables = ["phones","emails","servers","domains","webhooks","escrows","tasks","logs","invoices","notifications","ratings","collaborations","agent_config","agent_secrets","agent_logs","agent_comms","agent_alerts","agent_cron","agent_env"];

  const data: Record<string, any[]> = {};
  let total = 0;
  for (const t of tables) {
    const rows = safeAll(t, agentId);
    if (rows.length > 0) { data[t] = rows; total += rows.length; }
  }

  let agent: any = null;
  try { agent = db.prepare("SELECT * FROM agents WHERE wallet_address = ? OR id = ?").get(agentId, agentId); } catch {}

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
