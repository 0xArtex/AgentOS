import { Router, Request, Response } from "express";

const router = Router();

/**
 * @swagger
 * /api/agent-score:
 *   get:
 *     summary: Agent readiness score calculator
 *     description: Evaluates an agent's infrastructure readiness based on services provisioned. Returns a score 0-100 with recommendations.
 *     parameters:
 *       - in: query
 *         name: phone
 *         schema: { type: boolean }
 *         description: Has phone number provisioned
 *       - in: query
 *         name: email
 *         schema: { type: boolean }
 *         description: Has email configured
 *       - in: query
 *         name: compute
 *         schema: { type: boolean }
 *         description: Has compute resources
 *       - in: query
 *         name: domain
 *         schema: { type: boolean }
 *         description: Has custom domain
 *       - in: query
 *         name: storage
 *         schema: { type: boolean }
 *         description: Has persistent storage
 *       - in: query
 *         name: wallet
 *         schema: { type: boolean }
 *         description: Has USDC wallet configured
 *     tags: [Tools]
 *     responses:
 *       200:
 *         description: Agent readiness assessment
 */
router.get("/", (req: Request, res: Response) => {
  const services = {
    phone: req.query.phone === "true",
    email: req.query.email === "true",
    compute: req.query.compute === "true",
    domain: req.query.domain === "true",
    storage: req.query.storage === "true",
    wallet: req.query.wallet === "true",
  };

  const weights: Record<string, { points: number; label: string; tip: string }> = {
    phone: { points: 20, label: "Phone/SMS", tip: "Provision via POST /api/phone — enables voice calls and SMS alerts" },
    email: { points: 20, label: "Email", tip: "Provision via POST /api/email — enables sending/receiving emails" },
    compute: { points: 25, label: "Compute", tip: "Provision via POST /api/compute — dedicated processing power" },
    domain: { points: 10, label: "Custom Domain", tip: "Provision via POST /api/domain — professional agent identity" },
    storage: { points: 10, label: "Persistent Storage", tip: "Provision via POST /api/compute with storage flag" },
    wallet: { points: 15, label: "USDC Wallet", tip: "Required for post-hackathon x402 payments" },
  };

  let score = 0;
  const active: string[] = [];
  const recommendations: Array<{ service: string; points: number; tip: string }> = [];

  for (const [key, enabled] of Object.entries(services)) {
    const w = weights[key];
    if (enabled) {
      score += w.points;
      active.push(w.label);
    } else {
      recommendations.push({ service: w.label, points: w.points, tip: w.tip });
    }
  }

  // Sort recommendations by highest impact first
  recommendations.sort((a, b) => b.points - a.points);

  let tier: string;
  let emoji: string;
  if (score >= 90) { tier = "Production Ready"; emoji = "🟢"; }
  else if (score >= 70) { tier = "Advanced"; emoji = "🔵"; }
  else if (score >= 40) { tier = "Intermediate"; emoji = "🟡"; }
  else if (score > 0) { tier = "Getting Started"; emoji = "🟠"; }
  else { tier = "Not Started"; emoji = "⚪"; }

  res.json({
    score,
    maxScore: 100,
    tier: `${emoji} ${tier}`,
    activeServices: active,
    recommendations: recommendations.slice(0, 3),
    nextStep: recommendations.length > 0
      ? `Add ${recommendations[0].service} (+${recommendations[0].points} points): ${recommendations[0].tip}`
      : "You're fully provisioned! 🎉",
    hackathonNote: "All services FREE during Colosseum hackathon (until Feb 12). Add X-Agent-Id header to get started.",
    docs: "http://77.42.89.233:3001/docs",
  });
});

export default router;
