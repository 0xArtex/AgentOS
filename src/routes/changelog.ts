import { Router } from "express";

const router = Router();

const CHANGELOG = [
  {
    date: "2026-07",
    changes: [
      "Prepaid Visa cards: /cards — buy, list, get, refresh via dynamic x402 pricing (CLI 1.14.0)",
    ],
  },
  {
    date: "2026-07",
    changes: [
      "Distribution surfaces: hosted MCP server at /mcp (ai.palmyr/palmyr), Agent Skill via `npx skills add https://palmyr.ai`, Bazaar discovery metadata",
    ],
  },
  {
    date: "2026-06",
    changes: [
      "i402 orchestrator at /chat — multi-step plan execution with dynamic pricing and async polling",
      "Security hardening sweep across payments, wallet, and social routes",
      "Removed dead hackathon-era routes; /pricing and /openapi.json now generated from the live route registry",
    ],
  },
  {
    date: "2026-05",
    changes: [
      "Trading lifecycle: any wallet trades on Solana + Base with SOL/ETH or USDC funding, per-asset PnL, TTL auto-lock",
    ],
  },
  {
    date: "2026-05-11",
    changes: [
      "Rebrand: AgentOS is now Palmyr",
    ],
  },
  {
    date: "2026-05",
    changes: [
      "Email send/receive on custom domains via Mailgun",
    ],
  },
  {
    date: "2026-02",
    changes: [
      "Initial release: phone, email, domain, and compute provisioning paid per call with USDC via x402",
      "Swagger API documentation at /docs",
    ],
  },
];

router.get("/", (_req, res) => {
  res.json({
    project: "Palmyr",
    description: "Autonomous infrastructure for AI agents",
    changelog: CHANGELOG,
  });
});

export default router;
