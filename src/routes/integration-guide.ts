import { Router, Request, Response } from "express";

const router = Router();

/**
 * @swagger
 * /api/integration-guide:
 *   get:
 *     summary: Step-by-step integration guides for popular frameworks
 *     tags: [Developer]
 *     parameters:
 *       - in: query
 *         name: framework
 *         schema:
 *           type: string
 *           enum: [langchain, crewai, autogen, eliza, openai, raw]
 *     responses:
 *       200:
 *         description: Integration guide
 */
router.get("/", (req: Request, res: Response) => {
  const framework = (req.query.framework as string)?.toLowerCase();

  const guides: Record<string, object> = {
    langchain: {
      framework: "LangChain",
      difficulty: "beginner",
      timeToIntegrate: "5 minutes",
      steps: [
        { step: 1, title: "Install", code: "pip install langchain requests" },
        { step: 2, title: "Register agent", code: "curl -X POST https://palmyr.ai/api/agents -H Content-Type: application/json -d ..." },
        { step: 3, title: "Add Palmyr tool", description: "Create a LangChain Tool that calls Palmyr endpoints for phone, email, compute" },
        { step: 4, title: "Use in chain", code: "agent = initialize_agent(tools=[agentos_tool], llm=llm, agent=AgentType.ZERO_SHOT_REACT_DESCRIPTION)" }
      ],
      example: "from langchain.tools import Tool\nagentos = Tool(name=Palmyr, func=call_agentos, description=Provision infrastructure)"
    },
    crewai: {
      framework: "CrewAI",
      difficulty: "beginner",
      timeToIntegrate: "5 minutes",
      steps: [
        { step: 1, title: "Install", code: "pip install crewai requests" },
        { step: 2, title: "Register agent", code: "curl -X POST https://palmyr.ai/api/agents -H Content-Type: application/json -d ..." },
        { step: 3, title: "Create Palmyr tool for crew", description: "Define a tool that maps to Palmyr API endpoints" },
        { step: 4, title: "Assign to agent in crew", code: "agent = Agent(role=infra-manager, tools=[agentos_tool])" }
      ]
    },
    openai: {
      framework: "OpenAI Function Calling",
      difficulty: "beginner",
      timeToIntegrate: "3 minutes",
      steps: [
        { step: 1, title: "Define function schema", description: "Add Palmyr endpoints as function definitions" },
        { step: 2, title: "Handle function calls", description: "Route function calls to Palmyr API via HTTP" },
        { step: 3, title: "Return results", description: "Pass Palmyr response back to conversation" }
      ],
      example: "functions = [{name: provision_phone, parameters: {type: object, properties: {country: {type: string}}}}]"
    },
    raw: {
      framework: "Raw HTTP",
      difficulty: "any",
      timeToIntegrate: "1 minute",
      steps: [
        { step: 1, title: "Get API token", code: "curl https://palmyr.ai/api/agents -X POST" },
        { step: 2, title: "Call any endpoint", code: "curl https://palmyr.ai/api/phones -H X-Agent-Id:YOUR_ID" },
        { step: 3, title: "Pay with x402", description: "USDC payments on Solana or Base — automatic via 402 protocol" }
      ]
    }
  };

  if (framework && guides[framework]) {
    res.json({ guide: guides[framework], docs: "https://palmyr.ai/docs" });
  } else {
    res.json({
      availableFrameworks: Object.keys(guides),
      usage: "Add ?framework=langchain for specific guide",
      guides,
      docs: "https://palmyr.ai/docs",
      quickstart: "https://palmyr.ai/api/quickstart"
    });
  }
});

export default router;
