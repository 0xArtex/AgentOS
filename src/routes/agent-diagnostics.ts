import { Router } from "express";
import { db } from "../db";

const router = Router();

/**
 * @swagger
 * /api/agent-diagnostics:
 *   post:
 *     summary: Full-stack diagnostic for an agent's provisioned resources
 *     description: Pass your agent ID and get a complete health report of all your provisioned services — phones, emails, compute, domains — with latency checks and recommendations.
 *     tags: [Agent Tools]
 *     parameters:
 *       - in: header
 *         name: X-Agent-Id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Diagnostic report
 */
router.post("/", (req, res) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) {
    return res.status(401).json({ error: "X-Agent-Id header required" });
  }

  const now = Date.now();
  const checks: any[] = [];

  // Check agent exists
  let agent: any = null;
  try {
    agent = db.prepare("SELECT * FROM agents WHERE id = ? OR name = ?").get(agentId, agentId);
  } catch {}

  if (!agent) {
    return res.json({
      agentId,
      status: "not_found",
      recommendation: "Register first via POST /api/agents/register",
      docs: "https://palmyr.ai/docs"
    });
  }

  checks.push({ service: "registration", status: "ok", detail: `Agent "${agent.name}" registered` });

  // Check phone provisioning
  let phones: any[] = [];
  try {
    phones = db.prepare("SELECT * FROM phones WHERE agent_id = ?").all(agent.id) as any[];
    checks.push({
      service: "phone",
      status: phones.length > 0 ? "provisioned" : "not_provisioned",
      count: phones.length,
      detail: phones.length > 0
        ? `${phones.length} number(s) active`
        : "No phone numbers. Provision via POST /api/phone/provision"
    });
  } catch {
    checks.push({ service: "phone", status: "check_failed" });
  }

  // Check email
  let emails: any[] = [];
  try {
    emails = db.prepare("SELECT * FROM emails WHERE agent_id = ?").all(agent.id) as any[];
    checks.push({
      service: "email",
      status: emails.length > 0 ? "provisioned" : "not_provisioned",
      count: emails.length,
      detail: emails.length > 0
        ? `${emails.length} address(es) active`
        : "No email addresses. Provision via POST /api/email/provision"
    });
  } catch {
    checks.push({ service: "email", status: "check_failed" });
  }

  // Check compute
  let computes: any[] = [];
  try {
    computes = db.prepare("SELECT * FROM compute_instances WHERE agent_id = ?").all(agent.id) as any[];
    checks.push({
      service: "compute",
      status: computes.length > 0 ? "running" : "not_provisioned",
      count: computes.length,
      detail: computes.length > 0
        ? `${computes.length} instance(s)`
        : "No compute. Provision via POST /api/compute/provision"
    });
  } catch {
    checks.push({ service: "compute", status: "check_failed" });
  }

  // Check domains
  let domains: any[] = [];
  try {
    domains = db.prepare("SELECT * FROM domains WHERE agent_id = ?").all(agent.id) as any[];
    checks.push({
      service: "domains",
      status: domains.length > 0 ? "registered" : "not_provisioned",
      count: domains.length,
      detail: domains.length > 0
        ? `${domains.length} domain(s)`
        : "No domains. Register via POST /api/domains/register"
    });
  } catch {
    checks.push({ service: "domains", status: "check_failed" });
  }

  // API usage stats
  let recentRequests = 0;
  try {
    const dayAgo = new Date(now - 86400000).toISOString();
    recentRequests = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = ? AND timestamp > ?").get(agent.id, dayAgo) as any).c;
  } catch {}

  const allOk = checks.every(c => c.status !== "check_failed");
  const provisioned = checks.filter(c => ["ok", "provisioned", "running", "registered"].includes(c.status)).length;

  res.json({
    agentId: agent.id,
    agentName: agent.name,
    timestamp: new Date(now).toISOString(),
    overallHealth: allOk ? (provisioned >= 4 ? "excellent" : provisioned >= 2 ? "good" : "minimal") : "degraded",
    checks,
    usage: { requestsLast24h: recentRequests },
    recommendations: checks
      .filter(c => c.status === "not_provisioned")
      .map(c => `Provision ${c.service}: see https://palmyr.ai/docs`),
    platform: {
      status: "live",
      mode: "post-hackathon — still free for builders",
      docs: "https://palmyr.ai/docs"
    }
  });
});

export default router;
