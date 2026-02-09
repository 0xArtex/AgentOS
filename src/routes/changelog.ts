import { Router } from "express";

const router = Router();

const CHANGELOG = [
  {
    version: "0.4.1",
    date: "2026-02-09",
    changes: [
      "Analytics endpoint: GET /analytics?hours=N — usage stats by endpoint, agent, hour, status code",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-02-09",
    changes: [
      "Onboarding quickstart: POST /onboarding/quickstart — one API call to register + provision phone + email",
      "Integration guide: GET /onboarding/guide",
    ],
  },
  {
    version: "0.3.3",
    date: "2026-02-09",
    changes: [
      "Agent search: GET /agents/search?q=name",
      "Landing page: live hackathon countdown timer",
      "Landing page: real-time activity feed",
    ],
  },
  {
    version: "0.3.2",
    date: "2026-02-09",
    changes: [
      "Full CORS preflight support for browser-based agents",
      "Request timeout: 30s global with 408 responses",
      "Global rate limiting: 60 req/min per IP on all routes",
    ],
  },
  {
    version: "0.3.1",
    date: "2026-02-09",
    changes: [
      "Landing page: live stats from /stats endpoint",
      "Input validation middleware with type/pattern/enum/minLength/maxLength checks",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-02-09",
    changes: [
      "Enhanced /health: DB check, memory usage, system info, hackathon status",
      "/version endpoint: version, name, build SHA, node version",
      "/activity endpoint: platform activity feed",
      "Better error handler: JSON parse errors, payload too large",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-02-08",
    changes: [
      "Agent registration and leaderboard",
      "Agent-to-agent messaging",
      "Webhook notifications",
      "Stream overlay endpoint",
      "Request logging middleware",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-02-08",
    changes: [
      "Initial release: phone, email, domain, compute provisioning",
      "x402 payment integration",
      "Hackathon mode: free infra with X-Agent-Id header",
      "Swagger API documentation",
    ],
  },
];

router.get("/", (_req, res) => {
  res.json({
    project: "AgentOS",
    description: "Autonomous infrastructure for AI agents",
    changelog: CHANGELOG,
  });
});

export default router;
