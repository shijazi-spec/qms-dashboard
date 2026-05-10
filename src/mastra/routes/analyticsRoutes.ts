import "../../utils/executiveDigest";
import { logger } from "../../utils/logger";

const ANALYTICS_READ_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
] as const;
const DIGEST_SEND_ROLES = ["admin", "head_of_operations_quality"] as const;

export const analyticsRoutes = [
  {
    path: "/api/analytics/cycle-times",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for analytics data",
            );
          const { getCycleTimeMetrics } =
            await import("../../utils/analyticsEngine");
          const dateFrom = c.req.query("from") || undefined;
          const dateTo = c.req.query("to") || undefined;
          const metrics = await getCycleTimeMetrics(dateFrom, dateTo);
          return c.json(metrics);
        } catch (error) {
          return c.json({ error: "Failed to fetch cycle time metrics" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/agent-compliance",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for analytics data",
            );
          const { getAgentComplianceReports } =
            await import("../../utils/analyticsEngine");
          const reports = await getAgentComplianceReports();
          return c.json({ reports });
        } catch (error) {
          return c.json(
            { error: "Failed to fetch agent compliance reports" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/capa-recurrence",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for analytics data",
            );
          const { detectCAPARecurrence } =
            await import("../../utils/analyticsEngine");
          const recurrences = await detectCAPARecurrence();
          return c.json({ recurrences, total: recurrences.length });
        } catch (error) {
          return c.json({ error: "Failed to detect CAPA recurrence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/trends",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for analytics data",
            );
          const { getTrendData } = await import("../../utils/analyticsEngine");
          const periods = parseInt(c.req.query("periods") || "12");
          const interval =
            c.req.query("interval") === "week" ? "week" : ("month" as const);
          const trends = await getTrendData(periods, interval);
          return c.json({ trends });
        } catch (error) {
          return c.json({ error: "Failed to fetch trend data" }, 500);
        }
      };
    },
  },
  {
    path: "/api/digest/issues.xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to export digest issues",
            );

          const {
            computeDigestWindow,
            generateDigestData,
            dateLabelKsa,
            getEnterpriseGRCSnapshot,
            computeEnterpriseHealthScoreDetail,
            safeQuery,
          } = await import("../../utils/executiveDigest");
          // Buffered (in-memory) workbook path. The streaming
          // WorkbookWriter trips over an archiver-utils `isStream()`
          // check in the deployed module tree (readable-stream's
          // Duplex is not `instanceof require('stream').Stream` there),
          // failing every export with "input source must be valid
          // Stream or Buffer instance". The digest issues export is
          // tiny (≤ a few dozen finding-type rows) so we don't need
          // streaming — building the workbook in memory side-steps the
          // archiver path entirely.
          const { buildWorkbook, bufferResponseWithRange, xlsxResponseHeaders } =
            await import("../../utils/excelExport");

          const cadenceRaw = String(c.req.query("cadence") || "weekly").toLowerCase();
          const cadence =
            cadenceRaw === "monthly" || cadenceRaw === "quarterly"
              ? cadenceRaw
              : "weekly";

          const now = new Date();
          const fallbackWindow = computeDigestWindow(cadence as any, now);
          const windowStartRaw = c.req.query("windowStart");
          const windowEndRaw = c.req.query("windowEnd");
          const requestedWindow =
            windowStartRaw && windowEndRaw
              ? (() => {
                  const start = new Date(windowStartRaw);
                  const end = new Date(windowEndRaw);
                  return {
                    cadence,
                    start,
                    end,
                    // Derive the label from the actual requested range so
                    // the Period column matches Window Start/End. Falling
                    // back to the cadence's default label here was the
                    // source of the "weekly label on a quarterly export"
                    // mismatch.
                    periodLabel: `${dateLabelKsa(start)} - ${dateLabelKsa(end)}`,
                  };
                })()
              : fallbackWindow;

          // Drill-down rows (capped per sheet for export size). Ordered
          // by recency so the most relevant records surface first.
          const ROW_CAP = 200;
          const [
            data,
            snapshot,
            auditFindings,
            ncRows,
            capaRows,
            riskRows,
            kpiRowsDetail,
            complianceRows,
            qaResults,
          ] = await Promise.all([
            generateDigestData({
              cadence: cadence as any,
              now,
              window: requestedWindow as any,
            }),
            getEnterpriseGRCSnapshot(),
            safeQuery(
              `SELECT finding_number, criteria_name, dimension, severity, status,
                      owner, target_date, resolution_date, created_at
               FROM audit_findings
               ORDER BY created_at DESC NULLS LAST
               LIMIT $1`,
              [ROW_CAP],
            ),
            safeQuery(
              `SELECT nc_number, title, nc_type, severity, status, disposition,
                      detected_by, detected_date, closed_date
               FROM nonconformance_records
               ORDER BY detected_date DESC NULLS LAST
               LIMIT $1`,
              [ROW_CAP],
            ),
            safeQuery(
              `SELECT capa_number, title, type, status, priority,
                      assigned_to, department, due_date, created_at
               FROM capas
               ORDER BY created_at DESC NULLS LAST
               LIMIT $1`,
              [ROW_CAP],
            ),
            safeQuery(
              `SELECT id, risk_title, risk_category, risk_level, risk_score,
                      impact_score, likelihood_score, status,
                      risk_owner, treatment_strategy, treatment_deadline,
                      identified_date
               FROM enterprise_risks
               ORDER BY risk_score DESC NULLS LAST, identified_date DESC NULLS LAST
               LIMIT $1`,
              [ROW_CAP],
            ),
            safeQuery(
              `WITH latest AS (
                 SELECT DISTINCT ON (kpi_id)
                   kpi_id, period_start, period_end,
                   actual_value, target_value, status, trend, updated_at
                 FROM kpi_values
                 ORDER BY kpi_id, period_end DESC NULLS LAST, id DESC
               )
               SELECT * FROM latest
               ORDER BY
                 CASE LOWER(COALESCE(status,''))
                   WHEN 'red' THEN 1 WHEN 'off_track' THEN 1
                   WHEN 'amber' THEN 2 WHEN 'at_risk' THEN 2
                   ELSE 3 END,
                 updated_at DESC NULLS LAST
               LIMIT $1`,
              [ROW_CAP],
            ),
            safeQuery(
              `SELECT id, obligation_id, assessment_date, assessed_by,
                      compliance_status, score, remediation_required,
                      remediation_status, remediation_deadline, next_assessment_date
               FROM compliance_assessments
               ORDER BY assessment_date DESC NULLS LAST
               LIMIT $1`,
              [ROW_CAP],
            ),
            safeQuery(
              `SELECT audit_date, total_records_audited, total_issues_found,
                      people_score, process_score, governance_score, overall_score
               FROM quality_audit_results
               ORDER BY audit_date DESC NULLS LAST
               LIMIT 20`,
            ),
          ]);

          // Recompute health detail using the same snapshot inputs.
          const ncOpenN = snapshot.nc_summary.open;
          const ncTotalN = snapshot.nc_summary.total;
          const capaOpenN = snapshot.capa_summary.open;
          const capaTotalN = snapshot.capa_summary.total;
          const capaActionsTotal = parseInt(
            (await safeQuery(`SELECT COUNT(*) as cnt FROM capa_action_items`))[0]
              ?.cnt || "0",
            10,
          );
          const capaActionsCompleted = parseInt(
            (await safeQuery(
              `SELECT COUNT(*) as cnt FROM capa_action_items WHERE LOWER(COALESCE(status,'open')) = 'completed'`,
            ))[0]?.cnt || "0",
            10,
          );

          const detail = computeEnterpriseHealthScoreDetail({
            auditScore: snapshot.audit_score,
            auditPeople: snapshot.audit_dimensions?.people ?? null,
            auditProcess: snapshot.audit_dimensions?.process ?? null,
            auditGovernance: snapshot.audit_dimensions?.governance ?? null,
            auditRecords: snapshot.audit_records,
            auditIssues: snapshot.audit_issues,
            auditModuleBreakdown: snapshot.audit_module_breakdown,
            ncOpen: ncOpenN,
            ncTotal: ncTotalN,
            capaOpen: capaOpenN,
            capaTotal: capaTotalN,
            capaEffectiveCompleted: capaActionsCompleted,
            capaEffectiveTotal: capaActionsTotal,
            riskActive: snapshot.risk_summary.active,
            riskCritHigh: snapshot.risk_summary.critical_high,
            riskTotal: riskRows.length, // accurate vs cached snapshot count
            kpiGreen: snapshot.kpi_summary.green,
            kpiAmber: snapshot.kpi_summary.amber,
            kpiTotal: snapshot.kpi_summary.total,
            complianceMet: snapshot.compliance_summary.met,
            compliancePartial: snapshot.compliance_summary.partial,
            complianceTotal: snapshot.compliance_summary.total,
          });

          const summaryRows = [
            { metric: "Period", value: data.period },
            { metric: "Window Start (UTC)", value: data.window_start },
            { metric: "Window End (UTC)", value: data.window_end },
            { metric: "Cadence", value: cadence },
            { metric: "Generated At (UTC)", value: data.generated_at },
            { metric: "", value: "" },
            { metric: "Enterprise Health Score", value: `${detail.score} / 100` },
            { metric: "Health Rating", value: detail.rating },
            { metric: "", value: "" },
            { metric: "Audit — latest QA overall score (raw)", value: snapshot.audit_score ?? "—" },
            (() => {
              const auditComp = detail.components.find((c) =>
                c.name.startsWith("Audit"),
              );
              const blended =
                auditComp && auditComp.included && auditComp.value !== null
                  ? Math.round(auditComp.value * 10) / 10
                  : "—";
              const dims = snapshot.audit_dimensions;
              const dimsLabel = dims
                ? `people ${dims.people ?? "—"} / process ${dims.process ?? "—"} / governance ${dims.governance ?? "—"}`
                : "—";
              const mb = snapshot.audit_module_breakdown ?? [];
              const perDept = mb.length
                ? mb
                    .map((m) => {
                      const pct = m.recordsAudited > 0
                        ? Math.round((m.recordsWithIssues / m.recordsAudited) * 1000) / 10
                        : 0;
                      return `${m.module} ${pct}%`;
                    })
                    .join(" / ")
                : "(no per-department breakdown)";
              const avg = mb.length
                ? Math.round(
                    (mb.reduce(
                      (s, m) =>
                        s +
                        (m.recordsAudited > 0
                          ? m.recordsWithIssues / m.recordsAudited
                          : 0),
                      0,
                    ) /
                      mb.length) *
                      1000,
                  ) / 10
                : null;
              return {
                metric:
                  "Audit — value used in health score (process-weighted, dept-contamination-penalised)",
                value: `${blended}  [${dimsLabel}; dept bad-rate avg ${avg ?? "—"}% — ${perDept}]`,
              };
            })(),
            {
              metric: "Audit Findings (recorded)",
              value: auditFindings.length,
            },
            {
              metric: "Nonconformances — open / total",
              value: `${ncOpenN} / ${ncTotalN}`,
            },
            {
              metric: "CAPAs — open / total",
              value: `${capaOpenN} / ${capaTotalN}`,
            },
            {
              metric: "CAPA action items — completed / total",
              value: `${capaActionsCompleted} / ${capaActionsTotal}`,
            },
            {
              metric: "Risks — active / critical-high / register total",
              value: `${snapshot.risk_summary.active} / ${snapshot.risk_summary.critical_high} / ${riskRows.length}`,
            },
            {
              metric: "KPIs — green / amber / red / total",
              value: `${snapshot.kpi_summary.green} / ${snapshot.kpi_summary.amber} / ${snapshot.kpi_summary.red} / ${snapshot.kpi_summary.total}`,
            },
            {
              metric: "Compliance — met / partial / not-met / total",
              value: `${snapshot.compliance_summary.met} / ${snapshot.compliance_summary.partial} / ${snapshot.compliance_summary.not_met} / ${snapshot.compliance_summary.total}`,
            },
          ];

          const healthBreakdownRows = detail.components.map((c) => ({
            component: c.name,
            value: c.value === null ? "—" : Math.round(c.value * 10) / 10,
            weight: c.weight,
            contribution:
              c.included && c.value !== null
                ? Math.round(((c.value * c.weight) / detail.totalWeight) * 10) /
                  10
                : "—",
            included: c.included ? "Yes" : "No",
            note: c.included
              ? Object.entries(c.raw || {})
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")
              : c.reason || "",
          }));

          const issueRows = data.finding_types.map((f) => ({
            module: f.module,
            issue_type: f.issue_type,
            severity: f.severity,
            count: f.count,
          }));

          const safeCadence = cadence.replace(/[^a-z]/gi, "_");
          const filename = `quality_audit_report_${safeCadence}_${Date.now()}.xlsx`;

          const buffer = await buildWorkbook(
            [
              {
                name: "Summary",
                columns: [
                  { header: "Metric", key: "metric", width: 48 },
                  { header: "Value", key: "value", width: 56 },
                ],
                rows: summaryRows,
              },
              {
                name: "Health Breakdown",
                columns: [
                  { header: "Component", key: "component", width: 44 },
                  { header: "Value (0-100)", key: "value", width: 14 },
                  { header: "Weight", key: "weight", width: 10 },
                  { header: "Contribution", key: "contribution", width: 14 },
                  { header: "Included", key: "included", width: 10 },
                  { header: "Note / Inputs", key: "note", width: 60 },
                ],
                rows: healthBreakdownRows,
              },
              {
                name: "Digest Issues",
                columns: [
                  { header: "Module", key: "module", width: 18 },
                  { header: "Issue Type", key: "issue_type", width: 40 },
                  { header: "Severity", key: "severity", width: 12 },
                  { header: "Count", key: "count", width: 10 },
                ],
                rows: issueRows,
              },
              {
                name: "Audit Findings",
                columns: [
                  { header: "Finding #", key: "finding_number", width: 14 },
                  { header: "Criteria", key: "criteria_name", width: 36 },
                  { header: "Dimension", key: "dimension", width: 16 },
                  { header: "Severity", key: "severity", width: 12 },
                  { header: "Status", key: "status", width: 14 },
                  { header: "Owner", key: "owner", width: 20 },
                  { header: "Target Date", key: "target_date", width: 14 },
                  { header: "Resolved", key: "resolution_date", width: 14 },
                  { header: "Created", key: "created_at", width: 22 },
                ],
                rows: auditFindings,
              },
              {
                name: "Nonconformances",
                columns: [
                  { header: "NC #", key: "nc_number", width: 14 },
                  { header: "Title", key: "title", width: 40 },
                  { header: "Type", key: "nc_type", width: 16 },
                  { header: "Severity", key: "severity", width: 12 },
                  { header: "Status", key: "status", width: 14 },
                  { header: "Disposition", key: "disposition", width: 16 },
                  { header: "Detected By", key: "detected_by", width: 20 },
                  { header: "Detected", key: "detected_date", width: 22 },
                  { header: "Closed", key: "closed_date", width: 22 },
                ],
                rows: ncRows,
              },
              {
                name: "CAPAs",
                columns: [
                  { header: "CAPA #", key: "capa_number", width: 14 },
                  { header: "Title", key: "title", width: 40 },
                  { header: "Type", key: "type", width: 14 },
                  { header: "Status", key: "status", width: 14 },
                  { header: "Priority", key: "priority", width: 12 },
                  { header: "Assigned To", key: "assigned_to", width: 20 },
                  { header: "Department", key: "department", width: 18 },
                  { header: "Due Date", key: "due_date", width: 22 },
                  { header: "Created", key: "created_at", width: 22 },
                ],
                rows: capaRows,
              },
              {
                name: "Risks",
                columns: [
                  { header: "ID", key: "id", width: 8 },
                  { header: "Title", key: "risk_title", width: 36 },
                  { header: "Category", key: "risk_category", width: 18 },
                  { header: "Level", key: "risk_level", width: 12 },
                  { header: "Score", key: "risk_score", width: 8 },
                  { header: "Impact", key: "impact_score", width: 8 },
                  { header: "Likelihood", key: "likelihood_score", width: 12 },
                  { header: "Status", key: "status", width: 14 },
                  { header: "Owner", key: "risk_owner", width: 20 },
                  { header: "Treatment", key: "treatment_strategy", width: 16 },
                  { header: "Treatment Deadline", key: "treatment_deadline", width: 22 },
                  { header: "Identified", key: "identified_date", width: 22 },
                ],
                rows: riskRows,
              },
              {
                name: "KPIs",
                columns: [
                  { header: "KPI ID", key: "kpi_id", width: 10 },
                  { header: "Period Start", key: "period_start", width: 14 },
                  { header: "Period End", key: "period_end", width: 14 },
                  { header: "Actual", key: "actual_value", width: 12 },
                  { header: "Target", key: "target_value", width: 12 },
                  { header: "Status", key: "status", width: 12 },
                  { header: "Trend", key: "trend", width: 12 },
                  { header: "Updated", key: "updated_at", width: 22 },
                ],
                rows: kpiRowsDetail,
              },
              {
                name: "Compliance",
                columns: [
                  { header: "ID", key: "id", width: 8 },
                  { header: "Obligation", key: "obligation_id", width: 14 },
                  { header: "Assessed", key: "assessment_date", width: 22 },
                  { header: "Assessed By", key: "assessed_by", width: 20 },
                  { header: "Status", key: "compliance_status", width: 18 },
                  { header: "Score", key: "score", width: 8 },
                  { header: "Remediation Required", key: "remediation_required", width: 18 },
                  { header: "Remediation Status", key: "remediation_status", width: 18 },
                  { header: "Remediation Deadline", key: "remediation_deadline", width: 22 },
                  { header: "Next Assessment", key: "next_assessment_date", width: 22 },
                ],
                rows: complianceRows,
              },
              {
                name: "QA Audit History",
                columns: [
                  { header: "Audit Date", key: "audit_date", width: 22 },
                  { header: "Records Audited", key: "total_records_audited", width: 16 },
                  { header: "Issues Found", key: "total_issues_found", width: 14 },
                  { header: "People", key: "people_score", width: 10 },
                  { header: "Process", key: "process_score", width: 10 },
                  { header: "Governance", key: "governance_score", width: 12 },
                  { header: "Overall", key: "overall_score", width: 10 },
                ],
                rows: qaResults,
              },
            ],
            { title: "WalaPlus Quality Audit Report" },
          );

          const headers = xlsxResponseHeaders(filename);
          const reqHeadersBag: Record<string, string> = {};
          const range = c.req.header("Range") || c.req.header("range");
          if (range) reqHeadersBag["range"] = range;
          const ifRange = c.req.header("If-Range") || c.req.header("if-range");
          if (ifRange) reqHeadersBag["if-range"] = ifRange;

          return bufferResponseWithRange(
            buffer,
            headers["Content-Type"],
            filename,
            reqHeadersBag,
          );
        } catch (error) {
          logger.error("[digest/issues.xlsx] export failed", { error: error instanceof Error ? error.message : String(error) });
          return c.json({
            error: "Failed to export digest issues to XLSX",
            detail: error instanceof Error ? error.message : String(error),
          }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for executive digest",
            );
          const { generateDigestData, buildDigestHTML } =
            await import("../../utils/executiveDigest");
          const format = c.req.query("format");
          const periodQuery = String(
            c.req.query("period") || "weekly",
          ).toLowerCase();
          const cadence =
            periodQuery === "monthly" || periodQuery === "quarterly"
              ? periodQuery
              : "weekly";
          const data = await generateDigestData({ cadence: cadence as any });
          if (format === "html") {
            const html = buildDigestHTML(data);
            return new Response(html, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return c.json(data);
        } catch (error) {
          return c.json({ error: "Failed to generate digest" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/health",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for executive digest diagnostics",
            );
          const { getDigestDeliveryHealth } =
            await import("../../utils/executiveDigest");
          const periodQuery = String(
            c.req.query("period") || "weekly",
          ).toLowerCase();
          const cadence =
            periodQuery === "monthly" || periodQuery === "quarterly"
              ? periodQuery
              : "weekly";
          const health = await getDigestDeliveryHealth(cadence as any, new Date());
          return c.json({
            success: true,
            health,
            guidance: {
              manual_force_send_endpoint: "/api/analytics/executive-digest/send",
              manual_force_send_payload: {
                target: "slack",
                period: cadence,
                preview: false,
                force: true,
              },
            },
          });
        } catch (error) {
          return c.json(
            { error: "Failed to fetch executive digest diagnostics" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/runs",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for executive digest run history",
            );
          const { getRecentDigestRuns } =
            await import("../../utils/executiveDigest");
          const periodQuery = String(
            c.req.query("period") || "",
          ).toLowerCase();
          const cadence =
            periodQuery === "weekly" ||
            periodQuery === "monthly" ||
            periodQuery === "quarterly"
              ? periodQuery
              : undefined;
          const limitRaw = Number.parseInt(String(c.req.query("limit") || "30"), 10);
          const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
          const runs = await getRecentDigestRuns(limit, cadence as any);
          return c.json({
            success: true,
            count: runs.length,
            runs,
          });
        } catch (error) {
          return c.json(
            { error: "Failed to fetch executive digest run history" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/outbox",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for notification outbox visibility",
            );
          const { getOutboxEntries } = await import("../../utils/notificationOutbox");
          const source = String(c.req.query("source") || "").trim() || undefined;
          const statusRaw = String(c.req.query("status") || "").trim().toLowerCase();
          const status =
            statusRaw === "pending" ||
            statusRaw === "processing" ||
            statusRaw === "sent" ||
            statusRaw === "failed"
              ? statusRaw
              : undefined;
          const limitRaw = Number.parseInt(String(c.req.query("limit") || "50"), 10);
          const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
          const outbox = await getOutboxEntries({
            source,
            status: status as any,
            limit,
          });
          return c.json({
            success: true,
            count: outbox.length,
            outbox,
          });
        } catch (error) {
          return c.json(
            { error: "Failed to fetch notification outbox entries" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/outbox/process",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...DIGEST_SEND_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to process notification outbox",
            );
          let body: any = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const limitRaw = Number.parseInt(String(body.limit || "30"), 10);
          const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
          const { processDueOutboxMessages } = await import("../../utils/notificationOutbox");
          const result = await processDueOutboxMessages(limit);
          return c.json({
            success: true,
            result,
          });
        } catch (error) {
          return c.json(
            { error: "Failed to process notification outbox" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/send",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...DIGEST_SEND_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to send executive digest",
            );
          const {
            sendDigestEmail,
            sendDigestSlack,
            runDigestFanout,
            computeDigestWindow,
          } =
            await import("../../utils/executiveDigest");
          let body: any = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const target = String(body.target || "email").toLowerCase();
          const period = String(body.period || "weekly").toLowerCase();
          const preview = !!body.preview;
          const force = !!body.force;
          const cadence =
            period === "monthly" || period === "quarterly"
              ? period
              : "weekly";
          const now = new Date();
          const window = computeDigestWindow(cadence as any, now);
          const enforceIdempotency = !force;
          if (target === "slack") {
            const result = await sendDigestSlack({
              cadence: cadence as any,
              now,
              window,
              preview,
              enforceIdempotency,
            });
            return c.json(result);
          }
          if (target === "both") {
            const result = await runDigestFanout(cadence as any, {
              now,
              window,
              preview,
              enforceIdempotency,
            });
            return c.json(result);
          }
          const result = await sendDigestEmail({
            cadence: cadence as any,
            now,
            window,
            enforceIdempotency,
          });
          return c.json(result);
        } catch (error) {
          return c.json({ error: "Failed to send digest" }, 500);
        }
      };
    },
  },
];
