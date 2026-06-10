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
        // Mirrors src/routes/phone.ts `requireAuth(price, ...)` values verbatim.
        // Keep this in sync when route prices change — agents read this endpoint
        // for the canonical per-op price list, separately from the per-route 402
        // negotiation. SMS is $0.05, not the old marketing $0.01; provisioning
        // is a one-time $3.00, not the old "$2.00/mo" subscription framing.
        search_numbers: { price: "FREE", unit: "per query" },
        list_numbers: { price: isFree ? "FREE" : "$0.01", unit: "per query" },
        provision: { price: isFree ? "FREE" : "$3.00", unit: "per number provisioned" },
        release_number: { price: isFree ? "FREE" : "$0.01", unit: "per release" },
        messages: { price: isFree ? "FREE" : "$0.02", unit: "per read of an inbox" },
        sms: { price: isFree ? "FREE" : "$0.05", unit: "per message sent" },
        list_calls: { price: isFree ? "FREE" : "$0.02", unit: "per query (calls on a number)" },
        call_info: { price: isFree ? "FREE" : "$0.02", unit: "per call lookup" },
        call: { price: isFree ? "FREE" : "$0.10", unit: "per outbound call placed" },
        speak: { price: isFree ? "FREE" : "$0.08", unit: "per TTS on a live call" },
        play: { price: isFree ? "FREE" : "$0.08", unit: "per audio playback on a live call" },
        dtmf: { price: isFree ? "FREE" : "$0.02", unit: "per DTMF send" },
        gather: { price: isFree ? "FREE" : "$0.08", unit: "per gather (collect caller input)" },
        record: { price: isFree ? "FREE" : "$0.10", unit: "per recording started" },
        record_stop: { price: isFree ? "FREE" : "$0.02", unit: "per recording stop" },
        hangup: { price: isFree ? "FREE" : "$0.02", unit: "per hangup" },
        answer_inbound: { price: isFree ? "FREE" : "$0.02", unit: "per inbound call answer" },
        transfer: { price: isFree ? "FREE" : "$0.10", unit: "per call transfer" },
        transfer_ownership: { price: isFree ? "FREE" : "$0.01", unit: "per ownership transfer (move a number to another wallet)" },
        share: { price: isFree ? "FREE" : "$0.01", unit: "per share grant (another wallet can use the number)" },
        unshare: { price: isFree ? "FREE" : "$0.01", unit: "per share revocation" },
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
