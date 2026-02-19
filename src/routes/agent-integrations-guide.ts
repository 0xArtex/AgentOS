import { Router, Request, Response } from 'express';

const router = Router();

const integrationGuides = [
  {
    name: "LangChain",
    language: "python",
    difficulty: "beginner",
    description: "Use AgentOS as a tool provider in LangChain agents",
    snippet: `from langchain.tools import Tool
import requests

AGENTOS_URL = "https://agntos.dev"
API_KEY = "your_api_key"

def provision_phone(input: str) -> str:
    r = requests.post(f"{AGENTOS_URL}/phones/provision",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={"agentId": input})
    return r.json()

phone_tool = Tool(name="ProvisionPhone",
    func=provision_phone,
    description="Provision a phone number for an agent")`,
    docs_url: "https://agntos.dev/docs#langchain"
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
    """Send an SMS via AgentOS"""
    r = requests.post("https://agntos.dev/phones/send-sms",
        headers={"Authorization": "Bearer YOUR_KEY"},
        json={"to": to, "message": message})
    return r.json()

agent = Agent(role="Outreach Agent",
    tools=[send_sms],
    goal="Contact leads via SMS")`,
    docs_url: "https://agntos.dev/docs#crewai"
  },
  {
    name: "Eliza (ai16z)",
    language: "typescript",
    difficulty: "intermediate",
    description: "Add AgentOS capabilities as Eliza plugins",
    snippet: `import { Plugin } from '@ai16z/eliza';

const agentOSPlugin: Plugin = {
  name: 'agentos',
  actions: [{
    name: 'PROVISION_INFRA',
    handler: async (runtime, message) => {
      const res = await fetch('https://agntos.dev/agent/onboard', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + runtime.getSetting('AGENTOS_KEY') },
        body: JSON.stringify({ agentId: runtime.agentId, services: ['phone','email'] })
      });
      return res.json();
    }
  }]
};`,
    docs_url: "https://agntos.dev/docs#eliza"
  },
  {
    name: "AutoGen",
    language: "python",
    difficulty: "intermediate",
    description: "Register AgentOS as function calls in AutoGen multi-agent conversations",
    snippet: `import autogen
import requests

def check_email(agent_id: str) -> dict:
    """Check agent's email inbox via AgentOS"""
    r = requests.get(f"https://agntos.dev/emails/{agent_id}/inbox",
        headers={"Authorization": "Bearer YOUR_KEY"})
    return r.json()

assistant = autogen.AssistantAgent("assistant",
    llm_config={"functions": [{"name": "check_email",
        "description": "Check email inbox", 
        "parameters": {"type": "object", "properties": {"agent_id": {"type": "string"}}}}]})`,
    docs_url: "https://agntos.dev/docs#autogen"
  },
  {
    name: "cURL / Raw HTTP",
    language: "bash",
    difficulty: "beginner",
    description: "Direct API access — works with any language or framework",
    snippet: `# Register your agent
curl -X POST https://agntos.dev/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-agent","framework":"custom"}'

# One-call onboard (phone + email + compute)
curl -X POST https://agntos.dev/agent/onboard \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -d '{"agentId":"my-agent","services":["phone","email","compute"]}'`,
    docs_url: "https://agntos.dev/docs"
  }
];

router.get('/api/integrations-guide', (_req: Request, res: Response) => {
  res.json({
    title: "AgentOS Integration Guides",
    description: "Copy-paste integration examples for popular AI agent frameworks",
    total_frameworks: integrationGuides.length,
    guides: integrationGuides,
    note: "All integrations use the same REST API — these are convenience patterns for popular frameworks",
    get_started: "https://agntos.dev/docs"
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
