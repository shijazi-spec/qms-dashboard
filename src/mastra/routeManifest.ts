/**
 * Route Manifest for WalaPlus Platform
 * ======================================
 * This file documents every route registered in the Mastra server.
 * Routes are grouped by their functional domain.
 *
 * HOW TO ADD A NEW ROUTE:
 *   1. API routes: Add to the relevant domain file in src/mastra/routes/
 *      - dashboardApiRoutes.ts  → /api/dashboard/*, /api/audit/*, /api/agents/*, /api/scorecards, /api/crm/*, /api/governance, /api/integrations/*
 *      - adminApiRoutes.ts      → /api/admin/*, /api/workflow/*, /api/system/*, /api/activity/*
 *      - qmsApiRoutes.ts        → /api/qms/*
 *      - sandboxApiRoutes.ts    → /api/sandbox/*
 *      - tablefApiRoutes.ts     → /api/tablef/*
 *      - feedbackApiRoutes.ts   → /api/feedback/*
 *      - sopRoutes.ts           → /api/sop, /api/sop/download
 *      - OR create a new domain file following the same pattern
 *   2. Page shell routes: Add to staticPageRoutes.ts
 *   3. Static assets: Add to staticAssetRoutes.ts
 *   4. Import and spread in src/mastra/index.ts
 *   5. Update this manifest
 *
 * HOW TO ADD NEW MIDDLEWARE:
 *   Add to src/mastra/middleware/index.ts — follow the existing pattern of
 *   checking `urlPath`, `method`, and `isApi` flags before applying logic.
 */

export const ROUTE_MANIFEST = {
  inngest: [
    { path: '/api/inngest', method: 'ALL', file: 'routes/dashboardApiRoutes.ts' },
  ],

  dashboardApi: [
    { path: '/api/dashboard', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/dashboard/layouts-breakdown', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/dashboard/quality-trend', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/dashboard/issues-category-trend', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/audit/latest', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/audit/history', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/audit/trigger', method: 'POST', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/agents/performance', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/scorecards', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/scorecard', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/integrations/status', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/crm/data', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/crm/enrich', method: 'POST', file: 'routes/dashboardApiRoutes.ts' },
    { path: '/api/governance', method: 'GET', file: 'routes/dashboardApiRoutes.ts' },
  ],

  auth: [
    { path: '/api/auth/*', method: '*', file: 'routes/authRoutes.ts' },
    { path: '/api/login', method: 'POST', file: 'routes/authRoutes.ts' },
    { path: '/api/logout', method: 'POST', file: 'routes/authRoutes.ts' },
    { path: '/api/invitations/*', method: '*', file: 'routes/authRoutes.ts' },
  ],

  admin: [
    { path: '/api/admin/auth', method: 'POST', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/auth/logout', method: 'POST', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/documents', method: 'GET|POST', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/documents/:id/activate', method: 'PUT', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/scorecard/weights', method: 'PUT', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/scorecard/attributes', method: 'POST', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/scorecard/link-doc', method: 'PUT', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/scorecards', method: 'GET|POST', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/scorecards/:id', method: 'PUT|DELETE', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/scorecards/:id/activate', method: 'PUT', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/scorecards/:id/clone', method: 'POST', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/scorecards/:id/attributes', method: 'GET|POST', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/scorecards/:id/attributes/reorder', method: 'PUT', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/attributes/:id', method: 'PUT|DELETE', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/seed-defaults', method: 'POST', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/activities', method: 'GET', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/workflow/runs', method: 'GET', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/workflow/runs/:id', method: 'GET', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/system/events', method: 'GET', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/activity/feed', method: 'GET', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/activity/stats', method: 'GET', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/rate-limit-stats', method: 'GET', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/redaction-sweep/status', method: 'GET', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/export-cache/stats', method: 'GET', file: 'routes/adminApiRoutes.ts' },
    { path: '/api/admin/alert-recipients', method: 'GET|POST|DELETE', file: 'routes/adminApiRoutes.ts' },
  ],

  qms: [
    { path: '/api/qms/dashboard', method: 'GET', file: 'routes/qmsApiRoutes.ts' },
    { path: '/api/qms/evaluations', method: 'GET', file: 'routes/qmsApiRoutes.ts' },
    { path: '/api/qms/evaluations/stats', method: 'GET', file: 'routes/qmsApiRoutes.ts' },
    { path: '/api/qms/capa', method: 'GET|POST', file: 'routes/qmsApiRoutes.ts' },
    { path: '/api/qms/capa/:id', method: 'GET', file: 'routes/qmsApiRoutes.ts' },
    { path: '/api/qms/nc', method: 'GET|POST', file: 'routes/qmsApiRoutes.ts' },
    { path: '/api/qms/training', method: 'GET', file: 'routes/qmsApiRoutes.ts' },
    { path: '/api/qms/training/assignments', method: 'GET', file: 'routes/qmsApiRoutes.ts' },
    { path: '/api/qms/framework', method: 'GET', file: 'routes/qmsApiRoutes.ts' },
  ],

  sandbox: [
    { path: '/api/sandbox/mode', method: 'GET', file: 'routes/sandboxApiRoutes.ts' },
    { path: '/api/sandbox/stats', method: 'GET', file: 'routes/sandboxApiRoutes.ts' },
    { path: '/api/sandbox/leads', method: 'GET|POST', file: 'routes/sandboxApiRoutes.ts' },
    { path: '/api/sandbox/deals', method: 'GET|POST', file: 'routes/sandboxApiRoutes.ts' },
    { path: '/api/sandbox/activities', method: 'GET', file: 'routes/sandboxApiRoutes.ts' },
    { path: '/api/sandbox/users', method: 'GET', file: 'routes/sandboxApiRoutes.ts' },
    { path: '/api/sandbox/calendar', method: 'GET', file: 'routes/sandboxApiRoutes.ts' },
    { path: '/api/sandbox/calls', method: 'GET', file: 'routes/sandboxApiRoutes.ts' },
    { path: '/api/sandbox/audit', method: 'POST', file: 'routes/sandboxApiRoutes.ts' },
  ],

  tablef: [
    { path: '/api/tablef/departments', method: 'GET', file: 'routes/tablefApiRoutes.ts' },
    { path: '/api/tablef/kpis', method: 'GET|POST', file: 'routes/tablefApiRoutes.ts' },
    { path: '/api/tablef/performance', method: 'GET|POST', file: 'routes/tablefApiRoutes.ts' },
    { path: '/api/tablef/users', method: 'GET', file: 'routes/tablefApiRoutes.ts' },
  ],

  feedback: [
    { path: '/api/feedback', method: 'GET|POST', file: 'routes/feedbackApiRoutes.ts' },
    { path: '/api/feedback/stats', method: 'GET', file: 'routes/feedbackApiRoutes.ts' },
  ],

  sop: [
    { path: '/api/sop', method: 'GET', file: 'routes/sopRoutes.ts' },
    { path: '/api/sop/download', method: 'GET', file: 'routes/sopRoutes.ts' },
  ],

  exportDownloads: [
    { path: '/api/exports/recent-downloads', method: 'GET', file: 'routes/exportDownloadRoutes.ts' },
    { path: '/api/exports/recent-downloads', method: 'POST', file: 'routes/exportDownloadRoutes.ts' },
    { path: '/api/exports/recent-downloads', method: 'DELETE', file: 'routes/exportDownloadRoutes.ts' },
  ],

  moduleRoutes: [
    'routes/callIntelligenceRoutes.ts',
    'routes/roiRoutes.ts',
    'routes/teamRoutes.ts',
    'routes/pmpRoutes.ts',
    'routes/eventLogsRoutes.ts',
    'routes/onboardingRoutes.ts',
    'routes/riskRoutes.ts',
    'routes/policyRoutes.ts',
    'routes/complianceRoutes.ts',
    'routes/auditRoutes.ts',
    'routes/infographicRoutes.ts',
    'routes/vendorRoutes.ts',
    'routes/migrationRoutes.ts',
    'routes/handoffRoutes.ts',
    'routes/kpiRoutes.ts',
    'routes/duplicateRadarRoutes.ts',
    'routes/rbacRoutes.ts',
    'routes/scorecardRoutes.ts',
    'routes/pdplRoutes.ts',
    'routes/triggerRoutes.ts',
    'routes/auditProgrammeRoutes.ts',
    'routes/manualAuditRoutes.ts',
    'routes/externalAuditRoutes.ts',
    'routes/userAccessRoutes.ts',
    'routes/smokeTestRoutes.ts',
    'routes/consultantRoutes.ts',
    'routes/mobileRoutes.ts',
    'routes/aiApprovalRoutes.ts',
    'routes/qmsEnhancedRoutes.ts',
    'routes/notificationRoutes.ts',
    'routes/knowledgeRoutes.ts',
    'routes/reportRoutes.ts',
    'routes/managementReviewRoutes.ts',
    'routes/analyticsRoutes.ts',
    'routes/healthPulseRoutes.ts',
    'routes/exportDownloadRoutes.ts',
  ],

  pages: [
    '/', '/dashboard', '/dashboard/:name', '/login', '/admin', '/users', '/accept-invite',
    '/qms', '/sandbox', '/crm', '/audits', '/compliance', '/document-mapping',
    '/audit-readiness', '/import-review',
    '/integrated-qms', '/policies', '/reviews', '/risks', '/grc', '/pdpl', '/feedback', '/guide',
    '/migration', '/logs', '/ai-approvals', '/intake', '/external-audits',
    '/vendors', '/tablef', '/infographic', '/sop', '/docs/SCOPE_OF_WORK.html',
  ],

  staticAssets: [
    '/dashboard/tailwind.css',
    '/css/navigation.css',
    '/css/utilities.css',
    '/css/a11y.css',
    '/js/navigation.js',
    '/js/ai-consultant-widget.js',
    '/js/csp-styles.js',
    '/js/streaming-download.js',
    '/js/duplicates-app.js',
  ],
} as const;
