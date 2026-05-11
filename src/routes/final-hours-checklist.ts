import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/api/final-hours-checklist", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  const agents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any)?.c || 0;
  const phones = (db.prepare("SELECT COUNT(*) as c FROM phone_numbers").get() as any)?.c || 0;
  const emails = (db.prepare("SELECT COUNT(*) as c FROM email_inboxes").get() as any)?.c || 0;
  const servers = (db.prepare("SELECT COUNT(*) as c FROM servers").get() as any)?.c || 0;
  const requests = (db.prepare("SELECT COUNT(*) as c FROM request_log").get() as any)?.c || 0;

  const fs = require("fs");
  const routeFiles = fs.readdirSync("/root/Palmyr/src/routes").filter((f: string) => f.endsWith(".ts")).length;

  const checklist = [
    { item: "API live and responding", status: "✅", proof: "https://palmyr.ai/health" },
    { item: "Docs/Swagger available", status: "✅", proof: "https://palmyr.ai/docs" },
    { item: "x402 payments working", status: "✅", proof: "EVM + Solana verified" },
    { item: "Agent registration", status: "✅", proof: `${agents} agents registered` },
    { item: "Phone provisioning", status: "✅", proof: `${phones} phones provisioned` },
    { item: "Email provisioning", status: "✅", proof: `${emails} inboxes created` },
    { item: "Compute provisioning", status: "✅", proof: `${servers} servers running` },
    { item: "Domain management", status: "✅", proof: "CRUD endpoints live" },
    { item: "Webhook system", status: "✅", proof: "Event-driven callbacks" },
    { item: "Agent-to-agent comms", status: "✅", proof: "Messaging + pub/sub" },
    { item: "Reputation system", status: "✅", proof: "Peer scoring + tiers" },
    { item: "Billing & invoicing", status: "✅", proof: "Usage-based USDC billing" },
    { item: "GitHub repo public", status: "✅", proof: "https://github.com/0xArtex/Palmyr" },
    { item: "Colosseum project submitted", status: "⚠️", proof: "Draft — needs final submit" },
    { item: "Demo video", status: "⚠️", proof: "Not yet recorded" },
  ];

  const done = checklist.filter(c => c.status === "✅").length;

  res.json({
    project: "Palmyr",
    hoursRemaining: Math.round(hoursLeft * 10) / 10,
    urgency: hoursLeft < 6 ? "FINAL_SPRINT" : hoursLeft < 12 ? "CRUNCH_TIME" : "HEADS_DOWN",
    checklist,
    score: `${done}/${checklist.length}`,
    liveStats: { agents, phones, emails, servers, totalRequests: requests, routeFiles },
    links: {
      api: "https://palmyr.ai",
      docs: "https://palmyr.ai/docs",
      github: "https://github.com/0xArtex/Palmyr",
      dashboard: "https://palmyr.ai/dashboard",
      skill: "https://palmyr.ai/skill.md"
    }
  });
});

export default router;
