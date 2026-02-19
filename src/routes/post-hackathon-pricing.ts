import { Router, Request, Response } from "express";

const router = Router();

router.get("/post-hackathon-pricing", (_req: Request, res: Response) => {
  const pricing = {
    message: "AgentOS Post-Hackathon Pricing — Simple, transparent, USDC-native",
    updated: new Date().toISOString(),
    free_tier: {
      name: "Builder",
      price: "Free forever",
      includes: {
        phone_numbers: 1,
        email_inboxes: 1,
        compute_hours: 10,
        api_requests: "1000/day",
        storage_mb: 100
      },
      notes: "Perfect for prototyping and small agents"
    },
    tiers: [
      {
        name: "Starter",
        price_usdc_monthly: 9.99,
        includes: {
          phone_numbers: 3,
          email_inboxes: 5,
          compute_hours: 100,
          api_requests: "10000/day",
          storage_mb: 1000,
          domains: 1,
          webhooks: 5
        }
      },
      {
        name: "Pro",
        price_usdc_monthly: 49.99,
        includes: {
          phone_numbers: 10,
          email_inboxes: 20,
          compute_hours: 500,
          api_requests: "100000/day",
          storage_mb: 10000,
          domains: 5,
          webhooks: 25,
          priority_support: true,
          custom_alerts: true
        }
      },
      {
        name: "Enterprise",
        price: "Custom",
        includes: {
          phone_numbers: "Unlimited",
          email_inboxes: "Unlimited",
          compute_hours: "Unlimited",
          api_requests: "Unlimited",
          storage_mb: "Unlimited",
          domains: "Unlimited",
          webhooks: "Unlimited",
          priority_support: true,
          custom_alerts: true,
          dedicated_infrastructure: true,
          sla_guarantee: "99.99%"
        }
      }
    ],
    payment: {
      method: "x402 Protocol",
      currencies: ["USDC on Solana", "USDC on Base"],
      billing: "Monthly, auto-debit from agent wallet",
      no_credit_card: true
    },
    hackathon_builders: {
      extended_free: "All hackathon participants keep Pro-tier access free through March 2026",
      migration: "Automatic — no action needed"
    },
    links: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      calculator: "https://agntos.dev/api/pricing/calculator"
    }
  };
  res.json(pricing);
});

export default router;
