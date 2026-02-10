import { Router, Request, Response } from "express";

const router = Router();

// In-memory ratings store (would be DB in production)
const ratings: Map<string, { scores: number[]; reviews: { agentId: string; score: number; comment: string; timestamp: string }[] }> = new Map();

/**
 * @swagger
 * /api/agent-rating/{agentId}:
 *   post:
 *     summary: Rate an agent after interaction
 *     tags: [Agent Rating]
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reviewer_agent_id: { type: string }
 *               score: { type: number, minimum: 1, maximum: 5 }
 *               comment: { type: string }
 *     responses:
 *       200:
 *         description: Rating submitted
 */
router.post("/:agentId", (req: Request, res: Response) => {
  const agentId = req.params.agentId as string;
  const { reviewer_agent_id, score, comment } = req.body;

  if (!reviewer_agent_id || !score || score < 1 || score > 5) {
    return res.status(400).json({ error: "Need reviewer_agent_id and score (1-5)" });
  }

  const entry = ratings.get(agentId) || { scores: [], reviews: [] };
  const review = { agentId: reviewer_agent_id, score, comment: comment || "", timestamp: new Date().toISOString() };
  entry.scores.push(score);
  entry.reviews.push(review);
  ratings.set(agentId, entry);

  const avg = entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length;
  res.json({ agent_id: agentId, average_rating: Math.round(avg * 100) / 100, total_reviews: entry.scores.length, latest_review: review });
});

/**
 * @swagger
 * /api/agent-rating/{agentId}:
 *   get:
 *     summary: Get agent reputation and reviews
 *     tags: [Agent Rating]
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Agent reputation data
 */
router.get("/:agentId", (req: Request, res: Response) => {
  const agentId = req.params.agentId as string;
  const entry = ratings.get(agentId);

  if (!entry || entry.scores.length === 0) {
    return res.json({ agent_id: agentId, average_rating: null, total_reviews: 0, reviews: [], trust_level: "unrated" });
  }

  const avg = entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length;
  const trustLevel = avg >= 4.5 ? "excellent" : avg >= 3.5 ? "good" : avg >= 2.5 ? "average" : "poor";

  res.json({
    agent_id: agentId,
    average_rating: Math.round(avg * 100) / 100,
    total_reviews: entry.scores.length,
    trust_level: trustLevel,
    reviews: entry.reviews.slice(-10)
  });
});

/**
 * @swagger
 * /api/agent-rating:
 *   get:
 *     summary: Leaderboard of top-rated agents
 *     tags: [Agent Rating]
 *     responses:
 *       200:
 *         description: Agent leaderboard
 */
router.get("/", (_req: Request, res: Response) => {
  const leaderboard = Array.from(ratings.entries())
    .map(([id, data]) => ({
      agent_id: id,
      average_rating: Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 100) / 100,
      total_reviews: data.scores.length
    }))
    .sort((a, b) => b.average_rating - a.average_rating)
    .slice(0, 20);

  res.json({ title: "Agent Reputation Leaderboard", description: "Top-rated agents by peer reviews", leaderboard });
});

export default router;
