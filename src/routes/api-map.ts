import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";

const router = Router();

router.get("/api/api-map", (_req: Request, res: Response) => {
  // Dynamically list all route files as a browsable API map
  const routesDir = path.join(__dirname);
  const files = fs.readdirSync(routesDir)
    .filter(f => f.endsWith(".ts") || f.endsWith(".js"))
    .map(f => f.replace(/\.(ts|js)$/, ""))
    .sort();

  const categories: Record<string, string[]> = {
    "Core Services": ["phone", "email", "compute", "domain", "wallet", "messages"],
    "Identity & Trust": ["agents", "verify", "reputation", "directory", "agent-directory", "whoami"],
    "Analytics & Monitoring": ["analytics", "metrics", "logs", "alerts", "agent-activity", "system-metrics", "system-health", "service-health", "healthmatrix", "health-summary", "uptime", "ping"],
    "Developer Experience": ["sdk", "examples", "faq", "quickstart", "walkthrough", "demo", "demo-flow", "demo-interactive", "demo-walkthrough", "playground", "sandbox", "starter-kit", "debug", "integration-test", "integration-guide"],
    "Hackathon": ["hackathon", "hackathon-stats", "hackathon-status", "countdown", "deadline", "deadlines", "final-push", "final-sprint", "submit-checklist", "submission-ready", "judge-ready", "judge-brief", "judge-summary", "for-judges", "colosseum-ready", "live-demo"],
    "Ecosystem": ["ecosystem", "network", "partners", "partner-workflows", "agent-toolkit", "integrations", "compatibility", "templates", "leaderboard"],
    "Business": ["pricing", "calculator", "grants", "invoice", "demo-request", "pitch", "why-palmyr", "comparison", "migration"],
    "Configuration": ["config", "webhooks", "events", "feedback", "ratelimits", "sla", "security"]
  };

  const categorized = new Set<string>();
  for (const cat of Object.values(categories)) {
    cat.forEach(c => categorized.add(c));
  }
  
  const uncategorized = files.filter(f => !categorized.has(f) && f !== "api-map");

  res.json({
    name: "Palmyr API Map",
    version: "v1.2.3",
    totalRouteFiles: files.length,
    baseUrl: "http://77.42.89.233:3001",
    docs: "http://77.42.89.233:3001/docs",
    categories,
    uncategorized,
    tip: "All endpoints accept X-Agent-Id header. Free during hackathon!",
    hackathonDeadline: "2026-02-12T17:00:00Z"
  });
});

export default router;
