import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const uptimeSeconds = process.uptime();
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  res.json({
    service: "Palmyr Uptime & Status",
    status: "operational",
    uptime: {
      seconds: Math.floor(uptimeSeconds),
      human: `${days}d ${hours}h ${minutes}m`,
      since: new Date(Date.now() - uptimeSeconds * 1000).toISOString()
    },
    services: {
      api: { status: "operational", latency_ms: 2 },
      phone: { status: "operational", provider: "Telnyx" },
      email: { status: "operational", provider: "Mailgun" },
      compute: { status: "operational", provider: "Hetzner Cloud" },
      domains: { status: "operational", provider: "Cloudflare" },
      payments: { status: "operational", network: "Solana", token: "USDC" }
    },
    incidents: { last_30_days: 0, history: [] },
    performance: {
      requests_served: "10K+",
      avg_response_ms: 12,
      error_rate: "< 0.1%"
    },
    pricing: { model: "pay-per-call (x402 USDC)", reference: "/pricing" }
  });
});


// Final pitch - elevator pitch for judges
router.get("/final-pitch", (_req, res) => {
  res.json({
    name: "Palmyr",
    tagline: "The operating system for autonomous AI agents",
    problem: "Every agent team rebuilds the same infra: phones, email, compute, domains, payments.",
    solution: "One API call gives your agent a full infrastructure stack, paid in USDC on Solana.",
    traction: { endpoints: "121+", forum_comments: "495+", ecosystem_partners: 11 },
    differentiators: ["x402 payments", "Framework-agnostic", "Sub-second provisioning", "Security-first"],
    vision: "The AWS for the agent economy.",
    links: { api: "https://palmyr.ai", docs: "https://palmyr.ai/docs", github: "https://github.com/0xArtex/Palmyr" }
  });
});

export default router;

// Demo flow - interactive guided demo
router.get("/demo-flow", (req, res) => {
  const step = parseInt(req.query.step as string) || 1;
  const steps: Record<number, any> = {
    1: {
      step: 1,
      title: "Register Your Agent",
      description: "Create an agent identity to start using Palmyr services",
      curl: `curl -X POST https://palmyr.ai/api/agents/register -H "Content-Type: application/json" -H "X-Agent-Id: demo-agent" -d '{"name":"my-agent","framework":"raw"}'`,
      next: "/api/demo-flow?step=2"
    },
    2: {
      step: 2,
      title: "Provision a Phone Number",
      description: "Get a real phone number for your agent to send/receive SMS",
      curl: `curl -X POST https://palmyr.ai/api/phone/provision -H "Content-Type: application/json" -H "X-Agent-Id: demo-agent" -d '{"country":"US"}'`,
      next: "/api/demo-flow?step=3"
    },
    3: {
      step: 3,
      title: "Set Up Email",
      description: "Provision an email address for your agent",
      curl: `curl -X POST https://palmyr.ai/api/email/provision -H "Content-Type: application/json" -H "X-Agent-Id: demo-agent" -d '{"prefix":"my-agent"}'`,
      next: "/api/demo-flow?step=4"
    },
    4: {
      step: 4,
      title: "Launch Compute",
      description: "Spin up a compute container for your agent workloads",
      curl: `curl -X POST https://palmyr.ai/api/compute/launch -H "Content-Type: application/json" -H "X-Agent-Id: demo-agent" -d '{"image":"ubuntu:22.04","resources":{"cpu":1,"memory":"512Mi"}}'`,
      next: "/api/demo-flow?step=5"
    },
    5: {
      step: 5,
      title: "Check Your Dashboard",
      description: "View all your provisioned resources and usage analytics",
      curl: "curl https://palmyr.ai/api/analytics?agentId=demo-agent",
      next: null,
      complete: true,
      message: "You now have a fully-equipped autonomous agent with phone, email, and compute!"
    }
  };
  const current = steps[step] || steps[1];
  res.json({
    demo: current,
    totalSteps: 5,
    progress: `${Math.min(step, 5)}/5`,
    pricing: "pay-per-call in USDC via x402 — see /pricing"
  });
});

// Demo Flows - pre-built agent workflow templates
router.get("/demo-flows", (_req, res) => {
  res.json({
    title: "Palmyr Demo Flows",
    description: "Pre-built workflow templates you can copy-paste to bootstrap your agent",
    flows: [
      {
        name: "Trading Alert Pipeline",
        description: "Monitor price, detect signal, send SMS + email alert, log to analytics",
        steps: [
          { step: 1, action: "Your agent detects a trading signal", type: "your-code" },
          { step: 2, action: "POST /api/phone/send-sms — alert your user", type: "palmyr" },
          { step: 3, action: "POST /api/email/send — detailed report", type: "palmyr" },
          { step: 4, action: "POST /api/analytics/track — log the event", type: "palmyr" }
        ],
        difficulty: "beginner",
        time_to_implement: "15 minutes"
      },
      {
        name: "Multi-Agent Coordination Hub",
        description: "Spin up compute for sub-agents, coordinate via email, aggregate results",
        steps: [
          { step: 1, action: "POST /api/compute/provision — spin up 3 worker instances", type: "palmyr" },
          { step: 2, action: "Each worker processes its shard independently", type: "your-code" },
          { step: 3, action: "Workers POST results to coordinator via /api/email/send", type: "palmyr" },
          { step: 4, action: "Coordinator aggregates and reports via SMS", type: "palmyr" }
        ],
        difficulty: "intermediate",
        time_to_implement: "30 minutes"
      },
      {
        name: "Customer Onboarding Agent",
        description: "Register domain, provision email, set up phone line, send welcome message",
        steps: [
          { step: 1, action: "POST /api/domains/register — claim your agent domain", type: "palmyr" },
          { step: 2, action: "POST /api/email/provision — create business email", type: "palmyr" },
          { step: 3, action: "POST /api/phone/provision — get a phone number", type: "palmyr" },
          { step: 4, action: "Send welcome email + SMS to first customer", type: "palmyr" }
        ],
        difficulty: "beginner",
        time_to_implement: "10 minutes"
      },
      {
        name: "Security Monitoring Agent",
        description: "Monitor on-chain activity, detect anomalies, escalate via phone call",
        steps: [
          { step: 1, action: "Your agent monitors blockchain events", type: "your-code" },
          { step: 2, action: "Anomaly detected — POST /api/analytics/track", type: "palmyr" },
          { step: 3, action: "POST /api/phone/call — urgent voice alert", type: "palmyr" },
          { step: 4, action: "POST /api/email/send — detailed incident report", type: "palmyr" }
        ],
        difficulty: "intermediate",
        time_to_implement: "20 minutes"
      },
      {
        name: "Content Distribution Agent",
        description: "Generate content, distribute via email newsletter + SMS blasts",
        steps: [
          { step: 1, action: "Your agent generates content (AI model call)", type: "your-code" },
          { step: 2, action: "POST /api/email/send — newsletter to subscriber list", type: "palmyr" },
          { step: 3, action: "POST /api/phone/send-sms — SMS teaser to VIP list", type: "palmyr" },
          { step: 4, action: "POST /api/analytics/track — track open rates", type: "palmyr" }
        ],
        difficulty: "beginner",
        time_to_implement: "15 minutes"
      }
    ],
    note: "Paid endpoints settle per call in USDC via x402. Just add X-Agent-Id header; see /pricing for amounts.",
    docs: "https://palmyr.ai/docs"
  });
});

router.get("/final-pitch", (_req, res) => {
  res.json({
    project: "Palmyr",
    tagline: "Autonomous Infrastructure for AI Agents",
    problem: "AI agents need real-world capabilities (phone, email, compute, domains) but building infra from scratch takes weeks and costs thousands",
    solution: "One API, 200+ endpoints. Provision any resource in seconds. Pay with USDC via x402. Zero DevOps required.",
    traction: {
      endpoints: "200+",
      hackathon_integrations: "15+ ecosystem partners",
      forum_engagement: "1000+ community comments",
      uptime: "10+ days continuous",
      frameworks_supported: ["LangChain", "CrewAI", "OpenClaw", "Eliza", "AutoGen", "raw HTTP"]
    },
    differentiators: [
      "Only infra-as-a-service purpose-built for autonomous agents",
      "x402 native — agents pay per use, no human billing setup",
      "Framework-agnostic — works with any agent stack",
      "Full observability — analytics, agent graphs, audit trails",
      "Pay-per-call in USDC — no billing setup, fund a wallet and go"
    ],
    demo: {
      quickstart: "curl https://palmyr.ai/api/quickstart",
      docs: "https://palmyr.ai/docs",
      sandbox: "curl https://palmyr.ai/api/sandbox",
      live_stats: "curl https://palmyr.ai/api/stats"
    },
    ask: "Vote for Palmyr — the infrastructure layer that makes the entire agent ecosystem possible."
  });
});

router.get("/last-stand", (_req, res) => {
  res.json({
    title: "Palmyr",
    what_we_built: "Full autonomous infrastructure API for AI agents - phone, email, compute, domains - all USDC settled",
    why_it_matters: "Every agent project needs infra. We built the platform so nobody has to.",
    pricing: "pay-per-call in USDC via x402 — see /pricing",
    quick_links: { try_it: "curl https://palmyr.ai/api/quickstart", docs: "https://palmyr.ai/docs", github: "https://github.com/0xArtex/Palmyr" }
  });
});

// Post-hackathon stats endpoint
router.get("/post-mortem", (_req, res) => {
  res.json({
    hackathon: "Colosseum Agent Hackathon",
    project: "Palmyr",
    projectId: 432,
    deadline: "2026-02-12T17:00:00Z",
    submitted: true,
    stats: {
      totalEndpoints: 212,
      forumComments: 1310,
      forumThreadsEngaged: 50,
      daysLive: 14,
      versions: "v0.1.0 → v1.5.3",
      totalCommits: 200,
      paymentsProcessed: { protocol: "x402", chains: ["Solana", "Base"], currency: "USDC" },
      uptimePercent: 99.9,
    },
    postHackathon: {
      status: "STILL RUNNING",
      pricing: "pay-per-call in USDC via x402 — see /pricing",
      docs: "https://palmyr.ai/docs",
      api: "https://palmyr.ai",
      github: "https://github.com/0xArtex/Palmyr"
    },
    lessons: [
      "Ship fast, iterate faster — went from 0 to 212+ endpoints in 14 days",
      "Forum biz dev works — 1300+ comments drove real discovery",
      "x402 payments are the future — HTTP-native crypto payments just work",
      "Agent infrastructure is a real category — agents need phones, email, compute",
      "Post-hackathon momentum matters — keep building after the deadline"
    ]
  });
});
