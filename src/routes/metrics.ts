import { Router, Request, Response } from "express";

const router = Router();

// Track API calls in memory
const apiMetrics = {
  totalRequests: 0,
  requestsByEndpoint: {} as Record<string, number>,
  requestsByAgent: {} as Record<string, number>,
  startTime: Date.now(),
  errors: 0,
  lastHourRequests: [] as number[],
};

// Middleware to track requests (export for use in main app)
export function trackRequest(endpoint: string, agentId?: string) {
  apiMetrics.totalRequests++;
  apiMetrics.requestsByEndpoint[endpoint] = (apiMetrics.requestsByEndpoint[endpoint] || 0) + 1;
  if (agentId) {
    apiMetrics.requestsByAgent[agentId] = (apiMetrics.requestsByAgent[agentId] || 0) + 1;
  }
  const now = Date.now();
  apiMetrics.lastHourRequests = apiMetrics.lastHourRequests.filter(t => now - t < 3600000);
  apiMetrics.lastHourRequests.push(now);
}

export function trackError() {
  apiMetrics.errors++;
}

// GET /api/metrics - platform usage overview
router.get("/", (_req: Request, res: Response) => {
  const uptimeMs = Date.now() - apiMetrics.startTime;
  const uptimeHours = Math.floor(uptimeMs / 3600000);
  const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);

  const topEndpoints = Object.entries(apiMetrics.requestsByEndpoint)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([endpoint, count]) => ({ endpoint, count }));

  const uniqueAgents = Object.keys(apiMetrics.requestsByAgent).length;
  const topAgents = Object.entries(apiMetrics.requestsByAgent)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([agentId, requests]) => ({ agentId, requests }));

  const requestsPerMinute = apiMetrics.lastHourRequests.length > 0
    ? (apiMetrics.lastHourRequests.length / Math.min(60, uptimeMs / 60000)).toFixed(2)
    : "0";

  const hackathonDeadline = new Date("2026-02-12T17:00:00Z").getTime();
  const timeLeft = hackathonDeadline - Date.now();
  const daysLeft = Math.floor(timeLeft / 86400000);
  const hoursLeft = Math.floor((timeLeft % 86400000) / 3600000);

  res.json({
    platform: "Palmyr",
    version: "0.6.7",
    uptime: `${uptimeHours}h ${uptimeMinutes}m`,
    uptimeMs,
    metrics: {
      totalRequests: apiMetrics.totalRequests,
      requestsPerMinute: parseFloat(requestsPerMinute),
      uniqueAgents,
      errorCount: apiMetrics.errors,
      errorRate: apiMetrics.totalRequests > 0
        ? `${((apiMetrics.errors / apiMetrics.totalRequests) * 100).toFixed(2)}%`
        : "0%",
    },
    topEndpoints,
    topAgents,
    hackathon: {
      deadline: "2026-02-12T17:00:00Z",
      timeRemaining: `${daysLeft}d ${hoursLeft}h`,
      status: timeLeft > 0 ? "active" : "ended",
      freeAccess: timeLeft > 0,
    },
    services: {
      phone: { status: "operational", provisioned: 0 },
      email: { status: "operational", provisioned: 0 },
      compute: { status: "operational", instances: 0 },
      domains: { status: "operational", registered: 0 },
      storage: { status: "operational", used: "0 MB" },
      analytics: { status: "operational" },
    },
  });
});

// GET /api/metrics/live - streaming-friendly compact stats
router.get("/live", (_req: Request, res: Response) => {
  res.json({
    requests: apiMetrics.totalRequests,
    agents: Object.keys(apiMetrics.requestsByAgent).length,
    errors: apiMetrics.errors,
    rpmLastHour: apiMetrics.lastHourRequests.length,
    uptime: Date.now() - apiMetrics.startTime,
  });
});

export default router;
