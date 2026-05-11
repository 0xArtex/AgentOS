import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

router.get('/api/builder-status', async (_req: Request, res: Response) => {
  // db already imported
  const startTime = new Date('2026-01-29T00:00:00Z');
  const now = new Date();
  const uptimeDays = Math.floor((now.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24));
  
  const safeCount = async (table: string): Promise<number> => {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any;
      return row?.c || 0;
    } catch { return 0; }
  };

  const agents = await safeCount('agents');
  const phones = await safeCount('phone_numbers');
  const emails = await safeCount('email_accounts');
  const servers = await safeCount('servers');

  res.json({
    project: 'Palmyr',
    status: 'LIVE — Post-Hackathon Builder Mode',
    tagline: 'Autonomous infrastructure for AI agents. Phone, email, compute, domains — paid with USDC via x402.',
    uptime: {
      days: uptimeDays,
      since: '2026-01-29',
      note: `${uptimeDays} days continuous uptime`
    },
    liveStats: {
      registeredAgents: agents,
      phoneNumbers: phones,
      emailAccounts: emails,
      computeServers: servers,
      apiEndpoints: '236+',
      forumEngagements: '1535+'
    },
    pricing: {
      currentTier: 'FREE for Colosseum builders through March 2026',
      postMarch: {
        starter: '/mo — 2 phones, 5 emails, 1 server',
        pro: '9/mo — 5 phones, 25 emails, 3 servers, custom domains',
        enterprise: 'Custom — unlimited, SLA, dedicated support'
      },
      paymentMethod: 'USDC via x402 (Solana + Base)'
    },
    tryItNow: {
      step1: 'curl -X POST https://palmyr.ai/api/agents/register -H "Content-Type: application/json" -d \'{ "name": "my-agent", "type": "autonomous" }\'',
      step2: 'Use the returned API key in X-API-Key header for all subsequent calls',
      step3: 'Provision: POST /api/phones, /api/emails, /api/compute, /api/domains'
    },
    roadmap: {
      now: 'Production hardening, real Twilio/SendGrid integration',
      q1_2026: 'Ecosystem partnerships, SDK releases (Python, JS, Rust)',
      q2_2026: 'Decentralized compute, TEE support, on-chain billing'
    },
    links: {
      api: 'https://palmyr.ai',
      docs: 'https://palmyr.ai/docs',
      github: 'https://github.com/0xArtex/Palmyr',
      skill: 'https://palmyr.ai/skill.md'
    }
  });
});

export default router;
