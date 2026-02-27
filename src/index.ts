import hackathonSummaryRoute from "./routes/hackathon-summary";
import judgeScorecardRoute from "./routes/judge-scorecard";
import agentGraphRoute from "./routes/agent-graph";
import agentLifecycleRoute from "./routes/agent-lifecycle";
import agentLeaderboardRoute from "./routes/agent-leaderboard";
import fleetDashboardRoute from "./routes/fleet-dashboard";
import agentReputationRouter from "./routes/agent-reputation";
import serviceProbeRouter from "./routes/service-probe";
import liveDashboardRoute from "./routes/live-dashboard";
import agentBackupRoute from "./routes/agent-backup";
import trafficDashboardRoute from "./routes/traffic-dashboard";
import last48hRoute from "./routes/last-48h";
import marketplaceRoutes from "./routes/agent-marketplace";
import submissionSummaryRoutes from "./routes/submission-summary";
import submissionRouter from "./routes/submission";
import agentWorkflowsRoutes from "./routes/agent-workflows";
import finalCountdownRoute from "./routes/final-countdown";
import liveStatusRoute from "./routes/live-status";
import apiMapRoute from "./routes/api-map";
import integrationsGuideRoute from "./routes/agent-integrations-guide";
import demoFlowRoute from "./routes/demo-flow";
import demoLiveRoute from "./routes/demo-live";
import demoScriptRoute from "./routes/demo-script";
import warRoomRouter from "./routes/war-room";
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
import postHackathonStatusRoute from "./routes/post-hackathon-status";
import express from "express";
import path from "path";
import swaggerUi from "swagger-ui-express";
import { config } from "./config";
import { swaggerSpec } from "./swagger";
import "./db"; // Initialize database
import phoneRoutes from "./routes/phone";
import emailRoutes from "./routes/email";
import domainRoutes from "./routes/domains";
import xAccountRoutes from "./routes/xaccounts";
import skillsRoutes from "./routes/skills";
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
import whyUsRouter from "./routes/why-us";
import whyRouter from "./routes/why";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import agentNetworkRouter from "./routes/agent-network";
import agentSearchHub from "./routes/agent-search-hub";
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
import hackathonPitchRoutes from "./routes/hackathon-pitch";
import agentManifestRoutes from "./routes/agent-manifest";


const app = express();
import deadlineDayRoute from "./routes/deadline-day";

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
import healthRouter from "./routes/health"; app.use("/health", healthRouter);

// ── Version endpoint ─────────────────────────────────────────
app.get("/version", (_req, res) => {
  res.json(getVersion());

});
// ── API Documentation ─────────────────────────────────────────
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ── Dashboard session resolution (global) ────────────────────
import { resolveDashboardSession } from "./middleware/dashboard-session";
app.use(resolveDashboardSession as any);

// ── Routes ────────────────────────────────────────────────────
app.use("/phone", phoneRoutes);
app.use("/email", emailRoutes);
app.use("/x", xAccountRoutes);
app.use("/skills", skillsRoutes);
app.use("/domains", domainRoutes);
app.use("/compute", computeRoutes);
import provisionRoutes from "./routes/provision";
app.use("/provision", provisionRoutes);
import dashboardAuthRoutes from "./routes/dashboard-auth";
app.use("/auth", dashboardAuthRoutes);
import balanceRoutes from "./routes/balance";
app.use("/balance", balanceRoutes);
import projectRoutes from "./routes/projects";
app.use("/projects", projectRoutes);
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
app.use("/api/why", whyRouter);
app.use("/api", submissionReadyRoutes);
import partnerHealthRoutes from "./routes/partner-health";app.use("/api/partner-health", partnerHealthRoutes);

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
app.use(demoLiveRoute);
app.use(demoScriptRoute);
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
import hackathonRecapRoute from "./routes/hackathon-recap";
import hackathonJourneyRoute from "./routes/hackathon-journey";
import liveTestRoute from "./routes/live-test";
app.use("/api/agent-toolkit", agentToolkitRouter);
app.use("/api", serviceHealthRouter);
app.use("/api/hackathon-status", hackathonStatusRouter);
app.use("/api", demoWalkthroughRoute);
app.use(liveDemoRoute);
app.use("/api/architecture", architectureRoute);
app.use("/api/for-judges", forJudgesRoute);
app.use("/api/hackathon-recap", hackathonRecapRoute);
app.use("/api/live-test", liveTestRoute);
app.use("/api/hackathon-journey", hackathonJourneyRoute);
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
app.use(integrationsGuideRoute);
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
app.use("/api", hackathonPitchRoutes);
app.use("/api", agentManifestRoutes);
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
import agentCostOptimizerRoute from "./routes/agent-cost-optimizer";app.use("/api/cost-optimizer", agentCostOptimizerRoute);
import agentConfigRoute from "./routes/agent-config";
import agentMetricsRoute from "./routes/agent-metrics";
app.use("/api/agent-config", agentConfigRoute);
app.use("/api/agent-metrics", agentMetricsRoute);
import agentSnapshotRoute from "./routes/agent-snapshot"; app.use(agentSnapshotRoute);
app.use("/dashboard", liveDashboardRoute);
app.use(serviceProbeRouter);
app.use(agentReputationRouter);
import agentChangelogRoute from "./routes/agent-changelog";
app.use("/api/agent-changelog", agentChangelogRoute);
import agentCompareRoute from "./routes/agent-compare";
app.use("/api/agent-compare", agentCompareRoute);
import agentUptimeReportRoute from "./routes/agent-uptime-report";
app.use("/api/agent-uptime-report", agentUptimeReportRoute);
import agentUptimeHistoryRoute from "./routes/agent-uptime-history";
app.use("/api/agent", agentUptimeHistoryRoute);
app.use(warRoomRouter);
app.use("/api", fleetDashboardRoute);
import finalStatsRouter from "./routes/final-stats";
app.use(finalStatsRouter);
import agentQuicksetup from "./routes/agent-quicksetup";app.use("/api/quicksetup", agentQuicksetup);
import agentFinalReviewRouter from "./routes/agent-final-review";
import agentFinalStats from "./routes/agent-final-stats";
app.use("/api/final-review", agentFinalReviewRouter);
app.use(agentFinalStats);
import deadlineCountdownRouter from "./routes/deadline-countdown"; app.use(deadlineCountdownRouter);
app.use("/api/agent-leaderboard", agentLeaderboardRoute);
app.use("/api/agent-graph", agentGraphRoute);
app.use("/api/agent-lifecycle", agentLifecycleRoute);
import agentHealthRoute from "./routes/agent-health"; app.use("/api", agentHealthRoute);
app.use(judgeScorecardRoute);
import finalHoursRouter from "./routes/final-hours";
app.use("/api", finalHoursRouter);
import finalDemoRouter from "./routes/final-demo"; app.use("/api", finalDemoRouter);
app.use(submissionRouter);
app.use(whyUsRouter);
import readyToJudge from "./routes/ready-to-judge";
app.use(readyToJudge);
import finalHoursChecklist from "./routes/final-hours-checklist";
app.use(finalHoursChecklist);
import submissionStatus from "./routes/submission-status";
app.use(submissionStatus);
import agentInboxRouter from "./routes/agent-inbox";
app.use("/api/inbox", agentInboxRouter);
app.use("/api/search", agentSearchHub);
app.use("/api/agent-network", agentNetworkRouter);
import deadlineFinalRouter from "./routes/deadline-final";
app.use("/api/deadline-final", deadlineFinalRouter);
import agentPulseRouter from "./routes/agent-pulse";
app.use("/api/agent-pulse", agentPulseRouter);
import agentSearchV2Router from "./routes/agent-search-v2";
app.use("/api/search", agentSearchV2Router);
import countdownLive from "./routes/countdown-live";
import lastDayRoute from "./routes/last-day";
app.use(lastDayRoute);
import thankYouRouter from "./routes/thank-you";
app.use("/api/thank-you", thankYouRouter);
import lastCallRouter from "./routes/last-call";
app.use("/api/last-call", lastCallRouter);
app.use(countdownLive);
app.use("/api/final-hours", finalHoursRouter);
import finalHoursRoute from "./routes/final-hours";
app.use(finalHoursRoute);
import ecosystemMapRoute from "./routes/ecosystem-map";app.use("/api/ecosystem-map", ecosystemMapRoute);
app.use("/api/ecosystem-health", require("./routes/ecosystem-health").default);
import ecosystemStatsRoute from "./routes/ecosystem-stats";app.use("/api/ecosystem-stats", ecosystemStatsRoute);
import judgesRouter from "./routes/judges"; app.use("/api/judges", judgesRouter);
import pitchDeckRoute from "./routes/pitch-deck"; app.use(pitchDeckRoute);
app.use("/api", deadlineDayRoute);
import postHackathonRoute from "./routes/post-hackathon";app.use("/api/post-hackathon", postHackathonRoute);
import judgesBriefRouter from "./routes/judges-brief"; app.use("/api", judgesBriefRouter);
app.use(hackathonSummaryRoute);
import judgeOverviewRoute from "./routes/judge-overview"; app.use(judgeOverviewRoute);
import wrapUpRoute from "./routes/wrap-up";app.use("/api/wrap-up", wrapUpRoute);
import builderStatusRouter from "./routes/builder-status";
import agentStatusPage from "./routes/agent-status-page"; app.use("/api/status-page", agentStatusPage);
import postHackathonRecapRoute from "./routes/post-hackathon-recap";app.use("/api/recap", postHackathonRecapRoute);
import postHackathonRoadmapRoute from "./routes/post-hackathon-roadmap";app.use(postHackathonRoadmapRoute);
import communityStatsRoute from "./routes/community-stats";app.use(communityStatsRoute);
app.use("/api/post-hackathon-status", postHackathonStatusRoute);
import agentDiscoveryRoute from "./routes/agent-discovery";
app.use("/api/agent-discovery", agentDiscoveryRoute);
import builderProgramRoute from "./routes/builder-program";app.use("/api/builder-program", builderProgramRoute);
import agentNetworkMapRoute from "./routes/agent-network-map";app.use("/api/agent-network-map", agentNetworkMapRoute);
import agentIntegrationTestRoute from "./routes/agent-integration-test";app.use("/api/agent-integration-test", agentIntegrationTestRoute);
import agentAuditLogRoute from "./routes/agent-audit-log";app.use(agentAuditLogRoute);
import agentHealthReportRoute from "./routes/agent-health-report";app.use(agentHealthReportRoute);
import ecosystemPulseRouter from "./routes/ecosystem-pulse";
app.use("/api/ecosystem-pulse", ecosystemPulseRouter);
import networkGraphRouter from "./routes/network-graph";app.use("/api/network-graph", networkGraphRouter);
import platformHealthRoute from "./routes/platform-health";app.use(platformHealthRoute);
// ── x402 Facilitator Proxy ────────────────────────────────────
app.all("/x402/*", async (req, res) => {
  try {
    const targetPath = req.path.replace("/x402", "");
    const targetUrl = `http://localhost:8090${targetPath}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (req.headers.authorization) headers["Authorization"] = req.headers.authorization as string;
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const data = await resp.text();
    res.status(resp.status).set("Content-Type", resp.headers.get("content-type") || "application/json").send(data);
  } catch (err: any) {
    res.status(502).json({ error: "Facilitator proxy error", message: err.message });
  }
});

app.use(notFoundHandler);
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────
import { startDepositMonitor } from "./services/deposit-monitor";
app.listen(config.port, () => {
  startDepositMonitor();
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
app.use(whyUsRouter);


// moved up

// moved to top
import demoVideoRoute from "./routes/demo-video";import judgeWalkthroughRoute from "./routes/judge-walkthrough";app.use("/api/demo-video", demoVideoRoute);app.use("/api/judge-walkthrough", judgeWalkthroughRoute);

import communityBoardRoute from "./routes/community-board";app.use("/api", communityBoardRoute);

import agentDiagnosticsRoute from "./routes/agent-diagnostics";app.use("/api/agent-diagnostics", agentDiagnosticsRoute);
import communityRoute from "./routes/community";app.use("/api/community", communityRoute);

export default app;
import postmortemRoute from "./routes/postmortem";app.use("/api/post-mortem", postmortemRoute);
app.use(builderStatusRouter);

import builderStatsRoute from "./routes/builder-stats";app.use("/api/builder-stats", builderStatsRoute);
