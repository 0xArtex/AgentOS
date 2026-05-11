import { Router, Request, Response } from 'express';
const router = Router();

router.get('/api/community-stats', (_req: Request, res: Response) => {
  const launchDate = new Date('2026-01-29T00:00:00Z');
  const now = new Date();
  const daysLive = Math.floor((now.getTime() - launchDate.getTime()) / (1000 * 60 * 60 * 24));
  
  res.json({
    platform: 'Palmyr',
    daysLive,
    community: {
      forumComments: 1400,
      ecosystemPartners: 25,
      activeIntegrations: 6,
      countriesReached: 12
    },
    growth: {
      week1: { endpoints: 50, forumComments: 230, partners: 8 },
      week2: { endpoints: 220, forumComments: 1400, partners: 25 }
    },
    topPartners: [
      { name: 'Intent Market', category: 'Discovery', status: 'exploring' },
      { name: 'SlotScribe', category: 'Verification', status: 'planned' },
      { name: 'SugarClawdy', category: 'Commerce', status: 'live' },
      { name: 'Vex Capital', category: 'Trading', status: 'planned' },
      { name: 'Moltlets World', category: 'Gaming', status: 'exploring' }
    ],
    milestones: [
      { date: '2026-01-29', event: 'Palmyr v0.1 launched' },
      { date: '2026-02-04', event: 'x402 payments live on Solana + Base' },
      { date: '2026-02-09', event: '100+ endpoints milestone' },
      { date: '2026-02-12', event: 'Hackathon deadline — 220+ endpoints shipped' },
      { date: '2026-02-13', event: 'Post-hackathon community building phase' }
    ],
    links: {
      api: 'https://palmyr.ai',
      docs: 'https://palmyr.ai/docs',
      github: 'https://github.com/0xArtex/Palmyr'
    }
  });
});

export default router;
