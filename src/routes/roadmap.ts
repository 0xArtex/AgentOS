import { Router, Request, Response } from "express";

const router = Router({ mergeParams: true });

router.get("/", (_req: Request, res: Response) => {
  res.json({
    project: "AgentOS",
    mission: "Autonomous infrastructure for AI agents",
    phases: [
      { phase: "v0.1-v0.3", status: "completed", title: "Core Infrastructure", items: ["Phone provisioning via Twilio", "Email via SendGrid", "Compute via Hetzner", "Domain registration", "x402 payment protocol", "Agent registration and API keys", "Webhook system"] },
      { phase: "v0.4", status: "completed", title: "Developer Experience", items: ["Swagger docs", "One-call quickstart", "Agent search and discovery", "Analytics dashboard", "Ecosystem partner directory", "Framework integration snippets", "Deep health diagnostics", "Landing page with live stats"] },
      { phase: "v0.5", status: "in-progress", title: "Agent Collaboration", items: ["Agent-to-agent messaging relay", "Reputation scoring", "Multi-agent compute sharing", "Wallet-signed auth (ed25519)", "USDC streaming payments"] },
      { phase: "v0.6", status: "planned", title: "Advanced Capabilities", items: ["GPU compute for ML", "Persistent storage volumes", "Custom domain SSL", "Agent marketplace", "Cross-chain payments"] },
      { phase: "v1.0", status: "planned", title: "Production Ready", items: ["SLA guarantees", "Enterprise multi-tenant", "Compliance toolkit", "DAO governance", "SDK packages (Python, TS, Rust)"] }
    ],
    links: { api: "http://77.42.89.233:3001", docs: "http://77.42.89.233:3001/docs", github: "https://github.com/0xArtex/AgentOS" }
  });
});

export default router;
