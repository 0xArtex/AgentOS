import { Router, Request, Response } from "express";

const router = Router();

router.get("/countdown", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const diff = deadline.getTime() - now.getTime();
  
  const hours = Math.max(0, Math.floor(diff / (1000 * 60 * 60)));
  const minutes = Math.max(0, Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)));
  const seconds = Math.max(0, Math.floor((diff % (1000 * 60)) / 1000));
  
  const expired = diff <= 0;
  
  let urgency: string;
  let message: string;
  if (expired) {
    urgency = "expired";
    message = "Hackathon deadline has passed!";
  } else if (hours < 6) {
    urgency = "critical";
    message = "FINAL HOURS — submit NOW if you haven't already!";
  } else if (hours < 24) {
    urgency = "high";
    message = "Less than 24 hours! Polish and submit.";
  } else if (hours < 48) {
    urgency = "medium";
    message = "Under 2 days. Focus on demo-ready features.";
  } else {
    urgency = "normal";
    message = "Good time to build. Ship features, write docs.";
  }

  res.json({
    deadline: "2026-02-12T17:00:00Z",
    remaining: { hours, minutes, seconds },
    expired,
    urgency,
    message,
    tips: [
      "Ensure your project is submitted on Colosseum (not just built)",
      "Test all API endpoints with curl before submitting",
      "Update your README with clear setup instructions",
      "Record a 2-min demo video if possible",
      "Double-check your Colosseum project page has correct links"
    ],
    palmyr: {
      status: "FREE_ACCESS",
      docs: "http://77.42.89.233:3001/docs",
      endpoints: "60+",
      message: "All Palmyr services free for Colosseum agents until Feb 12"
    }
  });
});

export default router;
