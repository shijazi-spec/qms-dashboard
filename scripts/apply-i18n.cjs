/**
 * Phase 2 i18n applier:
 * - Adds <script src="/js/i18n.js?v=1.0"></script> before </head> if missing.
 * - Adds an i18n init <script> before </body> if missing.
 * - Applies a per-page list of literal-string replacements that swap
 *   raw English text for the same text wrapped with data-i18n="<key>".
 *
 * Replacements are conservative literal substitutions (split/join). Each
 * one is verified to match before being applied; any that don't match
 * are silently skipped (with a count) so this script remains idempotent
 * and tolerant of pages that have already been partially translated.
 *
 * Run: node scripts/apply-i18n.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'dashboard');

const I18N_SCRIPT = '    <script src="/js/i18n.js?v=1.0"></script>\n';
const INIT_BLOCK = `    <script>
        if (window.WalaPlusI18n) {
            window.WalaPlusI18n.init().then(function () { window.WalaPlusI18n.applyToDOM(); });
        }
    </script>
`;

// Helpers ---------------------------------------------------------------------
function setI18n(open, key, text) {
  const idx = open.lastIndexOf('>');
  if (idx < 0) throw new Error('bad open tag: ' + open);
  const newOpen = open.slice(0, idx) + ' data-i18n="' + key + '"' + open.slice(idx);
  return { from: open + text, to: newOpen + text };
}

// Wrap a KPI label `<p class="text-sm text-gray-500">XXX</p>`
function kpiLabel(text, key) {
  return {
    from: '<p class="text-sm text-gray-500">' + text + '</p>',
    to: '<p class="text-sm text-gray-500" data-i18n="' + key + '">' + text + '</p>',
  };
}

// Wrap a div KPI label `<div class="text-sm text-gray-500">XXX</div>`
function kpiLabelDiv(text, key) {
  return {
    from: '<div class="text-sm text-gray-500">' + text + '</div>',
    to: '<div class="text-sm text-gray-500" data-i18n="' + key + '">' + text + '</div>',
  };
}

// Wrap a tab button matched by id
// Most tabs follow the pattern:
//   <button onclick="showTab('xx')" id="tab-xx" class="...">
//                Label
//            </button>
function tabBtn(id, text, key) {
  // Two whitespace patterns we see in the codebase
  const patterns = [
    {
      from: 'id="tab-' + id + '" class="flex-1 px-4 py-2.5 font-medium rounded-lg transition tab-active">\n                ' + text + '\n            </button>',
      to:   'id="tab-' + id + '" class="flex-1 px-4 py-2.5 font-medium rounded-lg transition tab-active" data-i18n="' + key + '">\n                ' + text + '\n            </button>',
    },
    {
      from: 'id="tab-' + id + '" class="flex-1 px-4 py-2.5 font-medium rounded-lg transition text-gray-600 hover:bg-gray-200">\n                ' + text + '\n            </button>',
      to:   'id="tab-' + id + '" class="flex-1 px-4 py-2.5 font-medium rounded-lg transition text-gray-600 hover:bg-gray-200" data-i18n="' + key + '">\n                ' + text + '\n            </button>',
    },
    {
      from: 'id="tab-' + id + '" class="flex-1 px-4 py-2.5 font-medium rounded-lg transition tab-active whitespace-nowrap">\n                ' + text + '\n            </button>',
      to:   'id="tab-' + id + '" class="flex-1 px-4 py-2.5 font-medium rounded-lg transition tab-active whitespace-nowrap" data-i18n="' + key + '">\n                ' + text + '\n            </button>',
    },
    {
      from: 'id="tab-' + id + '" class="flex-1 px-4 py-2.5 font-medium rounded-lg transition text-gray-600 hover:bg-gray-200 whitespace-nowrap">\n                ' + text + '\n            </button>',
      to:   'id="tab-' + id + '" class="flex-1 px-4 py-2.5 font-medium rounded-lg transition text-gray-600 hover:bg-gray-200 whitespace-nowrap" data-i18n="' + key + '">\n                ' + text + '\n            </button>',
    },
  ];
  return patterns;
}

// Section header h2/h3 with simple class
function section(tag, cls, text, key) {
  return {
    from: '<' + tag + ' class="' + cls + '">' + text + '</' + tag + '>',
    to:   '<' + tag + ' class="' + cls + '" data-i18n="' + key + '">' + text + '</' + tag + '>',
  };
}

// Shorthand: many `<h2 class="text-lg font-semibold text-gray-900">XXX</h2>`
function h2lg(text, key) { return section('h2', 'text-lg font-semibold text-gray-900', text, key); }
function h2xl(text, key) { return section('h2', 'text-xl font-semibold text-gray-900', text, key); }
function h3lg(text, key) { return section('h3', 'text-lg font-semibold text-gray-900', text, key); }

// Per-page replacements -------------------------------------------------------
const PAGES = {
  'audits.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'audits.title', 'Internal Audits Dashboard'),
    setI18n('<h2 class="text-lg font-semibold text-gray-900">', 'audits.annual_programme', 'Annual Audit Programme'),
    setI18n('<a href="/ai-approvals" class="text-sm text-indigo-700 hover:text-indigo-900 underline">', 'audits.view_hitl', 'View HITL queue'),
    { from: '>Programme Code</div>', to: ' data-i18n="audits.programme_code">Programme Code</div>' },
    { from: '>Year</div>', to: ' data-i18n="audits.year">Year</div>' },
    { from: '>Approved By</div>', to: ' data-i18n="audits.approved_by">Approved By</div>' },
    { from: '>Approved At</div>', to: ' data-i18n="audits.approved_at">Approved At</div>' },
    { from: '>Total Audits</div>', to: ' data-i18n="audits.total_audits">Total Audits</div>' },
    { from: '>Planned</div>', to: ' data-i18n="audits.planned">Planned</div>' },
    { from: '>Open Findings</div>', to: ' data-i18n="audits.open_findings">Open Findings</div>' },
    { from: '>Overdue Findings</div>', to: ' data-i18n="audits.overdue_findings">Overdue Findings</div>' },
    { from: '                    Manual Intake\n', to: '                    <span data-i18n="audits.manual_intake">Manual Intake</span>\n' },
    { from: '                    + Finding\n', to: '                    <span data-i18n="audits.new_finding">+ Finding</span>\n' },
    { from: '                    New Audit\n', to: '                    <span data-i18n="audits.new_audit">New Audit</span>\n' },
  ],
  'kpis.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'kpis.title', 'KPI Engine'),
    { from: '>Role-based KPI tracking with automated calculations<', to: ' data-i18n="kpis.subtitle">Role-based KPI tracking with automated calculations<' },
    { from: '>Total KPIs</div>', to: ' data-i18n="kpis.total_kpis">Total KPIs</div>' },
    { from: '>On Target</div>', to: ' data-i18n="kpis.on_target">On Target</div>' },
    { from: '>At Risk</div>', to: ' data-i18n="kpis.at_risk">At Risk</div>' },
    { from: '>Off Target</div>', to: ' data-i18n="kpis.off_target">Off Target</div>' },
    { from: '>KPIs by Owner</h3>', to: ' data-i18n="kpis.kpis_by_owner">KPIs by Owner</h3>' },
    { from: '>Status Distribution</h3>', to: ' data-i18n="kpis.status_distribution">Status Distribution</h3>' },
    { from: '>KPIs by Category</h3>', to: ' data-i18n="kpis.kpis_by_category">KPIs by Category</h3>' },
    { from: '>KPI Catalog</h2>', to: ' data-i18n="kpis.kpi_catalog">KPI Catalog</h2>' },
  ],
  'risks.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'risks.title', 'Enterprise Risk Register'),
    { from: '>Centralized risk management with AI-powered detection<', to: ' data-i18n="risks.subtitle">Centralized risk management with AI-powered detection<' },
    { from: '>Total Risks</div>', to: ' data-i18n="risks.total_risks">Total Risks</div>' },
    { from: '>Critical</div>', to: ' data-i18n="risks.critical">Critical</div>' },
    { from: '>High</div>', to: ' data-i18n="risks.high">High</div>' },
    { from: '>Medium</div>', to: ' data-i18n="risks.medium">Medium</div>' },
    { from: '>Low</div>', to: ' data-i18n="risks.low">Low</div>' },
    { from: '>AI Detected</div>', to: ' data-i18n="risks.ai_detected">AI Detected</div>' },
    { from: '>Risk Heatmap</h2>', to: ' data-i18n="risks.risk_heatmap">Risk Heatmap</h2>' },
    { from: '>Top 5 Risks</h2>', to: ' data-i18n="risks.top_risks">Top 5 Risks</h2>' },
    { from: '>Risk Register</h2>', to: ' data-i18n="risks.risk_register">Risk Register</h2>' },
  ],
  'compliance.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'compliance.title', 'Regulatory Compliance'),
    { from: '>PDPL, NCA/ECC, ISO standards tracking and obligation management<', to: ' data-i18n="compliance.subtitle">PDPL, NCA/ECC, ISO standards tracking and obligation management<' },
    { from: '>Overall Compliance Score</div>', to: ' data-i18n="compliance.overall_score">Overall Compliance Score</div>' },
    { from: '>Active Regulations</div>', to: ' data-i18n="compliance.active_regulations">Active Regulations</div>' },
    { from: '>Total Obligations</div>', to: ' data-i18n="compliance.total_obligations">Total Obligations</div>' },
    { from: '>Pending Remediations</div>', to: ' data-i18n="compliance.pending_remediations">Pending Remediations</div>' },
    { from: '>Regulation Library</h2>', to: ' data-i18n="compliance.regulation_library">Regulation Library</h2>' },
    { from: '>Obligations Register</h2>', to: ' data-i18n="compliance.obligations_register">Obligations Register</h2>' },
    { from: '>By Regulation</h2>', to: ' data-i18n="compliance.by_regulation">By Regulation</h2>' },
    { from: '>By Priority</h2>', to: ' data-i18n="compliance.by_priority">By Priority</h2>' },
    { from: '>Upcoming Deadlines</h2>', to: ' data-i18n="compliance.upcoming_deadlines">Upcoming Deadlines</h2>' },
    { from: '>Gap Analysis</h2>', to: ' data-i18n="compliance.gap_analysis">Gap Analysis</h2>' },
  ],
  'crm.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'crm.title', 'CRM Data Hub'),
    { from: '>Live CRM data enriched with quality scores & duplicate detection<', to: ' data-i18n="crm.subtitle">Live CRM data enriched with quality scores & duplicate detection<' },
    { from: '>Records Shown</div>', to: ' data-i18n="crm.records_shown">Records Shown</div>' },
    { from: '>Clean Records</div>', to: ' data-i18n="crm.clean_records">Clean Records</div>' },
    { from: '>With Issues</div>', to: ' data-i18n="crm.with_issues">With Issues</div>' },
    { from: '>Junk / Spam</div>', to: ' data-i18n="crm.junk_spam">Junk / Spam</div>' },
    { from: '>In Dup. Clusters</div>', to: ' data-i18n="crm.in_dup_clusters">In Dup. Clusters</div>' },
  ],
  'duplicates.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'duplicates.title', 'Duplicate Radar'),
    { from: '>True Duplicates</div>', to: ' data-i18n="duplicates.true_duplicates">True Duplicates</div>' },
    { from: '>Dup Leads</div>', to: ' data-i18n="duplicates.dup_leads">Dup Leads</div>' },
    { from: '>Dup Deals</div>', to: ' data-i18n="duplicates.dup_deals">Dup Deals</div>' },
    { from: '>Dup Contacts</div>', to: ' data-i18n="duplicates.dup_contacts">Dup Contacts</div>' },
    { from: '>Dup Accounts</div>', to: ' data-i18n="duplicates.dup_accounts">Dup Accounts</div>' },
    { from: '>Strong Confidence</div>', to: ' data-i18n="duplicates.strong_confidence">Strong Confidence</div>' },
    { from: '>Moderate Confidence</div>', to: ' data-i18n="duplicates.moderate_confidence">Moderate Confidence</div>' },
    { from: '>Pipeline Inflation</div>', to: ' data-i18n="duplicates.pipeline_inflation">Pipeline Inflation</div>' },
    { from: '>Resolution Rate</div>', to: ' data-i18n="duplicates.resolution_rate">Resolution Rate</div>' },
  ],
  'vendors.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'vendors.title', 'Vendor Risk Management'),
    { from: '>Manage third-party vendors, risk assessments, and remediation tracking<', to: ' data-i18n="vendors.subtitle">Manage third-party vendors, risk assessments, and remediation tracking<' },
    { from: '>Total Vendors</div>', to: ' data-i18n="vendors.total_vendors">Total Vendors</div>' },
    { from: '>Pending Approval</div>', to: ' data-i18n="vendors.pending_approval">Pending Approval</div>' },
    { from: '>On Probation</div>', to: ' data-i18n="vendors.on_probation">On Probation</div>' },
    { from: '>Critical Vendors</div>', to: ' data-i18n="vendors.critical_vendors">Critical Vendors</div>' },
    { from: '>High Data Access</div>', to: ' data-i18n="vendors.high_data_access">High Data Access</div>' },
    { from: '>Open Remediations</div>', to: ' data-i18n="vendors.open_remediations">Open Remediations</div>' },
    { from: '>Vendor Registry</h2>', to: ' data-i18n="vendors.vendor_registry">Vendor Registry</h2>' },
    { from: '>Vendors by Criticality</h2>', to: ' data-i18n="vendors.by_criticality">Vendors by Criticality</h2>' },
    { from: '>Expiring Contracts</h2>', to: ' data-i18n="vendors.expiring_contracts">Expiring Contracts</h2>' },
    { from: '>Overdue Assessments</h2>', to: ' data-i18n="vendors.overdue_assessments">Overdue Assessments</h2>' },
    { from: '>Remediation Tracker</h2>', to: ' data-i18n="vendors.remediation_tracker">Remediation Tracker</h2>' },
  ],
  'reviews.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'reviews.title', 'Management Review'),
    { from: '>ISO 9001 Clause 9.3 — Management review meetings, decisions, and action tracking<', to: ' data-i18n="reviews.subtitle">ISO 9001 Clause 9.3 — Management review meetings, decisions, and action tracking<' },
    { from: '>Total Actions</div>', to: ' data-i18n="reviews.total_actions">Total Actions</div>' },
  ],
  'external-audits.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'external_audits.title', 'External Audits'),
    { from: '>Certificate Register</h2>', to: ' data-i18n="external_audits.cert_register">Certificate Register</h2>' },
    { from: '>Readiness Checklist</h2>', to: ' data-i18n="external_audits.readiness_checklist">Readiness Checklist</h2>' },
  ],
  'policies.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'policies.title', 'Integrated QMS'),
    { from: '>Total Documents</div>', to: ' data-i18n="policies.total_docs">Total Documents</div>' },
    { from: '>Draft</div>', to: ' data-i18n="policies.draft">Draft</div>' },
    { from: '>In Review</div>', to: ' data-i18n="policies.in_review">In Review</div>' },
    { from: '>Pending Approval</div>', to: ' data-i18n="policies.pending_approval">Pending Approval</div>' },
    { from: '>Published</div>', to: ' data-i18n="policies.published">Published</div>' },
    { from: '>Overdue Reviews</div>', to: ' data-i18n="policies.overdue_reviews">Overdue Reviews</div>' },
    { from: '>Document Register</h2>', to: ' data-i18n="policies.doc_register">Document Register</h2>' },
    { from: '>Upcoming Reviews</h2>', to: ' data-i18n="policies.upcoming_reviews">Upcoming Reviews</h2>' },
    { from: '>By Category</h2>', to: ' data-i18n="policies.by_category">By Category</h2>' },
  ],
  'qms.html': [
    kpiLabel('Open CAPA', 'qms.kpi_open_capa'),
    kpiLabel('Open NC', 'qms.kpi_open_nc'),
    kpiLabel('First Pass Yield', 'qms.kpi_fpy'),
    kpiLabel('CAPA Effectiveness', 'qms.kpi_capa_eff'),
  ],
  'team.html': [
    ...tabBtn('overview', 'Overview', 'team.tab_overview'),
    ...tabBtn('members', 'Team Members', 'team.tab_members'),
    ...tabBtn('courses', 'Training Courses', 'team.tab_courses'),
    ...tabBtn('training', 'Training Matrix', 'team.tab_matrix'),
    ...tabBtn('projects', 'Projects', 'team.tab_projects'),
    ...tabBtn('analytics', 'Analytics', 'team.tab_analytics'),
    kpiLabel('Total Team Members', 'team.total_members'),
    kpiLabel('Avg Performance', 'team.avg_performance'),
    kpiLabel('Training Compliance', 'team.training_compliance'),
    kpiLabel('Active Projects', 'team.active_projects'),
  ],
  'scorecard.html': [
    setI18n('<h1 id="employeeName" class="text-3xl font-bold text-gray-900">', 'scorecard.title', 'Mohammed Al Muzaini'),
  ],
  'tablef.html': [
    ...tabBtn('overview', 'Overview', 'tablef.tab_overview'),
    ...tabBtn('department', 'Department View', 'tablef.tab_dept'),
    ...tabBtn('kpimanager', 'KPI Manager', 'tablef.tab_kpi_mgr'),
    ...tabBtn('insights', 'AI Insights', 'tablef.tab_ai'),
    ...tabBtn('access', 'Access & Roles', 'tablef.tab_access'),
  ],
  'projects.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'projects.title', 'PMP Project Portfolio'),
    { from: '>Project Management Professional Framework<', to: ' data-i18n="projects.subtitle">Project Management Professional Framework<' },
    { from: '>Total Projects</div>', to: ' data-i18n="projects.total_projects">Total Projects</div>' },
    { from: '>Avg SPI</div>', to: ' data-i18n="projects.avg_spi">Avg SPI</div>' },
    { from: '>Avg CPI</div>', to: ' data-i18n="projects.avg_cpi">Avg CPI</div>' },
    { from: '>At Risk</div>', to: ' data-i18n="projects.at_risk">At Risk</div>' },
    { from: '>High Risks</div>', to: ' data-i18n="projects.high_risks">High Risks</div>' },
  ],
  'calls.html': [
    ...tabBtn('overview', 'Overview', 'calls.tab_overview'),
    ...tabBtn('calls', 'Call Records', 'calls.tab_records'),
    ...tabBtn('sources', 'Data Sources', 'calls.tab_sources'),
    ...tabBtn('evaluate', 'SDR Evaluation', 'calls.tab_sdr'),
    ...tabBtn('scorecards', 'Scorecards', 'calls.tab_scorecards'),
    ...tabBtn('compliance', 'CRM Compliance', 'calls.tab_compliance'),
    ...tabBtn('analytics', 'Analytics', 'calls.tab_analytics'),
  ],
  'users.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'users.title', 'Users & Access Control'),
    { from: '>Manage user invitations, approvals, and permissions<', to: ' data-i18n="users.subtitle">Manage user invitations, approvals, and permissions<' },
    { from: '>Total Users</div>', to: ' data-i18n="users.total_users">Total Users</div>' },
  ],
  'admin.html': [
    h2lg('System Audit Trail', 'admin.tab_audit'),
  ],
  'ai-approvals.html': [
    setI18n('<h1 class="text-2xl font-semibold text-gray-900">', 'ai_approvals.title', 'AI Approvals Queue'),
  ],
  'ai-ops.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'ai_ops.title', 'AI Operations'),
    { from: '>Token usage, cost trends, latency, and error telemetry across all AI agents.<', to: ' data-i18n="ai_ops.subtitle">Token usage, cost trends, latency, and error telemetry across all AI agents.<' },
  ],
  'health.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900" data-testid="text-page-title">', 'health.title', 'Platform Health Pulse'),
  ],
  'logs.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'logs.title', 'System Event Logs'),
    kpiLabel('Total Logs', 'logs.total_logs'),
    kpiLabel('Last 24 Hours', 'logs.last_24h'),
    kpiLabel('Critical Events', 'logs.critical_events'),
    kpiLabel('AI Actions', 'logs.ai_actions'),
  ],
  'migration.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'migration.title', 'Data Migration Engine'),
    { from: '>Total Jobs</div>', to: ' data-i18n="migration.total_jobs">Total Jobs</div>' },
    { from: '>Records Imported</div>', to: ' data-i18n="migration.records_imported">Records Imported</div>' },
    { from: '>Duplicates Detected</div>', to: ' data-i18n="migration.duplicates_detected">Duplicates Detected</div>' },
  ],
  'onboarding.html': [
    setI18n('<h1 class="text-3xl font-bold mb-2">', 'onboarding.title', 'Welcome to WalaPlus Quality & Investment System'),
    kpiLabel('Total Users', 'onboarding.total_users'),
    kpiLabel('Video Watched', 'onboarding.video_watched'),
    kpiLabel('Tour Completed', 'onboarding.tour_completed'),
    kpiLabel('Skipped', 'onboarding.skipped'),
  ],
  'feedback.html': [
    setI18n('<h1 class="text-3xl font-bold text-gray-900">', 'feedback.title', 'Team Feedback Center'),
    kpiLabel('Total Feedback', 'feedback.total_feedback'),
    kpiLabel('Avg. Rating', 'feedback.avg_rating'),
    kpiLabel('Ease of Use', 'feedback.ease_of_use'),
    kpiLabel('Dashboards Rated', 'feedback.dashboards_rated'),
  ],
  'sop.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'sop.title', 'Standard Operating Procedure'),
  ],
  'pdpl.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'pdpl.title', 'PDPL Compliance Dashboard'),
    { from: '>Personal Data Protection Law - Privacy by Design<', to: ' data-i18n="pdpl.subtitle">Personal Data Protection Law - Privacy by Design<' },
  ],
  'roi.html': [
    kpiLabel('Total Initiatives', 'roi.total_initiatives'),
    kpiLabel('Average ROI', 'roi.avg_roi'),
    kpiLabel('Total NPV', 'roi.total_npv'),
    kpiLabel('Avg Payback', 'roi.avg_payback'),
  ],
  'intake.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'intake.title', 'Manual Audit Intake Workspace'),
  ],
  'infographic.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'infographic.title', 'Infographic Generator'),
  ],
  'guide.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'guide.title', 'Welcome to WalaPlus'),
  ],
  'index.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'index.title', 'Quality Dashboard'),
    { from: '>Overall Quality Score</div>', to: ' data-i18n="index.kpi_quality">Overall Quality Score</div>' },
    { from: '>Critical Issues</div>', to: ' data-i18n="index.kpi_critical">Critical Issues</div>' },
    { from: '>Total Records Audited</div>', to: ' data-i18n="index.kpi_records">Total Records Audited</div>' },
    { from: '>Compliance Rate</div>', to: ' data-i18n="index.kpi_compliance">Compliance Rate</div>' },
  ],
  'accept-invite.html': [
    setI18n('<h1 class="text-2xl font-bold">', 'accept_invite.title', 'WalaPlus Platform'),
    { from: '<h2 class="text-xl font-bold text-gray-900 mb-2">Invalid Invitation</h2>', to: '<h2 class="text-xl font-bold text-gray-900 mb-2" data-i18n="accept_invite.invalid">Invalid Invitation</h2>' },
    { from: '<h2 class="text-xl font-bold text-gray-900">Welcome!</h2>', to: '<h2 class="text-xl font-bold text-gray-900" data-i18n="accept_invite.welcome">Welcome!</h2>' },
  ],
  'a11y.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'a11y.title', 'Accessibility Statement'),
  ],
};

let totalApplied = 0;
let totalSkipped = 0;
let pagesUpdated = 0;

function ensureI18nScript(html) {
  if (html.indexOf('/js/i18n.js') !== -1) return { html: html, changed: false };
  const idx = html.indexOf('</head>');
  if (idx < 0) return { html: html, changed: false };
  const updated = html.slice(0, idx) + I18N_SCRIPT + html.slice(idx);
  return { html: updated, changed: true };
}

function ensureInitBlock(html) {
  if (html.indexOf('WalaPlusI18n.init()') !== -1) return { html: html, changed: false };
  const idx = html.lastIndexOf('</body>');
  if (idx < 0) return { html: html, changed: false };
  const updated = html.slice(0, idx) + INIT_BLOCK + html.slice(idx);
  return { html: updated, changed: true };
}

Object.keys(PAGES).forEach(function (file) {
  const fullPath = path.join(ROOT, file);
  if (!fs.existsSync(fullPath)) {
    console.warn('[skip] missing file:', file);
    return;
  }
  let html = fs.readFileSync(fullPath, 'utf8');
  let pageChanged = false;

  const a = ensureI18nScript(html);
  html = a.html;
  if (a.changed) pageChanged = true;

  const b = ensureInitBlock(html);
  html = b.html;
  if (b.changed) pageChanged = true;

  const reps = PAGES[file];
  let applied = 0, skipped = 0;
  reps.forEach(function (rep) {
    if (html.indexOf(rep.from) !== -1) {
      // Already-translated check: skip if data-i18n is already on this exact node
      if (rep.to && html.indexOf(rep.to) !== -1) {
        // already applied
        return;
      }
      html = html.split(rep.from).join(rep.to);
      applied++;
      pageChanged = true;
    } else {
      skipped++;
    }
  });
  totalApplied += applied;
  totalSkipped += skipped;

  if (pageChanged) {
    fs.writeFileSync(fullPath, html, 'utf8');
    pagesUpdated++;
    console.log('[updated]', file, 'applied=' + applied, 'skipped=' + skipped);
  } else {
    console.log('[no-op]  ', file);
  }
});

console.log('---');
console.log('Pages updated:', pagesUpdated, 'Total replacements applied:', totalApplied, 'skipped:', totalSkipped);
