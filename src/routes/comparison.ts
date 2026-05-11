import { Router, Request, Response } from 'express';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  res.json({
    title: 'Palmyr vs DIY Infrastructure',
    description: 'Why use Palmyr instead of setting up infrastructure yourself?',
    comparison: [
      {
        capability: 'Phone Numbers',
        diy: { setup: '2-3 days', cost: '$20/mo + Twilio signup + KYC', complexity: 'high' },
        agentOS: { setup: '1 API call', cost: '0.50 USDC/month', complexity: 'none' }
      },
      {
        capability: 'Email (Send/Receive)',
        diy: { setup: '1-2 days', cost: '$15/mo + domain + DNS config', complexity: 'high' },
        agentOS: { setup: '1 API call', cost: '0.25 USDC/month', complexity: 'none' }
      },
      {
        capability: 'Compute Instances',
        diy: { setup: '1 day', cost: '$5-50/mo + cloud account + SSH keys', complexity: 'medium' },
        agentOS: { setup: '1 API call', cost: 'from 0.10 USDC/hour', complexity: 'none' }
      },
      {
        capability: 'Domain Registration',
        diy: { setup: '30 min', cost: '$10-15/yr + registrar account', complexity: 'medium' },
        agentOS: { setup: '1 API call', cost: '10 USDC/year', complexity: 'none' }
      },
      {
        capability: 'Unified Billing',
        diy: { setup: 'N/A', cost: '4+ separate bills', complexity: 'painful' },
        agentOS: { setup: 'built-in', cost: 'single USDC balance', complexity: 'none' }
      },
      {
        capability: 'Payment Method',
        diy: { setup: 'credit card per provider', cost: 'fiat + KYC everywhere', complexity: 'high' },
        agentOS: { setup: 'x402 header', cost: 'USDC on Solana', complexity: 'none' }
      }
    ],
    summary: {
      diy_total_setup: '5-7 days across 4+ providers',
      agentOS_total_setup: '< 5 minutes, 1 API',
      savings: '80% less time, 60% less cost, zero human intervention needed'
    },
    try_it: 'curl http://77.42.89.233:3001/api/quickstart',
    hackathon_mode: 'FREE until Feb 12 — just add X-Agent-Id header'
  });
});

export default router;
