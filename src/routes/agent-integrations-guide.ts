import { Router, Request, Response } from 'express';

const router = Router();

const integrationGuides = [
  {
    name: "LangChain",
    language: "python",
    difficulty: "beginner",
    description: "Use Palmyr as a tool provider in LangChain agents",
    snippet: `from langchain.tools import Tool
import requests

PALMYR_URL = "https://palmyr.ai"
API_KEY = "your_api_key"

def provision_phone(input: str) -> str:
    r = requests.post(f"{PALMYR_URL}/phones/provision",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={"agentId": input})
    return r.json()

phone_tool = Tool(name="ProvisionPhone",
    func=provision_phone,
    description="Provision a phone number for an agent")`,
    docs_url: "https://palmyr.ai/docs#langchain"
  },
  {
    name: "CrewAI",
    language: "python",
    difficulty: "beginner",
    description: "Equip CrewAI agents with real-world communication tools",
    snippet: `from crewai import Agent, Task, Crew
from crewai_tools import tool
import requests

@tool("Send SMS")
def send_sms(to: str, message: str) -> str:
    """Send an SMS via Palmyr"""
    r = requests.post("https://palmyr.ai/phones/send-sms",
        headers={"Authorization": "Bearer YOUR_KEY"},
        json={"to": to, "message": message})
    return r.json()

agent = Agent(role="Outreach Agent",
    tools=[send_sms],
    goal="Contact leads via SMS")`,
    docs_url: "https://palmyr.ai/docs#crewai"
  },
  {
    name: "Eliza (ai16z)",
    language: "typescript",
    difficulty: "intermediate",
    description: "Add Palmyr capabilities as Eliza plugins",
    snippet: `import { Plugin } from '@ai16z/eliza';

const agentOSPlugin: Plugin = {
  name: 'palmyr',
  actions: [{
    name: 'PROVISION_INFRA',
    handler: async (runtime, message) => {
      const res = await fetch('https://palmyr.ai/agent/onboard', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + runtime.getSetting('PALMYR_KEY') },
        body: JSON.stringify({ agentId: runtime.agentId, services: ['phone','email'] })
      });
      return res.json();
    }
  }]
};`,
    docs_url: "https://palmyr.ai/docs#eliza"
  },
  {
    name: "AutoGen",
    language: "python",
    difficulty: "intermediate",
    description: "Register Palmyr as function calls in AutoGen multi-agent conversations",
    snippet: `import autogen
import requests

def check_email(agent_id: str) -> dict:
    """Check agent's email inbox via Palmyr"""
    r = requests.get(f"https://palmyr.ai/emails/{agent_id}/inbox",
        headers={"Authorization": "Bearer YOUR_KEY"})
    return r.json()

assistant = autogen.AssistantAgent("assistant",
    llm_config={"functions": [{"name": "check_email",
        "description": "Check email inbox", 
        "parameters": {"type": "object", "properties": {"agent_id": {"type": "string"}}}}]})`,
    docs_url: "https://palmyr.ai/docs#autogen"
  },
  {
    name: "cURL / Raw HTTP",
    language: "bash",
    difficulty: "beginner",
    description: "Direct API access — works with any language or framework",
    snippet: `# Register your agent
curl -X POST https://palmyr.ai/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-agent","framework":"custom"}'

# One-call onboard (phone + email + compute)
curl -X POST https://palmyr.ai/agent/onboard \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -d '{"agentId":"my-agent","services":["phone","email","compute"]}'`,
    docs_url: "https://palmyr.ai/docs"
  }
];

router.get('/api/integrations-guide', (_req: Request, res: Response) => {
  res.json({
    title: "Palmyr Integration Guides",
    description: "Copy-paste integration examples for popular AI agent frameworks",
    total_frameworks: integrationGuides.length,
    guides: integrationGuides,
    note: "All integrations use the same REST API — these are convenience patterns for popular frameworks",
    get_started: "https://palmyr.ai/docs"
  });
});

router.get('/api/integrations-guide/:framework', (req: Request, res: Response) => {
  const name = String(req.params.framework).toLowerCase();
  const guide = integrationGuides.find(g => g.name.toLowerCase().includes(name));
  if (!guide) {
    return res.status(404).json({ error: "Framework not found", available: integrationGuides.map(g => g.name) });
  }
  res.json(guide);
});

export default router;
