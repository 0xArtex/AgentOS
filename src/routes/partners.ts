import { Router, Request, Response } from 'express';

const router = Router();

interface Partner {
  name: string;
  agentId: number;
  category: string;
  status: 'live' | 'in-progress' | 'planned';
  integration: string;
  useCase: string;
  forumThread?: number;
  url?: string;
}

const partners: Partner[] = [
  {
    name: 'SugarClawdy',
    agentId: 1090,
    category: 'Task Marketplace',
    status: 'live',
    integration: 'Workers use Palmyr compute for task execution',
    useCase: 'Spin up isolated environments per task, email delivery for task notifications',
    forumThread: 3152,
    url: 'https://sugarclawdy.com'
  },
  {
    name: 'SolSignal',
    agentId: 982,
    category: 'Signal Verification',
    status: 'live',
    integration: 'SMS/email alerts for verified trading signals',
    useCase: 'Real-time trade alerts via Palmyr phone/email APIs',
    forumThread: 3248,
    url: 'https://solsignal-dashboard.vercel.app'
  },
  {
    name: 'ClawGig',
    agentId: 1149,
    category: 'Freelance Marketplace',
    status: 'planned',
    integration: 'On-demand infra for gig completion',
    useCase: 'Workers spin up Palmyr resources to deliver freelance work',
    forumThread: 3276,
    url: 'https://clawgig.ai'
  },
  {
    name: 'SIDEX',
    agentId: 235,
    category: 'Trading',
    status: 'planned',
    integration: 'Trade alert notifications via SMS/email',
    useCase: 'Autonomous trading agents notify humans of executions',
    forumThread: 3240,
    url: 'https://devs.sidex.fun'
  },
  {
    name: 'Agent Casino Protocol',
    agentId: 307,
    category: 'Gaming/DeFi',
    status: 'live',
    integration: 'Agent identity and comms for casino participants',
    useCase: 'Player notifications, game result delivery',
    forumThread: 3243
  },
  {
    name: 'Identity Prism',
    agentId: 872,
    category: 'Identity',
    status: 'in-progress',
    integration: 'Verified agent identity for Palmyr provisioning',
    useCase: 'Trust layer for resource allocation',
    forumThread: 2914
  },
  {
    name: 'NawaPay',
    agentId: 1060,
    category: 'Payments',
    status: 'planned',
    integration: 'Payment rails for Palmyr billing',
    useCase: 'Alternative payment processing for agent subscriptions',
    forumThread: 3136
  },
  {
    name: 'Varuna',
    agentId: 1166,
    category: 'DeFi Risk',
    status: 'planned',
    integration: 'Risk assessment APIs consume Palmyr compute',
    useCase: 'Sandboxed environments for DeFi risk analysis',
    forumThread: 3160
  },
  {
    name: 'RemitMesh',
    agentId: 1166,
    category: 'Remittances',
    status: 'planned',
    integration: 'SMS notifications for remittance status',
    useCase: 'Cross-border payment alerts via Palmyr phone API',
    forumThread: 3239
  },
  {
    name: 'Unbrowse',
    agentId: 0,
    category: 'Data Access',
    status: 'planned',
    integration: 'Web data feeds into Palmyr compute jobs',
    useCase: 'Agents browse + process data in isolated environments',
    forumThread: 3119
  },
  {
    name: 'CrewDegen Arena',
    agentId: 0,
    category: 'Trading Arena',
    status: 'planned',
    integration: 'Arena participants use Palmyr infra',
    useCase: 'Isolated compute for trading competition agents',
    forumThread: 3221
  },
  {
    name: 'Crypto Market Pulse',
    agentId: 206,
    category: 'Analytics',
    status: 'planned',
    integration: 'Market data delivery via email/SMS',
    useCase: 'Scheduled market reports sent through Palmyr',
    forumThread: 3242
  }
];

router.get('/', (_req: Request, res: Response) => {
  const summary = {
    totalPartners: partners.length,
    live: partners.filter(p => p.status === 'live').length,
    inProgress: partners.filter(p => p.status === 'in-progress').length,
    planned: partners.filter(p => p.status === 'planned').length,
    categories: [...new Set(partners.map(p => p.category))],
    partners: partners.map(p => ({
      ...p,
      forumUrl: p.forumThread ? `https://colosseum.com/agent-hackathon/forum/${p.forumThread}` : undefined
    }))
  };
  res.json(summary);
});

router.get('/live', (_req: Request, res: Response) => {
  res.json(partners.filter(p => p.status === 'live'));
});

router.get('/categories', (_req: Request, res: Response) => {
  const cats = [...new Set(partners.map(p => p.category))].map(cat => ({
    category: cat,
    count: partners.filter(p => p.category === cat).length,
    partners: partners.filter(p => p.category === cat).map(p => p.name)
  }));
  res.json(cats);
});

export default router;
