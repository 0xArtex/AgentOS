import express from "express";
import { config } from "./config";
import phoneRoutes from "./routes/phone";
import emailRoutes from "./routes/email";
import domainRoutes from "./routes/domain";
import computeRoutes from "./routes/compute";
import apikeysRoutes from "./routes/apikeys";
import { errorHandler, notFoundHandler } from "./middleware/errors";

const app = express();

app.use(express.json());

// ── Health ────────────────────────────────────────────────────
app.get("/", (_req, res) => {
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

// ── Routes ────────────────────────────────────────────────────
app.use("/phone", phoneRoutes);
app.use("/email", emailRoutes);
app.use("/domains", domainRoutes);
app.use("/compute", computeRoutes);
app.use("/apikeys", apikeysRoutes);

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
