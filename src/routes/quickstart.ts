import { Router, Request, Response } from 'express';

const router = Router();

interface QuickstartStep {
  step: number;
  title: string;
  description: string;
  curl: string;
  expectedResponse: string;
}

const steps: QuickstartStep[] = [
  {
    step: 1,
    title: "Get an API Key",
    description: "Register your agent and get an API key in one call.",
    curl: `curl -X POST http://77.42.89.233:3001/api/onboarding/quickstart \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: your-agent-name" \\
  -d '{"agentName": "your-agent-name", "capabilities": ["compute"]}'`,
    expectedResponse: '{"apiKey": "ak_...", "agentId": "...", "message": "Welcome to AgentOS!"}'
  },
  {
    step: 2,
    title: "Provision a Phone Number",
    description: "Get a dedicated phone number for your agent to make/receive calls and SMS.",
    curl: `curl -X POST http://77.42.89.233:3001/api/phone/provision \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "X-Agent-Id: your-agent-name" \\
  -d '{"country": "US", "capabilities": ["voice", "sms"]}'`,
    expectedResponse: '{"phoneNumber": "+1...", "status": "active"}'
  },
  {
    step: 3,
    title: "Send an Email",
    description: "Send emails from your agent's own email address.",
    curl: `curl -X POST http://77.42.89.233:3001/api/email/send \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "X-Agent-Id: your-agent-name" \\
  -d '{"to": "user@example.com", "subject": "Hello from my agent", "body": "Automated message"}'`,
    expectedResponse: '{"messageId": "msg_...", "status": "sent"}'
  },
  {
    step: 4,
    title: "Spin Up Compute",
    description: "Launch a sandboxed compute instance for your agent's workloads.",
    curl: `curl -X POST http://77.42.89.233:3001/api/compute/provision \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "X-Agent-Id: your-agent-name" \\
  -d '{"type": "sandbox", "resources": {"cpu": 2, "memoryMb": 2048}}'`,
    expectedResponse: '{"instanceId": "i_...", "status": "running", "ssh": "..."}'
  },
  {
    step: 5,
    title: "Check Your Usage",
    description: "Monitor costs and resource consumption.",
    curl: `curl http://77.42.89.233:3001/api/analytics/usage \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "X-Agent-Id: your-agent-name"`,
    expectedResponse: '{"totalCostUSDC": 0.00, "resources": {...}}'
  }
];

router.get('/', (_req: Request, res: Response) => {
  res.json({
    title: "AgentOS Quickstart Guide",
    description: "Go from zero to fully-equipped agent in 5 API calls. Free during Colosseum hackathon.",
    timeToComplete: "~2 minutes",
    prerequisites: ["curl or any HTTP client", "An agent name"],
    hackathonNote: "All services are FREE until Feb 12, 2026. Just include X-Agent-Id header.",
    steps,
    nextSteps: [
      "Explore all endpoints: GET /docs",
      "See integration examples: GET /api/integrations",
      "Check framework compatibility: GET /api/compatibility",
      "Calculate costs: GET /api/pricing/calculator"
    ],
    support: {
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/AgentOS",
      forum: "https://agents.colosseum.com"
    }
  });
});

export default router;
