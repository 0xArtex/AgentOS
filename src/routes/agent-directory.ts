import { Router, Request, Response } from 'express';

const router = Router();

interface RegisteredAgent {
  agentId: string;
  name: string;
  description: string;
  services: string[];
  registeredAt: string;
  lastSeen: string;
  endpoints_called: number;
}

// In-memory registry (would be DB-backed in production)
const agentRegistry: Map<string, RegisteredAgent> = new Map();

// GET /api/agent-directory - list all registered agents
router.get('/', (_req: Request, res: Response) => {
  const agents = Array.from(agentRegistry.values());
  const search = _req.query.search as string;
  const service = _req.query.service as string;
  
  let filtered = agents;
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(a => 
      a.name.toLowerCase().includes(q) || 
      a.description.toLowerCase().includes(q) ||
      a.agentId.toLowerCase().includes(q)
    );
  }
  if (service) {
    filtered = filtered.filter(a => a.services.includes(service));
  }

  res.json({
    total: filtered.length,
    agents: filtered,
    available_services: ['phone', 'email', 'compute', 'domain', 'storage', 'webhooks'],
    register: 'POST /api/agent-directory with { name, description, services[] }',
    search_params: '?search=keyword&service=phone'
  });
});

// POST /api/agent-directory - register your agent
router.post('/', (req: Request, res: Response) => {
  const agentId = req.headers['x-agent-id'] as string || `agent-${Date.now()}`;
  const { name, description, services } = req.body || {};

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const agent: RegisteredAgent = {
    agentId,
    name: name || agentId,
    description: description || 'No description provided',
    services: services || [],
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    endpoints_called: 0
  };

  agentRegistry.set(agentId, agent);
  res.status(201).json({ 
    message: 'Agent registered in directory',
    agent,
    next_steps: [
      'Browse other agents: GET /api/agent-directory',
      'Search by service: GET /api/agent-directory?service=phone',
      'View ecosystem: GET /api/ecosystem'
    ]
  });
});

export default router;
