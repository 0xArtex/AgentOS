import express from "express";
import { config } from "./config";
import phoneRoutes from "./routes/phone";
import emailRoutes from "./routes/email";

const app = express();

app.use(express.json());

// ── Health ────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    service: "AgentOS",
    version: "0.1.0",
    status: "operational",
    docs: "https://github.com/0xArtex/AgentOS",
    services: ["phone", "email"],
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ── Routes ────────────────────────────────────────────────────
app.use("/phone", phoneRoutes);
app.use("/email", emailRoutes);

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
    },
  });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`⚡ AgentOS running on port ${config.port}`);
  console.log(`   Treasury: ${config.treasuryWallet}`);
  console.log(`   Network:  Solana (${config.solanaRpcUrl})`);
  console.log(`   Email:    *@${config.emailDomain}`);
});

export default app;
