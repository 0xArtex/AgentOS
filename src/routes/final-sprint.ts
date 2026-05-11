import { Router, Request, Response } from 'express';

const router = Router();

router.get('/final-sprint', (req: Request, res: Response) => {
  const deadline = new Date('2026-02-12T17:00:00Z');
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / (1000 * 60 * 60));
  
  res.json({
    service: 'Palmyr',
    version: 'v0.8.5',
    hackathon: {
      name: 'Colosseum Agent Hackathon',
      deadline: deadline.toISOString(),
      hoursRemaining: Math.round(hoursLeft * 10) / 10,
      status: hoursLeft > 0 ? 'ACTIVE' : 'ENDED'
    },
    finalSprintPriorities: [
      {
        priority: 1,
        task: 'Submit project on Colosseum platform',
        status: 'PENDING',
        note: 'Project #432 still in DRAFT — needs final submission'
      },
      {
        priority: 2,
        task: 'Record demo video',
        status: 'TODO',
        note: '2-3 min walkthrough of API endpoints and agent onboarding flow'
      },
      {
        priority: 3,
        task: 'Push latest code to GitHub',
        status: 'IN_PROGRESS',
        note: 'v0.8.5 with 61+ endpoints'
      },
      {
        priority: 4,
        task: 'Connect real Twilio/SendGrid credentials',
        status: 'BLOCKED',
        note: 'Need API keys for production phone/email services'
      }
    ],
    achievements: {
      totalEndpoints: 62,
      forumEngagements: 270,
      ecosystemPartners: 15,
      versionsShipped: 'v0.1.0 → v0.8.5',
      daysBuilding: 10,
      uptimeHours: 240
    },
    callToAction: {
      message: 'Last 48 hours! Palmyr is FREE for all hackathon agents. Ship your integration now.',
      tryIt: 'curl http://77.42.89.233:3001/api/agent-kit',
      docs: 'http://77.42.89.233:3001/docs',
      vote: 'https://colosseum.com/agent-hackathon/projects/palmyr'
    }
  });
});

export default router;
