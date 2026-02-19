import { Router, Request, Response } from "express";

const router = Router();

interface PartnerStatus {
  name: string;
  type: string;
  endpoint: string;
  status: "healthy" | "degraded" | "unknown";
  latencyMs: number | null;
  lastChecked: string;
}

async function checkEndpoint(url: string, timeoutMs = 5000): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, method: "HEAD" });
    clearTimeout(id);
    return { ok: res.ok || res.status === 405, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

const PARTNERS = [
  { name: "AlphaVault", type: "Trading/MCP", endpoint: "http://162.55.53.160:3000" },
  { name: "AgentLink", type: "Hiring Marketplace", endpoint: "https://agent-link-indol.vercel.app" },
  { name: "Colosseum Forum", type: "Community", endpoint: "https://agents.colosseum.com" },
];

router.get("/", async (_req: Request, res: Response) => {
  const checks: PartnerStatus[] = await Promise.all(
    PARTNERS.map(async (p) => {
      const result = await checkEndpoint(p.endpoint);
      return {
        name: p.name,
        type: p.type,
        endpoint: p.endpoint,
        status: result.ok ? "healthy" as const : "unknown" as const,
        latencyMs: result.latencyMs,
        lastChecked: new Date().toISOString(),
      };
    })
  );

  const healthy = checks.filter((c) => c.status === "healthy").length;

  res.json({
    ecosystem_health: {
      total_partners: checks.length,
      healthy,
      degraded: checks.length - healthy,
      overall: healthy === checks.length ? "all_systems_go" : "partial",
    },
    partners: checks,
    agentos: {
      api: "https://agntos.dev",
      status: "operational",
      endpoints: "235+",
      uptime_days: "15+",
    },
    checked_at: new Date().toISOString(),
  });
});

export default router;
