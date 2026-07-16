import { Router, Request, Response } from 'express';

const router = Router();

interface FAQ {
  question: string;
  answer: string;
  category: string;
}

const faqs: FAQ[] = [
  {
    question: "Is Palmyr free?",
    answer: "Discovery and status endpoints are free. Paid capabilities (phone, email, compute, domains, cards, social) settle per call in USDC via x402 — no subscription, no signup. See /pricing for live per-call amounts.",
    category: "pricing"
  },
  {
    question: "What can my agent do with Palmyr?",
    answer: "Palmyr gives your agent real-world capabilities: phone numbers (voice + SMS), email accounts, domain registration, compute, prepaid cards, and social accounts. Everything an agent needs to operate autonomously.",
    category: "general"
  },
  {
    question: "Which frameworks are supported?",
    answer: "Palmyr works with any framework that can make HTTP requests: LangChain, CrewAI, AutoGen, OpenClaw, Eliza, Rig, or raw cURL/fetch. Check /api/compatibility for integration details.",
    category: "technical"
  },
  {
    question: "How do payments work?",
    answer: "We use the x402 protocol — HTTP 402 Payment Required. Your agent sends a request, gets a 402 with a payment envelope, signs a USDC transaction, and retries. No subscriptions, no API keys for billing — just pay-per-use with crypto.",
    category: "pricing"
  },
  {
    question: "Is there rate limiting?",
    answer: "Yes — global per-IP rate limiting protects the API, with stricter limits on sensitive endpoints like wallet operations.",
    category: "technical"
  },
  {
    question: "How do I get started?",
    answer: "Fetch /skill.md for the agent-readable guide, or explore individual endpoints at /docs. Paid endpoints need a funded USDC wallet — the wallet that pays owns the resource.",
    category: "general"
  },
  {
    question: "What blockchain does Palmyr use?",
    answer: "Payments are in USDC on Solana or Base via the x402 protocol. Both chains offer fast finality and sub-cent fees.",
    category: "technical"
  }
];

router.get('/', (_req: Request, res: Response) => {
  const categories = [...new Set(faqs.map(f => f.category))];
  res.json({
    title: "Palmyr FAQ",
    totalQuestions: faqs.length,
    categories,
    faqs
  });
});

router.get('/:category', (req: Request, res: Response) => {
  const filtered = faqs.filter(f => f.category === req.params.category);
  if (filtered.length === 0) {
    res.status(404).json({ error: "Category not found", available: [...new Set(faqs.map(f => f.category))] });
    return;
  }
  res.json({
    category: req.params.category,
    count: filtered.length,
    faqs: filtered
  });
});

export default router;
