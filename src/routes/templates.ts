import { Router, Request, Response } from "express";
import { db } from "../db";
import { DashboardRequest, requireDashboardAuth, resolveDashboardSession } from "../middleware/dashboard-session";
import crypto from "crypto";

const router = Router();

// Service base costs (USDC) — what it actually costs us to provision
const SERVICE_COSTS: Record<string, number> = {
  compute_cax11: 5,    // 2 vCPU, 4GB RAM
  compute_cax21: 10,   // 4 vCPU, 8GB RAM
  compute_cax31: 20,   // 8 vCPU, 16GB RAM
  compute_cpx21: 12,  // 3 AMD vCPU, 4GB RAM
  compute_cpx31: 24,  // 4 AMD vCPU, 8GB RAM
  wallet_base: 0,     // Free (gas funded from factory)
  wallet_solana: 0,   // Free (rent funded from factory)
  phone: 3,           // Monthly phone number
  email: 0,           // Free (Cloudflare worker)
  openclaw: 0,        // Free (installed on VPS)
  domain: 12,         // .dev domain yearly
};

function calculateBaseCost(services: any[]): number {
  let cost = 0;
  for (const svc of services) {
    const key = svc.spec ? `${svc.type}_${svc.spec}` : svc.type;
    cost += SERVICE_COSTS[key] || 0;
  }
  return cost;
}

function getUserId(req: DashboardRequest): string | null {
  return req.dashUserId || (req.headers["x-dashboard-user"] as string) || null;
}

// ─── Public: Browse templates ───
router.get("/", (req: Request, res: Response) => {
  const { tag, sort = "popular", limit = 20, offset = 0 } = req.query;

  let query = "SELECT id, author_id, name, description, thumbnail, services, base_cost_usdc, margin_usdc, total_price_usdc, deploys, tags, created_at FROM templates WHERE status = 'published'";
  const params: any[] = [];

  if (tag) {
    query += " AND tags LIKE ?";
    params.push(`%${tag}%`);
  }

  if (sort === "popular") query += " ORDER BY deploys DESC, created_at DESC";
  else if (sort === "newest") query += " ORDER BY created_at DESC";
  else if (sort === "cheapest") query += " ORDER BY total_price_usdc ASC";
  else query += " ORDER BY deploys DESC";

  query += " LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));

  const templates = db.prepare(query).all(...params);

  // Enrich with author info
  const enriched = templates.map((t: any) => {
    const author = db.prepare("SELECT display_name, wallet_address FROM dashboard_users WHERE id = ?").get(t.author_id) as any;
    return {
      ...t,
      services: JSON.parse(t.services || "[]"),
      tags: t.tags ? t.tags.split(",") : [],
      author: author ? { name: author.display_name, wallet: author.wallet_address } : null,
    };
  });

  res.json({ templates: enriched });
});

// ─── Public: Get template detail ───
router.get("/:id", (req: Request, res: Response) => {
  const template = db.prepare(
    "SELECT * FROM templates WHERE id = ? AND status IN ('published', 'unlisted')"
  ).get(req.params.id) as any;

  if (!template) return res.status(404).json({ error: "Template not found" });

  const author = db.prepare("SELECT display_name, wallet_address FROM dashboard_users WHERE id = ?").get(template.author_id) as any;

  res.json({
    ...template,
    blueprint: JSON.parse(template.blueprint || "{}"),
    services: JSON.parse(template.services || "[]"),
    tags: template.tags ? template.tags.split(",") : [],
    author: author ? { name: author.display_name, wallet: author.wallet_address } : null,
  });
});

// ─── Auth required: Publish template from canvas ───
router.post("/", requireDashboardAuth, (req: DashboardRequest, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Auth required" });

  const { name, description, projectId, margin = 0, tags = [], status = "published" } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  if (!projectId) return res.status(400).json({ error: "projectId required" });

  // Fetch canvas state from project
  const project = db.prepare("SELECT canvas_state FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId) as any;
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.canvas_state) return res.status(400).json({ error: "Project has no canvas state" });

  const canvasState = JSON.parse(project.canvas_state);

  // Extract services from canvas nodes and strip secrets
  const services: any[] = [];
  const sanitizedNodes = (canvasState.nodes || []).map((node: any) => {
    const sanitized = { ...node };

    // Strip secrets from node config
    if (sanitized.config) {
      const cfg = { ...sanitized.config };
      delete cfg.privateKey;
      delete cfg.apiKey;
      delete cfg.secret;
      delete cfg.token;
      delete cfg.sshKey;
      delete cfg.password;
      sanitized.config = cfg;
    }

    // Extract service type
    if (node.type === "wallet") {
      services.push({ type: "wallet_base" });
      services.push({ type: "wallet_solana" });
    } else if (node.type === "compute" || node.type === "server") {
      services.push({ type: "compute", spec: node.config?.spec || "cax11" });
    } else if (node.type === "phone") {
      services.push({ type: "phone" });
    } else if (node.type === "email") {
      services.push({ type: "email" });
    } else if (node.type === "openclaw") {
      services.push({ type: "openclaw", skills: node.config?.skills || [] });
    } else if (node.type === "domain") {
      services.push({ type: "domain" });
    }

    return sanitized;
  });

  const blueprint = {
    nodes: sanitizedNodes,
    connections: canvasState.connections || [],
    viewport: canvasState.viewport,
  };

  const baseCost = calculateBaseCost(services);
  const totalPrice = baseCost + Number(margin);

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO templates (id, author_id, name, description, blueprint, services, base_cost_usdc, margin_usdc, total_price_usdc, tags, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, name, description || "",
    JSON.stringify(blueprint), JSON.stringify(services),
    baseCost, Number(margin), totalPrice,
    Array.isArray(tags) ? tags.join(",") : tags || "",
    status
  );

  res.json({
    id,
    name,
    baseCost,
    margin: Number(margin),
    totalPrice,
    services,
    status,
  });
});

// ─── Auth required: Update template ───
router.put("/:id", requireDashboardAuth, (req: DashboardRequest, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Auth required" });

  const template = db.prepare("SELECT * FROM templates WHERE id = ? AND author_id = ?").get(req.params.id, userId) as any;
  if (!template) return res.status(404).json({ error: "Template not found or not yours" });

  const { name, description, margin, tags, status } = req.body;
  const updates: string[] = [];
  const params: any[] = [];

  if (name !== undefined) { updates.push("name = ?"); params.push(name); }
  if (description !== undefined) { updates.push("description = ?"); params.push(description); }
  if (status !== undefined) { updates.push("status = ?"); params.push(status); }
  if (tags !== undefined) { updates.push("tags = ?"); params.push(Array.isArray(tags) ? tags.join(",") : tags); }
  if (margin !== undefined) {
    const baseCost = template.base_cost_usdc;
    updates.push("margin_usdc = ?", "total_price_usdc = ?");
    params.push(Number(margin), baseCost + Number(margin));
  }

  if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id, userId);

  db.prepare(`UPDATE templates SET ${updates.join(", ")} WHERE id = ? AND author_id = ?`).run(...params);

  res.json({ success: true });
});

// ─── Auth required: Delete template ───
router.delete("/:id", requireDashboardAuth, (req: DashboardRequest, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Auth required" });

  const result = db.prepare("UPDATE templates SET status = 'removed' WHERE id = ? AND author_id = ?").run(req.params.id, userId);
  if (result.changes === 0) return res.status(404).json({ error: "Template not found or not yours" });

  res.json({ success: true });
});

// ─── Auth required: Deploy a template ───
router.post("/:id/deploy", requireDashboardAuth, async (req: DashboardRequest, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Auth required" });

  const template = db.prepare("SELECT * FROM templates WHERE id = ? AND status = 'published'").get(req.params.id) as any;
  if (!template) return res.status(404).json({ error: "Template not found" });

  // Validate ALL inputs BEFORE charging. Anything that can return 4xx has to
  // run ahead of the debit so a rejected request is never billed (the user
  // previously got charged and then a 400 with no refund). Parse the blueprint
  // and services here too — a malformed template row would otherwise throw
  // AFTER the debit and surface as a charged-then-500.
  let blueprint: any;
  let services: any[];
  try {
    blueprint = JSON.parse(template.blueprint);
    services = JSON.parse(template.services);
  } catch {
    return res.status(400).json({ error: "Template is malformed (invalid blueprint or services)" });
  }

  // Wallet passphrase (only required if the template needs wallet provisioning)
  const walletPassphrase = (req.body as any)?.walletPassphrase as string | undefined;
  const needsWallet = services.some((s: any) => s.type?.startsWith("wallet"));
  if (needsWallet && !walletPassphrase) {
    return res.status(400).json({ error: "walletPassphrase is required for templates that include wallet services" });
  }

  // Check balance and debit — only after every validation above has passed.
  const totalPrice = template.total_price_usdc || 0;
  if (totalPrice > 0) {
    try {
      const { debit } = await import("../services/balance");
      debit(userId!, totalPrice, "template_deploy", `Template: ${template.name}`);
    } catch (e: any) {
      return res.status(402).json({ error: e.message, required: totalPrice });
    }
  }

  const deployId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO template_deployments (id, template_id, user_id, status, provisioning_log)
    VALUES (?, ?, ?, 'pending', '[]')
  `).run(deployId, template.id, userId);

  // Increment deploy count
  db.prepare("UPDATE templates SET deploys = deploys + 1 WHERE id = ?").run(template.id);

  // Create a new project from the blueprint
  const projectId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO projects (id, user_id, name, canvas_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(projectId, userId, `${template.name} (deployed)`, JSON.stringify(blueprint));

  // Start async provisioning
  provisionTemplate(deployId, userId, projectId, blueprint, services, walletPassphrase).catch(async err => {
    console.error("[templates] provisioning error:", err);
    db.prepare("UPDATE template_deployments SET status = 'failed', provisioning_log = ? WHERE id = ?")
      .run(JSON.stringify([{ step: "error", error: err.message, ts: Date.now() }]), deployId);
    // Refund the up-front debit — a deployment that failed to provision must not
    // be billed (mirrors the wallet-payer refund-on-failure guarantee). Keyed on
    // the deployId so it credits back at most once even if this path re-runs.
    if (totalPrice > 0) {
      try {
        const { refund } = await import("../services/balance");
        refund(userId!, totalPrice, `Refund: failed template deploy ${template.name}`, `tmpl_refund_${deployId}`);
      } catch (e: any) {
        console.error(`[templates] refund failed for deploy ${deployId} ($${totalPrice} to ${userId}):`, e?.message ?? e);
      }
    }
  });

  res.json({
    deploymentId: deployId,
    projectId,
    status: "provisioning",
    message: "Deployment started. Poll GET /templates/deployments/:id for status.",
  });
});

// ─── Auth required: Check deployment status ───
router.get("/deployments/:id", requireDashboardAuth, (req: DashboardRequest, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Auth required" });

  const deployment = db.prepare(
    "SELECT * FROM template_deployments WHERE id = ? AND user_id = ?"
  ).get(req.params.id, userId) as any;

  if (!deployment) return res.status(404).json({ error: "Deployment not found" });

  res.json({
    ...deployment,
    provisioning_log: JSON.parse(deployment.provisioning_log || "[]"),
    resources: deployment.resources ? JSON.parse(deployment.resources) : null,
  });
});

// ─── Auth required: My templates ───
router.get("/mine/list", requireDashboardAuth, (req: DashboardRequest, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Auth required" });

  const templates = db.prepare(
    "SELECT id, name, description, deploys, total_price_usdc, margin_usdc, status, created_at FROM templates WHERE author_id = ? AND status != 'removed' ORDER BY created_at DESC"
  ).all(userId);

  res.json({ templates });
});

// ─── Provisioning Engine ───

interface ProvisionLog {
  step: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
  ts: number;
}

async function provisionTemplate(
  deployId: string,
  userId: string,
  projectId: string,
  blueprint: any,
  services: any[],
  walletPassphrase?: string,
): Promise<void> {
  const log: ProvisionLog[] = [];
  const resources: Record<string, any> = {};

  function updateStatus(status: string) {
    db.prepare("UPDATE template_deployments SET status = ?, provisioning_log = ?, resources = ? WHERE id = ?")
      .run(status, JSON.stringify(log), JSON.stringify(resources), deployId);
  }

  function logStep(step: string, status: ProvisionLog["status"], detail?: string) {
    log.push({ step, status, detail, ts: Date.now() });
    updateStatus("provisioning");
  }

  try {
    // Step 1: Provision compute (VPS)
    const computeServices = services.filter((s: any) => s.type === "compute");
    if (computeServices.length > 0) {
      const spec = computeServices[0].spec || "cax11";
      logStep("compute", "running", `Provisioning ${spec} VPS...`);

      // Call our compute API internally
      const resp = await fetch("http://localhost:3001/api/compute/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dashboard-User": userId },
        body: JSON.stringify({
          name: `agent-${deployId.slice(0, 8)}`,
          server_type: spec,
          // SSH key will be generated client-side and provided
          // For now, we provision and the user adds their key
        }),
      });
      const data = await resp.json() as any;
      if (!resp.ok) throw new Error(`Compute provision failed: ${data.error}`);

      resources.compute = { serverId: data.server?.id, ip: data.server?.ip, spec };
      logStep("compute", "done", `VPS ready: ${data.server?.ip}`);
    }

    // Step 2: Create wallets (non-custodial — passphrase plumbed from request body)
    const walletServices = services.filter((s: any) => s.type?.startsWith("wallet"));
    if (walletServices.length > 0) {
      if (!walletPassphrase) {
        logStep("wallet", "error", "walletPassphrase is required");
        throw new Error("walletPassphrase is required to provision template wallets");
      }
      logStep("wallet", "running", "Creating agent wallets...");

      const { createWallet, getAgentConfig } = require("../services/wallet");
      const wallet = await createWallet(userId, walletPassphrase, "Template Wallet", ["solana", "evm"]);
      const agentConfig = getAgentConfig(userId, wallet.id, walletPassphrase);

      resources.wallet = {
        id: wallet.id,
        base: { address: wallet.base.address },
        solana: { address: wallet.solana.address },
        vaultWalletId: wallet.vaultWalletId,
        agentConfig,
      };
      logStep("wallet", "done", "Wallet created (Solana + EVM, non-custodial)");
    }

    // Step 3: Allocate phone number
    const phoneServices = services.filter((s: any) => s.type === "phone");
    if (phoneServices.length > 0) {
      logStep("phone", "running", "Allocating phone number...");

      const phoneResp = await fetch("http://localhost:3001/api/phone/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dashboard-User": userId },
        body: JSON.stringify({ country: "US" }),
      });
      const phoneData = await phoneResp.json() as any;
      if (!phoneResp.ok) throw new Error(`Phone provision failed: ${phoneData.error}`);

      resources.phone = { number: phoneData.phone_number };
      logStep("phone", "done", `Phone: ${phoneData.phone_number}`);
    }

    // Step 4: Create email
    const emailServices = services.filter((s: any) => s.type === "email");
    if (emailServices.length > 0) {
      logStep("email", "running", "Creating email address...");

      const prefix = `agent-${deployId.slice(0, 8)}`;
      const emailResp = await fetch("http://localhost:3001/api/email/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dashboard-User": userId },
        body: JSON.stringify({ name: prefix }),
      });
      const emailData = await emailResp.json() as any;

      resources.email = { address: emailData.email || `${prefix}@palmyr.ai` };
      logStep("email", "done", `Email: ${resources.email.address}`);
    }

    // Step 5: Install OpenClaw on VPS (if compute was provisioned)
    const openclawServices = services.filter((s: any) => s.type === "openclaw");
    if (openclawServices.length > 0 && resources.compute?.ip) {
      logStep("openclaw", "running", "Installing OpenClaw on VPS...");
      // This would SSH into the VPS and run the install script
      // For now, mark as pending manual setup
      resources.openclaw = {
        status: "ready_to_install",
        installCommand: "curl -fsSL https://get.openclaw.ai | bash",
        skills: openclawServices[0].skills || [],
      };
      logStep("openclaw", "done", "OpenClaw install command ready");
    }

    // Mark complete
    updateStatus("completed");
    db.prepare("UPDATE template_deployments SET completed_at = datetime('now') WHERE id = ?").run(deployId);

  } catch (err: any) {
    logStep("error", "error", err.message);
    updateStatus("failed");
    throw err;
  }
}

export default router;
