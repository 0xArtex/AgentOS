import { Router, Request, Response } from "express";

const router = Router({ mergeParams: true });

router.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "Palmyr Architecture",
    version: "1.0.5",
    stack: {
      runtime: "Node.js + TypeScript + Express",
      database: "SQLite (better-sqlite3)",
      payments: "x402 protocol - USDC on Solana",
      auth: "X-Agent-Id header (free tier) + API keys (production)"
    },
    services: {
      phone: "Provision numbers, send/receive SMS",
      email: "Create inboxes, send/receive emails",
      compute: "Provision cloud servers with SSH",
      domain: "Register and manage domains",
      wallet: "Solana keypair generation",
      analytics: "Usage tracking and metrics"
    },
    security: ["Rate limiting (100 RPM)", "Input validation", "Agent isolation", "CORS", "Request timeouts"],
    endpoints: "92+ across 92 route modules",
    developer_experience: ["Swagger docs at /docs", "Skill file at /skill.md", "SDK guides at /api/sdk", "Debug tools at /api/debug"]
  });
});

export default router;
