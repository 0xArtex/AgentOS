import { Router, Request, Response } from "express";

const router = Router();

interface RateLimitTier {
  name: string;
  requestsPerMinute: number;
  requestsPerHour: number;
  requestsPerDay: number;
  burstLimit: number;
  concurrentConnections: number;
  features: string[];
  price: string;
}

const tiers: RateLimitTier[] = [
  {
    name: "hackathon",
    requestsPerMinute: 60,
    requestsPerHour: 1000,
    requestsPerDay: 10000,
    burstLimit: 10,
    concurrentConnections: 5,
    features: ["All endpoints", "Full API access", "No billing", "Community support"],
    price: "FREE (until Feb 12)"
  },
  {
    name: "starter",
    requestsPerMinute: 30,
    requestsPerHour: 500,
    requestsPerDay: 5000,
    burstLimit: 5,
    concurrentConnections: 3,
    features: ["Core endpoints", "Phone + Email", "Basic compute", "Email support"],
    price: "0.01 USDC/request (pay-per-use)"
  },
  {
    name: "pro",
    requestsPerMinute: 120,
    requestsPerHour: 5000,
    requestsPerDay: 50000,
    burstLimit: 20,
    concurrentConnections: 10,
    features: ["All endpoints", "Priority compute", "Webhooks", "Agent-to-agent comms", "Dedicated support"],
    price: "50 USDC/month"
  },
  {
    name: "enterprise",
    requestsPerMinute: 600,
    requestsPerHour: 25000,
    requestsPerDay: 250000,
    burstLimit: 50,
    concurrentConnections: 50,
    features: ["Unlimited endpoints", "Dedicated infra", "Custom domains", "SLA guarantee", "White-glove onboarding"],
    price: "Custom (contact us)"
  }
];

// GET /api/rate-limits — rate limit tiers and current status
router.get("/", (_req: Request, res: Response) => {
  const agentId = _req.headers["x-agent-id"] as string || "anonymous";
  const currentTier = "hackathon"; // All agents get hackathon tier until Feb 12

  res.json({
    currentTier,
    agentId,
    note: "All agents automatically get hackathon tier (FREE) until Feb 12, 2026 17:00 UTC",
    tiers,
    headers: {
      "X-RateLimit-Limit": "Requests allowed in current window",
      "X-RateLimit-Remaining": "Requests remaining in current window",
      "X-RateLimit-Reset": "Unix timestamp when window resets",
      "Retry-After": "Seconds to wait (only on 429 responses)"
    },
    tips: [
      "Use /api/agent-batch to combine multiple calls into one request",
      "Cache responses that don't change frequently (roadmap, docs, faq)",
      "Use webhooks instead of polling for event-driven workflows",
      "Contact us for enterprise tier with custom limits"
    ]
  });
});

// GET /api/rate-limits/:tier — specific tier details
router.get("/:tier", (req: Request, res: Response) => {
  const tier = tiers.find(t => t.name === req.params.tier);
  if (!tier) {
    return res.status(404).json({ error: "Tier not found", available: tiers.map(t => t.name) });
  }
  res.json(tier);
});

export default router;
