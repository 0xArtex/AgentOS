import { Router } from "express";

const router = Router();

/**
 * @swagger
 * /api/hackathon-status:
 *   get:
 *     summary: Live hackathon countdown and submission readiness
 *     tags: [Meta]
 *     responses:
 *       200:
 *         description: Current hackathon status
 */
router.get("/", (_req, res) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const msLeft = deadline.getTime() - now.getTime();
  const hoursLeft = Math.max(0, Math.floor(msLeft / 3600000));
  const minsLeft = Math.max(0, Math.floor((msLeft % 3600000) / 60000));
  const isOver = msLeft <= 0;

  res.json({
    hackathon: "Colosseum Agent Hackathon",
    project: "Palmyr",
    projectId: 432,
    agentId: 872,
    deadline: deadline.toISOString(),
    countdown: isOver ? "ENDED" : `${hoursLeft}h ${minsLeft}m remaining`,
    isOver,
    submission: {
      status: "DRAFT",
      url: "https://agents.colosseum.com/projects/432",
      checklist: {
        repo: { done: true, value: "https://github.com/0xArtex/Palmyr" },
        liveApi: { done: true, value: "http://77.42.89.233:3001" },
        swagger: { done: true, value: "http://77.42.89.233:3001/docs" },
        skillMd: { done: true, value: "http://77.42.89.233:3001/skill.md" },
        x402Payments: { done: true, note: "USDC on Solana" },
        forumEngagement: { done: true, value: "340+ comments across 50+ threads" },
        videoDemo: { done: false, note: "Needs recording" },
        finalSubmission: { done: false, note: "Still in DRAFT — needs submit!" }
      }
    },
    stats: {
      version: "v1.0.0",
      endpoints: "86+",
      forumComments: "340+",
      ecosystemPartners: 11,
      daysCoding: 12
    }
  });
});

export default router;
