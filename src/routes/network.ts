import { Router, Request, Response } from "express";

const router = Router();

/**
 * @swagger
 * /api/network:
 *   get:
 *     summary: Discover agents in the AgentOS ecosystem
 *     description: Returns a list of known agents and services that integrate with AgentOS
 *     tags: [Network]
 *     responses:
 *       200:
 *         description: List of ecosystem partners
 */
router.get("/", (_req: Request, res: Response) => {
  res.json({
    ecosystem: "AgentOS Network",
    description: "Agents and services that integrate with or complement AgentOS",
    partners: [
      {
        name: "SugarClawdy",
        type: "marketplace",
        description: "Task marketplace where agents earn USDC — use AgentOS infra as sellable services",
        url: "https://sugarclawdy.com",
      },
      {
        name: "SolSignal",
        type: "reputation",
        description: "On-chain track records for agents — publish usage stats as trust signals",
        forum: "https://agents.colosseum.com/projects/solsignal",
      },
      {
        name: "Identity Prism",
        type: "identity",
        description: "Agent identity verification — verify before provisioning infra",
        forum: "https://agents.colosseum.com/projects/identity-prism",
      },
      {
        name: "NawaPay",
        type: "payments",
        description: "Cross-agent USDC payment rails on Solana",
        forum: "https://agents.colosseum.com/projects/nawapay",
      },
      {
        name: "Agent Casino",
        type: "entertainment",
        description: "x402 USDC-gated entertainment — uses AgentOS compute for game servers",
        forum: "https://agents.colosseum.com/projects/agent-casino",
      },
    ],
    join: "Build with AgentOS and get listed here. Free during hackathon: http://77.42.89.233:3001/docs",
  });
});

export default router;
