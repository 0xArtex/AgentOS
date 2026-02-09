import { Router, Request, Response } from 'express';
const router = Router();

router.get('/integration-guide', (req: Request, res: Response) => {
  const framework = (req.query.framework as string || 'all').toLowerCase();

  const guides: Record<string, object> = {
    langchain: {
      framework: 'LangChain',
      language: 'Python',
      install: 'pip install langchain requests',
      setup: `from langchain.tools import tool
import requests

BASE = "http://77.42.89.233:3001/api"
HEADERS = {"X-Agent-Id": "my-agent"}

@tool
def provision_phone(area_code: str = "415") -> str:
    """Provision a phone number for the agent."""
    r = requests.post(f"{BASE}/phone/provision", 
        json={"area_code": area_code}, headers=HEADERS)
    return r.json()

@tool  
def send_email(to: str, subject: str, body: str) -> str:
    """Send an email from the agent's address."""
    r = requests.post(f"{BASE}/email/send",
        json={"to": to, "subject": subject, "body": body}, headers=HEADERS)
    return r.json()

@tool
def provision_compute(image: str = "ubuntu:22.04") -> str:
    """Spin up a compute container."""
    r = requests.post(f"{BASE}/compute/provision",
        json={"image": image}, headers=HEADERS)
    return r.json()`,
      note: 'Add these tools to your LangChain agent toolkit'
    },
    crewai: {
      framework: 'CrewAI',
      language: 'Python',
      install: 'pip install crewai requests',
      setup: `from crewai import Agent, Task, Crew
from crewai_tools import tool
import requests

BASE = "http://77.42.89.233:3001/api"
HEADERS = {"X-Agent-Id": "my-crew-agent"}

@tool("Provision Phone")
def provision_phone(area_code: str) -> str:
    """Get a phone number for outreach."""
    return requests.post(f"{BASE}/phone/provision",
        json={"area_code": area_code}, headers=HEADERS).text

@tool("Send Email")  
def send_email(to: str, subject: str, body: str) -> str:
    """Send email from agent address."""
    return requests.post(f"{BASE}/email/send",
        json={"to": to, "subject": subject, "body": body}, headers=HEADERS).text

outreach_agent = Agent(
    role="Outreach Specialist",
    goal="Reach potential clients via phone and email",
    tools=[provision_phone, send_email]
)`,
      note: 'CrewAI agents can use AgentOS tools directly'
    },
    curl: {
      framework: 'Raw HTTP (curl)',
      language: 'Any',
      setup: `# 1. Check API health
curl http://77.42.89.233:3001/api/health

# 2. Provision a phone number
curl -X POST http://77.42.89.233:3001/api/phone/provision \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: my-agent" \\
  -d '{"area_code": "415"}'

# 3. Send an email  
curl -X POST http://77.42.89.233:3001/api/email/send \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: my-agent" \\
  -d '{"to": "user@example.com", "subject": "Hello", "body": "From my agent"}'

# 4. Spin up compute
curl -X POST http://77.42.89.233:3001/api/compute/provision \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: my-agent" \\
  -d '{"image": "ubuntu:22.04"}'`,
      note: 'Works with any language that can make HTTP requests'
    },
    typescript: {
      framework: 'TypeScript/Node.js',
      language: 'TypeScript',
      install: 'npm install axios',
      setup: `import axios from 'axios';

const api = axios.create({
  baseURL: 'http://77.42.89.233:3001/api',
  headers: { 'X-Agent-Id': 'my-agent' }
});

// Provision phone
const phone = await api.post('/phone/provision', { area_code: '415' });

// Send email
const email = await api.post('/email/send', {
  to: 'user@example.com',
  subject: 'Hello from my agent',
  body: 'Automated outreach via AgentOS'
});

// Spin up compute
const compute = await api.post('/compute/provision', { image: 'ubuntu:22.04' });

// Check everything
const health = await api.get('/health');`,
      note: 'Full TypeScript SDK coming soon'
    }
  };

  const result = framework === 'all' ? guides : (guides[framework] || { error: `Unknown framework. Available: ${Object.keys(guides).join(', ')}` });

  res.json({
    title: 'AgentOS Integration Guide',
    description: 'Step-by-step integration for popular AI agent frameworks',
    available_frameworks: Object.keys(guides),
    usage: 'GET /api/integration-guide?framework=langchain',
    guides: result
  });
});

export default router;
