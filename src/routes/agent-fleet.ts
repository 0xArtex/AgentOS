import { Router, Request, Response } from 'express';

const router = Router();

router.get('/api/agent-fleet', (req: Request, res: Response) => {
  const agentCount = parseInt(req.query.count as string) || 5;
  const capped = Math.min(agentCount, 50);

  const fleet = Array.from({ length: capped }, (_, i) => ({
    agentId: `agent-${String(i + 1).padStart(3, '0')}`,
    name: `Fleet Agent #${i + 1}`,
    services: {
      phone: { status: 'provisioned', number: `+1555${String(1000 + i).slice(-4)}` },
      email: { status: 'provisioned', address: `agent${i + 1}@agentos.dev` },
      compute: { status: 'active', cpu: '2 vCPU', ram: '4GB' },
    },
    monthlyEstimate: `${(12.5 + i * 0.5).toFixed(2)} USDC`,
  }));

  res.json({
    endpoint: '/api/agent-fleet',
    description: 'Fleet management — provision and monitor multiple agents from a single dashboard',
    useCases: [
      'Run 10 specialized agents (researcher, coder, trader, comms) under one account',
      'Scale up during high-demand periods, scale down to save costs',
      'Centralized billing and analytics across your entire fleet',
    ],
    fleet: {
      total: capped,
      agents: fleet,
    },
    totalMonthlyEstimate: `${fleet.reduce((sum, a) => sum + parseFloat(a.monthlyEstimate), 0).toFixed(2)} USDC`,
    try_it: 'GET /api/agent-fleet?count=10',
    docs: 'http://77.42.89.233:3001/docs',
  });
});

export default router;
