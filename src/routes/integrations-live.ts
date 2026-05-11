import { Router } from "express";

const router = Router();

interface PartnerStatus {
  name: string;
  category: string;
  status: "live" | "testing" | "planned";
  lastPing?: string;
  endpoint?: string;
  description: string;
}

const partners: PartnerStatus[] = [
  {
    name: "SlotScribe",
    category: "Observability",
    status: "testing",
    description: "Flight recorder integration — Palmyr activity logs feed into SlotScribe's on-chain verification pipeline",
  },
  {
    name: "Wunderland",
    category: "Identity",
    status: "planned",
    description: "HEXACO personality vectors + Palmyr operational identity for composite trust profiles",
  },
  {
    name: "MoltLaunch",
    category: "Trust Layer",
    status: "testing",
    description: "Infrastructure verification attestations — Palmyr agents get MoltLaunch trust scores",
  },
  {
    name: "AAP (Agent Agreement Protocol)",
    category: "Execution",
    status: "planned",
    description: "Delegation scopes + Palmyr resource provisioning for multi-party agent agreements",
  },
  {
    name: "Farnsworth AI Swarm",
    category: "Collective Intelligence",
    status: "planned",
    description: "Swarm oracle queries routed through Palmyr compute containers for isolated execution",
  },
  {
    name: "Prometheus Vault",
    category: "DeFi",
    status: "planned",
    description: "Decision logging via Palmyr audit trails for verifiable yield optimization history",
  },
  {
    name: "MutualAgent Insurance",
    category: "Risk",
    status: "planned",
    description: "Notification infrastructure for autonomous claim processing and agent-to-agent alerts",
  },
  {
    name: "Vex Capital",
    category: "Trading",
    status: "planned",
    description: "Operational backbone — SMS alerts, compute for backtesting, webhook event routing",
  },
];

/**
 * @swagger
 * /api/integrations-live:
 *   get:
 *     summary: Live ecosystem integration status
 *     description: Real-time status of Palmyr integrations with hackathon ecosystem partners
 *     tags: [Ecosystem]
 *     responses:
 *       200:
 *         description: Integration partner statuses
 */
router.get("/", (_req, res) => {
  const live = partners.filter((p) => p.status === "live").length;
  const testing = partners.filter((p) => p.status === "testing").length;
  const planned = partners.filter((p) => p.status === "planned").length;

  res.json({
    totalPartners: partners.length,
    summary: { live, testing, planned },
    partners,
    updatedAt: new Date().toISOString(),
    note: "Post-hackathon: actively onboarding partners. DM @zoltyagent or hit /api/demo-request to integrate.",
  });
});

/**
 * @swagger
 * /api/integrations-live/{category}:
 *   get:
 *     summary: Filter integrations by category
 *     tags: [Ecosystem]
 *     parameters:
 *       - in: path
 *         name: category
 *         required: true
 *         schema:
 *           type: string
 */
router.get("/:category", (req, res) => {
  const category = req.params.category.toLowerCase();
  const filtered = partners.filter(
    (p) => p.category.toLowerCase() === category
  );

  if (filtered.length === 0) {
    return res.status(404).json({
      error: "No integrations found for category",
      availableCategories: [...new Set(partners.map((p) => p.category))],
    });
  }

  res.json({ category: req.params.category, partners: filtered });
});

export default router;
