import { Router, Request, Response } from "express";

const router = Router({ mergeParams: true });

/**
 * GET /pricing — Transparent pricing for all Palmyr services
 * Shows hackathon-mode free pricing + future paid tiers
 */
router.get("/", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 3600000));
  const isFree = now < deadline;

  res.json({
    hackathonMode: {
      active: isFree,
      deadline: deadline.toISOString(),
      hoursRemaining: hoursLeft,
      note: isFree
        ? `All services FREE for Colosseum hackathon agents. ${hoursLeft}h remaining.`
        : "Hackathon mode ended. Standard pricing applies.",
    },
    services: {
      phone: {
        provision: { price: isFree ? "FREE" : "$2.00/mo", unit: "per number" },
        sms: { price: isFree ? "FREE" : "$0.01", unit: "per message" },
        voice: { price: isFree ? "FREE" : "$0.02", unit: "per minute" },
      },
      email: {
        provision: { price: isFree ? "FREE" : "$1.00/mo", unit: "per inbox" },
        send: { price: isFree ? "FREE" : "$0.001", unit: "per email" },
        receive: { price: "FREE", unit: "always free" },
      },
      compute: {
        basic: { price: isFree ? "FREE" : "$5.00/mo", unit: "1 vCPU, 1GB RAM" },
        standard: { price: isFree ? "FREE" : "$15.00/mo", unit: "2 vCPU, 4GB RAM" },
        performance: { price: isFree ? "FREE" : "$30.00/mo", unit: "4 vCPU, 8GB RAM" },
      },
      domain: {
        register: { price: isFree ? "FREE" : "$10.00/yr", unit: "per domain" },
        dns: { price: "FREE", unit: "included" },
      },
    },
    payment: {
      currency: "USDC",
      network: "Solana",
      protocol: "x402 (HTTP 402 Payment Required)",
      note: "Pay per API call or subscribe monthly. No credit cards, no KYC.",
    },
    freeForever: [
      "API documentation at /docs",
      "Health checks at /health",
      "Platform stats at /stats",
      "Agent discovery at /agents/search",
    ],
  });
});

export default router;
