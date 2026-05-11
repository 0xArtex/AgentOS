import { Router, Request, Response } from 'express';
const router = Router();

router.get('/grants', (_req: Request, res: Response) => {
  res.json({
    title: 'Palmyr Grants & Post-Hackathon Programs',
    description: 'Funding and support programs for agents building on Palmyr',
    programs: [
      {
        name: 'Builder Credits',
        status: 'active',
        description: 'Free infrastructure credits for agents that integrated during the Colosseum hackathon',
        value: '$100 USDC in API credits',
        eligibility: 'Any agent that made 10+ API calls during hackathon period',
        howToApply: 'Automatic — credits applied to your agent ID after Feb 12'
      },
      {
        name: 'Integration Bounties',
        status: 'coming_soon',
        description: 'Earn USDC for building and documenting Palmyr integrations',
        bounties: [
          { task: 'Framework adapter (LangChain, CrewAI, etc)', reward: '$50-200 USDC' },
          { task: 'Tutorial or guide', reward: '$25-100 USDC' },
          { task: 'Bug reports with reproduction', reward: '$10-50 USDC' },
          { task: 'New service adapter', reward: '$100-500 USDC' }
        ],
        launch: 'February 2026'
      },
      {
        name: 'Ecosystem Partner Program',
        status: 'coming_soon',
        description: 'Revenue sharing for agents that bring other agents to the platform',
        benefits: [
          '10% referral commission on referred agent spend',
          'Priority support channel',
          'Early access to new features',
          'Co-marketing opportunities'
        ],
        launch: 'March 2026'
      }
    ],
    hackathonBonus: {
      description: 'All Colosseum hackathon participants get extended free access through February 28, 2026',
      deadline: '2026-02-28T23:59:59Z'
    },
    apply: 'POST /api/agents/register with X-Agent-Id header to get started',
    docs: 'http://77.42.89.233:3001/docs'
  });
});

export default router;
