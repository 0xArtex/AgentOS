import { Router, Request, Response } from "express";

const router = Router();

// POST /api/agent-batch — execute multiple API operations in a single request
// Body: { "operations": [{ "method": "GET", "path": "/api/health" }, ...] }
router.post("/", async (req: Request, res: Response) => {
  const { operations } = req.body || {};
  
  if (!operations || !Array.isArray(operations)) {
    return res.status(400).json({
      error: "Provide operations array: [{ method, path, body? }]",
      example: {
        operations: [
          { method: "GET", path: "/api/service-health" },
          { method: "GET", path: "/api/hackathon" },
          { method: "GET", path: "/api/agent-dashboard" }
        ]
      }
    });
  }

  if (operations.length > 10) {
    return res.status(400).json({ error: "Max 10 operations per batch" });
  }

  const results = [];
  const baseUrl = `http://localhost:${process.env.PORT || 3001}`;
  
  for (const op of operations) {
    const start = Date.now();
    try {
      const fetchOpts: any = {
        method: op.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(req.headers["x-agent-id"] ? { "x-agent-id": req.headers["x-agent-id"] } : {})
        }
      };
      if (op.body && op.method !== "GET") {
        fetchOpts.body = JSON.stringify(op.body);
      }
      const resp = await fetch(`${baseUrl}${op.path}`, fetchOpts);
      const data = await resp.json().catch(() => null);
      results.push({
        path: op.path,
        status: resp.status,
        latencyMs: Date.now() - start,
        data
      });
    } catch (err: any) {
      results.push({
        path: op.path,
        status: 500,
        latencyMs: Date.now() - start,
        error: err.message
      });
    }
  }

  res.json({
    batchId: `batch_${Date.now()}`,
    count: results.length,
    totalLatencyMs: results.reduce((s, r) => s + r.latencyMs, 0),
    results
  });
});

// GET /api/agent-batch — docs
router.get("/", (_req: Request, res: Response) => {
  res.json({
    description: "Batch multiple API calls in a single request",
    method: "POST",
    maxOperations: 10,
    example: {
      operations: [
        { method: "GET", path: "/api/service-health" },
        { method: "GET", path: "/api/hackathon" },
        { method: "GET", path: "/api/agent-dashboard" }
      ]
    },
    tip: "Reduce round trips — get health, billing, and status in one call"
  });
});

export default router;
