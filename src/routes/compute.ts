import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { AuthenticatedRequest, ServerAction } from "../types";
import * as computeService from "../services/compute";
import { db } from "../db";
import { trackHackathonUsage } from "../middleware/hackathon";

const router = Router();

const PLATFORM_KEY = '/root/.ssh/id_ed25519_platform';

/** Build SSH command — prefer platform key, fallback to password */
function sshCmd(ip: string, pw?: string | null): string {
  // Always try platform key first (injected by cloud-init)
  return `ssh -i ${PLATFORM_KEY} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o PasswordAuthentication=no root@${ip}`;
}

// ── Plans (free, no auth) ─────────────────────────────────────

/**
 * GET /compute/plans — List available server types with specs and pricing
 * Free — no auth required
 */
router.get("/plans", (_req, res: Response) => {
  const plans = computeService.getPlans();
  res.json({
    plans,
    currency: "USDC",
    billingPeriod: "monthly",
    note: "Pay via x402 protocol (Solana or Base USDC). Price includes setup.",
  });
});

// ── SSH Keys ──────────────────────────────────────────────────

/**
 * POST /compute/ssh-keys — Upload an SSH public key
 * Cost: 0.10 USDC
 */
router.post("/ssh-keys", rateLimit(10, 60_000), requireAuth(0.10, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, publicKey } = req.body as { name: string; publicKey: string };

    if (!name || !publicKey) {
      res.status(400).json({
        error: "Missing Required Fields",
        message: "Both 'name' and 'publicKey' are required",
        hint: "Include 'name' (key label) and 'publicKey' (your SSH public key, e.g. ssh-ed25519 AAAA...)"
      });
      return;
    }

    if (!publicKey.startsWith("ssh-") && !publicKey.startsWith("ecdsa-")) {
      res.status(400).json({
        error: "Invalid SSH Key",
        message: "publicKey must be a valid SSH public key",
        hint: "Format: ssh-ed25519 AAAA... or ssh-rsa AAAA..."
      });
      return;
    }

    const id = await computeService.uploadSshKey(name, publicKey);
    res.status(201).json({ id, name, message: "SSH key uploaded. Use this ID when creating servers." });
  } catch (err: any) {
    res.status(500).json({
      error: "SSH Key Upload Failed",
      message: err.message || "Failed to upload SSH key",
    });
  }
});

/**
 * GET /compute/ssh-keys — List SSH keys
 * Cost: 0.01 USDC
 */
router.get("/ssh-keys", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const keys = await computeService.listSshKeys();
    res.json({ sshKeys: keys.map((k: any) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint })) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list SSH keys", message: err.message });
  }
});

/**
 * DELETE /compute/ssh-keys/:id — Delete an SSH key
 * Cost: 0.01 USDC
 */
router.delete("/ssh-keys/:id", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await computeService.deleteSshKey(Number(String(req.params.id)));
    res.json({ deleted: true, id: String(req.params.id) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete SSH key", message: err.message });
  }
});

// ── Servers ───────────────────────────────────────────────────

/**
 * POST /compute/servers — Create a server
 * Cost: varies by plan (6-50 USDC)
 */
router.post("/servers", rateLimit(5, 60_000), requireAuth(6.0, 'server'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, serverType, image, sshKeyIds, location, installOpenClaw } = req.body as {
      name: string;
      serverType: string;
      image?: string;
      sshKeyIds?: number[];
      location?: string;
      installOpenClaw?: boolean;
    };

    if (!name || !serverType) {
      res.status(400).json({
        error: "Missing Required Fields",
        message: "Both 'name' and 'serverType' are required",
        hint: "GET /compute/plans for available types. Include sshKeyIds from POST /compute/ssh-keys."
      });
      return;
    }

    const owner = req.agentId || req.payment?.payer || "unknown";

    const server = await computeService.createServer(
      name,
      serverType as any,
      image ?? "ubuntu-24.04",
      owner,
      sshKeyIds,
      installOpenClaw
    );

    if (req.isHackathonMode && req.agentId) {
      trackHackathonUsage(req.agentId, 'server', server.id);
    }

    res.status(201).json({
      ...server,
      message: "Server created. SSH in with: ssh root@" + (server.ipv4 || "<ip>"),
      note: server.rootPassword
        ? "Root password provided below. Save it — we don't store it."
        : "Use your SSH key to connect.",
    });
  } catch (err: any) {
    console.error("[compute] Create error:", err);
    res.status(500).json({
      error: "Server Creation Failed",
      message: err.message || "Failed to create server",
      hint: "GET /compute/plans for valid server types"
    });
  }
});

/**
 * GET /compute/servers — List your servers
 * Cost: 0.01 USDC
 */
router.get("/servers", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = req.agentId || req.payment?.payer || "unknown";
    const servers = await computeService.listServers(owner);
    res.json({ servers, count: servers.length });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list servers", message: err.message });
  }
});

/**
 * GET /compute/servers/:id — Get server details + live status
 * Cost: 0.01 USDC
 */
router.get("/servers/:id", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await computeService.getServer(String(req.params.id));
    res.json(server);
  } catch (err: any) {
    res.status(404).json({ error: "Server Not Found", message: err.message });
  }
});

/**
 * POST /compute/servers/:id/actions — Perform server action (reboot, poweron, poweroff, rebuild, reset)
 * Cost: 0.05 USDC
 */
router.post("/servers/:id/actions", requireAuth(0.05, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, image } = req.body as { action: string; image?: string };
    const validActions: ServerAction[] = ["reboot", "poweron", "poweroff", "rebuild", "reset"];

    if (!action || !validActions.includes(action as ServerAction)) {
      res.status(400).json({
        error: "Invalid Action",
        message: `Action must be one of: ${validActions.join(", ")}`,
        hint: "reboot = graceful restart, reset = hard restart, rebuild = reinstall OS (data lost!)"
      });
      return;
    }

    const result = await computeService.serverAction(String(req.params.id), action as ServerAction, image);
    res.json({
      action: action,
      serverId: String(req.params.id),
      status: result?.status || "running",
      message: action === "rebuild"
        ? "Server is being rebuilt. All data will be lost."
        : `Server ${action} initiated.`,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Action Failed", message: err.message });
  }
});

/**
 * POST /compute/servers/:id/setup-ssh — Inject user's public key, disable password auth, delete root password from DB
 * This is the "zero access" handoff: after this, only the user can SSH in.
 */
router.post("/servers/:id/setup-ssh", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { publicKey } = req.body as { publicKey: string };

    if (!publicKey || !publicKey.startsWith("ssh-")) {
      return res.status(400).json({ error: "Invalid SSH public key", hint: "Must start with ssh-ed25519 or ssh-rsa" });
    }

    const row = db.prepare("SELECT ipv4, root_password FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });
    if (!row.root_password) return res.status(400).json({ error: "SSH already configured — root password was already deleted" });

    const ip = row.ipv4;
    const { execSync } = require("child_process");
    const ssh = sshCmd(ip);

    // 1. Inject user's public key
    const escapedKey = publicKey.replace(/'/g, "'\\''");
    execSync(`${ssh} "mkdir -p ~/.ssh && echo '${escapedKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"`, { timeout: 20000 });

    // 2. Remove platform temp key from authorized_keys
    execSync(`${ssh} "sed -i '/agentos-platform-temp/d' ~/.ssh/authorized_keys"`, { timeout: 10000 });

    // 3. Lock root password
    execSync(`${ssh} "passwd -l root"`, { timeout: 10000 });

    // 4. Delete root password from our database — we can never access again
    db.prepare("UPDATE servers SET root_password = NULL WHERE id = ?").run(serverId);

    res.json({
      success: true,
      message: "SSH key injected, password auth disabled, root password deleted from platform. Only your key can access this server now.",
      ip,
      ssh: `ssh -i <your-key> root@${ip}`,
    });
  } catch (err: any) {
    console.error("[compute] SSH setup error:", err);
    res.status(500).json({ error: "SSH setup failed", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * GET /compute/servers/:id/verify — Verify OpenClaw installation on server
 */
router.get("/servers/:id/verify", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const row = db.prepare("SELECT ipv4, root_password FROM servers WHERE id = ?").get(serverId) as any;
    if (!row || !row.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ip = row.ipv4;

    // Try SSH with platform key
    let result: any = { ip, reachable: false, openclaw_installed: false, openclaw_version: null, hardened: false, provision_log: null };

    try {
      const ssh = sshCmd(ip);

      // Check reachability + OpenClaw version
      const versionOut = execSync(`${ssh} "openclaw --version 2>/dev/null || echo NOT_INSTALLED"`, { timeout: 15000, encoding: "utf-8" }).trim();
      result.reachable = true;

      if (versionOut && !versionOut.includes("NOT_INSTALLED")) {
        result.openclaw_installed = true;
        result.openclaw_version = versionOut;
      }

      // Check provision metadata
      try {
        const provisionJson = execSync(`${ssh} "cat /etc/openclaw/provision.json 2>/dev/null || echo {}"`, { timeout: 10000, encoding: "utf-8" }).trim();
        result.provision_log = JSON.parse(provisionJson);
        result.hardened = result.provision_log?.hardened || false;
      } catch (e) {}

      // Check firewall
      try {
        const ufwStatus = execSync(`${ssh} "ufw status 2>/dev/null | head -1 || echo inactive"`, { timeout: 10000, encoding: "utf-8" }).trim();
        result.firewall = ufwStatus.includes("active") ? "active" : "inactive";
      } catch (e) { result.firewall = "unknown"; }

    } catch (e: any) {
      if (e.message?.includes("timed out") || e.message?.includes("Connection refused")) {
        result.reachable = false;
      } else {
        result.error = e.message?.split("\n")[0] || "SSH failed";
      }
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: "Verification failed", message: err.message });
  }
});

/**
 * POST /compute/servers/:id/configure-openclaw — Configure OpenClaw on the VPS
 * Writes openclaw.json config and sets up the Anthropic API key
 */
router.post("/servers/:id/configure-openclaw", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const {
      anthropicKey,
      authMode,      // 'token' | 'setup-token'
      provider,      // 'anthropic' | 'openrouter' | 'openai'
      model,
      channel,       // 'telegram' | 'discord' | 'none'
      botToken,      // telegram bot token or discord token
      allowFrom,     // array of allowed user IDs
      gatewayPort,
      agentName,
    } = req.body;

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const ip = row.ipv4;
    const { execSync } = require("child_process");
    const ssh = sshCmd(ip);

    // 1. Ensure directory exists
    execSync(`${ssh} "mkdir -p /root/.openclaw/workspace"`, { timeout: 10000 });

    // 2. Read existing config (or start fresh)
    let config: any = {};
    try {
      const existing = execSync(`${ssh} "cat /root/.openclaw/openclaw.json 2>/dev/null || echo '{}'"`, { timeout: 10000, encoding: "utf-8" }).trim();
      config = JSON.parse(existing);
    } catch (e) { config = {}; }

    // Ensure base structure
    if (!config.auth) config.auth = { profiles: {} };
    if (!config.agents) config.agents = { defaults: { workspace: "/root/.openclaw/workspace", compaction: { mode: "safeguard" }, maxConcurrent: 4, subagents: { maxConcurrent: 8 } } };
    if (!config.commands) config.commands = { native: "auto", nativeSkills: "auto", restart: true };
    if (!config.gateway) config.gateway = { port: gatewayPort || 18789, mode: "local", bind: "loopback", auth: { mode: "token" } };
    if (!config.plugins) config.plugins = { entries: {} };
    if (!config.channels) config.channels = {};

    // 3. Apply model config if provided
    let envVar = '';
    let envValue = '';
    if (anthropicKey) {
      const effectiveProvider = provider || "anthropic";
      const effectiveAuthMode = authMode || "token";
      const profileKey = effectiveProvider + ":default";
      config.auth.profiles[profileKey] = { provider: effectiveProvider, mode: effectiveAuthMode };

      if (model) {
        config.agents.defaults.subagents = { ...(config.agents.defaults.subagents || {}), model };
      }

      const escapedKey = anthropicKey.replace(/'/g, "'\\''");
      if (effectiveAuthMode === 'setup-token') {
        execSync(`${ssh} "echo '${escapedKey}' | openclaw models auth paste-token --provider ${effectiveProvider} 2>/dev/null || true"`, { timeout: 30000 });
      } else {
        const envVarMap: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
        envVar = envVarMap[effectiveProvider] || 'ANTHROPIC_API_KEY';
        envValue = anthropicKey;
        // Idempotent: remove old line, add new
        execSync(`${ssh} "grep -v '${envVar}' /etc/environment > /tmp/env.tmp 2>/dev/null; echo '${envVar}=${escapedKey}' >> /tmp/env.tmp; mv /tmp/env.tmp /etc/environment"`, { timeout: 10000 });
      }
    }

    // 4. Apply channel config if provided
    if (channel === "telegram" && botToken) {
      config.channels.telegram = {
        enabled: true,
        dmPolicy: allowFrom?.length ? "allowlist" : "open",
        botToken,
        allowFrom: allowFrom || ["*"],
        groupPolicy: "allowlist",
        streaming: "partial"
      };
      config.plugins.entries.telegram = { enabled: true };
    } else if (channel === "discord" && botToken) {
      config.channels.discord = {
        enabled: true,
        token: botToken,
        dmPolicy: "open",
        allowFrom: allowFrom || ["*"],
        groupPolicy: "allowlist",
        streaming: "off"
      };
      config.plugins.entries.discord = { enabled: true };
    }

    // 5. Write merged config
    const configJson = JSON.stringify(config, null, 2);
    const configB64 = Buffer.from(configJson).toString('base64');
    execSync(`${ssh} "echo '${configB64}' | base64 -d > /root/.openclaw/openclaw.json"`, { timeout: 10000 });

    // 6. Create workspace files if agent name provided
    if (agentName) {
      const identityMd = `# IDENTITY.md\\n\\n- **Name:** ${agentName}\\n- **Born:** ${new Date().toISOString().split('T')[0]}\\n`;
      execSync(`${ssh} "echo -e '${identityMd}' > /root/.openclaw/workspace/IDENTITY.md"`, { timeout: 10000 });
    }

    // 7. Create/update systemd service + restart
    const envLine = envVar && envValue ? `Environment=${envVar}=${envValue}` : '';
    const serviceFile = `[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=root
${envLine}
ExecStart=/usr/bin/env openclaw gateway run --allow-unconfigured
WorkingDirectory=/root
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target`;

    const svcB64 = Buffer.from(serviceFile).toString('base64');
    execSync(`${ssh} "echo '${svcB64}' | base64 -d > /etc/systemd/system/openclaw.service"`, { timeout: 10000 });
    execSync(`${ssh} "systemctl daemon-reload && systemctl enable openclaw && systemctl restart openclaw"`, { timeout: 20000 });

    // 6. Verify it started
    let running = false;
    try {
      const status = execSync(`${ssh} "systemctl is-active openclaw 2>/dev/null || echo inactive"`, { timeout: 10000, encoding: "utf-8" }).trim();
      running = status === "active";
    } catch (e) {}

    // Update server record with openclaw configured flag
    db.prepare("UPDATE servers SET openclaw_configured = 1 WHERE id = ?").run(serverId);

    res.json({
      success: true,
      running,
      message: running
        ? "OpenClaw configured and running!"
        : "OpenClaw configured but may still be starting. Check with: systemctl status openclaw",
      config: {
        model: model || "anthropic/claude-sonnet-4-20250514",
        channel: channel || "none",
        gateway_port: gatewayPort || 18789,
      }
    });
  } catch (err: any) {
    console.error("[compute] OpenClaw config error:", err);
    res.status(500).json({ error: "Configuration failed", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/remove-openclaw-config — Remove channel or model config
 */
router.post("/servers/:id/remove-openclaw-config", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { remove } = req.body; // 'channel' or 'model'

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4);

    // Read existing config
    let config: any = {};
    try {
      const existing = execSync(`${ssh} "cat /root/.openclaw/openclaw.json 2>/dev/null || echo '{}'"`, { timeout: 10000, encoding: "utf-8" }).trim();
      config = JSON.parse(existing);
    } catch (e) { config = {}; }

    if (remove === 'channel') {
      // Remove all channel configs
      delete config.channels;
      config.channels = {};
      if (config.plugins?.entries) {
        delete config.plugins.entries.telegram;
        delete config.plugins.entries.discord;
      }
    } else if (remove === 'model') {
      // Remove auth profiles and env vars
      if (config.auth) config.auth.profiles = {};
      // Clear env var on server
      try {
        execSync(`${ssh} "grep -v '_API_KEY' /etc/environment > /tmp/env.tmp 2>/dev/null; mv /tmp/env.tmp /etc/environment"`, { timeout: 10000 });
      } catch (e) {}
    }

    // Write updated config
    const configJson = JSON.stringify(config, null, 2);
    const configB64 = Buffer.from(configJson).toString('base64');
    execSync(`${ssh} "echo '${configB64}' | base64 -d > /root/.openclaw/openclaw.json"`, { timeout: 10000 });

    // Restart OpenClaw
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, removed: remove });
  } catch (err: any) {
    console.error("[compute] Remove config error:", err);
    res.status(500).json({ error: "Failed to remove config", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/install-skill — Install a skill on the VPS
 */
router.post("/servers/:id/install-skill", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { skillName, skillUrl } = req.body; // skillUrl = clawhub URL or git repo

    if (!skillName) return res.status(400).json({ error: "skillName is required" });

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4);

    // Create skills directory
    execSync(`${ssh} "mkdir -p /root/.openclaw/workspace/skills"`, { timeout: 10000 });

    // Install skill via git clone or copy from clawhub
    const gitUrl = skillUrl || `https://github.com/openclaw/skills.git`;
    const skillDir = `/root/.openclaw/workspace/skills/${skillName}`;

    // Try clawhub first (openclaw install), fallback to direct copy from our VPS
    try {
      // Check if skill exists locally on our server, copy it
      const { existsSync } = require("fs");
      const localSkillPath = `/root/.openclaw/workspace/skills/${skillName}`;
      const builtinSkillPath = `/usr/lib/node_modules/openclaw/skills/${skillName}`;
      const sourcePath = existsSync(localSkillPath) ? localSkillPath : existsSync(builtinSkillPath) ? builtinSkillPath : null;
      if (sourcePath) {
        // Tar + pipe to remote
        const parentDir = require("path").dirname(sourcePath);
        execSync(`tar -C ${parentDir} -cf - ${skillName} | ${ssh} "tar -C /root/.openclaw/workspace/skills -xf -"`, { timeout: 30000 });
      } else if (skillUrl) {
        // Git clone
        execSync(`${ssh} "git clone --depth 1 ${skillUrl} ${skillDir} 2>/dev/null || echo 'clone failed'"`, { timeout: 30000 });
      } else {
        return res.status(400).json({ error: `Skill '${skillName}' not found locally and no URL provided` });
      }
    } catch (e: any) {
      return res.status(500).json({ error: "Failed to install skill", message: e.message?.split("\n")[0] });
    }

    // Verify it installed
    let installed = false;
    try {
      const check = execSync(`${ssh} "test -f ${skillDir}/SKILL.md && echo yes || echo no"`, { timeout: 10000, encoding: "utf-8" }).trim();
      installed = check === "yes";
    } catch (e) {}

    // Restart OpenClaw to pick up the new skill
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, skill: skillName, installed, message: installed ? `Skill '${skillName}' installed and OpenClaw restarted` : `Skill directory created but SKILL.md not found` });
  } catch (err: any) {
    console.error("[compute] Skill install error:", err);
    res.status(500).json({ error: "Failed to install skill", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/install-skills-bulk — Install multiple skills at once
 */
router.post("/servers/:id/install-skills-bulk", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { skills } = req.body as { skills: string[] };

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const { existsSync, readdirSync } = require("fs");
    const path = require("path");
    const ssh = sshCmd(row.ipv4);

    // Create skills directory
    execSync(`${ssh} "mkdir -p /root/.openclaw/workspace/skills"`, { timeout: 10000 });

    // If __ALL__, discover all available skills
    let skillList = skills || [];
    if (skillList.includes('__ALL__')) {
      const wsDir = '/root/.openclaw/workspace/skills';
      const builtinDir = '/usr/lib/node_modules/openclaw/skills';
      const allSkills = new Set<string>();
      try { readdirSync(wsDir).forEach((s: string) => allSkills.add(s)); } catch (e) {}
      try { readdirSync(builtinDir).forEach((s: string) => allSkills.add(s)); } catch (e) {}
      skillList = [...allSkills];
    }

    if (!skillList.length) return res.status(400).json({ error: "No skills found" });

    let installed = 0, failed = 0;
    const results: any[] = [];

    // Collect all skills that exist locally, tar them together for one transfer
    const localSkills: { name: string; dir: string }[] = [];
    const notFound: string[] = [];

    for (const skillName of skillList) {
      const wsPath = `/root/.openclaw/workspace/skills/${skillName}`;
      const builtinPath = `/usr/lib/node_modules/openclaw/skills/${skillName}`;
      if (existsSync(wsPath)) {
        localSkills.push({ name: skillName, dir: path.dirname(wsPath) });
      } else if (existsSync(builtinPath)) {
        localSkills.push({ name: skillName, dir: path.dirname(builtinPath) });
      } else {
        notFound.push(skillName);
        failed++;
      }
    }

    // Group by parent directory for efficient tar
    const byDir = new Map<string, string[]>();
    for (const s of localSkills) {
      const arr = byDir.get(s.dir) || [];
      arr.push(s.name);
      byDir.set(s.dir, arr);
    }

    for (const [dir, names] of byDir) {
      try {
        const tarList = names.join(' ');
        execSync(`tar -C ${dir} -cf - ${tarList} | ${ssh} "tar -C /root/.openclaw/workspace/skills -xf -"`, { timeout: 60000 });
        installed += names.length;
        names.forEach(n => results.push({ skill: n, status: 'installed' }));
      } catch (e: any) {
        failed += names.length;
        names.forEach(n => results.push({ skill: n, status: 'failed', error: e.message?.split("\n")[0] }));
      }
    }

    notFound.forEach(n => results.push({ skill: n, status: 'not_found' }));

    // Restart OpenClaw once after all installs
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, installed, failed, total: skillList.length, results });
  } catch (err: any) {
    console.error("[compute] Bulk skill install error:", err);
    res.status(500).json({ error: "Bulk install failed", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/remove-skill — Remove a skill from the VPS
 */
router.post("/servers/:id/remove-skill", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { skillName } = req.body;
    if (!skillName) return res.status(400).json({ error: "skillName is required" });

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4);

    execSync(`${ssh} "rm -rf /root/.openclaw/workspace/skills/${skillName}"`, { timeout: 10000 });
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, skill: skillName, message: `Skill '${skillName}' removed` });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to remove skill", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/remove-all-skills — Remove all skills from the VPS
 */
router.post("/servers/:id/remove-all-skills", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4);

    execSync(`${ssh} "rm -rf /root/.openclaw/workspace/skills/*"`, { timeout: 15000 });
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, message: "All skills removed from VPS" });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to remove skills", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/resize — Resize server (change plan)
 * Cost: 0.10 USDC (+ price difference on next billing)
 */
router.post("/servers/:id/resize", requireAuth(0.10, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { serverType, upgradeDisk } = req.body as { serverType: string; upgradeDisk?: boolean };

    if (!serverType) {
      res.status(400).json({
        error: "Missing serverType",
        message: "Specify the target server type",
        hint: "GET /compute/plans for available types. Server must be powered off to resize."
      });
      return;
    }

    const result = await computeService.resizeServer(String(req.params.id), serverType as any, upgradeDisk ?? false);
    res.json({
      action: "resize",
      serverId: String(req.params.id),
      newType: serverType,
      status: result?.status || "running",
      message: "Server resize initiated. Server must be off first.",
    });
  } catch (err: any) {
    res.status(500).json({ error: "Resize Failed", message: err.message });
  }
});

/**
 * DELETE /compute/servers/:id — Destroy server permanently
 * Cost: 0.05 USDC
 */
router.delete("/servers/:id", requireAuth(0.05, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await computeService.deleteServer(String(req.params.id));
    res.json({ deleted: true, id: String(req.params.id), message: "Server permanently destroyed." });
  } catch (err: any) {
    res.status(404).json({ error: "Deletion Failed", message: err.message });
  }
});

export default router;
