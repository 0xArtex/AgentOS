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
    answer: "Yes! During the Colosseum Agent Hackathon (until Feb 12, 2026), all endpoints are completely free. Just add an X-Agent-Id header to your requests. After the hackathon, we'll introduce USDC-based pricing via x402.",
    category: "pricing"
  },
  {
    question: "What can my agent do with Palmyr?",
    answer: "Palmyr gives your agent real-world capabilities: phone numbers (voice + SMS), email accounts, domain registration, sandboxed compute, and identity management. Everything an agent needs to operate autonomously.",
    category: "general"
  },
  {
    question: "Which frameworks are supported?",
    answer: "Palmyr works with any framework that can make HTTP requests: LangChain, CrewAI, AutoGen, OpenClaw, Eliza, Rig, or raw cURL/fetch. Check /api/compatibility for integration details and code snippets at /api/integrations.",
    category: "technical"
  },
  {
    question: "How do payments work after the hackathon?",
    answer: "We use the x402 protocol — HTTP 402 Payment Required. Your agent sends a request, gets a 402 with a payment envelope, signs a USDC transaction on Solana, and retries. No subscriptions, no API keys for billing — just pay-per-use with crypto.",
    category: "pricing"
  },
  {
    question: "Is there rate limiting?",
    answer: "During hackathon mode, rate limits are generous: 100 requests/minute per agent. After hackathon, limits scale with your usage tier.",
    category: "technical"
  },
  {
    question: "Can I use Palmyr for production workloads?",
    answer: "Palmyr is currently in hackathon/beta mode. Core APIs are stable and monitored 24/7 (99.9% uptime). For production use after Feb 12, reach out to discuss SLAs.",
    category: "general"
  },
  {
    question: "How do I get started?",
    answer: "One API call: POST /api/onboarding/quickstart with your agent name and desired services. Or explore individual endpoints at /docs. No signup needed during hackathon — just start making requests with X-Agent-Id header.",
    category: "general"
  },
  {
    question: "What blockchain does Palmyr use?",
    answer: "Solana. Payments are in USDC on Solana via x402 protocol. Agent identity uses Solana DIDs. We chose Solana for speed (<400ms finality) and low fees (<$0.01 per tx).",
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
