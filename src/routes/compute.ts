import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { AuthenticatedRequest, ServerAction } from "../types";
import * as computeService from "../services/compute";
import { db } from "../db";
import { trackHackathonUsage } from "../middleware/hackathon";

const router = Router();

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
    const pw = row.root_password;
    const { execSync } = require("child_process");
    const sshCmd = `sshpass -p '${pw.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 root@${ip}`;

    // 1. Inject public key
    const escapedKey = publicKey.replace(/'/g, "'\\''");
    execSync(`${sshCmd} "mkdir -p ~/.ssh && echo '${escapedKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"`, { timeout: 20000 });

    // 2. Disable password auth completely
    execSync(`${sshCmd} "sed -i 's/#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && sed -i 's/#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && sed -i 's/#\\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config && systemctl restart sshd"`, { timeout: 20000 });

    // 3. Delete root password from server (lock the account)
    execSync(`${sshCmd} "passwd -l root"`, { timeout: 10000 });

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
    const pw = row.root_password;

    // Try SSH with root password (sshpass) — 10s timeout
    let result: any = { ip, reachable: false, openclaw_installed: false, openclaw_version: null, hardened: false, provision_log: null };

    try {
      const sshCmd = pw
        ? `sshpass -p '${pw.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@${ip}`
        : `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@${ip}`;

      // Check reachability + OpenClaw version
      const versionOut = execSync(`${sshCmd} "openclaw --version 2>/dev/null || echo NOT_INSTALLED"`, { timeout: 15000, encoding: "utf-8" }).trim();
      result.reachable = true;

      if (versionOut && !versionOut.includes("NOT_INSTALLED")) {
        result.openclaw_installed = true;
        result.openclaw_version = versionOut;
      }

      // Check provision metadata
      try {
        const provisionJson = execSync(`${sshCmd} "cat /etc/openclaw/provision.json 2>/dev/null || echo {}"`, { timeout: 10000, encoding: "utf-8" }).trim();
        result.provision_log = JSON.parse(provisionJson);
        result.hardened = result.provision_log?.hardened || false;
      } catch (e) {}

      // Check firewall
      try {
        const ufwStatus = execSync(`${sshCmd} "ufw status 2>/dev/null | head -1 || echo inactive"`, { timeout: 10000, encoding: "utf-8" }).trim();
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
      model,
      channel,       // 'telegram' | 'discord' | 'none'
      botToken,      // telegram bot token or discord token
      allowFrom,     // array of allowed user IDs
      gatewayPort,
      agentName,
    } = req.body;

    if (!anthropicKey) return res.status(400).json({ error: "anthropicKey is required" });

    const row = db.prepare("SELECT ipv4, root_password FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const ip = row.ipv4;
    const pw = row.root_password;
    if (!pw) return res.status(400).json({ error: "Cannot configure — root password deleted. Use SSH key access." });

    const { execSync } = require("child_process");
    const sshCmd = `sshpass -p '${pw.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 root@${ip}`;

    // Build OpenClaw config
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "token"
          }
        }
      },
      agents: {
        defaults: {
          workspace: "/root/.openclaw/workspace",
          compaction: { mode: "safeguard" },
          maxConcurrent: 4,
          subagents: { maxConcurrent: 8, model: model || "anthropic/claude-sonnet-4-20250514" }
        }
      },
      commands: { native: "auto", nativeSkills: "auto", restart: true },
      gateway: {
        port: gatewayPort || 18789,
        mode: "local",
        bind: "loopback",
        auth: { mode: "token" }
      },
      plugins: { entries: {} },
      channels: {}
    };

    // Channel config
    if (channel === "telegram" && botToken) {
      config.channels.telegram = {
        enabled: true,
        dmPolicy: allowFrom?.length ? "allowlist" : "open",
        botToken: botToken,
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

    const configJson = JSON.stringify(config, null, 2);

    // 1. Create .openclaw directory
    execSync(`${sshCmd} "mkdir -p /root/.openclaw/workspace"`, { timeout: 10000 });

    // 2. Write config
    const escapedConfig = configJson.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/\$/g, '\\$');
    execSync(`${sshCmd} "cat > /root/.openclaw/openclaw.json << 'OCEOF'\n${configJson}\nOCEOF"`, { timeout: 10000 });

    // 3. Write Anthropic API key to environment
    const escapedKey = anthropicKey.replace(/'/g, "'\\''");
    execSync(`${sshCmd} "echo 'export ANTHROPIC_API_KEY=${escapedKey}' >> /root/.bashrc && echo 'ANTHROPIC_API_KEY=${escapedKey}' >> /etc/environment"`, { timeout: 10000 });

    // 4. Create workspace files if agent name provided
    if (agentName) {
      const identityMd = `# IDENTITY.md\\n\\n- **Name:** ${agentName}\\n- **Born:** ${new Date().toISOString().split('T')[0]}\\n`;
      execSync(`${sshCmd} "echo -e '${identityMd}' > /root/.openclaw/workspace/IDENTITY.md"`, { timeout: 10000 });
    }

    // 5. Create systemd service for OpenClaw
    const serviceFile = `[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=root
Environment=ANTHROPIC_API_KEY=${anthropicKey}
ExecStart=/usr/bin/openclaw gateway start --allow-unconfigured
WorkingDirectory=/root
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target`;

    const escapedService = serviceFile.replace(/'/g, "'\\''");
    execSync(`${sshCmd} "cat > /etc/systemd/system/openclaw.service << 'SVCEOF'\n${serviceFile}\nSVCEOF"`, { timeout: 10000 });
    execSync(`${sshCmd} "systemctl daemon-reload && systemctl enable openclaw && systemctl start openclaw"`, { timeout: 20000 });

    // 6. Verify it started
    let running = false;
    try {
      const status = execSync(`${sshCmd} "systemctl is-active openclaw 2>/dev/null || echo inactive"`, { timeout: 10000, encoding: "utf-8" }).trim();
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
