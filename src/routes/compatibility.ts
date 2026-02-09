import { Router, Request, Response } from "express";

const router = Router();

/**
 * GET /api/compatibility
 * Check if your agent framework is compatible with AgentOS
 */
router.get("/", (_req: Request, res: Response) => {
  res.json({
    title: "AgentOS Compatibility Matrix",
    description: "Framework and language compatibility for AgentOS integration",
    frameworks: [
      {
        name: "LangChain",
        language: "Python/TypeScript",
        compatible: true,
        integration: "HTTP tool calling — use requests/fetch to hit AgentOS endpoints",
        example: "langchain.tools.StructuredTool wrapping AgentOS API calls",
        difficulty: "easy"
      },
      {
        name: "CrewAI",
        language: "Python",
        compatible: true,
        integration: "Custom tool class calling AgentOS REST API",
        example: "crewai.tools.BaseTool with AgentOS HTTP client",
        difficulty: "easy"
      },
      {
        name: "AutoGen",
        language: "Python",
        compatible: true,
        integration: "Function calling with AgentOS endpoints as tools",
        difficulty: "easy"
      },
      {
        name: "OpenClaw",
        language: "TypeScript",
        compatible: true,
        integration: "Native skill system — drop SKILL.md pointing to AgentOS",
        example: "See /api/integrations for OpenClaw skill template",
        difficulty: "trivial"
      },
      {
        name: "Eliza (ai16z)",
        language: "TypeScript",
        compatible: true,
        integration: "Plugin system — wrap AgentOS calls in Eliza actions",
        difficulty: "easy"
      },
      {
        name: "Rig",
        language: "Rust",
        compatible: true,
        integration: "HTTP client tool calling AgentOS REST API",
        difficulty: "medium"
      },
      {
        name: "Raw HTTP / cURL",
        language: "Any",
        compatible: true,
        integration: "Direct REST API calls — no SDK needed",
        difficulty: "trivial"
      }
    ],
    languages: {
      python: { supported: true, recommendation: "Use requests or httpx" },
      typescript: { supported: true, recommendation: "Use fetch or axios" },
      rust: { supported: true, recommendation: "Use reqwest" },
      go: { supported: true, recommendation: "Use net/http" },
      any: { supported: true, note: "Any language with HTTP support works" }
    },
    requirements: {
      auth: "x-api-key header (get key from /api/apikeys)",
      payment: "x402 USDC on Solana (FREE during hackathon with X-Agent-Id header)",
      format: "JSON REST API",
      docs: "http://77.42.89.233:3001/docs"
    }
  });
});

export default router;
