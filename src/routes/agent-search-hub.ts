import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// GET /api/search — unified search across all Palmyr resources
router.get("/", (req: Request, res: Response) => {
  const q = (req.query.q as string || "").toLowerCase().trim();
  
  if (!q) {
    return res.json({
      endpoint: "/api/search",
      description: "Unified search across all Palmyr resources",
      usage: "GET /api/search?q=<query>",
      searchable: ["agents", "phones", "emails", "servers", "domains", "webhooks", "marketplace", "collaborations"],
      example: "curl https://palmyr.ai/api/search?q=trading"
    });
  }

  const results: any = { query: q, matches: {} };

  try {
    const agents = db.prepare("SELECT id, name, created_at FROM agents WHERE LOWER(name) LIKE ?").all(`%${q}%`);
    if (agents.length) results.matches.agents = agents;
  } catch {}

  try {
    const phones = db.prepare("SELECT id, agent_id, phone_number, created_at FROM phone_numbers WHERE phone_number LIKE ?").all(`%${q}%`);
    if (phones.length) results.matches.phones = phones;
  } catch {}

  try {
    const emails = db.prepare("SELECT id, agent_id, address, created_at FROM email_inboxes WHERE LOWER(address) LIKE ?").all(`%${q}%`);
    if (emails.length) results.matches.emails = emails;
  } catch {}

  try {
    const servers = db.prepare("SELECT id, agent_id, hostname, status, created_at FROM servers WHERE LOWER(hostname) LIKE ? OR LOWER(status) LIKE ?").all(`%${q}%`, `%${q}%`);
    if (servers.length) results.matches.servers = servers;
  } catch {}

  const totalMatches = Object.values(results.matches).reduce((sum: number, arr: any) => sum + arr.length, 0);
  results.totalMatches = totalMatches;
  results.searchedAt = new Date().toISOString();

  res.json(results);
});

export default router;
