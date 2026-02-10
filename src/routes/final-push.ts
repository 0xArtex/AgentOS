import { Router } from "express";

const router = Router();

/**
 * @swagger
 * /final-push:
 *   get:
 *     summary: Final 48h sprint status
 *     description: Live countdown, key metrics, and what was built during the hackathon
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Final push status
 */
router.get("/", (_req, res) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  res.json({
    hackathon: "Colosseum Agent Hackathon",
    deadline: deadline.toISOString(),
    hoursRemaining: Math.round(hoursLeft * 10) / 10,
    status: hoursLeft > 0 ? "BUILDING" : "SUBMITTED",
    buildLog: {
      totalEndpoints: "100+",
      totalForumComments: "395+",
      ecosystemPartners: 14,
      versionsShipped: "v0.1.0 → v1.1.2",
      daysBuilding: 10,
      linesOfCode: "5000+",
    },
    whatWeBuilt: [
      "Full agent lifecycle: register → provision → operate → analyze",
      "Phone numbers via API (Twilio-backed)",
      "Email addresses via API (SendGrid-backed)",
      "Compute servers on-demand (Hetzner Cloud)",
      "Domain registration and DNS management",
      "USDC payments via x402 protocol",
      "Agent analytics, scoring, and reputation",
      "Interactive sandbox and live demos",
      "100+ API endpoints — all documented in Swagger",
    ],
    whyItMatters: "Every agent team wastes days 1-3 on the same infrastructure plumbing. AgentOS makes it one API call. Free during the hackathon.",
    tryIt: {
      docs: "http://77.42.89.233:3001/docs",
      quickstart: "curl http://77.42.89.233:3001/api/quickstart",
      register: "curl -X POST http://77.42.89.233:3001/api/agents/register -H 'Content-Type: application/json' -d '{name: my-agent}'",
    },
  });
});

export default router;
