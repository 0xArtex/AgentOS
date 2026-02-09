import { Router, Request, Response } from 'express';

const router = Router();

interface Example {
  title: string;
  description: string;
  curl: string;
  response: Record<string, unknown>;
  difficulty: string;
}

const examples: Example[] = [
  {
    title: "Get a Phone Number",
    description: "Provision a US phone number for your agent in one API call",
    curl: `curl -X POST http://77.42.89.233:3001/api/phone/provision \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: my-agent" \\
  -d '{"country": "US", "capabilities": ["voice", "sms"]}'`,
    response: { phoneNumber: "+1-555-0142", sid: "PN...", status: "active" },
    difficulty: "beginner"
  },
  {
    title: "Send an Email",
    description: "Send an email on behalf of your agent",
    curl: `curl -X POST http://77.42.89.233:3001/api/email/send \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: my-agent" \\
  -d '{"to": "user@example.com", "subject": "Hello from Agent", "body": "Automated message"}'`,
    response: { messageId: "msg_abc123", status: "sent" },
    difficulty: "beginner"
  },
  {
    title: "Register a Domain",
    description: "Register a .sol or traditional domain for your agent",
    curl: `curl -X POST http://77.42.89.233:3001/api/domain/register \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: my-agent" \\
  -d '{"domain": "myagent.sol"}'`,
    response: { domain: "myagent.sol", status: "registered", expiresAt: "2027-02-09" },
    difficulty: "intermediate"
  },
  {
    title: "Spin Up Compute",
    description: "Launch a sandboxed compute instance for your agent",
    curl: `curl -X POST http://77.42.89.233:3001/api/compute/provision \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: my-agent" \\
  -d '{"type": "sandbox", "resources": {"cpu": 2, "memoryMb": 2048}}'`,
    response: { instanceId: "i-abc123", ip: "10.0.0.5", status: "running" },
    difficulty: "intermediate"
  },
  {
    title: "Full Onboarding (One Call)",
    description: "Provision phone + email + identity in a single quickstart call",
    curl: `curl -X POST http://77.42.89.233:3001/api/onboarding/quickstart \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: my-agent" \\
  -d '{"agentName": "my-agent", "services": ["phone", "email", "identity"]}'`,
    response: { agentId: "my-agent", services: { phone: "+1-555-0142", email: "my-agent@agentos.ai", identity: "did:sol:..." } },
    difficulty: "beginner"
  },
  {
    title: "Set Up Webhooks",
    description: "Receive real-time notifications when your agent gets calls or emails",
    curl: `curl -X POST http://77.42.89.233:3001/api/webhooks/register \\
  -H "Content-Type: application/json" \\
  -H "X-Agent-Id: my-agent" \\
  -d '{"url": "https://myserver.com/webhook", "events": ["call.incoming", "email.received"]}'`,
    response: { webhookId: "wh_abc123", events: ["call.incoming", "email.received"], status: "active" },
    difficulty: "intermediate"
  }
];

router.get('/', (_req: Request, res: Response) => {
  res.json({
    title: "AgentOS API Examples",
    description: "Copy-paste curl commands to get started in minutes",
    totalExamples: examples.length,
    examples,
    note: "All endpoints are FREE during Colosseum hackathon — just add X-Agent-Id header",
    docs: "http://77.42.89.233:3001/docs"
  });
});

router.get('/:difficulty', (req: Request, res: Response) => {
  const filtered = examples.filter(e => e.difficulty === req.params.difficulty);
  res.json({
    difficulty: req.params.difficulty,
    count: filtered.length,
    examples: filtered
  });
});

export default router;
