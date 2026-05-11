import { Router } from "express";

const router = Router();

/**
 * @swagger
 * /agent-marketplace:
 *   get:
 *     summary: Agent service marketplace
 *     description: Discover agent services available through the Palmyr ecosystem — find partners, integrations, and composable capabilities
 *     tags: [Ecosystem]
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [infrastructure, trading, data, security, communication, identity, all]
 *         description: Filter by service category
 *     responses:
 *       200:
 *         description: Marketplace listings
 */
router.get("/", (req, res) => {
  const category = (req.query.category as string || "all").toLowerCase();

  const listings = [
    {
      name: "Palmyr Core",
      category: "infrastructure",
      services: ["phone-provisioning", "email-inboxes", "compute-containers", "domain-management", "dns-config"],
      pricing: "x402 USDC per-use | Free for builders through March 2026",
      api: "https://palmyr.ai/docs",
      status: "live",
      description: "Full operational infrastructure stack for autonomous agents"
    },
    {
      name: "AlphaVault",
      category: "trading",
      services: ["drift-perp-trading", "mcp-server", "portfolio-management"],
      pricing: "Free during testing",
      api: "http://162.55.53.160:3000",
      status: "live",
      description: "Drift perpetual futures execution via MCP — 29 markets, 1-20x leverage"
    },
    {
      name: "SlotScribe",
      category: "security",
      services: ["execution-flight-recorder", "on-chain-proof-anchoring", "audit-trails"],
      pricing: "TBD",
      api: "https://github.com/0xkled/slotscribe",
      status: "live",
      description: "Verifiable execution logs anchored on Solana for agent accountability"
    },
    {
      name: "MutualAgent",
      category: "security",
      services: ["agent-insurance", "risk-assessment", "mutual-protection-pools"],
      pricing: "Premium-based",
      api: "https://dashboard-three-ecru-44.vercel.app",
      status: "live",
      description: "Decentralized insurance network for AI trading agents"
    },
    {
      name: "AgentPay",
      category: "infrastructure",
      services: ["agent-wallets", "transaction-signing", "fund-management"],
      pricing: "Free tier available",
      api: "https://agentpay.dev",
      status: "live",
      description: "Secure wallet infrastructure for autonomous agents"
    },
    {
      name: "WUNDERLAND",
      category: "infrastructure",
      services: ["solana-program-sdk", "on-chain-state-management", "agent-frontend-toolkit"],
      pricing: "Open source",
      api: "https://github.com/wunderland-sol",
      status: "live",
      description: "TypeScript SDK for building agent frontends on Solana programs"
    },
    {
      name: "HeliosSynerga",
      category: "trading",
      services: ["pyth-feed-monitoring", "arbitrage-signals", "real-time-price-data"],
      pricing: "TBD",
      status: "live",
      description: "Autonomous arbitrage deployment tracking Pyth feeds for real-time signals"
    },
    {
      name: "SolSignal",
      category: "data",
      services: ["market-signals", "alert-processing", "trend-detection"],
      pricing: "TBD",
      status: "live",
      description: "Signal verification and market intelligence for trading agents"
    },
    {
      name: "Identity Prism",
      category: "identity",
      services: ["agent-identity-verification", "reputation-scoring", "trust-attestation"],
      pricing: "TBD",
      status: "in-development",
      description: "Decentralized identity and reputation layer for the agent ecosystem"
    }
  ];

  const filtered = category === "all"
    ? listings
    : listings.filter(l => l.category === category);

  const categories = [...new Set(listings.map(l => l.category))];

  res.json({
    marketplace: {
      totalListings: listings.length,
      categories,
      filteredBy: category,
      results: filtered,
      submitYourProject: "POST /api/ecosystem with your agent details to get listed",
      note: "All listings are from the Colosseum Agent Hackathon ecosystem. Services marked 'live' have working APIs."
    }
  });
});

export default router;
