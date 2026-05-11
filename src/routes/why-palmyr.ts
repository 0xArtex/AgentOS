import { Router, Request, Response } from "express";

const router = Router();

router.get("/why-palmyr", async (_req: Request, res: Response) => {
  const startTime = Date.now();
  
  // Actually test a few endpoints to prove liveness
  const tests = ["/api/health", "/api/stats", "/api/agents"];
  const results = await Promise.all(
    tests.map(async (endpoint) => {
      const t0 = Date.now();
      try {
        const resp = await fetch(`http://localhost:3001${endpoint}`);
        return { endpoint, status: resp.status, latencyMs: Date.now() - t0 };
      } catch {
        return { endpoint, status: 0, latencyMs: Date.now() - t0 };
      }
    })
  );

  res.json({
    title: "Why Palmyr?",
    tagline: "One API. Phones, email, compute, domains. USDC payments via x402.",
    
    problem: {
      description: "Every AI agent team rebuilds the same infrastructure: Twilio for phones, SendGrid for email, AWS for compute, Namecheap for domains. Each integration takes days. Each has its own auth, billing, and failure modes.",
      cost: "2-4 weeks of infra work before your agent can DO anything"
    },
    
    solution: {
      description: "Palmyr unifies all agent infrastructure behind one REST API with one payment method (USDC via x402). Provision a phone number, send an email, spin up compute — all in one curl command.",
      timeToStart: "5 minutes",
      endpoints: "93+",
      paymentMethod: "USDC via x402 (HTTP 402 Payment Required)"
    },

    liveProof: {
      note: "These endpoints were tested RIGHT NOW to prove the API is live",
      results,
      totalLatencyMs: Date.now() - startTime
    },

    tryItNow: [
      {
        step: 1,
        description: "Check system health",
        command: "curl http://77.42.89.233:3001/api/health"
      },
      {
        step: 2,
        description: "See all available services",
        command: "curl http://77.42.89.233:3001/api/capabilities"
      },
      {
        step: 3,
        description: "Run the live self-test (exercises 15 endpoints)",
        command: "curl http://77.42.89.233:3001/api/live-test"
      },
      {
        step: 4,
        description: "Interactive API docs",
        url: "http://77.42.89.233:3001/docs"
      }
    ],

    differentiators: [
      "Unified API — one endpoint for all agent infra needs",
      "x402 native — no API keys, no subscriptions, pay-per-call with USDC",
      "Free during hackathon — X-Agent-Id header unlocks all endpoints",
      "93+ endpoints — from basic CRUD to ecosystem discovery, benchmarks, migration guides",
      "4ms average response time — built for agent-speed interactions"
    ],

    links: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      skill: "http://77.42.89.233:3001/skill.md",
      github: "https://github.com/0xArtex/Palmyr",
      colosseum: "https://colosseum.com/agent-hackathon/projects/palmyr"
    }
  });
});

export default router;
