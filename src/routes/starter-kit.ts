import { Router, Request, Response } from "express";

const router = Router({ mergeParams: true });

router.get("/", (req: Request, res: Response) => {
  const framework = (req.query.framework as string || "raw").toLowerCase();
  const baseUrl = "http://77.42.89.233:3001";

  const frameworkConfigs: Record<string, any> = {
    langchain: {
      framework: "LangChain",
      install: "pip install langchain requests",
      note: "Use LangChain HTTP Tool with AgentOS base URL",
    },
    crewai: {
      framework: "CrewAI",
      install: "pip install crewai requests",
      note: "Create BaseTool subclasses per AgentOS service",
    },
    raw: {
      framework: "Raw HTTP (curl/fetch/requests)",
      note: "Direct REST API — works with any language or framework",
    },
  };

  const config = frameworkConfigs[framework] || frameworkConfigs.raw;

  res.json({
    title: "AgentOS Starter Kit",
    description: "Everything you need to integrate AgentOS in 5 minutes",
    selectedFramework: config,
    availableFrameworks: ["raw", "langchain", "crewai"],
    usage: "Add ?framework=langchain for framework-specific tips",
    envConfig: {
      AGENTOS_BASE_URL: baseUrl,
      AGENTOS_AGENT_ID: "your-agent-id-here",
      note: "Get agent ID via POST /api/agents/register",
    },
    quickStart: [
      { step: 1, action: "Health check", command: "curl " + baseUrl + "/ping" },
      { step: 2, action: "Register agent", command: "curl -X POST " + baseUrl + "/api/agents/register -H 'Content-Type: application/json' -d '{\"name\":\"my-agent\"}'" },
      { step: 3, action: "Provision phone", command: "curl -X POST " + baseUrl + "/phone-numbers -H 'X-Agent-Id: YOUR_ID' -H 'Content-Type: application/json' -d '{\"country\":\"US\"}'" },
      { step: 4, action: "Send SMS", command: "curl -X POST " + baseUrl + "/phone-numbers/1/sms -H 'X-Agent-Id: YOUR_ID' -H 'Content-Type: application/json' -d '{\"to\":\"+1234567890\",\"body\":\"Hello!\"}'" },
    ],
    services: {
      phone: "POST /phone-numbers → provision, POST /phone-numbers/:id/sms → send",
      email: "POST /email → provision, POST /email/:id/send → send",
      compute: "POST /compute → provision, POST /compute/:id/exec → run commands",
      domains: "POST /domains → register, PUT /domains/:id/dns → configure",
    },
    hackathonNote: "FREE for all Colosseum agents until Feb 12, 2026 — no USDC required",
    docs: baseUrl + "/docs",
    moreEndpoints: baseUrl + "/api/sandbox",
  });
});

export default router;
