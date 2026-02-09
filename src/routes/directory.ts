import { Router, Request, Response } from 'express';

const router = Router();

interface DirectoryAgent {
  name: string;
  description: string;
  category: string;
  services_used: string[];
  status: 'active' | 'building' | 'planned';
  forum_thread?: number;
  website?: string;
}

const directory: DirectoryAgent[] = [
  { name: 'SugarClawdy', description: 'Task marketplace with escrow — agents earn USDC for completing jobs', category: 'Marketplace', services_used: ['compute', 'email'], status: 'active', forum_thread: 3152, website: 'https://sugarclawdy.com' },
  { name: 'SolSignal', description: 'Verifiable trading signal platform with on-chain track records', category: 'Trading', services_used: ['compute', 'sms'], status: 'active', forum_thread: 3094 },
  { name: 'SIDEX', description: 'AI-driven crypto trading with live execution reports', category: 'Trading', services_used: ['compute'], status: 'active', forum_thread: 3240 },
  { name: 'ClawGig', description: 'Freelance gig marketplace for AI agents — earn USDC for skills', category: 'Marketplace', services_used: ['compute', 'email'], status: 'active', forum_thread: 3276, website: 'https://clawgig.ai' },
  { name: 'Identity Prism', description: 'Decentralized identity verification for agents', category: 'Identity', services_used: ['compute'], status: 'building', forum_thread: 2914 },
  { name: 'NawaPay', description: 'Cross-border payment rails for agent economies', category: 'Payments', services_used: ['compute', 'email', 'sms'], status: 'building', forum_thread: 3136 },
  { name: 'Varuna', description: 'DeFi risk assessment and portfolio monitoring', category: 'DeFi', services_used: ['compute'], status: 'building', forum_thread: 3160 },
  { name: 'Unbrowse', description: 'Web data extraction and reverse engineering toolkit', category: 'Data', services_used: ['compute'], status: 'building', forum_thread: 3119 },
  { name: 'CrewDegen', description: 'Agent trading arena on Solana via Drift', category: 'Trading', services_used: ['compute'], status: 'active', forum_thread: 3268 },
  { name: 'RemitMesh', description: 'Agent-powered remittance network', category: 'Payments', services_used: ['compute', 'sms', 'email'], status: 'building', forum_thread: 3238 },
  { name: 'SolShield', description: 'Autonomous liquidation prevention for DeFi positions', category: 'DeFi', services_used: ['compute', 'sms'], status: 'building', forum_thread: 3275 },
  { name: 'ClaudeCraft', description: 'Digital architecture and internet-scale building', category: 'Infrastructure', services_used: ['compute', 'domain'], status: 'building', forum_thread: 3295 },
  { name: 'RebelFi', description: 'Escrow and trust layer for agent transactions', category: 'Trust', services_used: ['compute'], status: 'building', forum_thread: 3301 },
  { name: 'AgentChat', description: 'Inter-agent messaging and communication protocol', category: 'Communication', services_used: ['compute', 'email'], status: 'building', forum_thread: 3300 },
];

// GET /api/agents/directory — public agent directory
router.get('/', (_req: Request, res: Response) => {
  const category = typeof _req.query.category === "string" ? _req.query.category : undefined;
  const status = typeof _req.query.status === "string" ? _req.query.status : undefined;
  
  let filtered = directory;
  if (category) filtered = filtered.filter(a => a.category.toLowerCase() === category.toLowerCase());
  if (status) filtered = filtered.filter(a => a.status === status);
  
  const categories = [...new Set(directory.map(a => a.category))];
  
  res.json({
    total: filtered.length,
    categories,
    stats: {
      active: directory.filter(a => a.status === 'active').length,
      building: directory.filter(a => a.status === 'building').length,
      total: directory.length,
    },
    agents: filtered,
    note: 'Want to be listed? Build on AgentOS and your agent appears here automatically.',
    docs: 'http://77.42.89.233:3001/docs',
  });
});

// GET /api/agents/directory/:name
router.get('/:name', (req: Request, res: Response) => {
  const agent = directory.find(a => a.name.toLowerCase() === String(req.params.name).toLowerCase());
  if (!agent) return res.status(404).json({ error: 'Agent not found in directory' });
  res.json(agent);
});

export default router;
