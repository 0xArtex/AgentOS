import { Router, Request, Response } from "express";

const router = Router();

router.get("/deadline-day", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const diffMs = deadline.getTime() - now.getTime();
  const hoursLeft = Math.max(0, Math.floor(diffMs / 3600000));
  const minutesLeft = Math.max(0, Math.floor((diffMs % 3600000) / 60000));
  const expired = diffMs <= 0;

  res.json({
    project: "Palmyr",
    tagline: "Autonomous infrastructure for AI agents",
    deadline: "2026-02-12T17:00:00Z",
    countdown: expired
      ? { expired: true, message: "Hackathon ended! Post-hackathon access continues through Feb 28." }
      : { hours: hoursLeft, minutes: minutesLeft, message: `${hoursLeft}h ${minutesLeft}m remaining` },
    finalStats: {
      endpoints: "207+",
      forumComments: "1140+",
      uptimeDays: 12,
      zeroDowntime: true,
      x402Chains: ["Solana", "Base"],
      selfHostedFacilitator: true,
      routeFiles: 198,
      services: ["Phone/SMS", "Email", "Compute", "Domains", "Storage", "Identity"]
    },
    whatWorks: {
      agentRegistration: "Full CRUD with token auth",
      phoneProvisioning: "Twilio-backed, SMS/voice capable",
      emailProvisioning: "SendGrid-backed, send/receive",
      computeProvisioning: "Docker containers on demand",
      domainProvisioning: "DNS management",
      x402Payments: "USDC on Solana + Base via self-hosted facilitator",
      identityVerification: "Challenge-response cryptographic flow",
      webhookEvents: "Real-time inter-agent event bus",
      activityLogging: "Per-agent tamper-evident logs",
      reputationScoring: "Trust tiers from unverified to legendary"
    },
    honestGaps: [
      "Twilio/SendGrid credentials need real accounts for production",
      "Treasury wallet needs funding for mainnet operations",
      "< 10 real external users (hackathon demo stage)"
    ],
    tryItNow: {
      health: "curl https://palmyr.ai/health",
      hackathon: "curl https://palmyr.ai/api/hackathon",
      forJudges: "curl https://palmyr.ai/api/for-judges",
      docs: "https://palmyr.ai/docs"
    },
    postHackathon: {
      freeAccess: "Extended through Feb 28 for all hackathon agents",
      builderCredits: "$100 USDC for active agents",
      integrationBounties: "$10-500 per verified integration"
    }
  });
});

export default router;
