import { Router, Request, Response } from "express";

const router = Router();

/**
 * GET /migration — Migration guide from DIY infrastructure to Palmyr
 * Helps agents transition from self-managed infra to Palmyr APIs
 */
router.get("/", (req: Request, res: Response) => {
  res.json({
    title: "Migration Guide: DIY Infrastructure → Palmyr",
    description: "Step-by-step guide for agents currently managing their own infrastructure to migrate to Palmyr",
    estimatedMigrationTime: "< 30 minutes",
    steps: [
      {
        step: 1,
        title: "Register Your Agent",
        before: "Manual identity management, API keys scattered across services",
        after: "Single agent registration with unified identity",
        curl: "curl -X POST http://77.42.89.233:3001/api/agents -H \"Content-Type: application/json\" -H \"X-Agent-Id: your-agent\" -d \x27{\"name\": \"my-agent\", \"capabilities\": [\"trading\", \"research\"]}\x27",
        timeEstimate: "2 minutes"
      },
      {
        step: 2,
        title: "Replace Twilio/Vonage with Palmyr Phone",
        before: "Twilio account, phone number management, webhook setup, billing config",
        after: "One API call to provision a phone number with SMS + voice",
        curl: "curl -X POST http://77.42.89.233:3001/api/phone/provision -H \"X-Agent-Id: your-agent\" -H \"Content-Type: application/json\" -d \x27{\"country\": \"US\"}\x27",
        savings: "No separate Twilio account needed, no webhook infra, included in Palmyr"
      },
      {
        step: 3,
        title: "Replace SendGrid/Mailgun with Palmyr Email",
        before: "Email provider account, domain verification, template management",
        after: "Instant email inbox with send/receive capabilities",
        curl: "curl -X POST http://77.42.89.233:3001/api/email/inbox -H \"X-Agent-Id: your-agent\" -H \"Content-Type: application/json\" -d \x27{\"username\": \"my-agent\"}\x27",
        savings: "No domain setup, no SPF/DKIM config, works immediately"
      },
      {
        step: 4,
        title: "Replace AWS/Hetzner with Palmyr Compute",
        before: "Cloud provider account, SSH key management, server provisioning scripts, monitoring",
        after: "API-driven compute with automatic lifecycle management",
        curl: "curl -X POST http://77.42.89.233:3001/api/compute/provision -H \"X-Agent-Id: your-agent\" -H \"Content-Type: application/json\" -d \x27{\"type\": \"cx23\", \"image\": \"ubuntu-24.04\"}\x27",
        savings: "No cloud provider account, no SSH key management, auto-cleanup"
      },
      {
        step: 5,
        title: "Add Monitoring with Palmyr Analytics",
        before: "Grafana, Prometheus, custom dashboards",
        after: "Built-in analytics and activity tracking",
        curl: "curl http://77.42.89.233:3001/api/analytics?agentId=your-agent",
        savings: "Zero monitoring infrastructure needed"
      }
    ],
    rollbackPlan: "Palmyr does not lock you in. All provisioned resources can be exported. Phone numbers can be ported. Email can be forwarded. Compute runs standard Linux.",
    hackathonBonus: "During Colosseum hackathon: ALL of this is FREE. Just pass X-Agent-Id header. No USDC required until Feb 12.",
    getStarted: "http://77.42.89.233:3001/docs"
  });
});

export default router;
