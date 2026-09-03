// MUST be first: normalizes DATABASE_URL SSL mode before any pool/PostgresStore
// is constructed. See src/utils/normalizeDatabaseUrl.ts for the rationale.
import "../utils/normalizeDatabaseUrl";

// Installed as early as possible: an unhandled promise rejection anywhere in
// the process is fatal by default, and on a single-instance deployment that
// means every user of every module gets 500s for the next 30-60 seconds.
// Logs and keeps the server alive. See src/utils/processSafetyNet.ts.
import { installProcessSafetyNet } from "../utils/processSafetyNet";
installProcessSafetyNet();

import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";

import { sharedPostgresStorage } from "./storage";
import { registerCronTrigger } from "../triggers/cronTriggers";
import { registerSlackConsultantRatingRoutes } from "../triggers/slackConsultantRatingTrigger";
import { registerGrqAssistantSlackRoutes } from "../triggers/grqAssistantSlackChat";
import { qualitySpecialistAgent } from "./agents/qualitySpecialistAgent";
import { qmsConsultantAgent } from "./agents/qmsConsultantAgent";
import { duplicateResolutionAgent } from "./agents/duplicateResolutionAgent";
import { qualityAuditWorkflow } from "./workflows/qualityAuditWorkflow";
import { duplicateResolutionWorkflow } from "./workflows/duplicateResolutionWorkflow";
// Side-effect import: registers the gated "duplicate-resolution" execute tool in
// the approval registry so approving a queued cluster actually applies it.
import "./tools/duplicateResolutionExecuteTool";

import { evaluateSdrGovernanceTool } from "./tools/sdrGovernanceTool";
import { reconcileCallTool } from "./tools/callReconciliationTool";
import { matchLeadByPhoneTool } from "./tools/leadPhoneMatchTool";
import { driveCallImportTool } from "./tools/driveCallImportTool";
import { checkCommunicationEligibilityTool } from "./tools/checkCommunicationEligibilityTool";
import { getCallImportSourcesTool } from "./tools/getCallImportSourcesTool";

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
import { mcpCallEvaluationRoutes } from "./routes/mcpCallEvaluationRoutes";
import { roiRoutes } from "./routes/roiRoutes";
import { teamRoutes } from "./routes/teamRoutes";
import { pmpRoutes } from "./routes/pmpRoutes";
import { eventLogsRoutes } from "./routes/eventLogsRoutes";
import { onboardingRoutes } from "./routes/onboardingRoutes";
import { riskRoutes } from "./routes/riskRoutes";
import { policyRoutes } from "./routes/policyRoutes";
import { complianceRoutes } from "./routes/complianceRoutes";
import { certificationMilestoneRoutes } from "./routes/certificationMilestoneRoutes";
import { obligationDocumentsRoutes } from "./routes/obligationDocumentsRoutes";
import { fraudRoutes } from "./routes/fraudRoutes";
import { auditRoutes } from "./routes/auditRoutes";
import { vendorRoutes } from "./routes/vendorRoutes";
import { migrationRoutes } from "./routes/migrationRoutes";
import { handoffRoutes } from "./routes/handoffRoutes";
import { handoffTaskRoutes } from "./routes/handoffTaskRoutes";
import { techRequestRoutes } from "./routes/techRequestRoutes";
import { kpiRoutes } from "./routes/kpiRoutes";
import { leadershipFeedRoutes } from "./routes/leadershipFeedRoutes";
import { documentationTrackerRoutes } from "./routes/documentationTrackerRoutes";
import { northStarSourceRoutes } from "./routes/northStarSourceRoutes";
import { kpiCatalogRoutes } from "./routes/kpiCatalogRoutes";
import { duplicateRadarRoutes } from "./routes/duplicateRadarRoutes";
import { zohoAgingRoutes } from "./routes/zohoAgingRoutes";
import { zohoActivitiesRoutes } from "./routes/zohoActivitiesRoutes";
import { zohoTasksRoutes } from "./routes/zohoTasksRoutes";
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
import { qualityReportsRoutes } from "./routes/qualityReportsRoutes";
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
import { assertRateLimitEnabledInProductionOrThrow } from "../utils/rateLimiter";
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

// ─── Rate-limit kill-switch prod guard ────────────────────────────────────────
// RATE_LIMIT_DISABLED is a development-only escape hatch (used on Replit dev
// where typing demo flows trips the per-IP limits). If it survives into a
// production deploy via a forgotten env var, the entire HTTP rate limiter
// falls open and the platform has no DoS / brute-force protection. Fail boot
// loudly instead so the deploy is rolled back rather than running unprotected.
assertRateLimitEnabledInProductionOrThrow();

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

// Autonomous Duplicate Resolution — every 6 hours, 30 min AFTER the
// duplicate-radar auto-sync (`0 */6 * * *`) so it works on fresh clusters.
// Gated internally by AUTONOMOUS_RESOLUTION_ENABLED / _MODE (default: shadow,
// writes nothing). See src/utils/duplicateResolutionRunner.ts.
registerCronTrigger({
  cronExpression:
    process.env.AUTONOMOUS_RESOLUTION_CRON_EXPRESSION || "30 */6 * * *",
  workflow: duplicateResolutionWorkflow,
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
  workflows: { qualityAuditWorkflow, duplicateResolutionWorkflow },
  agents: { qualitySpecialistAgent, qmsConsultantAgent, duplicateResolutionAgent },
  mcpServers: {
    allTools: new MCPServer({
      name: "allTools",
      version: "1.0.0",
      // Tool keys MUST match each tool's own `id` field. The previous
      // shorthand `{ evaluateSdrGovernanceTool, ... }` registered every
      // tool under its JavaScript VARIABLE name (camelCase + "Tool"
      // suffix), so external MCP clients (Cursor / Claude Desktop /
      // Windsurf) calling `tools/call` with the documented id
      // ("evaluate-sdr-governance") received "Unknown tool". Inside
      // Mastra's own agent runtime the calls worked because agents
      // dispatch on the tool object directly without going through
      // the MCP protocol surface — which is exactly why this bug went
      // unnoticed until tests/mcpProtocol.test.ts started driving the
      // server through the wire-level lifecycle.
      tools: {
        "evaluate-sdr-governance": evaluateSdrGovernanceTool,
        "reconcile-call": reconcileCallTool,
        "match-lead-by-phone": matchLeadByPhoneTool,
        "drive-call-import": driveCallImportTool,
        "check-communication-eligibility": checkCommunicationEligibilityTool,
        "get-import-sources": getCallImportSourcesTool,
      },
    }),
  },
  bundler: {
    externals: [
      // zod MUST be externalized so the generated bundle manifest installs a
      // single shared zod (the workspace ^3.25.76) that BOTH the app schemas
      // and @mastra/core resolve to. Mastra packages declare
      // `zod: "^3.25.0 || ^4.0.0"`, so if zod is bundled (not external) the
      // bundle's fresh `npm install` pulls a SEPARATE zod v4 for @mastra/core
      // while the schemas were compiled against v3 — @mastra/core then calls
      // zod v4 `toJSONSchema()` on v3 schemas (`schema._zod` undefined) and
      // crash-loops on startup, failing the deploy health check. Dev avoids
      // this only because everything dedupes to the workspace zod 3.25.76.
      "zod",
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
      "pg-query-stream",
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
    host: "<REDACTED_IP>",
    // MUST honour the platform-assigned PORT. Replit Autoscale gives each
    // deployment a dynamic port and health-checks THAT port; a hardcoded 5000
    // meant the container listened on 5000 while the prober hit e.g.
    // <REDACTED_IP>:1104 -> "dial tcp <REDACTED_IP>:1104: connect: connection refused"
    // -> healthcheck fails -> promote aborts, even though the build succeeded
    // and the app was running fine. Falls back to 5000 so local dev and the
    // `[env] PORT = "5000"` / `localPort = 5000` mapping in .replit behave
    // exactly as before.
    port: Number(process.env.PORT) || 5000,
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
      ...mcpCallEvaluationRoutes,
      ...roiRoutes,
      ...teamRoutes,
      ...pmpRoutes,
      ...eventLogsRoutes,
      ...onboardingRoutes,
      ...riskRoutes,
      ...policyRoutes,
      ...complianceRoutes,
      ...certificationMilestoneRoutes,
      ...obligationDocumentsRoutes,
      ...fraudRoutes,
      ...auditRoutes,
      ...infographicRoutes,
      ...vendorRoutes,
      ...migrationRoutes,
      ...handoffRoutes,
      ...handoffTaskRoutes,
      ...techRequestRoutes,
      // ── Leadership KPI feed (registered BEFORE kpiRoutes so the literal
      //     `/api/kpis/leadership-feed` is matched before the dynamic
      //     `/api/kpis/:id` handlers). Pulled by the ExampleOrg Leadership
      //     Platform; self-authenticates via the X-Feed-Key header. ──────────
      ...leadershipFeedRoutes,
      ...documentationTrackerRoutes,
      ...northStarSourceRoutes,
      ...kpiCatalogRoutes,
      ...kpiRoutes,
      ...duplicateRadarRoutes,
      ...zohoAgingRoutes,
      ...zohoActivitiesRoutes,
      ...zohoTasksRoutes,
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
      ...qualityReportsRoutes,
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
      // Two-way GRQ Assistant chat over Slack (@mention / "GRQ …" / DM → reply).
      ...registerGrqAssistantSlackRoutes(),
    ],
  },
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({ name: "Mastra", level: "info" })
      : new PinoLogger({ name: "Mastra", level: "info" }),
});

/*  Sanity check 1: ExampleOrg runs 2 workflows by design — qualityAuditWorkflow
    (cron: weekly quality audit) and duplicateResolutionWorkflow (cron: 6-hourly
    duplicate radar resolution). Each is driven by its own cron trigger and
    invoked via REST/cron, NOT the Mastra playground UI. The original guard below
    only protected the dev-only playground UI (which can show inconsistent state
    with >1 workflow); it does not apply to this deployment and was crashing both
    dev and production on boot. Guard intentionally disabled — same rationale as
    Sanity check 2 for agents. Do NOT re-enable without first removing one of the
    by-design workflows above.

    if (Object.keys(mastra.getWorkflows()).length > 1) {
      throw new Error("More than 1 workflows found ...");
    }
*/

/*  Sanity check 2: ExampleOrg runs 2 agents (qualitySpecialistAgent + qmsConsultantAgent) by design.
    The Mastra UI single-agent assumption does not apply here — agents are invoked via REST routes,
    not the playground UI. Guard intentionally disabled. */

/*  Cache pre-warmer
    Eliminates the 60-80s cold-start wait on /api/agents/performance and /api/dashboard/layouts-breakdown
    by hitting them in the background shortly after boot, then re-warming every 13 minutes
    (just before the 15-minute TTL expires). Failures are logged but never crash the process.
*/
(function startCacheWarmer() {
  // Operator escape hatch — set DISABLE_CACHE_WARMER=true on a
  // resource-tight host to skip the background pre-warm entirely.
  // The warmer hits /api/agents/performance and
  // /api/dashboard/layouts-breakdown every 15 minutes, which is
  // helpful on a long-lived deploy but wasteful on a tight one
  // where the first user request can cold-fill the cache instead.
  if (
    String(process.env.DISABLE_CACHE_WARMER || "").toLowerCase() === "true"
  ) {
    safeLogger.info("⏭️  [CacheWarmer] disabled via DISABLE_CACHE_WARMER");
    return;
  }
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
          const res = await fetch(`<REDACTED_URL>`, {
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
  // Operator escape hatch — set DISABLE_SCHEDULED_JOB_FALLBACK=true on a
  // memory-tight host to skip the in-process cron fallback entirely. Each
  // helper fans out parallel Zoho fetches (DuplicateRadar + QualityAudit +
  // ConsultantScanner all pull 6 modules × CONCURRENCY=4 pages × 200
  // records, ~600MB+ resident at peak) which can OOM-kill the process.
  // When Inngest is wired up in front of this service, the fallback is
  // redundant anyway.
  if (
    String(process.env.DISABLE_SCHEDULED_JOB_FALLBACK || "").toLowerCase() ===
    "true"
  ) {
    safeLogger.info(
      "⏭️  [ScheduledJobFallback] disabled via DISABLE_SCHEDULED_JOB_FALLBACK",
    );
    return;
  }
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
        runCsOverlapScanIfStale,
        runDeletionFeedSweepIfStale,
        runAutonomousResolutionIfStale,
        runResolutionDigestIfDue,
        runWeeklyExecBriefIfDue,
        runLeadershipPushIfDue,
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
        { name: "CsOverlapScan", fn: () => runCsOverlapScanIfStale() },
        // Deletion-feed sweep — sync-independent (~every 3h). Prunes records
        // Zoho deleted from the mirror + pending-delete ledger, so stuck syncs
        // no longer leave deleted data lingering (Sample User 2026-07-23).
        { name: "DeletionFeedSweep", fn: () => runDeletionFeedSweepIfStale() },
        // Deal document compliance — a rolling slice of Zoho attachment checks
        // every tick, so the Deal Compliance tab reads stored results instead
        // of making the operator's browser do hundreds of live calls
        // (Sample User 2026-08-25). Disable with DEAL_DOC_SWEEP_ENABLED=false.
        // Monthly missing-documents report to the Head of Sales. Off unless
        // MISSING_DOCS_REPORT_ENABLED=true; sends once per month, enforced by
        // a primary key rather than an in-memory stamp.
        {
          name: "MissingDocsMonthlyReport",
          fn: async () => {
            const { runMonthlyMissingDocsReportIfDue } = await import(
              "../utils/scheduledJobs"
            );
            return runMonthlyMissingDocsReportIfDue();
          },
        },
        {
          name: "DealDocComplianceSweep",
          fn: async () => {
            const { runDealDocComplianceSweepIfDue } = await import(
              "../utils/scheduledJobs"
            );
            return runDealDocComplianceSweepIfDue();
          },
        },
        // Autonomous Duplicate Resolution — 6h fallback. Internally gated by
        // AUTONOMOUS_RESOLUTION_ENABLED/_MODE (default shadow → no Zoho writes).
        { name: "AutonomousResolution", fn: () => runAutonomousResolutionIfStale() },
        // Twice-daily apply digest (09:00 / 17:00 KSA). No-ops outside those windows.
        { name: "ResolutionDigest", fn: () => runResolutionDigestIfDue() },
        // Weekly leadership exec brief (Sunday 06:00 KSA). No-ops otherwise.
        { name: "ExecBriefWeekly", fn: () => runWeeklyExecBriefIfDue() },
        // Weekly push of KPI values to the Leadership Platform webhook — Thursday
        // 06:00-09:00 KSA, once/week. No-op unless PLATFORM_WEBHOOK_URL +
        // WEBHOOK_SECRET are set.
        { name: "LeadershipPushWeekly", fn: () => runLeadershipPushIfDue() },
        // Daily overdue reminders (Handoff Tracker + Tech Requests). Window-gated
        // to 07:00-09:59 KSA; per-row 20h stamp stops the 45-min loop re-sending.
        {
          name: "OverdueReminders",
          fn: async () => {
            const { runOverdueRemindersIfDue } = await import(
              "../utils/overdueReminders"
            );
            return runOverdueRemindersIfDue();
          },
        },
        // Documentation-collector dead-man's switch. Runs on EVERY tick (no
        // time window): a collector can die at any hour, and the 90-minute
        // "silent" threshold would be meaningless if only checked once a day.
        // The per-collector 20h alert stamp is what stops the loop re-sending.
        // A tracker that has quietly stopped updating is worse than no tracker,
        // because it is trusted.
        {
          name: "DocTrackerHealth",
          fn: async () => {
            const { runCollectorHealthCheckIfDue } = await import(
              "../utils/docTrackerStaleness"
            );
            return runCollectorHealthCheckIfDue();
          },
        },
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
