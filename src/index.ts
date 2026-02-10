import agentBackupRoute from "./routes/agent-backup";
import trafficDashboardRoute from "./routes/traffic-dashboard";
import last48hRoute from "./routes/last-48h";
import marketplaceRoutes from "./routes/agent-marketplace";
import submissionSummaryRoutes from "./routes/submission-summary";
import agentWorkflowsRoutes from "./routes/agent-workflows";
import finalCountdownRoute from "./routes/final-countdown";
import liveStatusRoute from "./routes/live-status";
import apiMapRoute from "./routes/api-map";
import demoFlowRoute from "./routes/demo-flow";
import judgeBriefRoutes from "./routes/judge-brief";
import partnerWorkflowsRoute from "./routes/partner-workflows";
import starterKitRoute from "./routes/starter-kit";
import colosseumReadyRoutes from "./routes/colosseum-ready";
import agentActivityRoutes from "./routes/agent-activity";
import whyAgentosRoute from "./routes/why-agentos";
import serviceHealthRouter from "./routes/service-health";
import hackathonStatusRouter from "./routes/hackathon-status";
import pitchRouter from "./routes/pitch";
import dashboardRoutes from "./routes/dashboard";
import healthSummaryRoutes from "./routes/health-summary";
import alertsRouter from "./routes/alerts";
import sdkRoutes from "./routes/sdk";
import ecosystemRoutes from "./routes/ecosystem";
import agentScoreRoutes from "./routes/agent-score";
import comparisonRoutes from "./routes/comparison";
import quickstartRoutes from "./routes/quickstart";
import integrationsLiveRouter from "./routes/integrations-live";
import express from "express";
import path from "path";
import swaggerUi from "swagger-ui-express";
import { config } from "./config";
import { swaggerSpec } from "./swagger";
import "./db"; // Initialize database
import phoneRoutes from "./routes/phone";
import emailRoutes from "./routes/email";
import domainRoutes from "./routes/domain";
import computeRoutes from "./routes/compute";
import apikeysRoutes from "./routes/apikeys";
import demoRoutes from "./routes/demo";
import demoInteractiveRoutes from "./routes/demo-interactive";
import webhookRoutes from "./routes/webhooks";
import submissionReadyRoutes from "./routes/submission-ready";
import agentRoutes from "./routes/agents";
import statsRoutes from "./routes/stats";
import messageRoutes from "./routes/messages";
import agentToolkitRouter from "./routes/agent-toolkit";
import bootstrapRouter from "./routes/bootstrap";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { requestLogger } from "./middleware/requestLog";
import { cors } from "./middleware/cors";
import { requestTimeout } from "./middleware/timeout";
import { rateLimit } from "./middleware/rateLimit";
import { securityHeaders, paramPollution, sqlInjectionGuard, sanitizeInputs, bodySizeLimit, bruteForceProtection } from "./middleware/security";
import { isHackathonActive, getAgentUsage } from "./middleware/hackathon";
import activityRoutes from "./routes/activity";
import onboardingRoutes from "./routes/onboarding";
import analyticsRoutes from "./routes/analytics";
import changelogRoutes from "./routes/changelog";
import reputationRoutes from "./routes/reputation";
import statusRoutes from "./routes/status";
import networkRoutes from "./routes/network";
import usecasesRoutes from "./routes/usecases";
import integrationsRoutes from "./routes/integrations";
import roadmapRoutes from "./routes/roadmap";
import testimonialsRoutes from "./routes/testimonials";
import examplesRoutes from "./routes/examples";
import faqRoutes from "./routes/faq";
import { getHealth, getVersion } from "./utils/health";
import compatibilityRoutes from "./routes/compatibility";
import securityRoutes from "./routes/security";
import calculatorRoutes from "./routes/calculator";
import migrationRoutes from "./routes/migration";
import benchmarksRoutes from "./routes/benchmarks";
import sandboxRoutes from "./routes/sandbox";
import slaRoutes from "./routes/sla";
import infoRoutes from "./routes/info";
import leaderboardRoutes from "./routes/leaderboard";
import healthMatrixRoutes from "./routes/healthmatrix";
import eventsRoutes from "./routes/events";
import changelogFullRoutes from "./routes/changelog-full";
import partnersRoutes from "./routes/partners";
import playgroundRoutes from "./routes/playground";
import templatesRoutes from "./routes/templates";
import capabilitiesRoutes from "./routes/capabilities";
import directoryRoutes from "./routes/directory";
import logsRoutes from "./routes/logs";
import metricsRoutes from "./routes/metrics";
import agentKitRoutes from "./routes/agent-kit";


const app = express();

app.use(securityHeaders);
app.use(paramPollution);
app.use(express.json({ limit: "100kb" }));
app.use(cors);
app.use(sanitizeInputs);
app.use(sqlInjectionGuard);
app.use(bruteForceProtection);
app.use(requestTimeout(30_000));
app.use(rateLimit(60, 60_000));
app.use(requestLogger);

// ── Static files (landing page) ──────────────────────────────
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Landing page ─────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ── API info (moved from GET /) ──────────────────────────────
app.get("/api", (_req, res) => {
  res.json({
    service: "AgentOS",
    version: getVersion().version,
    status: "operational",
    docs: "https://github.com/0xArtex/AgentOS",
    services: ["phone", "email", "domains", "compute", "apikeys", "agents", "messages", "stats", "activity"],
  });
});

app.get("/health", (_req, res) => {
  const health = getHealth();
  res.status(health.status === "healthy" ? 200 : 503).json(health);
});

// ── Version endpoint ─────────────────────────────────────────
app.get("/version", (_req, res) => {
  res.json(getVersion());
});

// ── API Documentation ─────────────────────────────────────────
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ── Routes ────────────────────────────────────────────────────
app.use("/phone", phoneRoutes);
app.use("/email", emailRoutes);
app.use("/domains", domainRoutes);
app.use("/compute", computeRoutes);
app.use("/apikeys", apikeysRoutes);

// ── Agent Management (free) ──────────────────────────────────
app.use("/agents", agentRoutes);

// ── Platform Stats (free) ────────────────────────────────────
app.use("/stats", statsRoutes);

// ── Agent Messaging (free during hackathon) ──────────────────
app.use("/messages", messageRoutes);

// ── Activity Feed (free) ─────────────────────────────────────
app.use("/activity", activityRoutes);
app.use("/onboarding", onboardingRoutes);
app.use("/analytics", analyticsRoutes);

// ── Demo Routes (no payment required) ────────────────────────
app.use("/demo", demoRoutes);
app.use("/api/demo/interactive", demoInteractiveRoutes);

// ── Webhook Routes (no x402 payment, for provider callbacks) ─
app.use("/webhooks", webhookRoutes);
app.use("/api", whyAgentosRoute);
app.use("/api", submissionReadyRoutes);

// ── Pricing info (no auth required) ──────────────────────────
app.get("/pricing", (_req, res) => {
  res.json({
    currency: "USDC",
    network: "solana",
    services: {
      phone: {
        "provision_number": "2.00",
        "get_messages": "0.01",
        "send_sms": "0.05",
      },
      email: {
        "create_inbox": "1.00",
        "get_messages": "0.01",
        "send_email": "0.05",
      },
      domains: {
        "register_domain": "10.00",
        "get_status": "0.01",
        "update_dns": "0.10",
      },
      compute: {
        "create_server": "5.00",
        "list_servers": "0.01",
        "get_server": "0.01",
        "delete_server": "0.10",
        "upload_ssh_key": "0.10",
      },
      apikeys: {
        "provision_key": "1.00",
        "list_keys": "0.01",
        "revoke_key": "0.01",
      },
    },
  });
});

// ── Hackathon status (no auth required) ──────────────────────
app.get("/hackathon/status", (req, res) => {
  const active = isHackathonActive();
  const agentId = req.headers["x-agent-id"] as string | undefined;
  
  const response: any = {
    mode: config.hackathonMode ? "enabled" : "disabled",
    active,
    deadline: config.hackathonEnd,
    limits: {
      phoneNumbers: 5,
      emailInboxes: 5, 
      servers: 2
    }
  };

  if (active && agentId) {
    const usage = getAgentUsage(agentId);
    response.usage = {
      agentId,
      phoneNumbers: usage.phoneNumbers,
      emailInboxes: usage.emailInboxes,
      servers: usage.servers
    };
  }

  res.json(response);
});

// ── Skill documentation for OpenClaw agents ─────────────────
app.get("/skill.md", (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const skillPath = path.join(__dirname, '..', 'public', 'skill.md');
  if (fs.existsSync(skillPath)) {
    res.setHeader('Content-Type', 'text/markdown');
    res.send(fs.readFileSync(skillPath, 'utf-8'));
  } else {
    res.status(404).send('# skill.md not found');
  }
});


// ── Stream Overlay Stats ──────────────────────────────────────
app.get("/overlay-stats", async (_req, res) => {
  // Read current task from a file (updated externally)
  let task = "Shipping AgentOS features...";
  let commits = 0;
  try {
    const fs = await import("fs");
    const taskFile = path.join(process.cwd(), "data", "overlay.json");
    if (fs.existsSync(taskFile)) {
      const data = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
      if (data.task) task = data.task;
      if (data.commits) commits = data.commits;
    }
  } catch {}

  // Count total endpoints from overlay data or default
  let endpoints = 48;
  try {
    const fs = await import("fs");
    const taskFile = path.join(process.cwd(), "data", "overlay.json");
    if (fs.existsSync(taskFile)) {
      const data = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
      if (data.endpoints) endpoints = data.endpoints;
    }
  } catch {}

  res.json({ task, commits, endpoints });
});

// ── Changelog ─────────────────────────────────────────────
app.use("/api/use-cases", usecasesRoutes);
app.use("/changelog", changelogRoutes);
app.use("/status", statusRoutes);
app.use("/api/network", networkRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/compatibility", compatibilityRoutes);
app.use("/api/roadmap", roadmapRoutes);
app.use("/api/testimonials", testimonialsRoutes);
app.use("/api/examples", examplesRoutes);
app.use("/api/faq", faqRoutes);
app.use("/api", securityRoutes);
app.use("/api", calculatorRoutes);
app.use("/api/quickstart", quickstartRoutes);
app.use("/api/comparison", comparisonRoutes);
app.use("/api/ecosystem", ecosystemRoutes);
app.use("/api/migration", migrationRoutes);
app.use("/api/benchmarks", benchmarksRoutes);
app.use("/api/sandbox", sandboxRoutes);
app.use("/api/sla", slaRoutes);
app.use("/api/uptime", infoRoutes);
app.get("/api/final-pitch", (_req: any, res: any) => {
  res.json({
    name: "AgentOS",
    tagline: "The operating system for autonomous AI agents",
    problem: "Every agent team rebuilds the same infra. Weeks wasted on plumbing.",
    solution: "One API call = full infra stack, paid in USDC on Solana.",
    traction: { endpoints: "121+", forum_comments: "495+", partners: 11 },
    differentiators: ["x402 payments", "Framework-agnostic", "Sub-second provisioning", "Security-first"],
    vision: "The AWS for the agent economy.",
    links: { api: "http://77.42.89.233:3001", docs: "http://77.42.89.233:3001/docs", github: "https://github.com/0xArtex/AgentOS" }
  });
});
app.use("/api/judge-brief", judgeBriefRoutes);
app.use("/api", last48hRoute);
app.use("/api/submission-summary", submissionSummaryRoutes);
app.use("/api", leaderboardRoutes);
app.use("/api/health-matrix", healthMatrixRoutes);
app.use("/api/changelog", changelogFullRoutes);
app.use("/api/events", eventsRoutes);
app.use("/api/partners", partnersRoutes);
app.use("/api/playground", playgroundRoutes);
app.use("/api/templates", templatesRoutes);
app.use("/api/capabilities", capabilitiesRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/metrics", metricsRoutes);
app.use("/api/agent-kit", agentKitRoutes);
app.use("/api/sdk", sdkRoutes);
app.use("/api/agents/directory", directoryRoutes);
import demoRouter from "./routes/demo";
app.use("/api/demo", demoRouter);
import verifyRouter from "./routes/verify";
import whoamiRouter from "./routes/whoami";
import feedbackRouter from "./routes/feedback";
app.use("/api/agents/verify", verifyRouter);
app.use("/api/whoami", whoamiRouter);
app.use("/api/feedback", feedbackRouter);

// ── Error handling ────────────────────────────────────────────
// ── Deep health check ────────────────────────────────────────
app.get("/health/deep", (_req, res) => {
  const os = require("os");
  const uptimeS = Math.floor(process.uptime());
  const mem = process.memoryUsage();
  res.json({
    status: "healthy",
    version: getVersion().version,
    uptime: { seconds: uptimeS, human: `${Math.floor(uptimeS/3600)}h ${Math.floor((uptimeS%3600)/60)}m ${uptimeS%60}s` },
    memory: { rss_mb: Math.round(mem.rss/1048576), heap_used_mb: Math.round(mem.heapUsed/1048576) },
    system: { cpus: os.cpus().length, load: os.loadavg(), free_mem_mb: Math.round(os.freemem()/1048576), total_mem_mb: Math.round(os.totalmem()/1048576) },
    hackathon: { deadline: "2026-02-12T17:00:00Z", hours_remaining: Math.max(0, Math.floor((new Date("2026-02-12T17:00:00Z").getTime() - Date.now())/3600000)), mode: "FREE" }
  });
});

import hackathonRouter from "./routes/hackathon";
app.use("/api/hackathon", hackathonRouter);
import grantsRouter from "./routes/grants";
import rateLimitsRouter from "./routes/ratelimits";
import agentEventsRouter from "./routes/agent-events";
app.use("/api", grantsRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/agents/reputation", reputationRoutes);
app.use("/api/dashboard", dashboardRoutes);
import configRouter from "./routes/config";
app.use("/api/config", configRouter);
import deadlinesRouter from "./routes/deadlines";
app.use("/api/deadlines", deadlinesRouter);
import integrationTestRouter from "./routes/integration-test";
app.use("/api/integration-test", integrationTestRouter);
import launchChecklistRouter from "./routes/launch-checklist";
app.use("/api/launch-checklist", launchChecklistRouter);
import submitChecklistRouter from "./routes/submit-checklist";
app.use("/api/submit-checklist", submitChecklistRouter);
import countdownRouter from "./routes/countdown";
app.use("/api", countdownRouter);
import finalSprintRouter from "./routes/final-sprint";
app.use("/api", finalSprintRouter);
import finalPushRouter from "./routes/final-push";app.use("/api/final-push", finalPushRouter);
import finalSummaryRouter from "./routes/final-summary";app.use("/api/final-summary", finalSummaryRouter);
import uptimeRouter from "./routes/uptime";
app.use("/api", uptimeRouter);
import walkthroughRouter from "./routes/walkthrough";
import demoRequestRouter from "./routes/demo-request";
app.use("/api/walkthrough", walkthroughRouter);
app.use("/api/demo-request", demoRequestRouter);
app.use("/demo-flow", demoFlowRoute);
app.use("/api/agent-workflows", agentWorkflowsRoutes);

app.use("/api/health-summary", healthSummaryRoutes);
app.use("/api/agent-score", agentScoreRoutes);
import walletRouter from "./routes/wallet";
app.use("/api/wallet", walletRouter);
import agentProfileRouter from "./routes/agent-profile";
import judgeReadyRouter from "./routes/judge-ready";
import judgeSummaryRouter from "./routes/judge-summary";
import agentReadinessRouter from "./routes/agent-readiness";
import agentDirectoryRouter from "./routes/agent-directory";
import integrationGuideRouter from "./routes/integration-guide";
import agentHealthRouter from "./routes/agent-health";
app.use("/api/agent-health", agentHealthRouter);
app.use("/api", integrationGuideRouter);
app.use("/api", judgeReadyRouter);
app.use("/api", agentReadinessRouter);
app.use("/api/agent-profile", agentProfileRouter);
app.use("/api/agent-directory", agentDirectoryRouter);
import debugRouter from "./routes/debug";
import invoiceRouter from "./routes/invoice";
import webhooksRouter from "./routes/webhooks";
app.use("/api/debug", debugRouter);
app.use("/api/invoice", invoiceRouter);
app.use("/api/webhooks", webhooksRouter);
app.use("/api/judge-summary", judgeSummaryRouter);
app.use("/api/pitch", pitchRouter);
import systemMetricsRouter from "./routes/system-metrics";
import demoWalkthroughRoute from "./routes/demo-walkthrough";
import liveDemoRoute from "./routes/live-demo";
import architectureRoute from "./routes/architecture";
app.use("/api/system-metrics", systemMetricsRouter);
import forJudgesRoute from "./routes/for-judges";
import liveTestRoute from "./routes/live-test";
app.use("/api/agent-toolkit", agentToolkitRouter);
app.use("/api", serviceHealthRouter);
app.use("/api/hackathon-status", hackathonStatusRouter);
app.use("/api", demoWalkthroughRoute);
app.use(liveDemoRoute);
app.use("/api/architecture", architectureRoute);
app.use("/api/for-judges", forJudgesRoute);
app.use("/api/live-test", liveTestRoute);
import systemOverviewRoute from "./routes/system-overview";
app.use("/api/system-overview", systemOverviewRoute);
import systemHealthRoute from "./routes/system-health";
app.use("/api/system-health", systemHealthRoute);
app.use("/api/bootstrap", bootstrapRouter);
app.use("/api/agent-activity", agentActivityRoutes);
app.use("/api", colosseumReadyRoutes);
import hackathonStatsRoute from "./routes/hackathon-stats";
app.use("/api", hackathonStatsRoute);
import pingRoute from "./routes/ping";
app.use("/api/ping", pingRoute);
app.use("/api/starter-kit", starterKitRoute);
app.use("/api/partner-workflows", partnerWorkflowsRoute);
app.use("/api/partner-workflows", partnerWorkflowsRoute);
app.use("/ping", pingRoute);
app.use("/api/live-status", liveStatusRoute);
app.use("/api", finalCountdownRoute);
import deadlineRoute from "./routes/deadline";
import proofOfWorkRoute from './routes/proof-of-work';
app.use("/api/deadline", deadlineRoute);
app.use(apiMapRoute);
app.use("/api/integrations-live", integrationsLiveRouter);
app.use(proofOfWorkRoute);
import agentRatingRoute from "./routes/agent-rating";
app.use("/api/agent-rating", agentRatingRoute);
import healthMonitorRoute from "./routes/health-monitor";
import judgeDashboardRoute from "./routes/judge-dashboard";
app.use("/api/health-monitor", healthMonitorRoute);
import agentTasksRoute from "./routes/agent-tasks";
app.use("/api/tasks", agentTasksRoute);
app.use("/api", judgeDashboardRoute);
app.use(trafficDashboardRoute);
import agentNotificationsRoute from "./routes/agent-notifications";
app.use("/api/notifications", agentNotificationsRoute);
import agentCommsRoute from "./routes/agent-comms";app.use("/api/agent-comms", agentCommsRoute);
import agentEscrowRoute from "./routes/agent-escrow";
import agentWebhooksRoute from "./routes/agent-webhooks"; app.use("/api/agent-webhooks", agentWebhooksRoute);
app.use("/api/agent-escrow", agentEscrowRoute);
import agentQueueRoute from "./routes/agent-queue";
app.use("/api/queue", agentQueueRoute);
import agentDashboardRoute from "./routes/agent-dashboard";app.use("/api/agent-dashboard", agentDashboardRoute);
import agentTemplatesRoute from "./routes/agent-templates";
app.use("/api/agent-templates", agentTemplatesRoute);
import agentBatchRoute from "./routes/agent-batch";app.use("/api/agent-batch", agentBatchRoute);
import agentStatsLiveRoute from "./routes/agent-stats-live";
import agentKanbanRoute from "./routes/agent-kanban";
app.use("/api/agent-kanban", agentKanbanRoute);
app.use("/api/agent-stats", agentStatsLiveRoute);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/agent-events", agentEventsRouter);
import agentAlertsRoute from "./routes/agent-alerts";
import agentIdentityRoute from "./routes/agent-identity";
app.use("/api/agent-alerts", agentAlertsRoute);
app.use("/api/agent-identity", agentIdentityRoute);
import agentSecretsRoute from "./routes/agent-secrets";
app.use("/api/agent-secrets", agentSecretsRoute);
import agentCronRoute from "./routes/agent-cron";
import agentEnvRouter from "./routes/agent-env";
app.use("/api/agent-env", agentEnvRouter);
app.use("/api/agent-cron", agentCronRoute);
import evaluateRoute from "./routes/evaluate";app.use("/api/evaluate", evaluateRoute);
app.use("/api/agent-backup", agentBackupRoute);
import agentComposeRoute from "./routes/agent-compose";
app.use("/api/agent-compose", agentComposeRoute);
import agentBillingRoute from "./routes/agent-billing";
app.use("/api/agent-billing", agentBillingRoute);
import agentSlaRoute from "./routes/agent-sla";app.use("/api/agent-sla", agentSlaRoute);
import agentOnboardRoute from "./routes/agent-onboard"; app.use("/api/agent-onboard", agentOnboardRoute);
import agentUptimeRoute from "./routes/agent-uptime";
app.use("/api/agent-uptime", agentUptimeRoute);
import agentCostOptimizerRoute from "./routes/agent-cost-optimizer";app.use("/api/cost-optimizer", agentCostOptimizerRoute);
import agentConfigRoute from "./routes/agent-config";
app.use("/api/agent-config", agentConfigRoute);
app.use(notFoundHandler);
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`⚡ AgentOS running on port ${config.port}`);
  console.log(`   Treasury: ${config.treasuryWallet}`);
  console.log(`   Network:  Solana (${config.solanaRpcUrl})`);
  console.log(`   Email:    *@${config.emailDomain}`);
});

import agentSimulationRoute from "./routes/agent-simulation";
import hackathonImpactRoute from "./routes/hackathon-impact";
app.use(agentSimulationRoute);
app.use(hackathonImpactRoute);
import agentCollaborationRoute from "./routes/agent-collaboration";
// removed duplicate
app.use("/api/agent-collaboration", agentCollaborationRoute);

import agentLogsRoute from "./routes/agent-logs";
import agentReputationRoute from "./routes/agent-reputation";
import agentFleetRoute from "./routes/agent-fleet";
app.use("/api/agent-logs", agentLogsRoute);
app.use("/api/agent-fleet", agentFleetRoute);
app.use("/api/agent-reputation", agentReputationRoute);


// moved up

export default app;

