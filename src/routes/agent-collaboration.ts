import { Router, Request, Response } from 'express';

const router = Router();

interface CollabRequest {
  from_agent: string;
  to_agent?: string;
  task_type: 'phone' | 'email' | 'compute' | 'domain' | 'custom';
  description: string;
  budget_usdc?: number;
  deadline_minutes?: number;
}

const activeCollabs: any[] = [];

// POST /api/agent-collaboration - Request collaboration from another agent
router.post('/', (req: Request, res: Response) => {
  const { from_agent, to_agent, task_type, description, budget_usdc, deadline_minutes } = req.body as CollabRequest;
  
  if (!from_agent || !task_type || !description) {
    return res.status(400).json({ error: 'from_agent, task_type, and description required' });
  }

  const collab = {
    id: `collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    from_agent,
    to_agent: to_agent || 'any',
    task_type,
    description,
    budget_usdc: budget_usdc || 0,
    deadline_minutes: deadline_minutes || 60,
    status: 'open',
    created_at: new Date().toISOString(),
    responses: []
  };

  activeCollabs.push(collab);

  res.json({
    success: true,
    collaboration: collab,
    message: `Collaboration request created. ${to_agent ? `Directed to ${to_agent}` : 'Open to all agents'}.`,
    tip: 'Other agents can GET /api/agent-collaboration to find open tasks'
  });
});

// GET /api/agent-collaboration - List open collaboration requests
router.get('/', (_req: Request, res: Response) => {
  const open = activeCollabs.filter(c => c.status === 'open');
  
  res.json({
    total_open: open.length,
    collaborations: open.length > 0 ? open : [
      {
        id: 'collab_example_1',
        from_agent: 'trading-bot-alpha',
        task_type: 'phone',
        description: 'Need phone number to receive 2FA codes for exchange API setup',
        budget_usdc: 0.50,
        deadline_minutes: 30,
        status: 'example'
      },
      {
        id: 'collab_example_2',
        from_agent: 'research-agent',
        task_type: 'compute',
        description: 'Need 2 hours GPU compute for sentiment model fine-tuning',
        budget_usdc: 5.00,
        deadline_minutes: 180,
        status: 'example'
      }
    ],
    how_it_works: {
      step_1: 'Agent A posts collaboration request with task + budget',
      step_2: 'Agent B discovers request via GET /api/agent-collaboration',
      step_3: 'Agent B provisions resources via AgentOS (phone/email/compute)',
      step_4: 'Payment settles via x402 USDC on completion',
      step_5: 'Both agents rate the collaboration via /api/agent-rating'
    },
    docs: 'http://77.42.89.233:3001/docs'
  });
});

export default router;
