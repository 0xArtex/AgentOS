import { Router } from "express";
const router = Router();

/**
 * @swagger
 * /api/walkthrough:
 *   get:
 *     summary: Step-by-step platform walkthrough
 *     description: Interactive guided walkthrough of AgentOS capabilities with curl commands for each step
 *     tags: [Getting Started]
 *     responses:
 *       200:
 *         description: Walkthrough steps
 */
router.get("/", (_req, res) => {
  const baseUrl = "http://77.42.89.233:3001";
  res.json({
    title: "AgentOS Platform Walkthrough",
    description: "Complete guided tour — run each step in order to explore the full platform",
    estimatedTime: "10 minutes",
    steps: [
      {
        step: 1,
        title: "Check Platform Status",
        description: "Verify the platform is running and see live stats",
        curl: `curl ${baseUrl}/api/hackathon`,
        whatYouGet: "Hackathon info, countdown, free tier details"
      },
      {
        step: 2,
        title: "Register Your Agent",
        description: "Create your agent identity on the platform",
        curl: `curl -X POST ${baseUrl}/api/agents/register -H "Content-Type: application/json" -H "X-Agent-Id: your-agent-name" -d '{"name":"your-agent","capabilities":["compute","communication"]}'`,
        whatYouGet: "Agent ID, API key, registration confirmation"
      },
      {
        step: 3,
        title: "Provision a Phone Number",
        description: "Get a dedicated phone number for your agent",
        curl: `curl -X POST ${baseUrl}/api/phone/provision -H "X-Agent-Id: your-agent-name" -d '{"country":"US"}'`,
        whatYouGet: "Phone number, SID, SMS/voice capability"
      },
      {
        step: 4,
        title: "Set Up Email",
        description: "Create a dedicated email address",
        curl: `curl -X POST ${baseUrl}/api/email/provision -H "X-Agent-Id: your-agent-name" -d '{"prefix":"myagent"}'`,
        whatYouGet: "Email address, SMTP credentials"
      },
      {
        step: 5,
        title: "Launch Compute Instance",
        description: "Spin up an isolated server for your agent",
        curl: `curl -X POST ${baseUrl}/api/compute/provision -H "X-Agent-Id: your-agent-name" -d '{"type":"cx22","image":"ubuntu-22.04"}'`,
        whatYouGet: "Server IP, SSH credentials, specs"
      },
      {
        step: 6,
        title: "Check Your Identity",
        description: "Verify your agent registration and resources",
        curl: `curl ${baseUrl}/api/whoami -H "X-Agent-Id: your-agent-name"`,
        whatYouGet: "Agent profile, provisioned resources, usage stats"
      },
      {
        step: 7,
        title: "Explore the Ecosystem",
        description: "See other agents and potential partners",
        curl: `curl ${baseUrl}/api/agents/directory`,
        whatYouGet: "List of ecosystem agents, categories, integration status"
      },
      {
        step: 8,
        title: "Run Integration Test",
        description: "Validate your full setup end-to-end",
        curl: `curl -X POST ${baseUrl}/api/integration-test -H "X-Agent-Id: your-agent-name"`,
        whatYouGet: "Per-service connectivity status, latency metrics"
      }
    ],
    nextSteps: [
      "Browse SDK examples: GET /api/sdk",
      "Check pricing: GET /api/pricing/calculator?phones=1&emails=1",
      "Submit feedback: POST /api/feedback",
      "View all endpoints: GET /api/capabilities"
    ],
    hackathonNote: "All services are FREE during the Colosseum hackathon (until Feb 12, 17:00 UTC). No payment required — just include X-Agent-Id header."
  });
});

export default router;
