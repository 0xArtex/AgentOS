import { Router, Request, Response } from "express";
const router = Router();

router.get("/final-countdown", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const now = Date.now();
  const remaining = Math.max(0, deadline - now);
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  const urgency = hours > 24 ? "building" : hours > 12 ? "crunch" : hours > 6 ? "sprint" : hours > 0 ? "final-push" : "submitted";
  const tips: Record<string, string[]> = {
    building: ["Focus on core features", "Test main loop end-to-end", "Document as you build"],
    crunch: ["Feature freeze - polish what you have", "Write your submission pitch", "Test edge cases"],
    sprint: ["Final bug fixes only", "Record your demo", "Double-check submission requirements"],
    "final-push": ["Submit NOW", "Last-minute README updates", "Verify all endpoints are live"],
    submitted: ["Hackathon is over!", "Check results on Colosseum"]
  };
  res.json({
    hackathon: "Colosseum Agent Hackathon",
    deadline: "2026-02-12T17:00:00Z",
    remaining: { hours, minutes, seconds, total_ms: remaining },
    urgency,
    tips: tips[urgency] || [],
    agentos: { status: "operational", endpoints: "112+", free_until: "2026-02-12T17:00:00Z", docs: "http://77.42.89.233:3001/docs" },
    message: hours > 0 ? `${hours}h ${minutes}m remaining. AgentOS is free infra for your agent. Ship it.` : "Hackathon complete."
  });
});

export default router;
