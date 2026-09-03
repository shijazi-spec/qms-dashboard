/**
 * ExampleOrg Platform QC Manifest
 * Maps each screen and functionality to API checks for quality control.
 * Used by run-platform-qc.ts to produce a report for HostingPlatform fixes.
 *
 * Aligned with: User Guide (<REDACTED_HOST>/guide) + Scope of Work
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface QCTestCase {
  id: string;
  screenName: string;
  screenRoute: string;
  functionalityName: string;
  method: HttpMethod;
  path: string;
  /** Optional: send these headers (e.g. X-Admin-Key). Use env var name in value, e.g. process.env.ADMIN_API_KEY */
  headers?: Record<string, string>;
  /** Optional: request body for POST/PUT/PATCH */
  body?: unknown;
  /** Expected HTTP status. Default 200. Use array to accept multiple (e.g. [200, 401] for auth-optional). */
  expectedStatus?: number | number[];
  /** If true, 401 is treated as pass (auth required). */
  allowUnauth?: boolean;
}

/** Base URL for API (e.g. <REDACTED_URL> or <REDACTED_URL_SCHEME><REDACTED_HOST>) */
export const getBaseUrl = (): string =>
  process.env.QC_BASE_URL || process.env.PLATFORM_URL || "<REDACTED_URL>";

const adminKeyHeader = (): Record<string, string> | undefined =>
  process.env.ADMIN_API_KEY ? { "X-Admin-Key": process.env.ADMIN_API_KEY } : undefined;

export const PLATFORM_QC_MANIFEST: QCTestCase[] = [
  // --- Quality Dashboard (/)
  {
    id: "quality-dashboard-data",
    screenName: "Quality Dashboard",
    screenRoute: "/",
    functionalityName: "Load dashboard data",
    method: "GET",
    path: "/api/dashboard",
    expectedStatus: 200,
  },
  {
    id: "quality-audit-latest",
    screenName: "Quality Dashboard",
    screenRoute: "/",
    functionalityName: "Load latest audit result",
    method: "GET",
    path: "/api/audit/latest",
    expectedStatus: [200, 404],
  },
  {
    id: "quality-audit-history",
    screenName: "Quality Dashboard",
    screenRoute: "/",
    functionalityName: "Load audit history",
    method: "GET",
    path: "/api/audit/history",
    expectedStatus: 200,
  },
  {
    id: "quality-agents-performance",
    screenName: "Quality Dashboard",
    screenRoute: "/",
    functionalityName: "Agent Performance widget",
    method: "GET",
    path: "/api/agents/performance",
    expectedStatus: [200, 404],
  },
  // --- Admin Panel (/admin)
  {
    id: "admin-documents",
    screenName: "Admin Panel",
    screenRoute: "/admin",
    functionalityName: "Governance Document Manager",
    method: "GET",
    path: "/api/admin/documents",
    headers: adminKeyHeader(),
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  {
    id: "admin-scorecards",
    screenName: "Admin Panel",
    screenRoute: "/admin",
    functionalityName: "Scorecard list",
    method: "GET",
    path: "/api/admin/scorecards",
    headers: adminKeyHeader(),
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  {
    id: "admin-activities",
    screenName: "Admin Panel",
    screenRoute: "/admin",
    functionalityName: "Activity logging",
    method: "GET",
    path: "/api/admin/activities",
    headers: adminKeyHeader(),
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  // --- ExampleOrg (/qms)
  {
    id: "ExampleOrg",
    screenName: "ExampleOrg",
    screenRoute: "/qms",
    functionalityName: "ExampleOrg data",
    method: "GET",
    path: "/api/qms/dashboard",
    headers: adminKeyHeader(),
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  {
    id: "qms-capa-list",
    screenName: "ExampleOrg",
    screenRoute: "/qms",
    functionalityName: "CAPA list",
    method: "GET",
    path: "/api/qms/capa",
    headers: adminKeyHeader(),
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  {
    id: "qms-nc-list",
    screenName: "ExampleOrg",
    screenRoute: "/qms",
    functionalityName: "Nonconformance list",
    method: "GET",
    path: "/api/qms/nc",
    headers: adminKeyHeader(),
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  {
    id: "qms-evaluations",
    screenName: "ExampleOrg",
    screenRoute: "/qms",
    functionalityName: "Deal evaluations",
    method: "GET",
    path: "/api/qms/evaluations",
    headers: adminKeyHeader(),
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  // --- GRC Control Tower (/grc)
  {
    id: "grc-risks-summary",
    screenName: "GRC Control Tower",
    screenRoute: "/grc",
    functionalityName: "Risk summary",
    method: "GET",
    path: "/api/risks/summary",
    expectedStatus: 200,
  },
  {
    id: "grc-compliance-summary",
    screenName: "GRC Control Tower",
    screenRoute: "/grc",
    functionalityName: "Compliance overview",
    method: "GET",
    path: "/api/compliance/summary",
    expectedStatus: 200,
  },
  {
    id: "grc-policies-summary",
    screenName: "GRC Control Tower",
    screenRoute: "/grc",
    functionalityName: "Policy summary",
    method: "GET",
    path: "/api/policies/summary",
    expectedStatus: 200,
  },
  {
    id: "grc-audits-summary",
    screenName: "GRC Control Tower",
    screenRoute: "/grc",
    functionalityName: "Audit summary",
    method: "GET",
    path: "/api/audits/summary",
    expectedStatus: 200,
  },
  {
    id: "grc-vendors-summary",
    screenName: "GRC Control Tower",
    screenRoute: "/grc",
    functionalityName: "Vendor summary",
    method: "GET",
    path: "/api/vendors/summary",
    expectedStatus: 200,
  },
  // --- Risk Register (/risks)
  {
    id: "risks-list",
    screenName: "Risk Register",
    screenRoute: "/risks",
    functionalityName: "List risks",
    method: "GET",
    path: "/api/risks",
    expectedStatus: 200,
  },
  {
    id: "risks-heatmap",
    screenName: "Risk Register",
    screenRoute: "/risks",
    functionalityName: "Risk heat map",
    method: "GET",
    path: "/api/risks/heatmap",
    expectedStatus: 200,
  },
  {
    id: "risks-categories",
    screenName: "Risk Register",
    screenRoute: "/risks",
    functionalityName: "Risk categories",
    method: "GET",
    path: "/api/risks/categories",
    expectedStatus: 200,
  },
  // --- Policy Governance (/policies)
  {
    id: "policies-list",
    screenName: "Policy Governance",
    screenRoute: "/policies",
    functionalityName: "List policies",
    method: "GET",
    path: "/api/policies",
    expectedStatus: 200,
  },
  {
    id: "policies-summary",
    screenName: "Policy Governance",
    screenRoute: "/policies",
    functionalityName: "Policy summary",
    method: "GET",
    path: "/api/policies/summary",
    expectedStatus: 200,
  },
  // --- Compliance Tracker (/compliance)
  {
    id: "compliance-regulations",
    screenName: "Compliance Tracker",
    screenRoute: "/compliance",
    functionalityName: "List regulations",
    method: "GET",
    path: "/api/compliance/regulations",
    expectedStatus: 200,
  },
  {
    id: "compliance-obligations",
    screenName: "Compliance Tracker",
    screenRoute: "/compliance",
    functionalityName: "List obligations",
    method: "GET",
    path: "/api/compliance/obligations",
    expectedStatus: 200,
  },
  {
    id: "compliance-summary",
    screenName: "Compliance Tracker",
    screenRoute: "/compliance",
    functionalityName: "Compliance summary",
    method: "GET",
    path: "/api/compliance/summary",
    expectedStatus: 200,
  },
  // --- Audit Readiness (/audits)
  {
    id: "audits-list",
    screenName: "Audit Readiness",
    screenRoute: "/audits",
    functionalityName: "List audits",
    method: "GET",
    path: "/api/audits",
    expectedStatus: 200,
  },
  {
    id: "audits-findings",
    screenName: "Audit Readiness",
    screenRoute: "/audits",
    functionalityName: "Audit findings",
    method: "GET",
    path: "/api/audits/findings",
    expectedStatus: 200,
  },
  // --- Vendor Risk (/vendors)
  {
    id: "vendors-list",
    screenName: "Vendor Risk Management",
    screenRoute: "/vendors",
    functionalityName: "List vendors",
    method: "GET",
    path: "/api/vendors",
    expectedStatus: 200,
  },
  {
    id: "vendors-summary",
    screenName: "Vendor Risk Management",
    screenRoute: "/vendors",
    functionalityName: "Vendor summary",
    method: "GET",
    path: "/api/vendors/summary",
    expectedStatus: 200,
  },
  // --- Data Migration (/migration)
  {
    id: "migration-templates",
    screenName: "Data Migration",
    screenRoute: "/migration",
    functionalityName: "Migration templates",
    method: "GET",
    path: "/api/migration/templates",
    expectedStatus: 200,
  },
  {
    id: "migration-jobs",
    screenName: "Data Migration",
    screenRoute: "/migration",
    functionalityName: "Migration jobs list",
    method: "GET",
    path: "/api/migration/jobs",
    expectedStatus: 200,
  },
  {
    id: "migration-dedup-rules",
    screenName: "Data Migration",
    screenRoute: "/migration",
    functionalityName: "Deduplication rules",
    method: "GET",
    path: "/api/migration/dedup-rules",
    expectedStatus: 200,
  },
  // --- Call Intelligence (/calls)
  {
    id: "calls-list",
    screenName: "Call Intelligence",
    screenRoute: "/calls",
    functionalityName: "Call records list",
    method: "GET",
    path: "/api/calls",
    expectedStatus: 200,
  },
  {
    id: "calls-analytics",
    screenName: "Call Intelligence",
    screenRoute: "/calls",
    functionalityName: "Call analytics",
    method: "GET",
    path: "/api/calls/analytics",
    expectedStatus: 200,
  },
  {
    id: "calls-mcp-import-sources",
    screenName: "Call Intelligence",
    screenRoute: "/calls",
    functionalityName: "QMS Bridge — import catalog & SDR scope",
    method: "GET",
    path: "/api/calls/evaluation/import-sources",
    expectedStatus: 200,
  },
  // --- ROI (/roi)
  {
    id: "roi-list",
    screenName: "ROI Evaluation",
    screenRoute: "/roi",
    functionalityName: "ROI initiatives",
    method: "GET",
    path: "/api/roi",
    expectedStatus: 200,
  },
  {
    id: "roi-analytics",
    screenName: "ROI Evaluation",
    screenRoute: "/roi",
    functionalityName: "ROI analytics",
    method: "GET",
    path: "/api/roi/analytics",
    expectedStatus: 200,
  },
  // --- Team Performance (/team)
  {
    id: "team-members",
    screenName: "Team Performance",
    screenRoute: "/team",
    functionalityName: "Team members list",
    method: "GET",
    path: "/api/team/members",
    expectedStatus: 200,
  },
  {
    id: "team-performance",
    screenName: "Team Performance",
    screenRoute: "/team",
    functionalityName: "Team performance data",
    method: "GET",
    path: "/api/team/performance",
    expectedStatus: 200,
  },
  // --- Project Portfolio (/projects)
  {
    id: "pmp-projects",
    screenName: "Project Portfolio (PMP)",
    screenRoute: "/projects",
    functionalityName: "Projects list",
    method: "GET",
    path: "/api/pmp/projects",
    expectedStatus: 200,
  },
  // --- Event Logs (/logs)
  {
    id: "logs-list",
    screenName: "System Event Logs",
    screenRoute: "/logs",
    functionalityName: "Event logs list",
    method: "GET",
    path: "/api/logs",
    expectedStatus: 200,
  },
  {
    id: "logs-stats",
    screenName: "System Event Logs",
    screenRoute: "/logs",
    functionalityName: "Logs stats",
    method: "GET",
    path: "/api/logs/stats",
    expectedStatus: 200,
  },
  // --- PDPL (/pdpl)
  {
    id: "pdpl-status",
    screenName: "PDPL Privacy Compliance",
    screenRoute: "/pdpl",
    functionalityName: "PDPL status",
    method: "GET",
    path: "/api/pdpl/status",
    expectedStatus: 200,
  },
  {
    id: "pdpl-inventory",
    screenName: "PDPL Privacy Compliance",
    screenRoute: "/pdpl",
    functionalityName: "Data inventory",
    method: "GET",
    path: "/api/pdpl/inventory",
    expectedStatus: 200,
  },
  // --- Users & Access (/users)
  {
    id: "users-stats",
    screenName: "Users & Access Control",
    screenRoute: "/users",
    functionalityName: "User stats",
    method: "GET",
    path: "/api/users/stats",
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  // --- Scorecard (/scorecard)
  {
    id: "scorecard-snapshot",
    screenName: "Scorecard",
    screenRoute: "/scorecard",
    functionalityName: "Scorecard snapshot",
    method: "GET",
    path: "/api/scorecard/snapshot",
    expectedStatus: [200, 404],
  },
  // --- Duplicate Radar (/duplicates)
  {
    id: "duplicates-summary",
    screenName: "Duplicate Radar",
    screenRoute: "/duplicates",
    functionalityName: "Duplicates summary",
    method: "GET",
    path: "/api/duplicates/summary",
    expectedStatus: 200,
  },
  // --- Handoff (Quality-GRC)
  {
    id: "handoff-rules",
    screenName: "Quality-GRC Handoffs",
    screenRoute: "/grc",
    functionalityName: "Handoff rules list",
    method: "GET",
    path: "/api/handoff/rules",
    expectedStatus: 200,
  },
  {
    id: "handoff-summary",
    screenName: "Quality-GRC Handoffs",
    screenRoute: "/grc",
    functionalityName: "Handoff summary",
    method: "GET",
    path: "/api/handoff/summary",
    expectedStatus: 200,
  },
  // --- Integrations status (Admin / dashboard)
  {
    id: "integrations-status",
    screenName: "Quality Dashboard / Admin",
    screenRoute: "/",
    functionalityName: "Integrations status",
    method: "GET",
    path: "/api/integrations/status",
    expectedStatus: 200,
  },
  // --- Workflow runs (Admin)
  {
    id: "workflow-runs",
    screenName: "Admin Panel",
    screenRoute: "/admin",
    functionalityName: "Workflow runs",
    method: "GET",
    path: "/api/workflow/runs",
    headers: adminKeyHeader(),
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  // --- KPIs (/kpis)
  {
    id: "kpis-list",
    screenName: "KPI Tracking",
    screenRoute: "/kpis",
    functionalityName: "KPI list",
    method: "GET",
    path: "/api/kpis",
    expectedStatus: 200,
  },
  {
    id: "kpis-summary",
    screenName: "KPI Tracking",
    screenRoute: "/kpis",
    functionalityName: "KPI summary",
    method: "GET",
    path: "/api/kpis/summary",
    expectedStatus: 200,
  },
  // --- Triggers (Admin / automation)
  {
    id: "triggers-list",
    screenName: "Admin Panel",
    screenRoute: "/admin",
    functionalityName: "Triggers list",
    method: "GET",
    path: "/api/triggers",
    expectedStatus: [200, 401],
    allowUnauth: true,
  },
  // --- MCP Call Evaluation (QMS Bridge)
  {
    id: "calls-mcp-import-sources",
    screenName: "Call Evaluation",
    screenRoute: "/calls",
    functionalityName: "MCP import-sources catalog",
    method: "GET",
    path: "/api/calls/evaluation/import-sources",
    expectedStatus: 200,
  },
];
