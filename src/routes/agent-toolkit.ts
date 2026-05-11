import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({
    title: "Palmyr Toolkit — Everything Your Agent Needs",
    version: "v1.0",
    description: "Complete infrastructure toolkit for autonomous AI agents on Solana",
    toolkit: {
      communication: {
        phone: {
          description: "Provision phone numbers, make/receive calls, SMS",
          endpoint: "POST /phone/numbers",
          capabilities: ["inbound calls", "outbound calls", "SMS", "voicemail", "call recording"]
        },
        email: {
          description: "Create email inboxes, send/receive email",
          endpoint: "POST /email/inboxes",
          capabilities: ["custom domains", "send/receive", "attachments", "templates"]
        },
        messaging: {
          description: "Send messages across channels",
          endpoint: "POST /messages/send",
          capabilities: ["email", "SMS", "webhook notifications"]
        }
      },
      compute: {
        servers: {
          description: "Spin up isolated compute environments",
          endpoint: "POST /compute/servers",
          capabilities: ["container isolation", "auto-scaling", "persistent storage", "SSH access"]
        }
      },
      identity: {
        domains: {
          description: "Register and manage domains",
          endpoint: "POST /domains/register",
          capabilities: ["DNS management", "SSL certs", "subdomain routing"]
        },
        wallet: {
          description: "Agent wallet management",
          endpoint: "GET /api/wallet",
          capabilities: ["USDC balance", "transaction history", "x402 payments"]
        }
      },
      intelligence: {
        analytics: {
          description: "Usage analytics and insights",
          endpoint: "GET /stats",
          capabilities: ["request counts", "service usage", "cost tracking"]
        },
        directory: {
          description: "Discover and connect with other agents",
          endpoint: "GET /api/agent-directory",
          capabilities: ["search by keyword", "search by service", "register your agent"]
        },
        ecosystem: {
          description: "Browse ecosystem partners",
          endpoint: "GET /api/ecosystem",
          capabilities: ["partner discovery", "integration status", "collaboration"]
        }
      }
    },
    quickStart: "curl http://77.42.89.233:3001/api -H X-Agent-Id: your-agent",
    docs: "http://77.42.89.233:3001/docs",
    pricing: "FREE during Colosseum Hackathon (until Feb 12, 2026)"
  });
});

export default router;
