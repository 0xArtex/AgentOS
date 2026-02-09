import { Router, Request, Response } from "express";

const router = Router();

const CAPABILITIES = {
  communication: {
    phone: {
      description: "Provision phone numbers, send/receive SMS and voice calls",
      actions: ["provision", "send_sms", "receive_sms", "make_call", "receive_call", "voicemail"],
      protocols: ["Twilio API"],
      latency: "< 500ms"
    },
    email: {
      description: "Provision email addresses, send/receive emails with attachments",
      actions: ["provision", "send", "receive", "forward", "template"],
      protocols: ["SMTP", "SendGrid API"],
      latency: "< 1s"
    }
  },
  infrastructure: {
    compute: {
      description: "Spin up isolated compute containers for agent workloads",
      actions: ["provision", "execute", "monitor", "scale", "terminate"],
      runtimes: ["Node.js", "Python", "Docker"],
      latency: "< 3s provisioning"
    },
    domains: {
      description: "Register and manage custom domains with DNS and SSL",
      actions: ["register", "configure_dns", "ssl_provision", "subdomain"],
      providers: ["Cloudflare", "Route53"],
      latency: "< 30s"
    }
  },
  intelligence: {
    analytics: {
      description: "Track agent actions, costs, and performance metrics",
      actions: ["track_event", "query_metrics", "cost_breakdown", "usage_report"],
      retention: "90 days"
    },
    monitoring: {
      description: "Health checks, uptime monitoring, incident alerts",
      actions: ["health_check", "uptime_report", "incident_subscribe", "performance_metrics"],
      interval: "30s checks"
    }
  },
  payments: {
    x402: {
      description: "HTTP 402 payment protocol — pay-per-request with USDC on Solana",
      actions: ["create_invoice", "verify_payment", "refund"],
      currencies: ["USDC"],
      chains: ["Solana"]
    }
  },
  meta: {
    total_capabilities: 6,
    total_actions: 32,
    hackathon_mode: "All capabilities FREE until Feb 12, 2026",
    docs: "http://77.42.89.233:3001/docs"
  }
};

router.get("/", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: CAPABILITIES,
    description: "Full capability matrix of AgentOS infrastructure services"
  });
});

router.get("/:category", (req: Request, res: Response) => {
  const category = req.params.category as keyof typeof CAPABILITIES;
  if (CAPABILITIES[category]) {
    res.json({ success: true, data: CAPABILITIES[category] });
  } else {
    res.status(404).json({ success: false, error: `Unknown category: ${category}. Available: ${Object.keys(CAPABILITIES).join(", ")}` });
  }
});

export default router;
