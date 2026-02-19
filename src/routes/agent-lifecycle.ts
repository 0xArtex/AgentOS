import { Router, Request, Response } from "express";

const router = Router();

/**
 * @swagger
 * /api/agent-lifecycle:
 *   get:
 *     summary: Agent lifecycle management guide
 *     description: Complete lifecycle stages from registration to scaling, with recommended actions at each stage
 *     tags: [Guides]
 */
router.get("/", (_req: Request, res: Response) => {
  const lifecycle = {
    title: "Agent Lifecycle Management",
    description: "Guide your agent from birth to production with AgentOS",
    stages: [
      {
        stage: 1,
        name: "Registration",
        description: "Create your agent identity",
        actions: ["POST /api/agents/register — create agent", "GET /api/whoami — verify identity"],
        duration: "< 30 seconds",
        tips: ["Use a descriptive agent name", "Store your agent ID securely"]
      },
      {
        stage: 2,
        name: "Provisioning",
        description: "Get real-world capabilities",
        actions: [
          "POST /api/phones/provision — get phone numbers",
          "POST /api/emails/provision — get email inboxes",
          "POST /api/compute/provision — spin up servers",
          "POST /api/domains/register — claim domains"
        ],
        duration: "< 60 seconds per resource",
        tips: ["Start with phone + email for basic comms", "Add compute when you need background processing"]
      },
      {
        stage: 3,
        name: "Integration",
        description: "Connect with ecosystem partners",
        actions: [
          "GET /api/ecosystem — discover partners",
          "POST /api/events/subscribe — set up webhooks",
          "GET /api/compatibility — check framework support"
        ],
        duration: "Minutes to hours",
        tips: ["Use webhooks for real-time event processing", "Check the partner directory for complementary services"]
      },
      {
        stage: 4,
        name: "Monitoring",
        description: "Track health and performance",
        actions: [
          "GET /api/analytics — usage analytics",
          "GET /api/agent-score — readiness score",
          "GET /api/logs — activity logs",
          "POST /api/alerts — set up alerting"
        ],
        duration: "Ongoing",
        tips: ["Set up alerts for error rate spikes", "Review logs weekly for optimization opportunities"]
      },
      {
        stage: 5,
        name: "Scaling",
        description: "Grow your agent operations",
        actions: [
          "POST /api/compute/provision — add more instances",
          "GET /api/rate-limits — check tier limits",
          "GET /api/pricing/calculator — estimate costs",
          "POST /api/agent-collaboration — form agent teams"
        ],
        duration: "As needed",
        tips: ["Monitor costs with the pricing calculator", "Use collaboration endpoints for multi-agent setups"]
      }
    ],
    postHackathon: {
      freeAccess: "Extended through Feb 28, 2026",
      pricing: "Pay-per-use USDC via x402 after free period",
      support: "https://agntos.dev/docs"
    },
    generatedAt: new Date().toISOString()
  };
  res.json(lifecycle);
});

export default router;
