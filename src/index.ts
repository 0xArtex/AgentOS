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
import whyAgentosRoute from "./routes/why-palmyr";
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
import { DATA_DIR, db } from "./db";
import { classifyAgent } from "./utils/agent-classifier";
import phoneRoutes from "./routes/phone";
import emailRoutes from "./routes/email";
import socialRoutes from "./routes/social";
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
import telemetryRoutes from "./routes/telemetry";
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
import { securityHeaders, paramPollution, sqlInjectionGuard, sanitizeInputs, bruteForceProtection } from "./middleware/security";
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

// gzip JSON + JS + CSS + HTML responses. WebP/MP4/PNG are skipped by the
// default `compressible` filter so already-compressed bytes don't get re-run.
import compression from "compression";
app.use(compression());

app.use(securityHeaders);
app.use(paramPollution);
// Social image-upload endpoints transfer up to ~10 MB of base64 image data;
// TikTok video uploads can hit ~100 MB (base64 is ~1.33× the raw bytes).
// Everything else stays on the security-tight 100 KB default.
const IMAGE_UPLOAD_ROUTES = new Set([
  "/social/twitter/avatar",
  "/social/twitter/banner",
  "/social/tiktok/avatar",
]);
const VIDEO_UPLOAD_ROUTES = new Set([
  "/social/tiktok/post",
  // X media routes accept 1-4 images OR 1 video — use the video tier so video
  // uploads aren't capped at 15 MB. Direct + scheduled both pass payload over
  // base64 so the wire size is ~1.33× the raw media bytes.
  "/social/twitter/post-media",
  "/social/scheduled/media",
]);
app.use((req, res, next) => {
  // Express is non-strict by default, so /social/twitter/post-media/ (trailing
  // slash) still hits the handler — normalize it before the Set lookup so the
  // upload tier isn't silently downgraded to 100kb and 413'd.
  const p = req.path.length > 1 && req.path.endsWith("/") ? req.path.slice(0, -1) : req.path;
  const limit = VIDEO_UPLOAD_ROUTES.has(p)
    ? "150mb"
    : IMAGE_UPLOAD_ROUTES.has(p)
      ? "15mb"
      : "100kb";
  return express.json({ limit })(req, res, next);
});
app.use(cors);
app.use(sanitizeInputs);
app.use(sqlInjectionGuard);
app.use(bruteForceProtection);

// Wallet routes BEFORE timeout (on-chain signing can take 60s+)
// Vault directories are created lazily on first write (see ensureVault in wallet-vault.ts)
import walletRoutes from "./routes/wallet";
import walletPasskeyRoutes from "./routes/wallet-passkey";
app.use("/wallet", walletRoutes);
app.use("/wallet", walletPasskeyRoutes);

// Social routes run a headless browser and can legitimately take 60-90s
// through a residential proxy. /chat (i402) streams multi-step plan execution
// which can run 10-30 minutes for compound outcomes like a product launch.
// Skip the default 30s timeout for both.
app.use((req, res, next) => {
  if (req.path.startsWith("/social") || req.path.startsWith("/chat")) return next();
  return requestTimeout(30_000)(req, res, next);
});

// Discovery endpoints (well-known + openapi) mounted BEFORE the global rate
// limiter so x402scan / Bazaar crawlers can probe them without 429s. Their
// handlers introspect the live router stack, so they reflect any route
// registered later in this file.
import { mountDiscoveryRoutes } from "./routes/well-known";
mountDiscoveryRoutes(app);

app.use(rateLimit(200, 60_000));
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
    service: "Palmyr",
    version: getVersion().version,
    status: "operational",
    docs: "https://github.com/0xArtex/Palmyr",
    services: ["phone", "email", "domains", "compute", "apikeys", "agents", "messages", "stats", "activity"],
  });

});
import healthRouter from "./routes/health"; app.use("/health", healthRouter);

// ── Version endpoint ─────────────────────────────────────────
app.get("/version", (_req, res) => {
  res.json(getVersion());

});
// ── TikTok connect QR hand-off page (public, unauthenticated) ──
// A human opens /connect/<token> to scan the login QR an agent forwarded them.
import { getQr, renderQrPage, renderExpiredPage } from "./services/qr-handoff";
app.get("/connect/:token", (req, res) => {
  const dataUrl = getQr(req.params.token);
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.status(dataUrl ? 200 : 404).send(dataUrl ? renderQrPage(dataUrl) : renderExpiredPage());
});

// ── API Documentation ─────────────────────────────────────────
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ── Dashboard session resolution (global) ────────────────────
import { resolveDashboardSession } from "./middleware/dashboard-session";
app.use(resolveDashboardSession as any);

// ── Routes ────────────────────────────────────────────────────
app.use("/phone", phoneRoutes);
app.use("/email", emailRoutes);
app.use("/social", socialRoutes);
app.use("/x", xAccountRoutes);
app.use("/skills", skillsRoutes);
app.use("/domains", domainRoutes);
app.use("/compute", computeRoutes);
import transfersRoutes from "./routes/transfers";
app.use("/transfers", transfersRoutes);
import agentChatRoutes from "./routes/agent-chat";
app.use("/chat", agentChatRoutes);
import discoveryRoutes from "./routes/discovery";
app.use("/api/discovery", discoveryRoutes);
// /discover (legacy server-rendered HTML) → /discovery (new React-built SPA).
app.get("/discover", (_req, res) => res.redirect(301, "/discovery"));
app.get("/discovery", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "discovery", "index.html"))
);
import provisionRoutes from "./routes/provision";
app.use("/provision", provisionRoutes);
// wallet routes proxied to port 3002 (see above, before timeout middleware)
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

// ── Opt-in CLI telemetry (free, no auth) ─────────────────────
app.use("/telemetry", telemetryRoutes);

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
    networks: ["solana", "base"],
    auth: "Your wallet is your identity. Pay via x402 — your wallet address owns the resource.",
    services: {
      phone: {
        // Source of truth: src/routes/phone.ts requireAuth(price, ...) calls.
        // Ordered roughly by the CLI subcommand grouping (search → number ops →
        // call ops). Keep in sync when route prices change — agents read this
        // endpoint for the canonical per-op price list.
        search_numbers: "0.00",
        list_numbers: "0.01",
        provision_number: "3.00",
        release_number: "0.01",
        read_messages: "0.02",
        send_sms: "0.05",
        place_call: "0.10",
        list_calls: "0.02",
        call_info: "0.02",
        speak_tts: "0.08",
        play_audio: "0.08",
        send_dtmf: "0.02",
        gather_input: "0.08",
        record_call: "0.10",
        record_stop: "0.02",
        hangup: "0.02",
        answer_inbound: "0.02",
        transfer_call: "0.10",
      },
      email: {
        create_inbox: "2.00",
        read_messages: "0.02",
        send_email: "0.08",
        list_threads: "0.02",
        thread_messages: "0.02",
        download_attachment: "0.02",
        register_webhook: "0.02",
        encryption: "E2E (NaCl box — server cannot read)",
      },
      compute: {
        create_server: "8.00-40.00",
        server_actions: "0.10",
        resize_server: "0.10",
        delete_server: "0.10",
      },
      domains: {
        register: "dynamic (25% markup)",
        check_availability: "free",
        pricing: "free",
        dns_management: "free",
      },
      wallet: {
        create: "free",
        import: "free",
        sign: "free",
        "sign-message": "free",
        "sign-typed": "free",
        "api-key": "free",
        note: "OWS-backed non-custodial wallet. 10 chain families, policy engine, EIP-712.",
      },
    },
    treasury: {
      solana: "B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3",
      base: "0x7fA8aC4b42fd0C97ca983Bc73135EdbeA5bD6ab2",
    },
    docs: "https://palmyr.ai/skill.md",
  });

});
// ── Skill documentation for agents ───────────────────────────
// Previously a 35-byte broken stub at public/skill.md was intercepting this
// route via express.static — agents fetching palmyr.ai/skill.md got a path
// string instead of the actual skill. Stub removed; handler now actually runs.
app.get("/skill.md", (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const skillPath = path.join(__dirname, '..', 'skills', 'palmyr', 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    res.status(404).send('# skill.md not found');
    return;
  }
  // Log who's pulling the skill — agent attribution for marketing. Never
  // blocks the response on failure.
  try {
    const ua = (req.headers['user-agent'] as string | undefined) || null;
    const rawReferer = req.headers['referer'] || req.headers['referrer'] || null;
    const referer = Array.isArray(rawReferer) ? rawReferer[0] : (rawReferer as string | null);
    db.prepare(
      `INSERT INTO skill_fetches (source, user_agent, agent_kind, referer)
       VALUES (?, ?, ?, ?)`
    ).run(
      'skill.md',
      ua ? ua.slice(0, 512) : null,
      classifyAgent(ua),
      referer ? referer.slice(0, 512) : null,
    );
  } catch {}
  res.setHeader('Content-Type', 'text/markdown');
  res.send(fs.readFileSync(skillPath, 'utf-8'));
});
// ── Stream Overlay Stats ──────────────────────────────────────
app.get("/overlay-stats", async (_req, res) => {
  // Read current task from a file (updated externally)
  let task = "Shipping Palmyr features...";
  let commits = 0;
  try {
    const fs = await import("fs");
    const taskFile = path.join(DATA_DIR, "overlay.json");
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
    const taskFile = path.join(DATA_DIR, "overlay.json");
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
    name: "Palmyr",
    tagline: "The operating system for autonomous AI agents",
    problem: "Every agent team rebuilds the same infra. Weeks wasted on plumbing.",
    solution: "One API call = full infra stack, paid in USDC on Solana.",
    traction: { endpoints: "121+", forum_comments: "495+", partners: 11 },
    differentiators: ["x402 payments", "Framework-agnostic", "Sub-second provisioning", "Security-first"],
    vision: "The AWS for the agent economy.",
    links: { api: "http://77.42.89.233:3001", docs: "http://77.42.89.233:3001/docs", github: "https://github.com/0xArtex/Palmyr" }
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
// /api/wallet → same wallet routes
app.use("/api/wallet", walletRoutes);
app.use("/api/wallet", walletPasskeyRoutes);
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
import { seedPalmyrPrimitives } from "./services/i402-providers";
import { ensureProviderEmbeddings, embeddingsAvailable } from "./services/i402-embeddings";
import { refreshFederatedCatalogs } from "./services/i402-agentic-market";
import { refreshHcloudTypes } from "./services/hcloud-types";

async function refreshI402Federations(): Promise<void> {
  try {
    const results = await refreshFederatedCatalogs();
    for (const r of results) {
      console.log(
        `[i402] ingested ${r.source}: ${r.registered} registered, ${r.skipped_unknown_capability} skipped, ${r.errors.length} errors (of ${r.fetched} fetched)`
      );
      for (const err of r.errors.slice(0, 3)) console.warn(`   ⚠ ${err}`);
    }
  } catch (err: any) {
    console.warn("[i402] federated catalog refresh failed:", err?.message ?? err);
  }
}

app.listen(config.port, () => {
  startDepositMonitor();
  seedPalmyrPrimitives();
  // Server-side social-post scheduler — polls scheduled_social_posts and
  // fires due items via the same internal post functions used by the
  // direct-post routes. Disable with SOCIAL_SCHEDULER_DISABLED=1.
  void import("./services/social-scheduler").then(m => m.startSocialScheduler());
  // Pull live Hetzner server-type catalog so we never hardcode types that
  // get deprecated. Background refresh; falls back to a tiny static list if
  // the API is unreachable at boot.
  refreshHcloudTypes().catch(err =>
    console.warn("[hcloud-types] initial refresh failed:", err?.message ?? err)
  );
  if (embeddingsAvailable()) {
    // Non-blocking: compute any missing provider embeddings in the background.
    ensureProviderEmbeddings().catch(err =>
      console.warn("[i402] provider embedding ensure failed:", err?.message ?? err)
    );
  }
  // Initial federation pull + periodic refresh. Errors never crash the server.
  refreshI402Federations();
  const refreshMinutes = parseInt(process.env.I402_AGENTIC_MARKET_REFRESH_MINUTES ?? "60", 10);
  if (refreshMinutes > 0 && process.env.I402_AGENTIC_MARKET_CATALOG_URL) {
    setInterval(refreshI402Federations, refreshMinutes * 60 * 1000).unref();
  }
  console.log(`⚡ Palmyr running on port ${config.port}`);
  console.log(`   Treasury: ${config.treasuryWallet}`);
  console.log(`   Network:  Solana (${config.solanaRpcUrl})`);
  console.log(`   Email:    *@${config.emailDomain}`);
  console.log(`   i402:     reference implementation wired at /chat`);
});
export default app;
app.use(builderStatusRouter);

import builderStatsRoute from "./routes/builder-stats";app.use("/api/builder-stats", builderStatsRoute);
