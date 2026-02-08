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
import { isHackathonActive, getAgentUsage } from "./middleware/hackathon";

const app = express();

app.use(express.json());
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
    version: "0.1.0",
    status: "operational",
    docs: "https://github.com/0xArtex/AgentOS",
    services: ["phone", "email", "domains", "compute", "apikeys"],
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
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

// ── Error handling ────────────────────────────────────────────
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
