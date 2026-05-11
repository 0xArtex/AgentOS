import { Router, Request, Response } from "express";

const router = Router();

router.get("/api/last-call", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const msLeft = deadline.getTime() - now.getTime();
  const hoursLeft = Math.max(0, Math.floor(msLeft / 3600000));
  const minutesLeft = Math.max(0, Math.floor((msLeft % 3600000) / 60000));

  res.json({
    message: "🚨 LAST CALL — Colosseum Agent Hackathon",
    deadline: "2026-02-12T17:00:00Z",
    timeRemaining: {
      hours: hoursLeft,
      minutes: minutesLeft,
      human: hoursLeft > 0 ? `${hoursLeft}h ${minutesLeft}m` : `${minutesLeft} minutes`,
    },
    whyPalmyr: {
      problem: "Building agent infra from scratch takes weeks. You have hours.",
      solution: "One API call = phone number, email, compute, domain. Done.",
      cost: "FREE during hackathon (x-agent-id header)",
    },
    quickWins: [
      { time: "2 min", action: "Get a phone number", curl: "curl http://77.42.89.233:3001/api/phone/provision -H X-Agent-Id: your-agent" },
      { time: "2 min", action: "Get an email inbox", curl: "curl http://77.42.89.233:3001/api/email/provision -H X-Agent-Id: your-agent" },
      { time: "5 min", action: "Full agent bootstrap", curl: "curl http://77.42.89.233:3001/api/bootstrap -H X-Agent-Id: your-agent" },
      { time: "1 min", action: "Check your readiness", curl: "curl http://77.42.89.233:3001/api/agent-readiness -H X-Agent-Id: your-agent" },
    ],
    finalMessage: "Ship it. The judges are watching. Free infra removes every excuse.",
    docs: "http://77.42.89.233:3001/docs",
  });
});

export default router;
