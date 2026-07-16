import { Router, Request, Response } from "express";
import os from "os";
import fs from "fs";
import path from "path";
import { db } from "../db";

const router = Router({ mergeParams: true });

function safeCount(table: string): number {
  try { return (db.prepare("SELECT COUNT(*) as c FROM " + table).get() as any).c; } catch { return 0; }
}

router.get("/", (_req: Request, res: Response) => {
  const routeCount = (() => { try { return fs.readdirSync(path.join(__dirname, ".")).filter(f => f.endsWith(".ts") || f.endsWith(".js")).length; } catch { return 0; } })();

  res.json({
    question: "Why does Palmyr exist?",
    answer: "AI agents need real-world infrastructure to operate autonomously. Phone numbers, email, compute, domains. Today these require human signup flows and credit cards. Palmyr makes it one API call, paid in USDC.",
    the_problem: {
      description: "Agents cannot use Twilio, AWS, or GoDaddy directly",
      reasons: [
        "Signup requires human identity verification",
        "Billing requires credit cards agents cannot hold",
        "Configuration requires manual dashboard interaction",
        "No unified API - agents juggle 6+ providers"
      ]
    },
    the_solution: {
      description: "One API for all operational infrastructure",
      services: {
        phone: "SMS + voice calls via /phone",
        email: "Send/receive via /email",
        compute: "Isolated instances via /compute",
        domains: "Custom domains via /domains",
        wallet: "Wallet management via /wallet",
        identity: "DID-compatible verification via /api/agents/verify"
      },
      payment: "USDC via x402 protocol",
      onboarding: "Fund a wallet and call the API — the wallet that pays owns the resource."
    },
    proof_its_real: {
      route_modules: routeCount,
      agents_registered: safeCount("agents"),
      phones_provisioned: safeCount("phone_numbers"),
      emails_provisioned: safeCount("email_inboxes"),
      uptime_hours: Math.round(os.uptime() / 3600)
    },
    try_it: {
      api: "curl https://palmyr.ai/api",
      docs: "https://palmyr.ai/docs",
      skill: "curl https://palmyr.ai/skill.md"
    }
  });
});

export default router;
