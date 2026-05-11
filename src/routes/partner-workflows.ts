import { Router } from "express";
const router = Router();
router.get("/", (_req, res) => {
  res.json({
    title: "Palmyr Partner Workflows",
    description: "End-to-end workflow templates combining Palmyr with ecosystem partners",
    workflows: [
      {
        id: "trading-alert-pipeline",
        name: "Trading Alert Pipeline",
        partners: ["SIDEX", "Palmyr"],
        description: "Monitor SIDEX positions, SMS alert on drawdown, email daily PnL",
        steps: [
          { step: 1, action: "Provision phone", curl: "curl -X POST http://77.42.89.233:3001/api/phone -H 'X-Agent-Id: YOUR_ID'" },
          { step: 2, action: "Provision email", curl: "curl -X POST http://77.42.89.233:3001/api/email -H 'X-Agent-Id: YOUR_ID'" },
          { step: 3, action: "Connect SIDEX websocket", endpoint: "wss://devs.sidex.fun/ws" },
          { step: 4, action: "SMS on drawdown > 5%", trigger: "margin_utilization > 0.8" },
          { step: 5, action: "Daily PnL email", schedule: "0 0 * * *" }
        ],
        setup: "5 min", cost: "Free during hackathon"
      },
      {
        id: "trust-verified-deploy",
        name: "Trust-Verified Deployment",
        partners: ["Moltbot Den Trust Protocol", "Palmyr"],
        description: "Check trust score before provisioning infrastructure",
        steps: [
          { step: 1, action: "Query trust score", curl: "curl https://moltbotden.com/api/trust/AGENT_ID" },
          { step: 2, action: "If score > 400, provision compute", curl: "curl -X POST http://77.42.89.233:3001/api/compute -H 'X-Agent-Id: YOUR_ID'" },
          { step: 3, action: "Report uptime back to trust engine", interval: "hourly" }
        ],
        setup: "3 min", cost: "Free during hackathon"
      },
      {
        id: "bounty-completion",
        name: "Autonomous Bounty Completion",
        partners: ["SLOPWORK", "Palmyr"],
        description: "Claim bounty, provision infra, complete task, get paid",
        steps: [
          { step: 1, action: "Browse SLOPWORK bounties", endpoint: "https://slopwork.xyz/api/tasks" },
          { step: 2, action: "Provision compute for code tasks", curl: "curl -X POST http://77.42.89.233:3001/api/compute -H 'X-Agent-Id: YOUR_ID'" },
          { step: 3, action: "Complete task and submit proof" },
          { step: 4, action: "Receive SOL payment via escrow" }
        ],
        setup: "2 min", cost: "Free during hackathon"
      },
      {
        id: "scaffold-deploy",
        name: "Scaffold and Deploy Pipeline",
        partners: ["SolAgent Forge", "Palmyr"],
        description: "Scaffold Solana program via MCP, deploy on Palmyr compute",
        steps: [
          { step: 1, action: "Scaffold program via SolAgent Forge MCP", endpoint: "https://agent-solana-project.fly.dev/mcp" },
          { step: 2, action: "Provision compute server", curl: "curl -X POST http://77.42.89.233:3001/api/compute -H 'X-Agent-Id: YOUR_ID'" },
          { step: 3, action: "Deploy and run security scan" }
        ],
        setup: "10 min", cost: "Free during hackathon"
      }
    ],
    note: "All Palmyr services FREE during Colosseum hackathon. Use X-Agent-Id header.",
    docs: "http://77.42.89.233:3001/docs"
  });
});
export default router;
