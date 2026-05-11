import { Router, Request, Response } from "express";

const router = Router();

interface TestResult {
  name: string;
  endpoint: string;
  status: "pass" | "fail";
  responseTimeMs: number;
  statusCode?: number;
  error?: string;
}

router.get("/", async (_req: Request, res: Response) => {
  const baseUrl = "http://localhost:3001";
  const endpoints = [
    { name: "Health Check", path: "/health" },
    { name: "Uptime Info", path: "/api/uptime" },
    { name: "Status Dashboard", path: "/status/live" },
    { name: "Agent Directory", path: "/api/agent-directory" },
    { name: "Analytics", path: "/analytics" },
    { name: "Ecosystem", path: "/api/ecosystem" },
    { name: "For Judges", path: "/api/for-judges" },
    { name: "Pricing Calculator", path: "/api/pricing/calculator?phones=1&emails=100" },
    { name: "Architecture", path: "/api/architecture" },
    { name: "Benchmarks", path: "/api/benchmarks" },
    { name: "Roadmap", path: "/api/roadmap" },
    { name: "FAQ", path: "/api/faq" },
    { name: "Security Model", path: "/api/security" },
    { name: "Compatibility", path: "/api/compatibility" },
    { name: "Agent Health", path: "/api/agent-health" },
  ];

  const results: TestResult[] = [];
  const startAll = Date.now();

  for (const ep of endpoints) {
    const start = Date.now();
    try {
      const resp = await fetch(`${baseUrl}${ep.path}`, {
        headers: { "X-Agent-Id": "live-test-runner" },
        signal: AbortSignal.timeout(5000),
      });
      results.push({
        name: ep.name,
        endpoint: ep.path,
        status: resp.ok ? "pass" : "fail",
        responseTimeMs: Date.now() - start,
        statusCode: resp.status,
      });
    } catch (err: any) {
      results.push({
        name: ep.name,
        endpoint: ep.path,
        status: "fail",
        responseTimeMs: Date.now() - start,
        error: err.message,
      });
    }
  }

  const totalTimeMs = Date.now() - startAll;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const avgResponseMs = Math.round(
    results.reduce((s, r) => s + r.responseTimeMs, 0) / results.length
  );

  res.json({
    summary: {
      totalTests: results.length,
      passed,
      failed,
      passRate: `${Math.round((passed / results.length) * 100)}%`,
      totalTimeMs,
      avgResponseMs,
      timestamp: new Date().toISOString(),
    },
    verdict:
      failed === 0
        ? "ALL SYSTEMS OPERATIONAL — Palmyr is fully functional"
        : `${failed} endpoint(s) need attention`,
    results,
    note: "This endpoint performs real HTTP requests against all major Palmyr routes. No mocks, no fakes — live verification.",
    tryIt: {
      description: "Run this test yourself",
      curl: "curl http://77.42.89.233:3001/api/live-test",
    },
  });
});

export default router;
