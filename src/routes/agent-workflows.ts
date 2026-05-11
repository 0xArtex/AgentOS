import { Router, Request, Response } from "express";

const router = Router({ mergeParams: true });

/**
 * GET /agent-workflows — Pre-built multi-step workflow recipes
 * Real composable pipelines agents can execute step-by-step
 */
router.get("/", (_req: Request, res: Response) => {
  res.json({
    title: "Palmyr Workflow Recipes",
    description: "Copy-paste multi-step workflows. Each step is a real API call.",
    workflows: [
      {
        id: "customer-support-bot",
        name: "Customer Support Agent",
        difficulty: "beginner",
        estimatedTime: "5 minutes",
        description: "Deploy a fully autonomous customer support agent with phone + email",
        steps: [
          {
            step: 1,
            action: "Provision phone number",
            method: "POST",
            endpoint: "/phone/numbers",
            body: { country: "US" },
            note: "Agent gets a real phone number for inbound calls"
          },
          {
            step: 2,
            action: "Create email inbox",
            method: "POST",
            endpoint: "/email/inboxes",
            body: { domain: "support", prefix: "help" },
            note: "Agent gets help@support.palmyr.dev"
          },
          {
            step: 3,
            action: "Set up webhook for incoming messages",
            method: "POST",
            endpoint: "/webhooks",
            body: { url: "https://your-agent.com/webhook", events: ["sms.received", "email.received"] },
            note: "Route all customer messages to your agent"
          },
          {
            step: 4,
            action: "Register in agent directory",
            method: "POST",
            endpoint: "/agents/register",
            body: { name: "SupportBot", capabilities: ["phone", "email"], status: "active" },
            note: "Make your agent discoverable"
          }
        ],
        totalCost: "2.55 USDC (free during hackathon)"
      },
      {
        id: "trading-alerts",
        name: "Trading Alert Pipeline",
        difficulty: "intermediate",
        estimatedTime: "10 minutes",
        description: "Multi-channel alert system: detect signal → notify via SMS + email",
        steps: [
          {
            step: 1,
            action: "Provision alert phone number",
            method: "POST",
            endpoint: "/phone/numbers",
            body: { country: "US" },
            note: "Dedicated number for trading alerts"
          },
          {
            step: 2,
            action: "Create alert email",
            method: "POST",
            endpoint: "/email/inboxes",
            body: { domain: "alerts", prefix: "trades" },
            note: "trades@alerts.palmyr.dev for email alerts"
          },
          {
            step: 3,
            action: "Spin up compute for signal detection",
            method: "POST",
            endpoint: "/compute/instances",
            body: { type: "small", image: "python-ml", name: "signal-detector" },
            note: "Dedicated instance running your detection model"
          },
          {
            step: 4,
            action: "Send test SMS alert",
            method: "POST",
            endpoint: "/phone/numbers/{id}/send",
            body: { to: "+1234567890", body: "🚨 SOL breakout detected: $185.50 (+12.3%)" },
            note: "Verify the pipeline works end-to-end"
          }
        ],
        totalCost: "3.55 USDC (free during hackathon)"
      },
      {
        id: "multi-agent-team",
        name: "Multi-Agent Coordination",
        difficulty: "advanced",
        estimatedTime: "15 minutes",
        description: "Spin up a team of specialized agents that communicate via Palmyr",
        steps: [
          {
            step: 1,
            action: "Register coordinator agent",
            method: "POST",
            endpoint: "/agents/register",
            body: { name: "Coordinator", capabilities: ["orchestration"], status: "active" }
          },
          {
            step: 2,
            action: "Register worker agents",
            method: "POST",
            endpoint: "/agents/register",
            body: { name: "Worker-Research", capabilities: ["compute", "email"], status: "active" },
            note: "Repeat for each specialized worker"
          },
          {
            step: 3,
            action: "Create shared communication channel",
            method: "POST",
            endpoint: "/email/inboxes",
            body: { domain: "team", prefix: "internal" },
            note: "Agents communicate via internal@team.palmyr.dev"
          },
          {
            step: 4,
            action: "Provision compute for each worker",
            method: "POST",
            endpoint: "/compute/instances",
            body: { type: "medium", name: "worker-1" },
            note: "Each worker gets isolated compute"
          },
          {
            step: 5,
            action: "Set up inter-agent messaging",
            method: "POST",
            endpoint: "/messages",
            body: { from: "Coordinator", to: "Worker-Research", content: "Analyze SOL/USDC pair last 24h" },
            note: "Coordinator delegates tasks via messaging API"
          }
        ],
        totalCost: "6.10 USDC (free during hackathon)"
      },
      {
        id: "saas-mvp",
        name: "Agent SaaS MVP",
        difficulty: "advanced",
        estimatedTime: "20 minutes",
        description: "Launch a micro-SaaS powered entirely by an AI agent",
        steps: [
          {
            step: 1,
            action: "Register custom domain",
            method: "POST",
            endpoint: "/domains",
            body: { domain: "myagent.app" },
            note: "Your agent's public-facing domain"
          },
          {
            step: 2,
            action: "Create business email",
            method: "POST",
            endpoint: "/email/inboxes",
            body: { domain: "myagent", prefix: "hello" },
            note: "hello@myagent.app for customer communication"
          },
          {
            step: 3,
            action: "Provision customer support line",
            method: "POST",
            endpoint: "/phone/numbers",
            body: { country: "US" }
          },
          {
            step: 4,
            action: "Deploy backend compute",
            method: "POST",
            endpoint: "/compute/instances",
            body: { type: "large", image: "node-18", name: "backend" }
          },
          {
            step: 5,
            action: "Set up usage analytics",
            method: "GET",
            endpoint: "/analytics",
            note: "Track your agent's performance and usage"
          },
          {
            step: 6,
            action: "Configure billing via wallet",
            method: "POST",
            endpoint: "/wallet/create",
            body: { type: "agent" },
            note: "Agent wallet for receiving USDC payments"
          }
        ],
        totalCost: "8.50 USDC (free during hackathon)"
      }
    ],
    hackathonNote: "All workflows are FREE during the Colosseum hackathon. Just include X-Agent-Id header.",
    tryIt: "curl http://77.42.89.233:3001/api/agent-workflows"
  });
});

export default router;
