import { Router, Request, Response } from "express";

const router = Router();

router.get("/agent-readiness", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || "anonymous";

  const services = [
    { name: "Phone", endpoint: "/api/phone/provision", status: "available", priority: "high", setupTime: "~2s" },
    { name: "Email", endpoint: "/api/email/send", status: "available", priority: "high", setupTime: "instant" },
    { name: "Compute", endpoint: "/api/compute/provision", status: "available", priority: "medium", setupTime: "~5s" },
    { name: "Domain", endpoint: "/api/domain/register", status: "available", priority: "low", setupTime: "~10s" },
    { name: "Wallet", endpoint: "/api/wallet/create", status: "available", priority: "high", setupTime: "~1s" },
    { name: "Webhooks", endpoint: "/api/webhooks/register", status: "available", priority: "medium", setupTime: "instant" }
  ];

  const quickBootstrap = {
    description: "Full agent bootstrap in 4 API calls (~10s total)",
    steps: [
      { order: 1, action: "Provision phone", curl: `curl -X POST http://77.42.89.233:3001/api/phone/provision -H "X-Agent-Id: ${agentId}"` },
      { order: 2, action: "Send test email", curl: `curl -X POST http://77.42.89.233:3001/api/email/send -H "X-Agent-Id: ${agentId}"` },
      { order: 3, action: "Provision compute", curl: `curl -X POST http://77.42.89.233:3001/api/compute/provision -H "X-Agent-Id: ${agentId}"` },
      { order: 4, action: "Create wallet", curl: `curl -X POST http://77.42.89.233:3001/api/wallet/create -H "X-Agent-Id: ${agentId}"` }
    ]
  };

  res.json({
    agentId,
    readinessScore: 100,
    status: "ready_to_bootstrap",
    services,
    recommendations: agentId === "anonymous" ? ["Set X-Agent-Id header to track resources"] : ["You're identified — start provisioning!"],
    quickBootstrap,
    hackathonMode: { active: true, pricing: "FREE", deadline: "2026-02-12T17:00:00Z" },
    timestamp: new Date().toISOString()
  });
});

export default router;
