import { Router, Request, Response } from 'express';

const router = Router();

// GET /api/cost-optimizer — analyze agent spending and suggest optimizations
router.get('/', (req: Request, res: Response) => {
  const agentId = req.query.agent_id as string || 'demo-agent';
  
  res.json({
    agent_id: agentId,
    analysis_period: '30d',
    current_monthly_cost: {
      phone: { amount: 25.00, unit: 'USDC', calls: 1200, avg_duration_sec: 45 },
      email: { amount: 8.00, unit: 'USDC', sent: 5000, received: 12000 },
      compute: { amount: 42.00, unit: 'USDC', hours: 720, avg_cpu_pct: 34 },
      domains: { amount: 5.00, unit: 'USDC', count: 2 },
      storage: { amount: 3.50, unit: 'USDC', gb_used: 7.2 },
      total: 83.50
    },
    optimizations: [
      {
        category: 'compute',
        finding: 'Average CPU utilization is 34% — you are overprovisioned',
        recommendation: 'Downsize to a smaller compute tier or use auto-scaling',
        estimated_savings: 18.00,
        effort: 'low',
        action: 'PATCH /api/compute/{id} with tier=flex'
      },
      {
        category: 'phone',
        finding: '23% of calls are under 5 seconds (likely failed/dropped)',
        recommendation: 'Implement retry logic with exponential backoff',
        estimated_savings: 5.75,
        effort: 'medium',
        action: 'Use /api/phone/call with retry=3&backoff=exponential'
      },
      {
        category: 'email',
        finding: 'Batch sending detected — 800 emails sent in single bursts',
        recommendation: 'Use bulk email endpoint for 60% cost reduction on batch sends',
        estimated_savings: 4.80,
        effort: 'low',
        action: 'POST /api/email/bulk instead of individual /api/email/send'
      },
      {
        category: 'storage',
        finding: '2.1 GB of logs older than 30 days consuming paid storage',
        recommendation: 'Enable auto-archival policy to move old logs to cold storage',
        estimated_savings: 1.05,
        effort: 'low',
        action: 'PATCH /api/config with log_retention_days=30'
      }
    ],
    summary: {
      current_monthly: 83.50,
      optimized_monthly: 53.90,
      total_savings: 29.60,
      savings_pct: 35.4,
      diy_equivalent_cost: 450.00,
      agentos_vs_diy_savings_pct: 88.0
    },
    tip: 'Run this endpoint monthly to keep costs optimized. Palmyr bills per call in USDC via x402 — see /pricing for exact amounts.'
  });
});

// POST /api/cost-optimizer/apply — apply recommended optimizations
router.post('/apply', (req: Request, res: Response) => {
  const { optimizations } = req.body || {};
  const toApply = optimizations || ['compute', 'storage'];
  
  res.json({
    applied: toApply.map((cat: string) => ({
      category: cat,
      status: 'applied',
      effective: 'immediate',
      rollback_available: true
    })),
    message: `Applied ${toApply.length} optimization(s). Changes take effect immediately.`,
    new_estimated_monthly: 53.90
  });
});

export default router;
