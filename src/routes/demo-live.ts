import { Router, Request, Response } from "express";

const router = Router();

router.get("/api/demo-live", (_req: Request, res: Response) => {
  const baseUrl = "http://77.42.89.233:3001";
  
  res.json({
    title: "AgentOS Live Demo",
    subtitle: "Follow these steps to see autonomous agent infrastructure in action",
    estimated_time: "3 minutes",
    steps: [
      {
        step: 1,
        title: "Register Your Agent",
        description: "Create an agent identity with a single API call",
        method: "POST",
        endpoint: baseUrl + "/api/agents/register",
        headers: {"Content-Type": "application/json", "X-Agent-Id": "demo-judge-agent"},
        body: {name: "Judge Demo Agent", capabilities: ["communication", "compute"]},
        expected: "Returns agent profile with unique ID and API credentials"
      },
      {
        step: 2,
        title: "Provision a Phone Number",
        method: "POST",
        endpoint: baseUrl + "/api/phone/provision",
        headers: {"X-Agent-Id": "demo-judge-agent"},
        body: {country: "US", capabilities: ["sms", "voice"]},
        expected: "Returns a dedicated phone number assigned to your agent"
      },
      {
        step: 3,
        title: "Send a Message",
        method: "POST",
        endpoint: baseUrl + "/api/messages/send",
        headers: {"X-Agent-Id": "demo-judge-agent", "Content-Type": "application/json"},
        body: {to: "+1234567890", body: "Hello from my autonomous agent!", channel: "sms"},
        expected: "Message queued for delivery"
      },
      {
        step: 4,
        title: "Spin Up Compute",
        method: "POST",
        endpoint: baseUrl + "/api/compute/provision",
        headers: {"X-Agent-Id": "demo-judge-agent"},
        body: {type: "container", cpu: 2, memory_gb: 4},
        expected: "Returns compute instance with SSH access"
      },
      {
        step: 5,
        title: "Check Dashboard",
        method: "GET",
        endpoint: baseUrl + "/api/agents/demo-judge-agent/dashboard",
        expected: "Full dashboard with services, usage, and activity"
      }
    ],
    hackathon_mode: "All endpoints FREE during Colosseum (X-Agent-Id header only)",
    total_endpoints: "201+",
    payment: "Post-hackathon: USDC via x402",
    links: {
      docs: baseUrl + "/docs",
      skill: baseUrl + "/skill.md",
      github: "https://github.com/0xArtex/AgentOS"
    }
  });
});

export default router;
