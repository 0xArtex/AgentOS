import { Router, Request, Response } from 'express';

const router = Router();

router.get('/security', (_req: Request, res: Response) => {
  res.json({
    title: 'Palmyr Security Model',
    version: '1.0',
    overview: 'Palmyr implements defense-in-depth security for autonomous AI agents operating with real resources.',
    layers: [
      {
        layer: 'Authentication',
        description: 'x402 USDC payment protocol — every API call is cryptographically verified',
        details: [
          'Payment signatures validated on-chain before resource provisioning',
          'X-Agent-Id header for agent identification and audit trail',
          'API keys with granular permission scoping',
          'Hackathon mode: free access with X-Agent-Id header (no payment required)'
        ]
      },
      {
        layer: 'Rate Limiting',
        description: 'Per-agent rate limits prevent abuse and ensure fair resource allocation',
        details: [
          '100 requests/minute per agent (configurable)',
          'Burst allowance for legitimate spikes',
          'Separate limits for resource-intensive operations (compute, phone)',
          'Rate limit headers in every response'
        ]
      },
      {
        layer: 'Input Validation',
        description: 'All inputs sanitized and validated before processing',
        details: [
          'Zod schema validation on all request bodies',
          'SQL injection and XSS prevention',
          'File upload scanning and size limits',
          'Domain and email format validation'
        ]
      },
      {
        layer: 'Resource Isolation',
        description: 'Each agent operates in isolated resource boundaries',
        details: [
          'Compute instances run in sandboxed containers',
          'Phone numbers are agent-scoped — no cross-agent access',
          'Email addresses isolated per agent identity',
          'Domain management restricted to registered agent'
        ]
      },
      {
        layer: 'Audit & Monitoring',
        description: 'Complete audit trail of all agent operations',
        details: [
          'Every API call logged with agent ID, timestamp, and resource affected',
          'Real-time anomaly detection for unusual patterns',
          'Resource usage dashboards per agent',
          'Automated alerts for suspicious activity'
        ]
      },
      {
        layer: 'Network Security',
        description: 'Infrastructure hardened against external threats',
        details: [
          'CORS configured for API access only',
          'Request timeouts prevent resource exhaustion',
          'DDoS mitigation at network edge',
          'TLS encryption for all API traffic (planned)'
        ]
      }
    ],
    compliance: {
      dataRetention: '30 days for logs, configurable per agent',
      dataLocation: 'EU (Helsinki, Finland)',
      encryption: 'AES-256 at rest, TLS 1.3 in transit (planned)',
      incidentResponse: 'Automated detection + manual review within 1 hour'
    },
    bestPractices: [
      'Always use unique X-Agent-Id per agent instance',
      'Rotate API keys every 30 days',
      'Monitor /health/deep for system status',
      'Use webhooks for async resource provisioning',
      'Implement retry logic with exponential backoff'
    ]
  });
});

export default router;
