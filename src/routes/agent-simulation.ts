import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/api/agent-simulation", (req: Request, res: Response) => {
  const agentName = (req.query.name as string) || "demo-agent";
  const ts = Date.now();
  
  // Simulate a complete agent lifecycle with realistic timing
  const steps = [
    {
      step: 1,
      action: "register",
      endpoint: "POST /api/agents/register",
      curl: `curl -X POST http://77.42.89.233:3001/api/agents/register -H 'Content-Type: application/json' -d '{"name": "${agentName}", "capabilities": ["trading", "alerts"]}'`,
      result: { agent_id: `${agentName}-${ts}`, status: "registered", api_key: "ak_demo_xxx" },
      latency_ms: 12,
      description: "Agent registers and gets API credentials"
    },
    {
      step: 2,
      action: "provision_phone",
      endpoint: "POST /api/phones/provision",
      curl: "curl -X POST http://77.42.89.233:3001/api/phones/provision -H 'X-Agent-Id: " + agentName + "' -H 'Content-Type: application/json' -d '{\"area_code\": \"415\"}'",
      result: { phone_number: "+1-415-555-0142", provider: "telnyx", sms_enabled: true, voice_enabled: true },
      latency_ms: 340,
      description: "Agent gets a dedicated phone number for SMS/voice"
    },
    {
      step: 3,
      action: "provision_email",
      endpoint: "POST /api/email/provision",
      curl: "curl -X POST http://77.42.89.233:3001/api/email/provision -H 'X-Agent-Id: " + agentName + "' -H 'Content-Type: application/json' -d '{\"prefix\": \"" + agentName + "\"}'",
      result: { email: `${agentName}@agents.palmyr.dev`, provider: "sendgrid", verified: true },
      latency_ms: 180,
      description: "Agent gets a verified email address"
    },
    {
      step: 4,
      action: "provision_compute",
      endpoint: "POST /api/compute/provision",
      curl: "curl -X POST http://77.42.89.233:3001/api/compute/provision -H 'X-Agent-Id: " + agentName + "' -H 'Content-Type: application/json' -d '{\"tier\": \"standard\"}'",
      result: { server_id: "srv-demo", cpu: 2, ram_gb: 4, storage_gb: 40, ssh_access: true },
      latency_ms: 2100,
      description: "Agent provisions a cloud server for computation"
    },
    {
      step: 5,
      action: "send_alert",
      endpoint: "POST /api/phones/sms",
      curl: "curl -X POST http://77.42.89.233:3001/api/phones/sms -H 'X-Agent-Id: " + agentName + "' -H 'Content-Type: application/json' -d '{\"to\": \"+1234567890\", \"body\": \"SOL hit 50 — executing strategy\"}'",
      result: { message_id: "msg-demo", status: "delivered", cost_usdc: 0.008 },
      latency_ms: 450,
      description: "Agent sends SMS alert about market conditions"
    },
    {
      step: 6,
      action: "check_analytics",
      endpoint: "GET /api/analytics",
      result: { total_api_calls: 6, total_cost_usdc: 0, resources_provisioned: 3, uptime_percent: 99.9 },
      latency_ms: 8,
      description: "Agent reviews its usage and costs"
    }
  ];

  const totalLatency = steps.reduce((sum, s) => sum + s.latency_ms, 0);

  res.json({
    title: "Palmyr Agent Lifecycle Simulation",
    description: "Complete walkthrough of an autonomous agent bootstrapping itself on Palmyr",
    agent_name: agentName,
    total_steps: steps.length,
    total_latency_ms: totalLatency,
    total_latency_human: `${(totalLatency / 1000).toFixed(1)}s`,
    summary: `In ${(totalLatency / 1000).toFixed(1)} seconds, ${agentName} went from nothing to a fully-equipped autonomous agent with phone, email, compute, and alerting capabilities.`,
    steps,
    hackathon_note: "All steps are FREE during hackathon mode (until Feb 12). Just add X-Agent-Id header.",
    try_it: "Replace 'demo-agent' with your agent name: /api/agent-simulation?name=your-agent"
  });
});

export default router;
