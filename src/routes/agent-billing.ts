import { Router, Request, Response } from "express";
const router = Router();

// Per-call x402 prices in USDC, mirroring the route-level requireAuth()/x402()
// charges (email.ts, phone.ts, social.ts). The canonical, drift-free source is
// the generated GET /pricing and GET /.well-known/x402 surface (route-discovery
// walks the live router). These are duplicated here only to power /estimate.
// Domain registration and compute deploys are priced dynamically per request, so
// they have no fixed entry — probe the route's 402 challenge for the exact amount.
const PRICE_USDC = {
  email_inbox: 2.0,
  email_send: 0.08,
  email_read: 0.02,
  phone_number: 3.0,
  phone_sms: 0.05,
  x_account: 5.0,
} as const;

// GET /api/agent-billing — billing model overview
router.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "agent-billing",
    model: "pay-per-call (x402)",
    description:
      "Palmyr bills per call in USDC via x402 — the exact amount is quoted in the 402 challenge at request time and settles on-chain to the provider treasury. There are no monthly invoices, post-paid balances, or accrued usage.",
    pricing: {
      note: "Canonical, drift-free prices are generated from the live route surface — see GET /pricing and GET /.well-known/x402. Common per-call prices (USDC):",
      email_inbox: PRICE_USDC.email_inbox,
      email_send: PRICE_USDC.email_send,
      email_read: PRICE_USDC.email_read,
      phone_number: PRICE_USDC.phone_number,
      phone_sms: PRICE_USDC.phone_sms,
      x_account: PRICE_USDC.x_account,
      domain_register: "dynamic (registry price + markup) — probe the 402",
      compute_deploy: "dynamic (per server type) — probe the 402",
      wallet_create: 0,
    },
    reference: { pricing: "/pricing", x402: "/.well-known/x402" },
    endpoints: [
      "GET /api/agent-billing — this overview",
      "GET /api/agent-billing/usage/:agentId — current period usage",
      "GET /api/agent-billing/invoices/:agentId — invoice history",
      "GET /api/agent-billing/estimate — cost estimator",
    ],
  });
});

// GET /api/agent-billing/usage/:agentId
router.get("/usage/:agentId", (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  res.json({
    agentId,
    model: "pay-per-call (x402)",
    usage: [],
    note: "Palmyr does not retain per-agent usage aggregates. Every call is paid at request time via x402 and settles on-chain — your wallet's transaction history is the source of truth for what you spent.",
  });
});

// GET /api/agent-billing/invoices/:agentId
router.get("/invoices/:agentId", (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  res.json({
    agentId,
    invoices: [],
    note: "Palmyr is pay-per-call (x402) and does not issue invoices. Each call settles in USDC on-chain at request time — see your wallet's transaction history.",
  });
});

// GET /api/agent-billing/estimate — estimate cost from per-call action counts
router.get("/estimate", (req: Request, res: Response) => {
  const emailInboxes = parseInt(String(req.query.email_inboxes || 0)) || 0;
  const emailSends = parseInt(String(req.query.email_sends || 0)) || 0;
  const phoneNumbers = parseInt(String(req.query.phone_numbers || 0)) || 0;
  const phoneSms = parseInt(String(req.query.phone_sms || 0)) || 0;
  const xAccounts = parseInt(String(req.query.x_accounts || 0)) || 0;

  const round = (n: number) => Math.round(n * 1000) / 1000;
  const breakdown = {
    email_inboxes: { units: emailInboxes, rate: PRICE_USDC.email_inbox, cost: round(emailInboxes * PRICE_USDC.email_inbox) },
    email_sends: { units: emailSends, rate: PRICE_USDC.email_send, cost: round(emailSends * PRICE_USDC.email_send) },
    phone_numbers: { units: phoneNumbers, rate: PRICE_USDC.phone_number, cost: round(phoneNumbers * PRICE_USDC.phone_number) },
    phone_sms: { units: phoneSms, rate: PRICE_USDC.phone_sms, cost: round(phoneSms * PRICE_USDC.phone_sms) },
    x_accounts: { units: xAccounts, rate: PRICE_USDC.x_account, cost: round(xAccounts * PRICE_USDC.x_account) },
  };

  const total = Object.values(breakdown).reduce((sum, b) => sum + b.cost, 0);

  res.json({
    model: "pay-per-call (x402)",
    estimate: breakdown,
    total_usdc: round(total),
    currency: "USDC",
    note: "Per-call x402 prices. Domain registration and compute deploys are priced dynamically — probe the route's 402 challenge for the exact amount. Canonical prices: /pricing.",
  });
});

export default router;
