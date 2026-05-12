import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";

import { sharedPostgresStorage } from "./storage";
import { registerCronTrigger } from "../triggers/cronTriggers";
import { registerSlackConsultantRatingRoutes } from "../triggers/slackConsultantRatingTrigger";
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
import { obligationDocumentsRoutes } from "./routes/obligationDocumentsRoutes";
import { fraudRoutes } from "./routes/fraudRoutes";
import { auditRoutes } from "./routes/auditRoutes";
import { vendorRoutes } from "./routes/vendorRoutes";
import { migrationRoutes } from "./routes/migrationRoutes";
import { handoffRoutes } from "./routes/handoffRoutes";
import { kpiRoutes } from "./routes/kpiRoutes";
import { duplicateRadarRoutes } from "./routes/duplicateRadarRoutes";
import { zohoAgingRoutes } from "./routes/zohoAgingRoutes";
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
import { mobileRoutes } from "./routes/mobileRoutes";
import { aiApprovalRoutes } from "./routes/aiApprovalRoutes";
import "../utils/integrationTestFixtureTools";
import { aiOpsRoutes } from "./routes/aiOpsRoutes";
import { qmsEnhancedRoutes } from "./routes/qmsEnhancedRoutes";
import { qmsDocsRoutes } from "./routes/qmsDocsRoutes";
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
import { assertAdminApiKeyStrengthOrThrow } from "../utils/rbacMiddleware";
import {
  lockDownStagedExportCacheDirAtStartup,
  checkStagedExportCacheLocation,
} from "../utils/excelExport";

import { logger as safeLogger } from "../utils/logger";
// ─── ADMIN_API_KEY strength gate ──────────────────────────────────────────────
// Runs *before* `new Mastra({...})` below registers any `/api/admin/*` route,
// so a weak rotation value (e.g. "admin123") aborts startup instead of quietly
// downgrading admin authentication. See docs/Security_Operations_SOP.md §5.7
// for the rotation procedure and the enforced minimum (length ≥ 32, distinct
// chars ≥ 10). No-op when ADMIN_API_KEY is unset — the "Setup Required" page
// flow handles the unconfigured-platform case.
assertAdminApiKeyStrengthOrThrow();

// ─── Streaming-export cache directory lockdown ────────────────────────────────
// Eagerly create / re-chmod the streaming-export cache directory to mode 0o700
// at boot, before any export routes start serving traffic. Closes the window
// where an inherited cache directory from a previous run could sit on disk
// with looser permissions, and surfaces FS / permission problems immediately
// at startup instead of on the first user export. The lazy ensure inside
// stageAndServeStreamingExport remains as a safety net. Awaited at the
// top level (ESM) so the cache dir is guaranteed to be 0o700 before
// `new Mastra({...})` below registers any export route.
await lockDownStagedExportCacheDirAtStartup();

// ─── Streaming-export cache location health check (Task #770) ────────────────
// One-shot fs.stat walk over the configured STREAMING_EXPORT_CACHE_DIR's
// ancestor chain. Silent in the default `/tmp`-based single-tenant
// configuration; logs a structured warning when an operator override points
// the cache at a path with a group/other-readable parent (filenames would
// leak via parent traversal even though the leaf dir itself is 0o700). See
// docs/Security_Operations_SOP.md §5.14. Best-effort — never blocks boot.
// Runs after the lockdown above so the cache dir is materialised before the
// ancestor walk (any segments the worker created are 0o700 by construction).
void checkStagedExportCacheLocation().catch((err) => {
  safeLogger.warn(
    "[stagedExport] cache-location healthcheck threw unexpectedly",
    { err: String(err) },
  );
});

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
      formatters: {
        level: (label: string, _number: number) => ({ level: label }),
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void {
    this.logger.debug(args, message);
  }
  info(message: string, args: Record<string, any> = {}): void {
    this.logger.info(args, message);
  }
  warn(message: string, args: Record<string, any> = {}): void {
    this.logger.warn(args, message);
  }
  error(message: string, args: Record<string, any> = {}): void {
    this.logger.error(args, message);
  }
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
    externals: [
      "@mastra/core",
      "@ai-sdk/openai",
      "@openrouter/ai-sdk-provider",
      "@slack/web-api",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
      "glob",
      "fstream",
      "pg",
      "pdfkit",
      "pino",
      "resend",
      "openai",
      "exa-js",
      "xmlbuilder",
    ],
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

      // ── QMS Enhanced (registered BEFORE qmsApiRoutes & kpiRoutes so that
      //     literal export segments like `/api/qms/capa/export` and
      //     `/api/kpis/export` are matched before the dynamic `:id` handlers
      //     defined in qmsApiRoutes / kpiRoutes — see task-670).
      ...qmsEnhancedRoutes,

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
      ...obligationDocumentsRoutes,
      ...fraudRoutes,
      ...auditRoutes,
      ...infographicRoutes,
      ...vendorRoutes,
      ...migrationRoutes,
      ...handoffRoutes,
      ...kpiRoutes,
      ...duplicateRadarRoutes,
      ...zohoAgingRoutes,
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
      ...mobileRoutes,
      ...aiApprovalRoutes,
      ...aiOpsRoutes,
      // qmsEnhancedRoutes was hoisted above qmsApiRoutes — see comment there.
      ...qmsDocsRoutes,
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

      // ── Slack consultant rating bot (Task #801) ──────────────────────────
      ...registerSlackConsultantRatingRoutes(),
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
    safeLogger.info(
      "⏭️  [CacheWarmer] ADMIN_API_KEY not set — skipping cache pre-warm",
    );
    return;
  }
  const endpoints = [
    "/api/agents/performance",
    "/api/dashboard/layouts-breakdown",
  ];
  const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
  let inflight = false;
  const warm = async () => {
    if (inflight) {
      safeLogger.info(
        "⏭️  [CacheWarmer] Previous warm still running — skipping this cycle",
      );
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
            safeLogger.info(
              `🔥 [CacheWarmer] Warmed ${ep} in ${dt}s (status ${res.status})`,
            );
          } else {
            safeLogger.warn(
              `⚠️  [CacheWarmer] ${ep} returned ${res.status} in ${dt}s`,
            );
          }
        } catch (err: any) {
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          const reason =
            err?.name === "AbortError" ? "timeout" : err?.message || err;
          safeLogger.warn(
            `⚠️  [CacheWarmer] Failed to warm ${ep} after ${dt}s:`,
            reason,
          );
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } finally {
      inflight = false;
    }
  };
  const startTimer = setTimeout(() => {
    safeLogger.info("🔥 [CacheWarmer] Starting initial cache warm...");
    warm();
  }, 30 * 1000);
  const refreshTimer = setInterval(warm, 13 * 60 * 1000);
  g.__walaplus_cacheWarmer = { startTimer, refreshTimer };
})();

/*  Scheduled-job in-process fallback
    Inngest crons (defined in src/mastra/inngest/index.ts) are the primary
    drivers for the rate_limit_429 pruner, the duplicate-radar scanner, the
    AI consultant background scanner, the weekly quality audit, and the
    daily KPI auto-calc. In practice the Inngest dev server isn't always
    attached to the local dev process and production runners have
    occasionally missed cron fires — leaving stale data for days at a time.

    Each `*IfStale` helper guards itself with a freshness check, so calling
    them on a fixed interval is cheap when the Inngest cron is healthy
    (one freshness query per helper) and self-healing when it isn't.

    Concurrency: a single `inflight` flag prevents overlapping cycles in
    the rare case where one of the helpers actually has work to do and
    runs longer than the interval. Mirrors the CacheWarmer pattern above.
*/
(function startScheduledJobFallback() {
  const g = globalThis as any;
  if (g.__walaplus_scheduledJobFallback) {
    clearTimeout(g.__walaplus_scheduledJobFallback.startTimer);
    clearInterval(g.__walaplus_scheduledJobFallback.refreshTimer);
  }
  if (!process.env.DATABASE_URL) {
    safeLogger.info(
      "⏭️  [ScheduledJobFallback] DATABASE_URL not set — skipping in-process fallback",
    );
    return;
  }
  let inflight = false;
  const tick = async () => {
    if (inflight) {
      safeLogger.info(
        "⏭️  [ScheduledJobFallback] Previous cycle still running — skipping this tick",
      );
      return;
    }
    inflight = true;
    try {
      const {
        runPruneRateLimit429IfStale,
        runDuplicateScanIfStale,
        runConsultantScannerIfStale,
        runQualityAuditIfStale,
        runKPIAutoCalcIfStale,
      } = await import("../utils/scheduledJobs");
      const helpers: Array<{
        name: string;
        fn: () => Promise<{ ran: boolean; ageHours: number }>;
      }> = [
        { name: "RateLimit429Pruner", fn: () => runPruneRateLimit429IfStale() },
        { name: "DuplicateRadar", fn: () => runDuplicateScanIfStale() },
        { name: "ConsultantScanner", fn: () => runConsultantScannerIfStale() },
        { name: "QualityAudit", fn: () => runQualityAuditIfStale() },
        { name: "KPIAutoCalc", fn: () => runKPIAutoCalcIfStale() },
      ];
      for (const h of helpers) {
        try {
          const out = await h.fn();
          if (out.ran) {
            safeLogger.info(
              `⏰ [ScheduledJobFallback] ${h.name} ran (ageHours=${out.ageHours === Infinity ? "∞" : out.ageHours.toFixed(1)})`,
            );
          }
        } catch (err) {
          safeLogger.error(`[ScheduledJobFallback] ${h.name} threw:`, err);
        }
      }
    } finally {
      inflight = false;
    }
  };
  // Wrap each timer fire so a thrown helper / failed dynamic import never
  // becomes an unhandled rejection (timer callbacks don't await the promise).
  const safeTick = () => {
    tick().catch((err) => {
      safeLogger.error("[ScheduledJobFallback] Unhandled tick error:", err);
    });
  };
  // Initial tick ~60s after boot so DB pools and routes are fully ready.
  const startTimer = setTimeout(() => {
    safeLogger.info("⏰ [ScheduledJobFallback] Starting initial pass...");
    safeTick();
  }, 60 * 1000);
  // Re-check every 45 minutes (between the suggested 30–60 min cadence).
  const refreshTimer = setInterval(safeTick, 45 * 60 * 1000);
  g.__walaplus_scheduledJobFallback = { startTimer, refreshTimer };
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
      onBootRedactionSweep().catch((err) => {
        safeLogger.error(
          "[Redaction] Unexpected error in boot sweep wrapper:",
          err,
        );
      });
    }, 5 * 1000);
              } else {
    safeLogger.info(
      "[Redaction] DATABASE_URL not set — boot redaction sweep skipped",
    );
  }
})();
