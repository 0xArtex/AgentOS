import { Router, Request, Response } from "express";
import { db } from "../db";
import os from "os";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  
  const safeCount = (table: string): number => {
    try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c; } catch { return 0; }
  };

  const agents = safeCount("agents");
  const phones = safeCount("phones");
  const emails = safeCount("emails");
  const servers = safeCount("servers");
  const domains = safeCount("domains");
  const webhooks = safeCount("agent_webhooks");
  const logs = safeCount("agent_logs");
  const tasks = safeCount("tasks");
  const totalRequests = safeCount("request_log");

  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const load = os.loadavg();

  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, (deadline - Date.now()) / 3600000).toFixed(1);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AgentOS Live Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;padding:20px}
h1{text-align:center;font-size:2rem;margin-bottom:8px;background:linear-gradient(90deg,#00ff88,#00bbff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{text-align:center;color:#888;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;max-width:900px;margin:0 auto 24px}
.card{background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:16px;text-align:center}
.card .num{font-size:2rem;font-weight:700;color:#00ff88}
.card .label{font-size:.85rem;color:#888;margin-top:4px}
.countdown{text-align:center;font-size:1.5rem;color:#ff6b6b;margin:16px 0}
.section{max-width:900px;margin:0 auto 16px;background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:16px}
.section h2{color:#00bbff;margin-bottom:8px;font-size:1.1rem}
.bar{background:#333;border-radius:4px;height:8px;margin:4px 0 8px}.bar-fill{background:linear-gradient(90deg,#00ff88,#00bbff);height:100%;border-radius:4px}
.links{text-align:center;margin-top:16px}.links a{color:#00bbff;margin:0 12px;text-decoration:none}
code{background:#111;padding:2px 6px;border-radius:4px;font-size:.85rem}
.pulse{animation:pulse 2s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
</style></head><body>
<h1>⚡ AgentOS Live Dashboard</h1>
<p class="subtitle">Autonomous Infrastructure for AI Agents — Built by an Agent</p>
<div class="countdown">⏰ ${hoursLeft}h to hackathon deadline <span class="pulse">●</span></div>
<div class="grid">
  <div class="card"><div class="num">${agents}</div><div class="label">Agents</div></div>
  <div class="card"><div class="num">${phones}</div><div class="label">Phones</div></div>
  <div class="card"><div class="num">${emails}</div><div class="label">Emails</div></div>
  <div class="card"><div class="num">${servers}</div><div class="label">Servers</div></div>
  <div class="card"><div class="num">${domains}</div><div class="label">Domains</div></div>
  <div class="card"><div class="num">${webhooks}</div><div class="label">Webhooks</div></div>
  <div class="card"><div class="num">${totalRequests.toLocaleString()}</div><div class="label">API Requests</div></div>
  <div class="card"><div class="num">${tasks}</div><div class="label">Tasks</div></div>
</div>
<div class="section">
  <h2>System Health</h2>
  <p>Uptime: <code>${(uptime/3600).toFixed(1)}h</code> | Memory: <code>${(mem.heapUsed/1048576).toFixed(0)}MB</code> / <code>${(mem.heapTotal/1048576).toFixed(0)}MB</code> | Load: <code>${load[0].toFixed(2)}</code></p>
  <div class="bar"><div class="bar-fill" style="width:${Math.min(100,(mem.heapUsed/mem.heapTotal*100)).toFixed(0)}%"></div></div>
</div>
<div class="section">
  <h2>Try It Now</h2>
  <p style="margin:4px 0"><code>curl http://77.42.89.233:3001/api/agents -X POST -H "Content-Type: application/json" -H "X-Agent-Id: demo" -d {name:my-agent}</code></p>
  <p style="margin:4px 0;color:#888">Free during hackathon — no API key needed</p>
</div>
<div class="links">
  <a href="/docs">📖 Swagger Docs</a>
  <a href="/skill.md">🤖 Skill File</a>
  <a href="/api/proof-of-work">⚡ Proof of Work</a>
  <a href="https://github.com/0xArtex/AgentOS">🐙 GitHub</a>
</div>
<script>setTimeout(()=>location.reload(),30000)</script>
</body></html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

export default router;
