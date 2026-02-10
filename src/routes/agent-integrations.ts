import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

const integrations = [
  {
    framework: "LangChain",
    language: "Python",
    description: "Use AgentOS as a tool provider in LangChain agents",
    install: "pip install langchain requests",
    code: "from langchain.tools import tool\nimport requests\n\nBASE = \"http://77.42.89.233:3001/api\"\nH = {\"X-Agent-Id\": \"my-agent\"}\n\n@tool\ndef provision_phone(country_code: str = \"US\") -> str:\n    \"\"\"Provision a phone number\"\"\"\n    r = requests.post(f\"{BASE}/phone/numbers\", json={\"country_code\": country_code}, headers=H)\n    return r.json()",
    features: ["Phone provisioning", "Email sending", "Tool-based integration"]
  },
  {
    framework: "CrewAI",
    language: "Python",
    description: "Equip CrewAI agents with real-world infrastructure",
    install: "pip install crewai requests",
    code: "from crewai import Agent, Task\nfrom crewai.tools import tool\nimport requests\n\nBASE = \"http://77.42.89.233:3001/api\"\nH = {\"X-Agent-Id\": \"my-crew\"}\n\n@tool(\"Provision compute\")\ndef get_compute(hours: int = 1) -> str:\n    r = requests.post(f\"{BASE}/compute/servers\", json={\"hours\": hours}, headers=H)\n    return str(r.json())",
    features: ["Compute provisioning", "Multi-agent crews", "Role-based access"]
  },
  {
    framework: "OpenClaw",
    language: "TypeScript",
    description: "Native integration via OpenClaw skills",
    install: "curl -o SKILL.md http://77.42.89.233:3001/skill.md",
    code: "// Add skill.md to your workspace, agent auto-discovers endpoints",
    features: ["Skill-based integration", "Auto-discovery", "Zero config"]
  },
  {
    framework: "Eliza",
    language: "TypeScript",
    description: "Add real-world capabilities to Eliza agents",
    install: "npm install node-fetch",
    code: "const plugin = { name: 'agentos', actions: [{ name: 'PROVISION_PHONE', handler: async (rt) => { const r = await fetch('http://77.42.89.233:3001/api/phone/numbers', { method: 'POST', headers: {'X-Agent-Id': rt.agentId, 'Content-Type': 'application/json'}, body: JSON.stringify({country_code:'US'}) }); return r.json(); }}]};",
    features: ["Plugin architecture", "Phone/SMS", "Event-driven"]
  },
  {
    framework: "Raw HTTP",
    language: "Any",
    description: "Direct API calls — no SDK needed",
    install: "# Just curl",
    code: "curl -X POST http://77.42.89.233:3001/api/phone/numbers -H 'X-Agent-Id: my-agent' -H 'Content-Type: application/json' -d '{\"country_code\":\"US\"}'",
    features: ["Zero dependencies", "Any language", "Copy-paste ready"]
  }
];

router.get("/api/integrations", (_req: Request, res: Response) => {
  const agentCount = db.prepare("SELECT COUNT(*) as count FROM agents").get() as any;
  res.json({
    title: "AgentOS Integration Guide",
    description: "Ready-to-use code examples for every major agent framework",
    frameworks: integrations.length,
    supported_frameworks: integrations.map(i => i.framework),
    integrations,
    hackathon_note: "All endpoints FREE during Colosseum hackathon with X-Agent-Id header",
    docs: "http://77.42.89.233:3001/docs",
    active_agents: agentCount?.count || 0
  });
});

router.get("/api/integrations/:framework", (req: Request, res: Response) => {
  const fw = String(req.params.framework).toLowerCase();
  const match = integrations.find(i => i.framework.toLowerCase() === fw);
  if (!match) {
    return res.status(404).json({ error: "Framework not found", available: integrations.map(i => i.framework) });
  }
  res.json(match);
});

export default router;
