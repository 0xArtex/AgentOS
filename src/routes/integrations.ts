import { Router } from "express";

const router = Router();

/**
 * @swagger
 * /integrations:
 *   get:
 *     summary: Integration guides for popular agent frameworks
 *     description: Code snippets and guides for integrating AgentOS with LangChain, CrewAI, AutoGPT, and more
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Integration guides
 */
router.get("/", (_req, res) => {
  res.json({
    title: "AgentOS Integration Guides",
    description: "Drop-in code snippets for popular agent frameworks. All endpoints accept X-Agent-Id header (free during hackathon).",
    baseUrl: "http://77.42.89.233:3001",
    frameworks: [
      {
        name: "LangChain / LangGraph",
        language: "python",
        description: "Use AgentOS as a tool in your LangChain agent",
        snippet: "import requests\n\nclass AgentOSTool:\n    BASE = \"http://77.42.89.233:3001\"\n    \n    def __init__(self, agent_id: str):\n        self.headers = {\"X-Agent-Id\": agent_id}\n    \n    def provision_phone(self, area_code=\"415\"):\n        return requests.post(f\"{self.BASE}/phone/provision\",\n            json={\"areaCode\": area_code}, headers=self.headers).json()\n    \n    def send_sms(self, phone_id: str, to: str, body: str):\n        return requests.post(f\"{self.BASE}/phone/{phone_id}/sms\",\n            json={\"to\": to, \"body\": body}, headers=self.headers).json()\n    \n    def provision_email(self, username: str):\n        return requests.post(f\"{self.BASE}/email/provision\",\n            json={\"username\": username}, headers=self.headers).json()\n    \n    def send_email(self, email_id: str, to: str, subject: str, body: str):\n        return requests.post(f\"{self.BASE}/email/{email_id}/send\",\n            json={\"to\": to, \"subject\": subject, \"body\": body}, headers=self.headers).json()",
        steps: ["pip install requests", "Initialize with your agent ID", "Use methods as LangChain tools"]
      },
      {
        name: "CrewAI",
        language: "python",
        description: "Give your CrewAI agents real-world communication abilities",
        snippet: "from crewai import Tool\nimport requests\n\ndef provision_phone(agent_id: str) -> dict:\n    return requests.post(\"http://77.42.89.233:3001/phone/provision\",\n        json={\"areaCode\": \"415\"},\n        headers={\"X-Agent-Id\": agent_id}).json()\n\nphone_tool = Tool(\n    name=\"provision_phone\",\n    description=\"Get a real phone number for SMS/calls\",\n    func=lambda: provision_phone(\"my-crew-agent\")\n)",
        steps: ["Add AgentOS tools to your crew", "Agents can provision resources autonomously", "Pay with USDC or use free hackathon mode"]
      },
      {
        name: "OpenClaw / Claude",
        language: "typescript",
        description: "Use AgentOS skill.md for automatic tool discovery",
        snippet: "// Fetch http://77.42.89.233:3001/skill.md for auto-discovery\n\nconst res = await fetch(\"http://77.42.89.233:3001/phone/provision\", {\n  method: \"POST\",\n  headers: { \"Content-Type\": \"application/json\", \"X-Agent-Id\": \"my-agent\" },\n  body: JSON.stringify({ areaCode: \"415\" })\n});\nconst phone = await res.json();",
        steps: ["Add skill.md URL to your agent config", "Agent auto-discovers all endpoints", "Provision resources with one API call"]
      },
      {
        name: "cURL / Any Language",
        language: "bash",
        description: "Works with any HTTP client",
        snippet: "# Provision a phone number\ncurl -X POST http://77.42.89.233:3001/phone/provision \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Agent-Id: my-agent' \\\n  -d '{\"areaCode\": \"415\"}'",
        steps: ["Set X-Agent-Id header", "Call any endpoint", "Free during Colosseum hackathon"]
      }
    ],
    quickstart: {
      description: "Get started in 30 seconds",
      steps: [
        "Pick your framework above",
        "Set X-Agent-Id header to any unique string",
        "Call POST /phone/provision or POST /email/provision",
        "Start sending messages"
      ],
      docsUrl: "http://77.42.89.233:3001/docs",
      skillUrl: "http://77.42.89.233:3001/skill.md"
    }
  });
});

export default router;
