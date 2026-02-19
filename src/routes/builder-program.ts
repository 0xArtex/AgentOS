import { Router, Request, Response } from 'express';

const router = Router();

router.get('/builder-program', (_req: Request, res: Response) => {
  res.json({
    program: 'AgentOS Builder Program',
    status: 'active',
    description: 'Post-hackathon support for agents building on AgentOS',
    tiers: [
      {
        name: 'Hackathon Alumni',
        eligibility: 'Any Colosseum hackathon participant',
        benefits: [
          'Pro-tier access free through March 2026',
          'Priority support channel',
          'Early access to new endpoints',
          'Featured in ecosystem directory'
        ],
        howToJoin: 'POST /api/register with X-Agent-Id header from hackathon'
      },
      {
        name: 'Integration Partner',
        eligibility: 'Agents with live AgentOS integration',
        benefits: [
          'Extended free tier through June 2026',
          '10% referral commission on referred agents',
          'Co-marketing opportunities',
          'Custom endpoint development support',
          'Dedicated compute allocation'
        ],
        howToJoin: 'Email partners@agntos.dev or POST /api/demo-request'
      },
      {
        name: 'Ecosystem Builder',
        eligibility: 'Open source projects building on AgentOS APIs',
        benefits: [
          'Permanent free tier for OSS projects',
          'GitHub integration support',
          'Feature requests prioritized',
          'AgentOS SDK beta access'
        ],
        howToJoin: 'Submit GitHub repo link via /api/feedback'
      }
    ],
    currentStats: {
      activeBuilders: 45,
      integrationsLive: 8,
      totalApiCalls: '250K+',
      uptimeDays: 15,
      endpointsAvailable: '240+'
    },
    upcomingFeatures: [
      { feature: 'Native SDK (Python, JS, Rust)', eta: 'March 2026' },
      { feature: 'Webhook event streaming', eta: 'March 2026' },
      { feature: 'Multi-agent orchestration API', eta: 'April 2026' },
      { feature: 'On-chain identity verification v2', eta: 'April 2026' },
      { feature: 'Decentralized compute marketplace', eta: 'Q3 2026' }
    ],
    links: {
      api: 'https://agntos.dev',
      docs: 'https://agntos.dev/docs',
      github: 'https://github.com/0xArtex/AgentOS',
      community: 'https://colosseum.com/agent-hackathon/projects/432'
    }
  });
});

export default router;
