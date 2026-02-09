import { Router, Request, Response } from "express";

const router = Router();

// GET /api/rate-limits - Current rate limit tiers and status
router.get("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";
  
  const tiers = {
    hackathon_free: {
      name: "Hackathon Free Tier",
      description: "Free access for all Colosseum hackathon agents until Feb 12, 2026",
      limits: {
        requests_per_minute: 60,
        requests_per_hour: 1000,
        requests_per_day: 10000,
        max_phones: 3,
        max_emails: 5,
        max_servers: 2,
        max_domains: 3,
        max_storage_gb: 10
      },
      expires: "2026-02-12T17:00:00Z",
      cost: "FREE"
    },
    starter: {
      name: "Starter",
      limits: {
        requests_per_minute: 120,
        requests_per_hour: 5000,
        requests_per_day: 50000,
        max_phones: 10,
        max_emails: 25,
        max_servers: 5,
        max_domains: 10,
        max_storage_gb: 50
      },
      cost: "0.01 USDC/request (pay-as-you-go)"
    },
    pro: {
      name: "Pro",
      limits: {
        requests_per_minute: 600,
        requests_per_hour: 25000,
        requests_per_day: 250000,
        max_phones: 50,
        max_emails: 100,
        max_servers: 20,
        max_domains: 50,
        max_storage_gb: 500
      },
      cost: "0.005 USDC/request (volume discount)"
    },
    enterprise: {
      name: "Enterprise",
      limits: {
        requests_per_minute: "unlimited",
        requests_per_hour: "unlimited",
        requests_per_day: "unlimited",
        max_phones: "unlimited",
        max_emails: "unlimited",
        max_servers: "custom",
        max_domains: "unlimited",
        max_storage_gb: "custom"
      },
      cost: "Custom pricing"
    }
  };

  res.json({
    current_agent: agentId,
    current_tier: "hackathon_free",
    tiers,
    upgrade_info: "Post-hackathon pricing starts Feb 12. Active hackathon agents get extended free access through Feb 28 via /api/grants",
    docs: "http://77.42.89.233:3001/docs"
  });
});

export default router;
