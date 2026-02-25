import { Router, Request, Response } from "express";
import {
  getAllCategories,
  getCategory,
  searchSkills,
  resolveSkills,
  getTotalSkillCount,
} from "../services/skills-catalog";

const router = Router();

/**
 * GET /skills — List all categories with skill counts
 */
router.get("/", (_req: Request, res: Response) => {
  const categories = getAllCategories();
  res.json({
    total_skills: getTotalSkillCount(),
    categories: categories.map(c => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      description: c.description,
      skill_count: c.skills.length,
    })),
  });
});

/**
 * GET /skills/all — Full catalog with all skills
 */
router.get("/all", (_req: Request, res: Response) => {
  const categories = getAllCategories();
  res.json({
    total_skills: getTotalSkillCount(),
    categories: categories.map(c => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      description: c.description,
      skills: c.skills,
    })),
  });
});

/**
 * GET /skills/search?q=<query> — Search skills by keyword
 */
router.get("/search", (req: Request, res: Response) => {
  const q = (req.query.q as string) || "";
  if (!q) {
    res.status(400).json({ error: "Missing query parameter 'q'" });
    return;
  }
  const results = searchSkills(q);
  res.json({ query: q, count: results.length, skills: results });
});

/**
 * POST /skills/resolve — Resolve category/skill names to full skill lists
 * 
 * Body: { skills: ["crypto", "research", "browser"] }
 * Returns: full list of skills with install commands
 */
router.post("/resolve", (req: Request, res: Response) => {
  const { skills: requested } = req.body;
  if (!requested || !Array.isArray(requested)) {
    res.status(400).json({ error: "Expected { skills: [...] } array" });
    return;
  }
  const resolved = resolveSkills(requested);
  res.json({
    requested,
    resolved_count: resolved.length,
    skills: resolved,
    install_commands: resolved.map(s => s.install),
  });
});

/**
 * GET /skills/:categoryId — Get a specific category with all skills
 */
router.get("/:categoryId", (req: Request, res: Response) => {
  const cat = getCategory(req.params.categoryId as string);
  if (!cat) {
    res.status(404).json({ error: "Category not found", available: getAllCategories().map(c => c.id) });
    return;
  }
  res.json({
    id: cat.id,
    name: cat.name,
    emoji: cat.emoji,
    description: cat.description,
    skill_count: cat.skills.length,
    skills: cat.skills,
  });
});

export default router;
