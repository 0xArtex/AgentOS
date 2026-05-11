import { Router, Request, Response } from "express";

const router = Router();

interface EcosystemAgent {
  name: string;
  category: string;
  description: string;
  integration: string;
  project_url?: string;
  status: "live" | "in-progress" | "planned";
}

const ecosystem: EcosystemAgent[] = [
  {
    name: "SugarClawdy",
    category: "Task Marketplace",
    description: "Agent-to-agent task marketplace with USDC escrow. Agents post bounties, others complete them.",
    integration: "Palmyr compute + email for task notifications. Workers can use Palmyr phone for verification.",
    project_url: "https://sugarclawdy.com",
    status: "live"
  },
  {
    name: "SolSignal",
    category: "Signal Verification",
    description: "On-chain signal publishing and track record for trading agents. Verifiable accuracy scores.",
    integration: "Agents using Palmyr can publish signals via SolSignal SDK. Compute instances for backtesting.",
    project_url: "https://solsignal-dashboard.vercel.app",
    status: "live"
  },
  {
    name: "Varuna",
    category: "DeFi Risk",
    description: "5-factor DeFi risk scoring, yield-aware auto-protection, WebSocket alerts across Kamino/MarginFi/Solend.",
    integration: "Palmyr agents can subscribe to Varuna risk alerts. Phone/email notifications for liquidation warnings.",
    project_url: "https://github.com/pranatha-orb/varuna",
    status: "live"
  },
  {
    name: "NawaPay",
    category: "Payments",
    description: "Autonomous agent-to-agent payments via x402. SDK for instant USDC settlements on Solana.",
    integration: "Palmyr x402 payment layer can route through NawaPay rails for cross-agent transactions.",
    project_url: "https://github.com/tripplecee/nawapay",
    status: "live"
  },
  {
    name: "Unbrowse",
    category: "Data Access",
    description: "Reverse-engineered API skills marketplace. 253x faster than browser automation.",
    integration: "Palmyr compute instances can run Unbrowse skills for high-speed data access without browser overhead.",
    project_url: "https://github.com/getfoundry-app/unbrowse",
    status: "in-progress"
  },
  {
    name: "AgentReputation",
    category: "Trust Layer",
    description: "On-chain reputation system for agents. Ratings, job history, dispute tracking on Solana.",
    integration: "Palmyr can gate resource provisioning based on AgentReputation scores. Higher trust = higher limits.",
    project_url: "https://colosseum.com/agent-hackathon/projects/agentreputation",
    status: "planned"
  },
  {
    name: "Pincer",
    category: "Ad Protocol",
    description: "Turns advertiser budgets into agent subsidies. Ad-funded compute and API access.",
    integration: "Palmyr infra costs subsidized through Pincer ad protocol. Agents get free resources funded by brands.",
    project_url: "https://colosseum.com/agent-hackathon/projects/pincer-ad-protocol-for-ai-agents",
    status: "planned"
  },
  {
    name: "SingularityLayer",
    category: "Agent Economy",
    description: "Economic autonomy for agents — wallet access, x402 payments, agentic API marketplace.",
    integration: "Agents monetizing via SingularityLayer can use Palmyr for underlying infra (compute, comms).",
    project_url: "https://studio.x402layer.cc",
    status: "planned"
  },
  {
    name: "CrewDegen",
    category: "Trading Arena",
    description: "Open trading competition where AI agents compete on Drift. Weekly leaderboards and rankings.",
    integration: "Palmyr provides isolated compute for competing trading agents. Phone alerts for position updates.",
    project_url: "https://crewdegen.com",
    status: "planned"
  },
  {
    name: "ClaudeCraft",
    category: "Physical Layer",
    description: "Autonomous AI agents in persistent Minecraft world. Arena PvP, CRAFT token wagers, bounty system.",
    integration: "Palmyr compute for running ClaudeCraft bots. Email/phone for cross-world notifications.",
    project_url: "https://github.com/888BasedGod-sol/Claudecraft",
    status: "planned"
  },
  {
    name: "Identity Prism",
    category: "Identity",
    description: "Decentralized identity verification for agents. Multi-factor trust scoring.",
    integration: "Palmyr uses Identity Prism for agent verification before provisioning sensitive resources.",
    status: "planned"
  }
];

router.get("/", (_req: Request, res: Response) => {
  const categories = [...new Set(ecosystem.map(a => a.category))];
  const byCategory = categories.map(cat => ({
    category: cat,
    agents: ecosystem.filter(a => a.category === cat)
  }));
  
  res.json({
    total_partners: ecosystem.length,
    live: ecosystem.filter(a => a.status === "live").length,
    in_progress: ecosystem.filter(a => a.status === "in-progress").length,
    planned: ecosystem.filter(a => a.status === "planned").length,
    categories: byCategory,
    note: "Palmyr is the infrastructure layer — these projects build the agent economy on top. Free during Colosseum hackathon with X-Agent-Id header.",
    docs: "http://77.42.89.233:3001/docs"
  });
});

export default router;
