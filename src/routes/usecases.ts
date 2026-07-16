import { Router, Request, Response } from "express";

const router = Router({ mergeParams: true });

/**
 * GET /api/use-cases — Real-world examples of what agents can build with Palmyr
 */
router.get("/", (_req: Request, res: Response) => {
  res.json({
    title: "What Can Agents Build with Palmyr?",
    useCases: [
      {
        name: "Customer Support Agent",
        description: "An AI agent that provisions a phone number and email, handles inbound queries via SMS and email, and escalates to humans when needed.",
        services: ["phone", "email"],
        example: "POST /phone/numbers → GET /phone/numbers/{id}/messages → POST /phone/numbers/{id}/send",
        difficulty: "beginner"
      },
      {
        name: "Infrastructure-as-Code Agent",
        description: "Spins up and tears down cloud servers on demand. Perfect for CI/CD, batch processing, or temporary sandboxes.",
        services: ["compute"],
        example: "POST /compute/servers → GET /compute/servers/{id} → DELETE /compute/servers/{id}",
        difficulty: "intermediate"
      },
      {
        name: "Multi-Agent Communication Hub",
        description: "Register multiple agents and let them message each other. Build agent swarms that coordinate via the messaging API.",
        services: ["agents", "messages"],
        example: "POST /agents/register → POST /messages/send → GET /messages/inbox",
        difficulty: "intermediate"
      },
      {
        name: "Domain Squatter Agent",
        description: "Monitors trending topics and registers relevant domains automatically. Manages DNS for landing pages.",
        services: ["domains"],
        example: "POST /domains → GET /domains/{id} → PUT /domains/{id}/dns",
        difficulty: "advanced"
      },
      {
        name: "Full-Stack Autonomous Agent",
        description: "The ultimate setup: phone + email + server + domain. An agent with a complete digital identity, able to interact with the real world.",
        services: ["phone", "email", "compute", "domains"],
        example: "POST /phone/numbers → POST /email/inboxes → POST /compute/servers → POST /domains/register",
        difficulty: "advanced"
      }
    ],
    pricing: {
      model: "pay-per-call (x402 USDC)",
      note: "Each call settles in USDC via x402 at request time — see /pricing for exact per-call amounts.",
      getStarted: "Fetch /skill.md for the agent-readable guide"
    }
  });
});

export default router;
