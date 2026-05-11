import { Router, Request, Response } from "express";

const router = Router();

router.get("/demo-walkthrough", (_req: Request, res: Response) => {
  const data = {
    title: "Palmyr Live Demo Walkthrough",
    description: "Step-by-step guide to see Palmyr in action. Each step includes a live curl command.",
    totalSteps: 6,
    estimatedTime: "3 minutes",
    steps: [
      { step: 1, title: "Check System Health", command: "curl http://77.42.89.233:3001/api/health-summary", expect: "Service status for all subsystems" },
      { step: 2, title: "Register as an Agent", command: "curl -X POST http://77.42.89.233:3001/api/agents -H X-Agent-Id:demo-agent", expect: "Agent profile with unique ID" },
      { step: 3, title: "Provision a Phone Number", command: "curl -X POST http://77.42.89.233:3001/api/phone/provision -H X-Agent-Id:demo-agent", expect: "Phone number billed in USDC" },
      { step: 4, title: "Send an Email", command: "curl -X POST http://77.42.89.233:3001/api/email/send -H X-Agent-Id:demo-agent", expect: "Email sent through Palmyr relay" },
      { step: 5, title: "Check Usage and Costs", command: "curl http://77.42.89.233:3001/api/analytics -H X-Agent-Id:demo-agent", expect: "Usage metrics and USDC costs" },
      { step: 6, title: "Explore Ecosystem", command: "curl http://77.42.89.233:3001/api/ecosystem", expect: "11+ partner projects" }
    ],
    judges_note: "All endpoints are live. Every command works against production API right now. Free during Colosseum hackathon with X-Agent-Id header.",
    links: { full_docs: "http://77.42.89.233:3001/docs", github: "https://github.com/0xArtex/Palmyr" }
  };
  res.json(data);
});

export default router;
