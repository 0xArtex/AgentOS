import { Router, Request, Response } from 'express';

const router = Router();

router.get('/api/demo-script', (_req: Request, res: Response) => {
  res.json({
    title: "AgentOS — 3-Minute Demo Script for Judges",
    description: "Follow these steps to see AgentOS in action. Each step includes a live curl command you can run right now.",
    estimated_time: "3 minutes",
    steps: [
      {
        step: 1,
        title: "Register Your Agent",
        description: "Create an agent identity with one API call. Returns your agent ID and API key.",
        curl: 'curl -X POST http://77.42.89.233:3001/api/agents/register -H "Content-Type: application/json" -H "X-Agent-Id: demo-judge" -d \'{"name": "JudgeBot", "capabilities": ["compute", "email"]}\'',
        expected: "Agent ID + API key returned instantly"
      },
      {
        step: 2,
        title: "Provision a Phone Number",
        description: "Your agent gets a real phone number it can use for SMS/voice — programmatically.",
        curl: 'curl -X POST http://77.42.89.233:3001/api/phones/provision -H "Content-Type: application/json" -H "X-Agent-Id: demo-judge" -d \'{"country": "US", "capabilities": ["sms", "voice"]}\'',
        expected: "Phone number assigned to your agent"
      },
      {
        step: 3,
        title: "Set Up Email",
        description: "Provision an email address your agent can send/receive from.",
        curl: 'curl -X POST http://77.42.89.233:3001/api/emails/provision -H "Content-Type: application/json" -H "X-Agent-Id: demo-judge" -d \'{"prefix": "judgebot"}\'',
        expected: "Email address provisioned"
      },
      {
        step: 4,
        title: "Spin Up Compute",
        description: "Launch a container for your agent's workloads.",
        curl: 'curl -X POST http://77.42.89.233:3001/api/compute/provision -H "Content-Type: application/json" -H "X-Agent-Id: demo-judge" -d \'{"cpu": 2, "memory_gb": 4, "image": "ubuntu:22.04"}\'',
        expected: "Container ID + SSH access returned"
      },
      {
        step: 5,
        title: "Check Your Agent Dashboard",
        description: "See everything your agent has provisioned in one view.",
        curl: 'curl http://77.42.89.233:3001/api/agents/demo-judge/dashboard -H "X-Agent-Id: demo-judge"',
        expected: "Full resource summary for your agent"
      },
      {
        step: 6,
        title: "View Live System Health",
        description: "Real infrastructure metrics — DB latency, memory, disk, uptime.",
        curl: 'curl http://77.42.89.233:3001/api/service-probe',
        expected: "Per-subsystem health with latency numbers"
      }
    ],
    bonus: {
      live_dashboard: "http://77.42.89.233:3001/dashboard",
      swagger_docs: "http://77.42.89.233:3001/docs",
      skill_file: "http://77.42.89.233:3001/skill.md",
      api_map: "http://77.42.89.233:3001/api/api-map"
    },
    hackathon_mode: "All endpoints FREE until Feb 12 — just include X-Agent-Id header"
  });
});

export default router;
