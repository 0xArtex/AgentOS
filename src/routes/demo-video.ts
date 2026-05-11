import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000).toFixed(1);

  res.json({
    title: "Palmyr — See It Live",
    description: "No slides. No mockups. Just working APIs you can call right now.",
    hoursToDeadline: parseFloat(hoursLeft),
    liveDemo: {
      step1_health: {
        description: "Check platform health",
        command: "curl https://palmyr.ai/health",
        whatYouGet: "Live uptime, memory, service status"
      },
      step2_register: {
        description: "Register your agent (free during hackathon)",
        command: "curl -X POST https://palmyr.ai/api/register -H \"Content-Type: application/json\" -d \"{\\\"name\\\": \\\"my-agent\\\"}\"",
        whatYouGet: "API key + agent ID, instant provisioning"
      },
      step3_phone: {
        description: "Get a phone number",
        command: "curl -X POST https://palmyr.ai/api/phone/provision -H \"X-Agent-Id: YOUR_ID\"",
        whatYouGet: "Working phone number for SMS/calls"
      },
      step4_email: {
        description: "Get an email address",
        command: "curl -X POST https://palmyr.ai/api/email/provision -H \"X-Agent-Id: YOUR_ID\"",
        whatYouGet: "Working email address on palmyr.ai"
      },
      step5_compute: {
        description: "Spin up compute",
        command: "curl -X POST https://palmyr.ai/api/compute/provision -H \"X-Agent-Id: YOUR_ID\"",
        whatYouGet: "Isolated compute container"
      },
      step6_pay: {
        description: "Pay with USDC via x402",
        command: "curl https://palmyr.ai/api/phone/provision -H \"X-Agent-Id: YOUR_ID\"",
        whatYouGet: "402 Payment Required → sign → provision. Crypto-native."
      }
    },
    differentiators: [
      "203+ endpoints — more than most SaaS companies ship in a year",
      "x402 USDC payments — agents pay for their own infra",
      "Zero downtime since launch",
      "One API for phone + email + compute + domains + analytics",
      "Free during hackathon — no excuses not to try it"
    ],
    links: {
      api: "https://palmyr.ai",
      docs: "https://palmyr.ai/docs",
      health: "https://palmyr.ai/health",
      judges: "https://palmyr.ai/api/judges",
      github: "https://github.com/0xArtex/Palmyr"
    }
  });
});

export default router;
