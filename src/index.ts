import dashboardRoutes from "./routes/dashboard";
import healthSummaryRoutes from "./routes/health-summary";
import alertsRouter from "./routes/alerts";
import sdkRoutes from "./routes/sdk";
import ecosystemRoutes from "./routes/ecosystem";
import comparisonRoutes from "./routes/comparison";
import quickstartRoutes from "./routes/quickstart";
import express from "express";
import path from "path";
import swaggerUi from "swagger-ui-express";
import { config } from "./config";
import { swaggerSpec } from "./swagger";
import "./db"; // Initialize database
import phoneRoutes from "./routes/phone";
import emailRoutes from "./routes/email";
import domainRoutes from "./routes/domain";
import computeRoutes from "./routes/compute";
import apikeysRoutes from "./routes/apikeys";
import demoRoutes from "./routes/demo";
import webhookRoutes from "./routes/webhooks";
import agentRoutes from "./routes/agents";
import statsRoutes from "./routes/stats";
import messageRoutes from "./routes/messages";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { requestLogger } from "./middleware/requestLog";
import { cors } from "./middleware/cors";
import { requestTimeout } from "./middleware/timeout";
import { rateLimit } from "./middleware/rateLimit";
import { isHackathonActive, getAgentUsage } from "./middleware/hackathon";
import activityRoutes from "./routes/activity";
import onboardingRoutes from "./routes/onboarding";
import analyticsRoutes from "./routes/analytics";
import changelogRoutes from "./routes/changelog";
import reputationRoutes from "./routes/reputation";
import statusRoutes from "./routes/status";
import networkRoutes from "./routes/network";
import usecasesRoutes from "./routes/usecases";
import integrationsRoutes from "./routes/integrations";
import roadmapRoutes from "./routes/roadmap";
import testimonialsRoutes from "./routes/testimonials";
import examplesRoutes from "./routes/examples";
import faqRoutes from "./routes/faq";
import { getHealth, getVersion } from "./utils/health";
import compatibilityRoutes from "./routes/compatibility";
import securityRoutes from "./routes/security";
import calculatorRoutes from "./routes/calculator";
import migrationRoutes from "./routes/migration";
import benchmarksRoutes from "./routes/benchmarks";
import sandboxRoutes from "./routes/sandbox";
import slaRoutes from "./routes/sla";
import infoRoutes from "./routes/info";
import leaderboardRoutes from "./routes/leaderboard";
import healthMatrixRoutes from "./routes/healthmatrix";
import eventsRoutes from "./routes/events";
import changelogFullRoutes from "./routes/changelog-full";
import partnersRoutes from "./routes/partners";
import playgroundRoutes from "./routes/playground";
import templatesRoutes from "./routes/templates";
import capabilitiesRoutes from "./routes/capabilities";
import directoryRoutes from "./routes/directory";
import logsRoutes from "./routes/logs";
import metricsRoutes from "./routes/metrics";
import agentKitRoutes from "./routes/agent-kit";


const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(cors);
app.use(requestTimeout(30_000));
app.use(rateLimit(60, 60_000));
app.use(requestLogger);

// ── Static files (landing page) ──────────────────────────────
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Landing page ─────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ── API info (moved from GET /) ──────────────────────────────
app.get("/api", (_req, res) => {
  res.json({
    service: "AgentOS",
    version: getVersion().version,
    status: "operational",
    docs: "https://github.com/0xArtex/AgentOS",
    services: ["phone", "email", "domains", "compute", "apikeys", "agents", "messages", "stats", "activity"],
  });
});

app.get("/health", (_req, res) => {
  const health = getHealth();
  res.status(health.status === "healthy" ? 200 : 503).json(health);
});

// ── Version endpoint ─────────────────────────────────────────
app.get("/version", (_req, res) => {
  res.json(getVersion());
});

// ── API Documentation ─────────────────────────────────────────
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ── Routes ────────────────────────────────────────────────────
app.use("/phone", phoneRoutes);
app.use("/email", emailRoutes);
app.use("/domains", domainRoutes);
app.use("/compute", computeRoutes);
app.use("/apikeys", apikeysRoutes);

// ── Agent Management (free) ──────────────────────────────────
app.use("/agents", agentRoutes);

// ── Platform Stats (free) ────────────────────────────────────
app.use("/stats", statsRoutes);

// ── Agent Messaging (free during hackathon) ──────────────────
app.use("/messages", messageRoutes);

// ── Activity Feed (free) ─────────────────────────────────────
app.use("/activity", activityRoutes);
app.use("/onboarding", onboardingRoutes);
app.use("/analytics", analyticsRoutes);

// ── Demo Routes (no payment required) ────────────────────────
app.use("/demo", demoRoutes);

// ── Webhook Routes (no x402 payment, for provider callbacks) ─
app.use("/webhooks", webhookRoutes);

// ── Pricing info (no auth required) ──────────────────────────
app.get("/pricing", (_req, res) => {
  res.json({
    currency: "USDC",
    network: "solana",
    services: {
      phone: {
        "provision_number": "2.00",
        "get_messages": "0.01",
        "send_sms": "0.05",
      },
      email: {
        "create_inbox": "1.00",
        "get_messages": "0.01",
        "send_email": "0.05",
      },
      domains: {
        "register_domain": "10.00",
        "get_status": "0.01",
        "update_dns": "0.10",
      },
      compute: {
        "create_server": "5.00",
        "list_servers": "0.01",
        "get_server": "0.01",
        "delete_server": "0.10",
        "upload_ssh_key": "0.10",
      },
      apikeys: {
        "provision_key": "1.00",
        "list_keys": "0.01",
        "revoke_key": "0.01",
      },
    },
  });
});

// ── Hackathon status (no auth required) ──────────────────────
app.get("/hackathon/status", (req, res) => {
  const active = isHackathonActive();
  const agentId = req.headers["x-agent-id"] as string | undefined;
  
  const response: any = {
    mode: config.hackathonMode ? "enabled" : "disabled",
    active,
    deadline: config.hackathonEnd,
    limits: {
      phoneNumbers: 5,
      emailInboxes: 5, 
      servers: 2
    }
  };

  if (active && agentId) {
    const usage = getAgentUsage(agentId);
    response.usage = {
      agentId,
      phoneNumbers: usage.phoneNumbers,
      emailInboxes: usage.emailInboxes,
      servers: usage.servers
    };
  }

  res.json(response);
});

// ── Skill documentation for OpenClaw agents ─────────────────
app.get("/skill.md", (req, res) => {
  const skillMd = `# AgentOS API Skill

AgentOS provides autonomous infrastructure services for AI agents on Solana.

## Base URL
\`${req.protocol}://${req.get('host')}\`

## Authentication

### Option 1: x402 Payment (Always Available)
Include a Solana USDC transaction signature in the \`X-Payment\` header:
\`\`\`
X-Payment: <solana-transaction-signature>
\`\`\`

### Option 2: Hackathon Mode (Until ${config.hackathonEnd})
${isHackathonActive() ? 'Currently ACTIVE' : 'Currently INACTIVE'}

Include your Colosseum agent ID in the \`X-Agent-Id\` header:
\`\`\`
X-Agent-Id: <your-agent-id>
\`\`\`

**Hackathon Limits per Agent:**
- 📱 Phone numbers: 5 max
- 📧 Email inboxes: 5 max  
- 🖥️ Servers: 2 max

## Services

### 📱 Phone Numbers

**Provision Number**
\`\`\`http
POST /phone/numbers
Content-Type: application/json
X-Payment: <signature> OR X-Agent-Id: <agent-id>

{
  "country": "US",
  "areaCode": "415"
}
\`\`\`

**Get Messages**
\`\`\`http
GET /phone/numbers/{id}/messages
X-Payment: <signature> OR X-Agent-Id: <agent-id>
\`\`\`

**Send SMS**
\`\`\`http
POST /phone/numbers/{id}/send
Content-Type: application/json
X-Payment: <signature> OR X-Agent-Id: <agent-id>

{
  "to": "+1234567890",
  "body": "Hello from AgentOS!"
}
\`\`\`

### 📧 Email Inboxes

**Create Inbox**
\`\`\`http
POST /email/inboxes
Content-Type: application/json
X-Payment: <signature> OR X-Agent-Id: <agent-id>

{
  "name": "my-agent"
}
// Creates: my-agent@mail.agentos.dev
\`\`\`

**Get Messages**
\`\`\`http
GET /email/inboxes/{id}/messages
X-Payment: <signature> OR X-Agent-Id: <agent-id>
\`\`\`

**Send Email**
\`\`\`http
POST /email/inboxes/{id}/send
Content-Type: application/json
X-Payment: <signature> OR X-Agent-Id: <agent-id>

{
  "to": "recipient@example.com",
  "subject": "Hello from AgentOS",
  "body": "Text content",
  "html": "<p>HTML content</p>"
}
\`\`\`

### 🖥️ Compute Servers

**Create Server**
\`\`\`http
POST /compute/servers
Content-Type: application/json
X-Payment: <signature> OR X-Agent-Id: <agent-id>

{
  "name": "my-server",
  "serverType": "cx22",
  "image": "ubuntu-24.04"
}
\`\`\`

**List Servers**
\`\`\`http
GET /compute/servers
X-Payment: <signature> OR X-Agent-Id: <agent-id>
\`\`\`

**Get Server**
\`\`\`http
GET /compute/servers/{id}
X-Payment: <signature> OR X-Agent-Id: <agent-id>
\`\`\`

**Delete Server**
\`\`\`http
DELETE /compute/servers/{id}
X-Payment: <signature> OR X-Agent-Id: <agent-id>
\`\`\`

### 🌐 Domain Management

**Register Domain**
\`\`\`http
POST /domains
Content-Type: application/json
X-Payment: <signature> OR X-Agent-Id: <agent-id>

{
  "name": "myagent",
  "tld": "com"
}
\`\`\`

### 🔑 API Key Management

**Provision API Key**
\`\`\`http
POST /apikeys
Content-Type: application/json
X-Payment: <signature> OR X-Agent-Id: <agent-id>

{
  "provider": "openai",
  "label": "My OpenAI Key"
}
\`\`\`

## Demo Endpoints (Free)

Test endpoints that don't require payment:

\`\`\`http
GET /demo/phone
GET /demo/email
GET /demo/compute
\`\`\`

## Pricing (USDC)

| Service | Action | Cost |
|---------|--------|------|
| 📱 Phone | Provision number | 2.00 |
| 📱 Phone | Get messages | 0.01 |
| 📱 Phone | Send SMS | 0.05 |
| 📧 Email | Create inbox | 1.00 |
| 📧 Email | Get messages | 0.01 |
| 📧 Email | Send email | 0.05 |
| 🖥️ Compute | Create server (cx22) | 5.00 |
| 🖥️ Compute | List/Get servers | 0.01 |
| 🖥️ Compute | Delete server | 0.10 |
| 🖥️ Compute | SSH key upload | 0.10 |
| 🌐 Domain | Register domain | 10.00 |
| 🌐 Domain | DNS updates | 0.10 |
| 🔑 API Keys | Provision key | 1.00 |

## Status & Health

- \`GET /\` - Landing page
- \`GET /api\` - API information
- \`GET /health\` - Health check
- \`GET /pricing\` - Pricing table
- \`GET /hackathon/status\` - Hackathon mode status
- \`GET /docs\` - Swagger documentation

## Error Handling

All errors include:
- \`error\`: Error type
- \`message\`: What went wrong  
- \`hint\`: What to do next

Example error:
\`\`\`json
{
  "error": "Missing Required Field",
  "message": "The 'country' field is required", 
  "hint": "Include 'country' in your request body (e.g., 'US', 'CA', 'GB')"
}
\`\`\`

## Treasury Wallet
${config.treasuryWallet}

## Support
For issues or questions, check the docs at \`/docs\` or contact the AgentOS team.
`;

  res.setHeader('Content-Type', 'text/markdown');
  res.send(skillMd);
});

// ── Stream Overlay Stats ──────────────────────────────────────
app.get("/overlay-stats", async (_req, res) => {
  // Read current task from a file (updated externally)
  let task = "Shipping AgentOS features...";
  let commits = 0;
  try {
    const fs = await import("fs");
    const taskFile = path.join(process.cwd(), "data", "overlay.json");
    if (fs.existsSync(taskFile)) {
      const data = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
      if (data.task) task = data.task;
      if (data.commits) commits = data.commits;
    }
  } catch {}

  // Count total endpoints from overlay data or default
  let endpoints = 48;
  try {
    const fs = await import("fs");
    const taskFile = path.join(process.cwd(), "data", "overlay.json");
    if (fs.existsSync(taskFile)) {
      const data = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
      if (data.endpoints) endpoints = data.endpoints;
    }
  } catch {}

  res.json({ task, commits, endpoints });
});

// ── Changelog ─────────────────────────────────────────────
app.use("/api/use-cases", usecasesRoutes);
app.use("/changelog", changelogRoutes);
app.use("/status", statusRoutes);
app.use("/api/network", networkRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/compatibility", compatibilityRoutes);
app.use("/api/roadmap", roadmapRoutes);
app.use("/api/testimonials", testimonialsRoutes);
app.use("/api/examples", examplesRoutes);
app.use("/api/faq", faqRoutes);
app.use("/api", securityRoutes);
app.use("/api", calculatorRoutes);
app.use("/api/quickstart", quickstartRoutes);
app.use("/api/comparison", comparisonRoutes);
app.use("/api/ecosystem", ecosystemRoutes);
app.use("/api/migration", migrationRoutes);
app.use("/api/benchmarks", benchmarksRoutes);
app.use("/api/sandbox", sandboxRoutes);
app.use("/api/sla", slaRoutes);
app.use("/api/uptime", infoRoutes);
app.use("/api", leaderboardRoutes);
app.use("/api/health-matrix", healthMatrixRoutes);
app.use("/api/changelog", changelogFullRoutes);
app.use("/api/events", eventsRoutes);
app.use("/api/partners", partnersRoutes);
app.use("/api/playground", playgroundRoutes);
app.use("/api/templates", templatesRoutes);
app.use("/api/capabilities", capabilitiesRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/metrics", metricsRoutes);
app.use("/api/agent-kit", agentKitRoutes);
app.use("/api/sdk", sdkRoutes);
app.use("/api/agents/directory", directoryRoutes);
import demoRouter from "./routes/demo";
app.use("/api/demo", demoRouter);
import verifyRouter from "./routes/verify";
import whoamiRouter from "./routes/whoami";
import feedbackRouter from "./routes/feedback";
app.use("/api/agents/verify", verifyRouter);
app.use("/api/whoami", whoamiRouter);
app.use("/api/feedback", feedbackRouter);

// ── Error handling ────────────────────────────────────────────
// ── Deep health check ────────────────────────────────────────
app.get("/health/deep", (_req, res) => {
  const os = require("os");
  const uptimeS = Math.floor(process.uptime());
  const mem = process.memoryUsage();
  res.json({
    status: "healthy",
    version: getVersion().version,
    uptime: { seconds: uptimeS, human: `${Math.floor(uptimeS/3600)}h ${Math.floor((uptimeS%3600)/60)}m ${uptimeS%60}s` },
    memory: { rss_mb: Math.round(mem.rss/1048576), heap_used_mb: Math.round(mem.heapUsed/1048576) },
    system: { cpus: os.cpus().length, load: os.loadavg(), free_mem_mb: Math.round(os.freemem()/1048576), total_mem_mb: Math.round(os.totalmem()/1048576) },
    hackathon: { deadline: "2026-02-12T17:00:00Z", hours_remaining: Math.max(0, Math.floor((new Date("2026-02-12T17:00:00Z").getTime() - Date.now())/3600000)), mode: "FREE" }
  });
});

import hackathonRouter from "./routes/hackathon";
app.use("/api/hackathon", hackathonRouter);
import grantsRouter from "./routes/grants";
import rateLimitsRouter from "./routes/ratelimits";
app.use("/api", grantsRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/agents/reputation", reputationRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/rate-limits", rateLimitsRouter);
import configRouter from "./routes/config";
app.use("/api/config", configRouter);
import deadlinesRouter from "./routes/deadlines";
app.use("/api/deadlines", deadlinesRouter);
import integrationTestRouter from "./routes/integration-test";
app.use("/api/integration-test", integrationTestRouter);
import launchChecklistRouter from "./routes/launch-checklist";
app.use("/api/launch-checklist", launchChecklistRouter);
import submitChecklistRouter from "./routes/submit-checklist";
app.use("/api/submit-checklist", submitChecklistRouter);
import countdownRouter from "./routes/countdown";
app.use("/api", countdownRouter);
import finalSprintRouter from "./routes/final-sprint";
app.use("/api", finalSprintRouter);
import uptimeRouter from "./routes/uptime";
app.use("/api", uptimeRouter);
import walkthroughRouter from "./routes/walkthrough";
import demoRequestRouter from "./routes/demo-request";
app.use("/api/walkthrough", walkthroughRouter);
app.use("/api/demo-request", demoRequestRouter);

app.use("/api/health-summary", healthSummaryRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`⚡ AgentOS running on port ${config.port}`);
  console.log(`   Treasury: ${config.treasuryWallet}`);
  console.log(`   Network:  Solana (${config.solanaRpcUrl})`);
  console.log(`   Email:    *@${config.emailDomain}`);
});

export default app;
