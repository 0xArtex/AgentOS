import { Router, Request, Response } from 'express';

const router = Router();

const releases = [
  {
    version: "0.5.9",
    date: "2026-02-09",
    title: "Health Matrix & Service Monitoring",
    changes: [
      "Added /api/health-matrix — real-time per-service health with latency, uptime, error rates",
      "Added /api/leaderboard — ecosystem agent leaderboard with integration scores",
      "Added /api/uptime — live system uptime and incident history",
      "Added /api/sla — service level agreements and guarantees",
      "Added /api/sandbox — interactive try-it-now guided scenarios",
      "34+ total API endpoints"
    ]
  },
  {
    version: "0.5.0",
    date: "2026-02-09",
    title: "Developer Experience & Onboarding",
    changes: [
      "Added /api/quickstart — 5-step interactive onboarding with curl examples",
      "Added /api/examples — copy-paste curl examples by difficulty",
      "Added /api/faq — categorized FAQs",
      "Added /api/security — 6-layer security model documentation",
      "Added /api/pricing/calculator — interactive USDC cost estimator",
      "25+ total API endpoints"
    ]
  },
  {
    version: "0.4.5",
    date: "2026-02-09",
    title: "Ecosystem & Integrations",
    changes: [
      "Added /api/integrations — framework-specific code snippets (LangChain, CrewAI, OpenClaw)",
      "Added /api/network — ecosystem partner discovery",
      "Added /api/use-cases — real-world agent examples",
      "Added /api/compatibility — framework compatibility matrix",
      "Added /api/testimonials — social proof from ecosystem agents",
      "Added /health/deep — detailed system diagnostics"
    ]
  },
  {
    version: "0.4.3",
    date: "2026-02-09",
    title: "Security & Reliability",
    changes: [
      "Input validation on all endpoints",
      "CORS configuration",
      "Rate limiting per API key",
      "Request timeouts",
      "SQLite persistence — no data loss on restart",
      "Transaction logging"
    ]
  },
  {
    version: "0.3.0",
    date: "2026-02-08",
    title: "Core Services Launch",
    changes: [
      "Phone provisioning and SMS/voice",
      "Email sending via SMTP",
      "Compute container management",
      "Domain registration",
      "x402 USDC payments",
      "Agent registration and API keys"
    ]
  }
];

router.get('/releases', (_req: Request, res: Response) => {
  res.json({
    project: "Palmyr",
    totalReleases: releases.length,
    latestVersion: releases[0].version,
    releases
  });
});

router.get('/releases/latest', (_req: Request, res: Response) => {
  res.json(releases[0]);
});

router.get('/releases/:version', (req: Request, res: Response) => {
  const release = releases.find(r => r.version === req.params.version);
  if (!release) {
    res.status(404).json({ error: "Version not found" });
    return;
  }
  res.json(release);
});

export default router;
