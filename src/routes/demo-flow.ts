import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  const step = parseInt(req.query.step as string) || 1;
  const steps: Record<number, any> = {
    1: {
      step: 1,
      title: "Register Your Agent",
      description: "Create an agent identity to start using AgentOS services",
      curl: "curl -X POST http://77.42.89.233:3001/agents/register -H \"Content-Type: application/json\" -H \"X-Agent-Id: demo-agent\" -d \"{\\\"name\\\":\\\"my-agent\\\",\\\"framework\\\":\\\"raw\\\"}\"",
      next: "/demo-flow?step=2"
    },
    2: {
      step: 2,
      title: "Provision a Phone Number",
      description: "Get a real phone number for SMS alerts and verification",
      curl: "curl -X POST http://77.42.89.233:3001/phone/numbers -H \"Content-Type: application/json\" -H \"X-Agent-Id: demo-agent\" -d \"{\\\"country\\\":\\\"US\\\"}\"",
      next: "/demo-flow?step=3"
    },
    3: {
      step: 3,
      title: "Set Up Email",
      description: "Provision an email for your agent to send reports and notifications",
      curl: "curl -X POST http://77.42.89.233:3001/email/inboxes -H \"Content-Type: application/json\" -H \"X-Agent-Id: demo-agent\" -d \"{\\\"prefix\\\":\\\"my-agent\\\"}\"",
      next: "/demo-flow?step=4"
    },
    4: {
      step: 4,
      title: "Launch Compute",
      description: "Spin up a compute container for running agent workloads",
      curl: "curl -X POST http://77.42.89.233:3001/compute/servers -H \"Content-Type: application/json\" -H \"X-Agent-Id: demo-agent\" -d \"{\\\"image\\\":\\\"ubuntu:22.04\\\",\\\"size\\\":\\\"small\\\"}\"",
      next: "/demo-flow?step=5"
    },
    5: {
      step: 5,
      title: "Check Analytics",
      description: "View usage, costs, and resource status across all services",
      curl: "curl http://77.42.89.233:3001/analytics -H \"X-Agent-Id: demo-agent\"",
      next: null,
      complete: true,
      message: "Your agent now has phone, email, and compute — fully autonomous infrastructure!"
    }
  };
  const current = steps[Math.min(Math.max(step, 1), 5)];
  res.json({
    demo: current,
    totalSteps: 5,
    progress: `${Math.min(step, 5)}/5`,
    hackathonMode: "FREE — no USDC required until Feb 12, 2026",
    tryIt: "http://77.42.89.233:3001/demo-flow?step=1"
  });
});

export default router;
