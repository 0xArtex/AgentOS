import { Router, Request, Response } from 'express';

const router = Router();

interface DemoStep {
  step: number;
  title: string;
  description: string;
  method: string;
  endpoint: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  expectedResponse: string;
  nextStep: string;
}

interface DemoScenario {
  id: string;
  name: string;
  description: string;
  estimatedTime: string;
  difficulty: string;
  steps: DemoStep[];
}

const scenarios: DemoScenario[] = [
  {
    id: 'agent-lifecycle',
    name: 'Full Agent Lifecycle',
    description: 'Register an agent, provision all services, run a task, check analytics, tear down',
    estimatedTime: '5 minutes',
    difficulty: 'intermediate',
    steps: [
      {
        step: 1,
        title: 'Register Your Agent',
        description: 'Create your agent identity on Palmyr',
        method: 'POST',
        endpoint: '/api/agents/onboard',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Id': 'demo-agent-001' },
        body: { name: 'Demo Agent', capabilities: ['compute', 'communicate'] },
        expectedResponse: 'Agent registered with unique ID',
        nextStep: 'Use the returned agent ID for all subsequent calls'
      },
      {
        step: 2,
        title: 'Provision Phone Number',
        description: 'Get a dedicated phone number for SMS/voice',
        method: 'POST',
        endpoint: '/api/phone/provision',
        headers: { 'X-Agent-Id': 'demo-agent-001' },
        body: { country: 'US', capabilities: ['sms', 'voice'] },
        expectedResponse: 'Phone number assigned to your agent',
        nextStep: 'Use the phone number to send notifications'
      },
      {
        step: 3,
        title: 'Send Email',
        description: 'Send an email through your agent',
        method: 'POST',
        endpoint: '/api/email/send',
        headers: { 'X-Agent-Id': 'demo-agent-001', 'Content-Type': 'application/json' },
        body: { to: 'test@example.com', subject: 'Hello from Palmyr', body: 'My first autonomous email!' },
        expectedResponse: 'Email queued for delivery',
        nextStep: 'Check delivery status via /api/email/status'
      },
      {
        step: 4,
        title: 'Spin Up Compute',
        description: 'Provision a dedicated compute instance',
        method: 'POST',
        endpoint: '/api/compute/provision',
        headers: { 'X-Agent-Id': 'demo-agent-001', 'Content-Type': 'application/json' },
        body: { type: 'sandbox', resources: { cpu: 2, memory: '4GB' } },
        expectedResponse: 'Compute instance ID and connection details',
        nextStep: 'Execute code on your instance'
      },
      {
        step: 5,
        title: 'Check Analytics',
        description: 'Review your agent usage and performance',
        method: 'GET',
        endpoint: '/api/analytics',
        headers: { 'X-Agent-Id': 'demo-agent-001' },
        expectedResponse: 'Usage stats, API calls, resource consumption',
        nextStep: 'Use insights to optimize your agent'
      }
    ]
  },
  {
    id: 'multi-agent',
    name: 'Multi-Agent Coordination',
    description: 'Spin up multiple agents that communicate and collaborate',
    estimatedTime: '10 minutes',
    difficulty: 'advanced',
    steps: [
      {
        step: 1,
        title: 'Register Coordinator Agent',
        description: 'Create the orchestrator that manages other agents',
        method: 'POST',
        endpoint: '/api/agents/onboard',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Id': 'coordinator-001' },
        body: { name: 'Coordinator', capabilities: ['orchestration', 'compute', 'communicate'] },
        expectedResponse: 'Coordinator agent registered',
        nextStep: 'Register worker agents'
      },
      {
        step: 2,
        title: 'Register Worker Agents',
        description: 'Create 3 specialized worker agents',
        method: 'POST',
        endpoint: '/api/agents/onboard',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Id': 'worker-001' },
        body: { name: 'Research Worker', capabilities: ['compute'] },
        expectedResponse: 'Worker agents registered (repeat for worker-002, worker-003)',
        nextStep: 'Provision shared compute resources'
      },
      {
        step: 3,
        title: 'Provision Shared Infrastructure',
        description: 'Set up compute and communication for the swarm',
        method: 'POST',
        endpoint: '/api/compute/provision',
        headers: { 'X-Agent-Id': 'coordinator-001', 'Content-Type': 'application/json' },
        body: { type: 'cluster', instances: 3, resources: { cpu: 2, memory: '2GB' } },
        expectedResponse: 'Cluster provisioned with 3 instances',
        nextStep: 'Agents can now communicate and share results'
      },
      {
        step: 4,
        title: 'Monitor Swarm Activity',
        description: 'Track all agent activity through the coordinator',
        method: 'GET',
        endpoint: '/api/logs?level=info',
        headers: { 'X-Agent-Id': 'coordinator-001' },
        expectedResponse: 'Activity logs from all agents in the swarm',
        nextStep: 'Use /api/metrics for real-time performance data'
      }
    ]
  }
];

// GET /api/demo - list all demo scenarios
router.get('/', (_req: Request, res: Response) => {
  res.json({
    title: 'Palmyr Interactive Demos',
    description: 'Step-by-step guided demos to experience Palmyr capabilities hands-on',
    hackathonNote: 'All demos are FREE during the Colosseum hackathon (until Feb 12). Just include X-Agent-Id header.',
    baseUrl: 'http://77.42.89.233:3001',
    scenarios: scenarios.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      estimatedTime: s.estimatedTime,
      difficulty: s.difficulty,
      steps: s.steps.length,
      url: `/api/demo/${s.id}`
    }))
  });
});

// GET /api/demo/:id - get specific demo with full steps
router.get('/:id', (req: Request, res: Response) => {
  const scenario = scenarios.find(s => s.id === req.params.id);
  if (!scenario) {
    return res.status(404).json({ error: 'Demo scenario not found', available: scenarios.map(s => s.id) });
  }
  res.json({
    ...scenario,
    baseUrl: 'http://77.42.89.233:3001',
    hackathonFree: true,
    tip: 'Copy-paste the curl commands below to follow along',
    curlExamples: scenario.steps.map(step => {
      let curl = `curl -X ${step.method} 'http://77.42.89.233:3001${step.endpoint}'`;
      Object.entries(step.headers).forEach(([k, v]) => { curl += ` -H '${k}: ${v}'`; });
      if (step.body) curl += ` -d '${JSON.stringify(step.body)}'`;
      return { step: step.step, title: step.title, curl };
    })
  });
});

export default router;
