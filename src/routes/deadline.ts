import { Router, Request, Response } from "express";

const router = Router();

// /api/deadline — real-time deadline tracker with urgency
router.get("/", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const now = Date.now();
  const remaining = deadline - now;
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const expired = remaining <= 0;

  const urgency = expired ? "EXPIRED" :
    hours < 6 ? "CRITICAL" :
    hours < 12 ? "HIGH" :
    hours < 24 ? "MEDIUM" : "NORMAL";

  const tips: Record<string, string[]> = {
    CRITICAL: ["Submit NOW if you haven't", "Final bug fixes only", "Record demo video"],
    HIGH: ["Polish landing page", "Test all endpoints", "Write submission description"],
    MEDIUM: ["Add final features", "Forum outreach", "Update documentation"],
    NORMAL: ["Build new features", "Community engagement", "Improve test coverage"]
  };

  res.json({
    project: "AgentOS",
    deadline: "2026-02-12T17:00:00Z",
    remaining: expired ? "EXPIRED" : `${hours}h ${minutes}m`,
    urgency,
    hoursLeft: Math.max(0, hours),
    tips: tips[urgency] || tips.NORMAL,
    buildStats: {
      endpoints: "106+",
      forumComments: "440+",
      versions: "v1.2.0",
      linesOfCode: "8000+",
      daysBuilding: 10
    },
    quickLinks: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/AgentOS",
      pitch: "http://77.42.89.233:3001/api/pitch",
      liveTest: "http://77.42.89.233:3001/api/live-test"
    }
  });
});

export default router;
