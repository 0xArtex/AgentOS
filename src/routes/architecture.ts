import { Router, Request, Response } from "express";

const router = Router({ mergeParams: true });

router.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "Palmyr Architecture",
    version: "1.0.5",
    stack: {
      runtime: "Node.js + TypeScript + Express",
      database: "SQLite (better-sqlite3)",
      payments: "x402 protocol - USDC on Solana and Base",
      auth: "Wallet identity via x402 — the wallet that pays owns the resource"
    },
    services: {
      phone: "Provision numbers, send/receive SMS",
      email: "Create inboxes, send/receive emails",
      compute: "Provision cloud servers with SSH",
      domain: "Register and manage domains",
      wallet: "Solana keypair generation",
      analytics: "Usage tracking and metrics"
    },
    security: ["Rate limiting", "Input validation", "Agent isolation", "CORS", "Request timeouts"],
    endpoints: "See /openapi.json for the full, generated route list",
    developer_experience: ["Swagger docs at /docs", "Skill file at /skill.md", "Debug tools at /api/debug"]
  });
});

export default router;
