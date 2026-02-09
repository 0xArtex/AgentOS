import { Router, Request, Response } from 'express';

const router = Router();

/**
 * @swagger
 * /api/sandbox:
 *   get:
 *     summary: Interactive sandbox - try AgentOS APIs without setup
 *     tags: [Sandbox]
 *     description: Returns a guided sandbox environment with pre-configured test scenarios agents can execute immediately
 *     responses:
 *       200:
 *         description: Sandbox scenarios and test commands
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    sandbox: {
      title: 'AgentOS Interactive Sandbox',
      description: 'Try every API endpoint right now — no signup, no API key, no USDC needed during hackathon',
      hackathonMode: true,
      expiresAt: '2026-02-12T17:00:00Z',
      baseUrl: 'http://77.42.89.233:3001',
      requiredHeader: { 'X-Agent-Id': 'your-agent-name' },
    },
    scenarios: [
      {
        name: '🚀 Full Agent Bootstrap',
        description: 'Provision a complete agent identity in 60 seconds',
        difficulty: 'beginner',
        estimatedTime: '60s',
        steps: [
          {
            step: 1,
            action: 'Register your agent',
            method: 'POST',
            endpoint: '/api/agents/register',
            curl: "curl -X POST http://77.42.89.233:3001/api/agents/register -H 'Content-Type: application/json' -H 'X-Agent-Id: my-agent' -d '{\"name\": \"my-agent\", \"capabilities\": [\"trading\", \"research\"]}'"
          },
          {
            step: 2,
            action: 'Get a phone number',
            method: 'POST',
            endpoint: '/api/phone/provision',
            curl: "curl -X POST http://77.42.89.233:3001/api/phone/provision -H 'Content-Type: application/json' -H 'X-Agent-Id: my-agent' -d '{\"country\": \"US\"}'"
          },
          {
            step: 3,
            action: 'Get an email address',
            method: 'POST',
            endpoint: '/api/email/provision',
            curl: "curl -X POST http://77.42.89.233:3001/api/email/provision -H 'Content-Type: application/json' -H 'X-Agent-Id: my-agent' -d '{\"prefix\": \"my-agent\"}'"
          },
          {
            step: 4,
            action: 'Spin up compute',
            method: 'POST',
            endpoint: '/api/compute/provision',
            curl: "curl -X POST http://77.42.89.233:3001/api/compute/provision -H 'Content-Type: application/json' -H 'X-Agent-Id: my-agent' -d '{\"type\": \"container\", \"specs\": {\"cpu\": 2, \"memoryMb\": 2048}}'"
          },
          {
            step: 5,
            action: 'Check your analytics',
            method: 'GET',
            endpoint: '/api/analytics',
            curl: "curl http://77.42.89.233:3001/api/analytics -H 'X-Agent-Id: my-agent'"
          }
        ]
      },
      {
        name: '📡 Communication Test',
        description: 'Send an SMS and email to verify comms work',
        difficulty: 'beginner',
        estimatedTime: '30s',
        steps: [
          {
            step: 1,
            action: 'Send an SMS',
            method: 'POST',
            endpoint: '/api/phone/send-sms',
            curl: "curl -X POST http://77.42.89.233:3001/api/phone/send-sms -H 'Content-Type: application/json' -H 'X-Agent-Id: my-agent' -d '{\"to\": \"+1234567890\", \"body\": \"Hello from my autonomous agent!\"}'"
          },
          {
            step: 2,
            action: 'Send an email',
            method: 'POST',
            endpoint: '/api/email/send',
            curl: "curl -X POST http://77.42.89.233:3001/api/email/send -H 'Content-Type: application/json' -H 'X-Agent-Id: my-agent' -d '{\"to\": \"test@example.com\", \"subject\": \"Agent comms test\", \"body\": \"Sent autonomously via AgentOS\"}'"
          }
        ]
      },
      {
        name: '🏗️ Infrastructure Deep Dive',
        description: 'Explore all available endpoints and capabilities',
        difficulty: 'intermediate',
        estimatedTime: '5min',
        endpoints: [
          { method: 'GET', path: '/api/status', description: 'System health and stats' },
          { method: 'GET', path: '/health/deep', description: 'Deep diagnostics with CPU, memory, uptime' },
          { method: 'GET', path: '/api/roadmap', description: 'Product roadmap and planned features' },
          { method: 'GET', path: '/api/ecosystem', description: 'Partner directory (11+ projects)' },
          { method: 'GET', path: '/api/benchmarks', description: 'Performance benchmarks' },
          { method: 'GET', path: '/api/pricing/calculator?phones=1&emails=2&compute_hours=10', description: 'Cost estimator' },
          { method: 'GET', path: '/api/compatibility', description: 'Framework compatibility matrix' },
          { method: 'GET', path: '/api/security', description: 'Security model documentation' },
        ]
      }
    ],
    tips: [
      'All endpoints are FREE during hackathon — just include X-Agent-Id header',
      'No API key needed, no USDC needed, no signup needed',
      'Resources are sandboxed per agent — your stuff is isolated',
      'Check /api/examples for more copy-paste curl commands',
      'Full Swagger docs at /docs'
    ]
  });
});

export default router;
