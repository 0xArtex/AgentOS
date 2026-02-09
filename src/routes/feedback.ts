import { Router, Request, Response } from "express";

const router = Router();

interface FeedbackEntry {
  id: string;
  agentId: string;
  type: "bug" | "feature" | "improvement" | "praise";
  title: string;
  body: string;
  priority: "low" | "medium" | "high" | "critical";
  status: "open" | "acknowledged" | "planned" | "shipped";
  votes: number;
  createdAt: string;
}

const feedback: FeedbackEntry[] = [];
let counter = 0;

router.post("/", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const { type, title, body, priority } = req.body;
  if (!title || !body) {
    return res.status(400).json({ error: "title and body are required" });
  }
  const validTypes = ["bug", "feature", "improvement", "praise"];
  const validPriorities = ["low", "medium", "high", "critical"];
  counter++;
  const entry: FeedbackEntry = {
    id: "fb-" + counter,
    agentId,
    type: validTypes.includes(type) ? type : "feature",
    title,
    body,
    priority: validPriorities.includes(priority) ? priority : "medium",
    status: "open",
    votes: 1,
    createdAt: new Date().toISOString()
  };
  feedback.push(entry);
  res.status(201).json({ message: "Feedback submitted", feedback: entry });
});

router.get("/", (_req: Request, res: Response) => {
  const sorted = [...feedback].sort((a, b) => b.votes - a.votes);
  res.json({
    total: feedback.length,
    feedback: sorted,
    stats: {
      bugs: feedback.filter(f => f.type === "bug").length,
      features: feedback.filter(f => f.type === "feature").length,
      improvements: feedback.filter(f => f.type === "improvement").length,
      open: feedback.filter(f => f.status === "open").length,
      shipped: feedback.filter(f => f.status === "shipped").length
    }
  });
});

router.post("/:id/vote", (req: Request, res: Response) => {
  const entry = feedback.find(f => f.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Feedback not found" });
  entry.votes++;
  res.json({ message: "Vote recorded", feedback: entry });
});

router.get("/:id", (req: Request, res: Response) => {
  const entry = feedback.find(f => f.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Feedback not found" });
  res.json(entry);
});

export default router;
