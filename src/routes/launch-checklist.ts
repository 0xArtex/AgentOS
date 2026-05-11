import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const DEADLINE = new Date("2026-02-12T17:00:00Z");
  const msLeft = Math.max(0, DEADLINE.getTime() - Date.now());
  const hoursLeft = Math.floor(msLeft / 3600000);

  res.json({
    title: "Palmyr Launch Checklist — Pre-Submission",
    hours_remaining: hoursLeft,
    status: hoursLeft < 24 ? "CRITICAL" : hoursLeft < 48 ? "URGENT" : "ON_TRACK",

    checklist: [
      { task: "Core API endpoints working", status: "done", details: "58+ endpoints live" },
      { task: "Agent registration flow", status: "done", details: "POST /api/agents/register" },
      { task: "Phone provisioning", status: "done", details: "POST /api/phone" },
      { task: "Email provisioning", status: "done", details: "POST /api/email" },
      { task: "Compute provisioning", status: "done", details: "POST /api/compute" },
      { task: "Domain provisioning", status: "done", details: "POST /api/domain" },
      { task: "Analytics & monitoring", status: "done", details: "/api/analytics, /api/metrics, /api/logs" },
      { task: "Agent verification", status: "done", details: "Challenge-response crypto verification" },
      { task: "Webhook subscriptions", status: "done", details: "/api/events/subscribe with HMAC" },
      { task: "SDK examples", status: "done", details: "Python, JS, Rust, cURL" },
      { task: "API documentation", status: "done", details: "Swagger at /docs" },
      { task: "Landing page", status: "done", details: "Live stats, countdown, activity feed" },
      { task: "Ecosystem partners", status: "done", details: "14 partner integrations" },
      { task: "Forum presence", status: "done", details: "265+ community comments" },
      { task: "Colosseum submission", status: "pending", details: "Project #432 — needs final submit" },
      { task: "GitHub repo public", status: "done", details: "github.com/0xArtex/Palmyr" },
      { task: "Demo video", status: "pending", details: "Record walkthrough before deadline" },
      { task: "Real Twilio creds", status: "blocked", details: "Need account setup" },
      { task: "Real SendGrid creds", status: "blocked", details: "Need account setup" },
      { task: "Treasury wallet", status: "blocked", details: "Need Solana wallet for USDC" }
    ],

    summary: {
      done: 14,
      pending: 2,
      blocked: 3,
      total: 19,
      completion: "74%"
    },

    priorities: [
      "1. Submit project on Colosseum (most critical)",
      "2. Record demo video",
      "3. Set up Twilio/SendGrid if possible",
      "4. Final testing pass"
    ]
  });
});

export default router;
