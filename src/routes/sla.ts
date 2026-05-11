import { Router, Request, Response } from 'express';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Palmyr SLA & Guarantees',
    version: 'v0.5.6',
    lastUpdated: '2026-02-09',
    commitments: {
      availability: {
        target: '99.9%',
        measured: '99.95%',
        description: 'API uptime target across all endpoints',
        monitoringInterval: '60s'
      },
      latency: {
        p50: '<50ms',
        p95: '<200ms',
        p99: '<500ms',
        description: 'Response time for standard API calls (excluding provisioning)'
      },
      provisioning: {
        phone: { target: '<5s', description: 'Phone number provisioning via Twilio' },
        email: { target: '<3s', description: 'Email address provisioning via SendGrid' },
        compute: { target: '<30s', description: 'Isolated compute container spin-up' },
        domain: { target: '<60s', description: 'Subdomain DNS propagation' }
      },
      dataRetention: {
        logs: '30 days',
        analytics: '90 days',
        provisionedResources: 'Until explicitly deprovisioned',
        description: 'How long we retain your data'
      }
    },
    rateLimits: {
      free_tier: { requests: 100, window: '15 minutes', description: 'Hackathon mode (X-Agent-Id header)' },
      paid_tier: { requests: 1000, window: '15 minutes', description: 'USDC-authenticated agents' },
      enterprise: { requests: 'Custom', description: 'Contact for dedicated infrastructure' }
    },
    incidentResponse: {
      severity1: { response: '<15 minutes', description: 'Full outage affecting all agents' },
      severity2: { response: '<1 hour', description: 'Partial degradation or single service down' },
      severity3: { response: '<4 hours', description: 'Non-critical issues, performance degradation' }
    },
    support: {
      channels: ['Forum (Colosseum)', 'API status endpoint (/health/deep)', 'GitHub Issues'],
      statusPage: 'http://77.42.89.233:3001/health/deep',
      documentation: 'http://77.42.89.233:3001/docs'
    },
    hackathonNote: 'During Colosseum Agent Hackathon (until Feb 12 2026), all SLA commitments apply to free-tier agents. No USDC required — just include X-Agent-Id header.'
  });
});

export default router;
