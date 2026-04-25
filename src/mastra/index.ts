import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";

import { sharedPostgresStorage } from "./storage";
import { registerCronTrigger } from "../triggers/cronTriggers";
import { qualitySpecialistAgent } from "./agents/qualitySpecialistAgent";
import { qmsConsultantAgent } from "./agents/qmsConsultantAgent";
import { qualityAuditWorkflow } from "./workflows/qualityAuditWorkflow";

import { globalMiddleware } from "./middleware";
import { dashboardApiRoutes } from "./routes/dashboardApiRoutes";
import { adminApiRoutes } from "./routes/adminApiRoutes";
import { qmsApiRoutes } from "./routes/qmsApiRoutes";
import { sandboxApiRoutes } from "./routes/sandboxApiRoutes";
import { tablefApiRoutes } from "./routes/tablefApiRoutes";
import { feedbackApiRoutes } from "./routes/feedbackApiRoutes";
import { sopRoutes } from "./routes/sopRoutes";
import { staticPageRoutes } from "./routes/staticPageRoutes";
import { staticAssetRoutes } from "./routes/staticAssetRoutes";

import { authRoutes } from "./routes/authRoutes";
import { callIntelligenceRoutes } from "./routes/callIntelligenceRoutes";
import { roiRoutes } from "./routes/roiRoutes";
import { teamRoutes } from "./routes/teamRoutes";
import { pmpRoutes } from "./routes/pmpRoutes";
import { eventLogsRoutes } from "./routes/eventLogsRoutes";
import { onboardingRoutes } from "./routes/onboardingRoutes";
import { riskRoutes } from "./routes/riskRoutes";
import { policyRoutes } from "./routes/policyRoutes";
import { complianceRoutes } from "./routes/complianceRoutes";
import { auditRoutes } from "./routes/auditRoutes";
import { vendorRoutes } from "./routes/vendorRoutes";
import { migrationRoutes } from "./routes/migrationRoutes";
import { handoffRoutes } from "./routes/handoffRoutes";
import { kpiRoutes } from "./routes/kpiRoutes";
import { duplicateRadarRoutes } from "./routes/duplicateRadarRoutes";
import { infographicRoutes } from "./routes/infographicRoutes";
import { rbacRoutes } from "./routes/rbacRoutes";
import { scorecardRoutes } from "./routes/scorecardRoutes";
import { pdplRoutes } from "./routes/pdplRoutes";
import { triggerRoutes } from "./routes/triggerRoutes";
import { auditProgrammeRoutes } from "./routes/auditProgrammeRoutes";
import { manualAuditRoutes } from "./routes/manualAuditRoutes";
import { externalAuditRoutes } from "./routes/externalAuditRoutes";
import { userAccessRoutes } from "./routes/userAccessRoutes";
import { smokeTestRoutes } from "./routes/smokeTestRoutes";
import { consultantRoutes } from "./routes/consultantRoutes";
import { aiApprovalRoutes } from "./routes/aiApprovalRoutes";
import { aiOpsRoutes } from "./routes/aiOpsRoutes";
import { qmsEnhancedRoutes } from "./routes/qmsEnhancedRoutes";
import { notificationRoutes } from "./routes/notificationRoutes";
import { knowledgeRoutes } from "./routes/knowledgeRoutes";
import { reportRoutes } from "./routes/reportRoutes";
import { managementReviewRoutes } from "./routes/managementReviewRoutes";
import { analyticsRoutes } from "./routes/analyticsRoutes";
import { healthPulseRoutes } from "./routes/healthPulseRoutes";
import { a11yRoutes } from "./routes/a11yRoutes";
import { i18nRoutes } from "./routes/i18nRoutes";
import { onBootRedactionSweep } from "../utils/redactHistoricalLogs";
import { exportDownloadRoutes } from "./routes/exportDownloadRoutes";

registerCronTrigger({
  cronExpression: process.env.SCHEDULE_CRON_EXPRESSION || "0 8 * * 1",
  workflow: qualityAuditWorkflow,
});

class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;

  constructor(options: { name?: string; level?: LogLevel } = {}) {
    super(options);
    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: { level: (label: string, _number: number) => ({ level: label }) },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void { this.logger.debug(args, message); }
  info(message: string, args: Record<string, any> = {}): void { this.logger.info(args, message); }
  warn(message: string, args: Record<string, any> = {}): void { this.logger.warn(args, message); }
  error(message: string, args: Record<string, any> = {}): void { this.logger.error(args, message); }
}

export const mastra = new Mastra({
  storage: sharedPostgresStorage,
  workflows: { qualityAuditWorkflow },
  agents: { qualitySpecialistAgent, qmsConsultantAgent },
  mcpServers: {
    allTools: new MCPServer({
      name: "allTools",
      version: "1.0.0",
      tools: {},
    }),
  },
  bundler: {
    externals: ["@slack/web-api", "inngest", "inngest/hono", "hono", "hono/streaming"],
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    cors: false,
    middleware: globalMiddleware,
    apiRoutes: [
      // ── Dashboard & Core API ──────────────────────────────────────────────
      ...dashboardApiRoutes,

      // ── Auth ─────────────────────────────────────────────────────────────
      ...authRoutes,

      // ── Admin API ────────────────────────────────────────────────────────
      ...adminApiRoutes,

      // ── QMS API ──────────────────────────────────────────────────────────
      ...qmsApiRoutes,

      // ── Sandbox/Testing API ──────────────────────────────────────────────
      ...sandboxApiRoutes,

      // ── Table F Governance ───────────────────────────────────────────────
      ...tablefApiRoutes,

      // ── Feedback API ─────────────────────────────────────────────────────
      ...feedbackApiRoutes,

      // ── SOP API & Page ───────────────────────────────────────────────────
      ...sopRoutes,

      // ── Module-specific routes (already in separate files) ────────────────
      ...callIntelligenceRoutes,
      ...roiRoutes,
      ...teamRoutes,
      ...pmpRoutes,
      ...eventLogsRoutes,
      ...onboardingRoutes,
      ...riskRoutes,
      ...policyRoutes,
      ...complianceRoutes,
      ...auditRoutes,
      ...infographicRoutes,
      ...vendorRoutes,
      ...migrationRoutes,
      ...handoffRoutes,
      ...kpiRoutes,
      ...duplicateRadarRoutes,
      ...rbacRoutes,
      ...scorecardRoutes,
      ...pdplRoutes,
      ...triggerRoutes,
      ...auditProgrammeRoutes,
      ...manualAuditRoutes,
      ...externalAuditRoutes,
      ...userAccessRoutes,
      ...smokeTestRoutes,
      ...consultantRoutes,
      ...aiApprovalRoutes,
      ...aiOpsRoutes,
      ...qmsEnhancedRoutes,
      ...notificationRoutes,
      ...knowledgeRoutes,
      ...reportRoutes,
      ...managementReviewRoutes,
      ...analyticsRoutes,
      ...healthPulseRoutes,

      // ── Export / Recent-downloads sync ───────────────────────────────────
      ...exportDownloadRoutes,

      // ── Accessibility ─────────────────────────────────────────────────────
      ...a11yRoutes,

      // ── HTML Page Shells ─────────────────────────────────────────────────
      ...staticPageRoutes,

      // ── Static Assets (CSS / JS) ──────────────────────────────────────────
      ...staticAssetRoutes,

      // ── i18n / Language API ──────────────────────────────────────────────
      ...i18nRoutes,
    ],
  },
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({ name: "Mastra", level: "info" })
      : new PinoLogger({ name: "Mastra", level: "info" }),
});

/*  Sanity check 1: Throw an error if there are more than 1 workflows.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getWorkflows()).length > 1) {
  throw new Error(
    "More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}

/*  Sanity check 2: WalaPlus runs 2 agents (qualitySpecialistAgent + qmsConsultantAgent) by design.
    The Mastra UI single-agent assumption does not apply here — agents are invoked via REST routes,
    not the playground UI. Guard intentionally disabled. */

/*  Cache pre-warmer
    Eliminates the 60-80s cold-start wait on /api/agents/performance and /api/dashboard/layouts-breakdown
    by hitting them in the background shortly after boot, then re-warming every 13 minutes
    (just before the 15-minute TTL expires). Failures are logged but never crash the process.
*/
(function startCacheWarmer() {
  const g = globalThis as any;
  if (g.__walaplus_cacheWarmer) {
    clearTimeout(g.__walaplus_cacheWarmer.startTimer);
    clearInterval(g.__walaplus_cacheWarmer.refreshTimer);
  }
  const port = process.env.PORT || "5000";
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.log("⏭️  [CacheWarmer] ADMIN_API_KEY not set — skipping cache pre-warm");
    return;
  }
  const endpoints = ["/api/agents/performance", "/api/dashboard/layouts-breakdown"];
  const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
  let inflight = false;
  const warm = async () => {
    if (inflight) {
      console.log("⏭️  [CacheWarmer] Previous warm still running — skipping this cycle");
      return;
    }
    inflight = true;
    try {
      for (const ep of endpoints) {
        const t0 = Date.now();
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(`http://localhost:${port}${ep}`, {
            headers: { "X-Admin-Key": adminKey },
            signal: ctrl.signal,
          });
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          if (res.ok) {
            console.log(`🔥 [CacheWarmer] Warmed ${ep} in ${dt}s (status ${res.status})`);
          } else {
            console.warn(`⚠️  [CacheWarmer] ${ep} returned ${res.status} in ${dt}s`);
          }
        } catch (err: any) {
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          const reason = err?.name === "AbortError" ? "timeout" : (err?.message || err);
          console.warn(`⚠️  [CacheWarmer] Failed to warm ${ep} after ${dt}s:`, reason);
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } finally {
      inflight = false;
    }
  };
  const startTimer = setTimeout(() => {
    console.log("🔥 [CacheWarmer] Starting initial cache warm...");
    warm();
  }, 30 * 1000);
  const refreshTimer = setInterval(warm, 13 * 60 * 1000);
  g.__walaplus_cacheWarmer = { startTimer, refreshTimer };
})();

/*  On-boot redaction sweep
    Automatically redacts any sensitive data that may have re-appeared in
    event_logs, nc_change_history, capa_change_history, or ai_pending_actions
    as a result of a database restore from a pre-fix backup.

    The sweep is idempotent (rows already clean are skipped), runs in the
    background (never delays the server from accepting requests), and writes
    its results to audit-evidence/last-sweep.json for operator visibility.
*/
(function startBootRedactionSweep() {
  if (process.env.DATABASE_URL) {
    setTimeout(() => {
      onBootRedactionSweep().catch(err => {
        console.error("[Redaction] Unexpected error in boot sweep wrapper:", err);
      });
    }, 5 * 1000);
  } else {
    console.log("[Redaction] DATABASE_URL not set — boot redaction sweep skipped");
  }
})();
