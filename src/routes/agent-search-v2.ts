import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// Any column whose name looks like a credential must never leave this endpoint.
// `SELECT *` previously dumped agents.token and servers.root_password to any
// caller across all tenants. We now (1) select explicit safe columns only and
// (2) redact, as defence in depth, any remaining sensitive-looking field — which
// also covers free-form tables (logs, marketplace) whose schema we don't pin.
const SECRET_KEY = /(token|secret|password|passwd|pwd|priv(ate)?_?key|privatekey|private|api_?key|apikey|credential|mnemonic|seed|root_password|access_key|signing_key|session)/i;

function redact<T extends Record<string, any>>(row: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(row)) {
    if (SECRET_KEY.test(k)) continue;
    (out as any)[k] = row[k];
  }
  return out;
}

// GET /api/search?q=keyword - Universal search across all resources
router.get("/", (req: Request, res: Response) => {
  const q = (req.query.q as string || "").toLowerCase().trim();
  if (!q) {
    return res.json({
      usage: "GET /api/search?q=<keyword>",
      description: "Search across agents, phones, emails, servers, logs, and more",
      example: "/api/search?q=trading"
    });
  }

  const results: Record<string, any[]> = {};
  // selectCols is an explicit allow-list — never "*". searchCols is what we match
  // the query against. Both are code-controlled (never user input), so this can't
  // be turned into column injection.
  const safeSearch = (table: string, searchCols: string[], selectCols: string[], label: string) => {
    try {
      const where = searchCols.map(c => `LOWER(${c}) LIKE ?`).join(" OR ");
      const params = searchCols.map(() => `%${q}%`);
      const rows = db.prepare(`SELECT ${selectCols.join(", ")} FROM ${table} WHERE ${where} LIMIT 10`).all(...params) as any[];
      if (rows.length > 0) results[label] = rows.map(redact);
    } catch {}
  };

  safeSearch("agents", ["name", "wallet_address"], ["id", "name", "description", "wallet_address", "created_at"], "agents");
  safeSearch("phone_numbers", ["phone_number", "owner"], ["id", "phone_number", "country", "owner", "provisioned_at"], "phones");
  safeSearch("email_inboxes", ["address", "owner"], ["id", "address", "owner", "created_at"], "emails");
  safeSearch("servers", ["name", "owner"], ["id", "name", "status", "owner", "created_at"], "servers");

  // Free-form tables we don't control the schema of — keep SELECT * but redact
  // every row so a stray credential-named column can never surface.
  try {
    const rows = db.prepare("SELECT * FROM agent_logs WHERE LOWER(action) LIKE ? OR LOWER(details) LIKE ? ORDER BY created_at DESC LIMIT 10").all(`%${q}%`, `%${q}%`) as any[];
    if (rows.length > 0) results["logs"] = rows.map(redact);
  } catch {}

  try {
    const rows = db.prepare("SELECT * FROM marketplace_listings WHERE LOWER(title) LIKE ? OR LOWER(description) LIKE ? LIMIT 10").all(`%${q}%`, `%${q}%`) as any[];
    if (rows.length > 0) results["marketplace"] = rows.map(redact);
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
