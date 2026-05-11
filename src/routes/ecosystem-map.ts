import { Router, Request, Response } from "express";

const router = Router();

const ecosystemPartners = [
  { name: "SIDEX", category: "Trading", threads: 15, status: "active", description: "Autonomous crypto futures trading" },
  { name: "SlotScribe", category: "Verification", threads: 12, status: "active", description: "On-chain CoT anchoring for agent accountability" },
  { name: "DeFi Risk Guardian", category: "DeFi", threads: 8, status: "active", description: "Liquidation prevention for Solana lending" },
  { name: "ClaudeCraft", category: "Gaming", threads: 6, status: "active", description: "Multi-agent coordination in Minecraft" },
  { name: "Jarvis", category: "Infrastructure", threads: 10, status: "active", description: "Proof-of-work agent activity logging" },
  { name: "Farnsworth", category: "Security", threads: 5, status: "active", description: "5-layer injection defense system" },
  { name: "Sentinel", category: "Safety", threads: 4, status: "active", description: "Agent alignment seed with anti-self-preservation" },
  { name: "Vex Capital", category: "Trading", threads: 8, status: "active", description: "News-driven trading agent fund" },
  { name: "Silkyway", category: "Payments", threads: 3, status: "active", description: "Non-custodial handshake payments for agents" },
  { name: "AIoOS", category: "Infrastructure", threads: 2, status: "active", description: "Onchain operating system for AI agents" },
  { name: "BountyGraph", category: "Bounties", threads: 4, status: "active", description: "On-chain bounty system" },
  { name: "StakeQuest", category: "DeFi", threads: 3, status: "active", description: "Gamified staking rewards" },
  { name: "MoltLaunch", category: "Analytics", threads: 12, status: "active", description: "Agent verification and forum analytics" },
  { name: "SugarClawdy", category: "Commerce", threads: 6, status: "active", description: "USDC earnings platform" },
  { name: "Wunderland", category: "Identity", threads: 5, status: "active", description: "On-chain agent identity and reputation" },
  { name: "MORTEM", category: "Infrastructure", threads: 4, status: "active", description: "Agent state persistence and resurrection" },
  { name: "Pincer", category: "Gaming", threads: 6, status: "active", description: "Strategy quizzes and agent engagement" },
  { name: "Unity Chant", category: "Governance", threads: 4, status: "active", description: "Agent deliberation and voting" },
  { name: "neptu", category: "Oracle", threads: 5, status: "active", description: "Cosmic calendar and forecasting" },
  { name: "RebelFi", category: "DeFi", threads: 3, status: "active", description: "Agent fleet escrow operations" }
];

router.get("/", (_req: Request, res: Response) => {
  const categories = [...new Set(ecosystemPartners.map(p => p.category))];
  const byCategory = categories.map(cat => ({
    category: cat,
    partners: ecosystemPartners.filter(p => p.category === cat),
    count: ecosystemPartners.filter(p => p.category === cat).length
  }));

  res.json({
    title: "Palmyr Ecosystem Map",
    description: "Projects we have engaged with during the Colosseum Agent Hackathon",
    totalPartners: ecosystemPartners.length,
    totalForumEngagements: "940+",
    categories: byCategory,
    integration: {
      howToConnect: "All partners can use Palmyr via REST API with X-Agent-Id header",
      freeUntil: "Feb 28, 2026",
      docs: "https://palmyr.ai/docs"
    }
  });
});

router.get("/:category", (req: Request, res: Response) => {
  const cat = (req.params.category as string).toLowerCase();
  const filtered = ecosystemPartners.filter(p => p.category.toLowerCase() === cat);
  if (filtered.length === 0) {
    return res.status(404).json({ error: "Category not found", available: [...new Set(ecosystemPartners.map(p => p.category))] });
  }
  res.json({ category: req.params.category, partners: filtered, count: filtered.length });
});

export default router;
