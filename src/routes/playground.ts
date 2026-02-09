import { Router, Request, Response } from "express";

const router = Router({ mergeParams: true });

/**
 * GET /playground — Interactive API playground with runnable scenarios
 */
router.get("/", (_req: Request, res: Response) => {
  const baseUrl = "http://77.42.89.233:3001";
  
  res.json({
    title: "AgentOS API Playground",
    description: "Test AgentOS APIs interactively. Each scenario is a sequence of curl commands you can run in order.",
    note: "All endpoints are FREE during the Colosseum hackathon. Just add X-Agent-Id header.",
    scenarios: [
      {
        name: "Quick Start: Register & Explore",
        difficulty: "beginner",
        estimatedTime: "30 seconds",
        steps: [
          {
            description: "Register your agent",
            method: "POST",
            endpoint: "/api/agents/register",
            body: { name: "TestAgent", capabilities: ["research"], wallet: "YOUR_SOLANA_WALLET" },
            headers: { "X-Agent-Id": "my-agent" }
          },
          {
            description: "Check platform stats",
            method: "GET",
            endpoint: "/api/stats",
            headers: { "X-Agent-Id": "my-agent" }
          },
          {
            description: "View your agent profile",
            method: "GET",
            endpoint: "/api/agents/me",
            headers: { "X-Agent-Id": "my-agent" }
          }
        ]
      },
      {
        name: "Communication Stack",
        difficulty: "intermediate",
        estimatedTime: "2 minutes",
        steps: [
          {
            description: "Provision a phone number",
            method: "POST",
            endpoint: "/api/phone/provision",
            body: { country: "US", capabilities: ["sms", "voice"] },
            headers: { "X-Agent-Id": "my-agent" }
          },
          {
            description: "Send an SMS",
            method: "POST",
            endpoint: "/api/phone/YOUR_NUMBER/sms",
            body: { to: "+1234567890", body: "Hello from AgentOS!" },
            headers: { "X-Agent-Id": "my-agent" }
          },
          {
            description: "Create an email inbox",
            method: "POST",
            endpoint: "/api/email/inbox",
            body: { prefix: "myagent" },
            headers: { "X-Agent-Id": "my-agent" }
          }
        ]
      },
      {
        name: "Compute & Infrastructure",
        difficulty: "intermediate",
        estimatedTime: "3 minutes",
        steps: [
          {
            description: "Spin up a compute instance",
            method: "POST",
            endpoint: "/api/compute/servers",
            body: { name: "worker-1", size: "small", image: "ubuntu-22.04" },
            headers: { "X-Agent-Id": "my-agent" }
          },
          {
            description: "Register a domain",
            method: "POST",
            endpoint: "/api/domains",
            body: { domain: "myagent.os" },
            headers: { "X-Agent-Id": "my-agent" }
          }
        ]
      },
      {
        name: "Analytics & Monitoring",
        difficulty: "beginner",
        estimatedTime: "1 minute",
        steps: [
          {
            description: "View usage analytics",
            method: "GET",
            endpoint: "/api/analytics",
            headers: { "X-Agent-Id": "my-agent" }
          },
          {
            description: "Deep health check",
            method: "GET",
            endpoint: "/health/deep"
          },
          {
            description: "Cost calculator",
            method: "GET",
            endpoint: "/api/pricing/calculator?phones=2&emails=5&compute_hours=100&domains=1"
          }
        ]
      }
    ],
    tips: [
      "X-Agent-Id can be any unique string identifying your agent",
      "All responses are JSON — pipe through jq for pretty output",
      "During hackathon: all services are FREE (no USDC needed)",
      "Check /docs for full Swagger documentation"
    ],
    links: {
      docs: baseUrl + "/docs",
      status: baseUrl + "/api/status",
      github: "https://github.com/0xArtex/AgentOS",
      project: "https://colosseum.com/agent-hackathon/projects/agentos"
    }
  });
});

export default router;
