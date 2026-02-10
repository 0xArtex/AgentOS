import { Router, Request, Response } from "express";
const router = Router();

const guides: Record<string, any> = {
  langchain: {
    name: "LangChain",
    language: "python",
    install: "pip install langchain requests",
    code: "from langchain.tools import tool\nimport requests\n\nBASE = \"http://77.42.89.233:3001/api\"\n\n@tool\ndef provision_phone(country: str = \"US\") -> str:\n    r = requests.post(f\"{BASE}/phone/provision\", json={\"country\": country}, headers={\"X-Agent-Id\": \"your-id\"})\n    return r.json()"
  },
  crewai: {
    name: "CrewAI",
    language: "python",
    install: "pip install crewai requests",
    code: "from crewai_tools import tool\nimport requests\n\n@tool(\"Bootstrap Agent Infra\")\ndef bootstrap(agent_id: str) -> str:\n    h = {\"X-Agent-Id\": agent_id}\n    base = \"http://77.42.89.233:3001/api\"\n    phone = requests.post(f\"{base}/phone/provision\", headers=h).json()\n    return str(phone)"
  },
  eliza: {
    name: "Eliza (ai16z)",
    language: "typescript",
    install: "npm install @ai16z/eliza",
    code: "const agentosAction = {\n  name: \"PROVISION_INFRA\",\n  handler: async (runtime: any) => {\n    const r = await fetch(\"http://77.42.89.233:3001/api/quickstart\", {\n      headers: { \"X-Agent-Id\": runtime.agentId }\n    });\n    return await r.json();\n  }\n};"
  },
  openclaw: {
    name: "OpenClaw",
    language: "yaml",
    install: "Skill URL: http://77.42.89.233:3001/skill.md",
    code: "# Auto-discovered via skill system. Just ask your agent to provision infrastructure."
  },
  curl: {
    name: "Raw HTTP / cURL",
    language: "bash",
    install: "curl",
    code: "# Register\ncurl -X POST http://77.42.89.233:3001/api/agents/register \\\n  -H \"X-Agent-Id: my-agent\" -H \"Content-Type: application/json\" \\\n  -d '{\"name\":\"my-agent\"}'\n\n# Provision phone\ncurl -X POST http://77.42.89.233:3001/api/phone/provision -H \"X-Agent-Id: my-agent\""
  }
};

router.get("/integrations", (_req: Request, res: Response) => {
  res.json({
    title: "Framework Integration Guides",
    description: "Copy-paste code to integrate AgentOS with your AI framework",
    frameworks: Object.keys(guides),
    guides,
    tip: "GET /api/integrations/:framework for a specific guide"
  });
});

router.get("/integrations/:fw", (req: Request, res: Response) => {
  const fw = (req.params.fw as string).toLowerCase();
  const guide = guides[fw];
  if (!guide) {
    res.status(404).json({ error: "Unknown framework", available: Object.keys(guides) });
    return;
  }
  res.json({ framework: fw, ...guide });
});

export default router;
