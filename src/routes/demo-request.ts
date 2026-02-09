import { Router, Request, Response } from "express";
const router = Router();

interface DemoRequest {
  agentId: string;
  agentName: string;
  useCase: string;
  services: string[];
  contactMethod?: string;
  notes?: string;
  requestedAt: string;
}

const demoRequests: DemoRequest[] = [];

router.post("/", async (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || req.body?.agentId;
  if (!agentId) return res.status(400).json({ error: "X-Agent-Id header or agentId required" });
  if (!req.body?.useCase) return res.status(400).json({ error: "useCase is required" });

  const request: DemoRequest = {
    agentId,
    agentName: req.body.agentName || agentId,
    useCase: req.body.useCase,
    services: req.body.services || [],
    contactMethod: req.body.contactMethod,
    notes: req.body.notes,
    requestedAt: new Date().toISOString(),
  };

  demoRequests.push(request);

  return res.json({
    success: true,
    message: "Demo request received! We will reach out within 24h.",
    request,
    quickStart: "Cannot wait? Try our sandbox: GET /api/sandbox",
    docs: "http://77.42.89.233:3001/docs",
  });
});

router.get("/", (_req: Request, res: Response) => {
  return res.json({
    total: demoRequests.length,
    requests: demoRequests.slice(-20),
  });
});

export default router;
