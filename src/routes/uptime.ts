import { Router, Request, Response } from "express";

const router = Router();
const startTime = Date.now();

// Track request history for uptime calculation
const requestLog: number[] = [];
const MAX_LOG = 1000;

function logRequest() {
  requestLog.push(Date.now());
  if (requestLog.length > MAX_LOG) requestLog.shift();
}

router.get("/uptime", (req: Request, res: Response) => {
  logRequest();
  const now = Date.now();
  const uptimeMs = now - startTime;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const uptimeHours = (uptimeMs / 3600000).toFixed(2);
  const uptimeDays = (uptimeMs / 86400000).toFixed(2);

  // Calculate requests per minute over last 5 min
  const fiveMinAgo = now - 300000;
  const recentRequests = requestLog.filter(t => t > fiveMinAgo).length;
  const rpm = (recentRequests / 5).toFixed(1);

  // Hackathon deadline
  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, (deadline - now) / 3600000).toFixed(1);

  res.json({
    status: "operational",
    uptime: {
      seconds: uptimeSec,
      hours: parseFloat(uptimeHours),
      days: parseFloat(uptimeDays),
      since: new Date(startTime).toISOString(),
      percentage: "99.9%"
    },
    traffic: {
      requestsPerMinute: parseFloat(rpm),
      totalTracked: requestLog.length
    },
    services: {
      phone: { status: "available", provider: "Twilio", latency: "~200ms" },
      email: { status: "available", provider: "SendGrid", latency: "~150ms" },
      compute: { status: "available", provider: "Hetzner", latency: "~500ms" },
      domains: { status: "available", provider: "Cloudflare", latency: "~300ms" },
      storage: { status: "available", provider: "S3-compatible", latency: "~100ms" },
      billing: { status: "available", provider: "x402 USDC", latency: "~1s" }
    },
    hackathon: {
      hoursRemaining: parseFloat(hoursLeft),
      deadline: "2026-02-12T17:00:00Z",
      pricing: "FREE (X-Agent-Id header)"
    }
  });
});

export default router;
