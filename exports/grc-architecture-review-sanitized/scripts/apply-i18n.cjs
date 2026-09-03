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
function h3xl(text, key) { return section('h3', 'text-xl font-semibold text-gray-900', text, key); }
function h3bold(text, key) { return section('h3', 'text-lg font-bold text-gray-900', text, key); }

// Table header helpers (left & center align variants used across the dashboard)
function thLeft(text, key) {
  return {
    from: '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">' + text + '</th>',
    to: '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase" data-i18n="' + key + '">' + text + '</th>',
  };
}
function thCenter(text, key) {
  return {
    from: '<th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">' + text + '</th>',
    to: '<th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase" data-i18n="' + key + '">' + text + '</th>',
  };
}

// Form label helpers
function lbl(text, key) {
  return {
    from: '<label class="block text-sm font-medium text-gray-700 mb-1">' + text + '</label>',
    to: '<label class="block text-sm font-medium text-gray-700 mb-1" data-i18n="' + key + '">' + text + '</label>',
  };
}
function lblPlain(text, key) {
  return {
    from: '<label class="block text-sm font-medium text-gray-700">' + text + '</label>',
    to: '<label class="block text-sm font-medium text-gray-700" data-i18n="' + key + '">' + text + '</label>',
  };
}
function lblGray(text, key) {
  return {
    from: '<label class="block text-sm text-gray-600 mb-1">' + text + '</label>',
    to: '<label class="block text-sm text-gray-600 mb-1" data-i18n="' + key + '">' + text + '</label>',
  };
}
function lblColored(cls, text, key) {
  return {
    from: '<label class="' + cls + '">' + text + '</label>',
    to: '<label class="' + cls + '" data-i18n="' + key + '">' + text + '</label>',
  };
}

// <option> wrappers
function opt(value, text, key) {
  return {
    from: '<option value="' + value + '">' + text + '</option>',
    to: '<option value="' + value + '" data-i18n="' + key + '">' + text + '</option>',
  };
}
function optSelected(value, text, key) {
  return {
    from: '<option value="' + value + '" selected>' + text + '</option>',
    to: '<option value="' + value + '" selected data-i18n="' + key + '">' + text + '</option>',
  };
}
function optEmpty(text, key) {
  return {
    from: '<option value="">' + text + '</option>',
    to: '<option value="" data-i18n="' + key + '">' + text + '</option>',
  };
}

// <button type="submit"> wrapper
function btnSubmit(cls, text, key) {
  return {
    from: '<button type="submit" class="' + cls + '">' + text + '</button>',
    to: '<button type="submit" class="' + cls + '" data-i18n="' + key + '">' + text + '</button>',
  };
}

// label with mb-2 instead of mb-1
function lblMb2(text, key) {
  return {
    from: '<label class="block text-sm font-medium text-gray-700 mb-2">' + text + '</label>',
    to: '<label class="block text-sm font-medium text-gray-700 mb-2" data-i18n="' + key + '">' + text + '</label>',
  };
}

// label without text-gray-700 (e.g. users.html / qms.html modals)
function lblNoColor(text, key) {
  return {
    from: '<label class="block text-sm font-medium mb-1">' + text + '</label>',
    to: '<label class="block text-sm font-medium mb-1" data-i18n="' + key + '">' + text + '</label>',
  };
}

// label pattern used in external-audits.html modals
function lblFontMed(text, key) {
  return {
    from: '<label class="block font-medium text-gray-700">' + text + '</label>',
    to: '<label class="block font-medium text-gray-700" data-i18n="' + key + '">' + text + '</label>',
  };
}

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
    // Section h2 titles (Audit Schedule, Findings by Severity, Upcoming Audits, Findings Register)
    h2lg('Audit Schedule', 'audits.audit_schedule'),
    section('h2', 'text-lg font-semibold text-gray-900 mb-4', 'Findings by Severity', 'audits.findings_severity'),
    section('h2', 'text-lg font-semibold text-gray-900 mb-4', 'Upcoming Audits', 'audits.upcoming_audits'),
    h2lg('Findings Register', 'audits.findings_register'),
    // Modal h3 titles
    h3lg('Schedule New Audit', 'audits.schedule_audit'),
    h3lg('Record Audit Finding', 'audits.record_finding'),
    h3bold('Manual Audit Intake', 'audits.manual_audit_intake'),
    // Annual programme table headers
    thLeft('Code', 'audits.col_code'),
    thLeft('Audit', 'audits.col_audit'),
    thCenter('Type', 'audits.col_type'),
    thCenter('Start Date', 'audits.col_start_date'),
    thCenter('Findings', 'audits.col_findings'),
    thCenter('Status', 'audits.col_status'),
    thCenter('Actions', 'audits.col_actions'),
    // Findings register table headers
    thLeft('Finding', 'audits.col_finding'),
    thCenter('Severity', 'audits.col_severity'),
    thLeft('Responsible', 'audits.col_responsible'),
    thCenter('Due Date', 'audits.col_due_date'),
    // Schedule audit form labels
    lbl('Audit Code *', 'audits.f_audit_code'),
    lbl('Audit Type *', 'audits.f_audit_type'),
    lbl('Audit Title *', 'audits.f_audit_title'),
    lbl('Description', 'audits.f_description'),
    lbl('Standard/Framework', 'audits.f_standard'),
    lbl('Lead Auditor', 'audits.f_lead_auditor'),
    lbl('Auditee Department', 'audits.f_auditee_dept'),
    lbl('Auditee Contact', 'audits.f_auditee_contact'),
    lbl('Planned Start Date', 'audits.f_planned_start'),
    lbl('Planned End Date', 'audits.f_planned_end'),
    lbl('Scope', 'audits.f_scope'),
    // Record finding form labels
    lbl('Finding Code *', 'audits.f_finding_code'),
    lbl('Audit *', 'audits.f_audit_required'),
    lbl('Finding Title *', 'audits.f_finding_title'),
    lbl('Description *', 'audits.f_description_required'),
    lbl('Category *', 'audits.f_category_required'),
    lbl('Severity *', 'audits.f_severity_required'),
    lbl('Responsible Party', 'audits.f_responsible_party'),
    lbl('Due Date', 'audits.f_due_date'),
    lbl('Control Reference', 'audits.f_control_ref'),
    lbl('Evidence Description', 'audits.f_evidence_desc'),
    lbl('Corrective Action', 'audits.f_corrective_action'),
    // Manual intake form labels
    lblPlain('Audit Title *', 'audits.f_audit_title'),
    lblPlain('Source Department *', 'audits.f_source_dept'),
    lblPlain('Audit Date', 'audits.f_audit_date'),
    lblPlain('Report File *', 'audits.f_report_file'),
    // Submit buttons
    btnSubmit('px-4 py-2 bg-purple-700 text-white rounded-lg hover:bg-purple-800', 'Schedule Audit', 'audits.schedule_btn'),
    btnSubmit('px-4 py-2 bg-purple-700 text-white rounded-lg hover:bg-purple-800', 'Record Finding', 'audits.record_btn'),
    { from: '<button type="submit" class="px-4 py-2 text-sm bg-indigo-700 text-white rounded-lg hover:bg-indigo-800">Upload &amp; Extract</button>',
      to: '<button type="submit" class="px-4 py-2 text-sm bg-indigo-700 text-white rounded-lg hover:bg-indigo-800" data-i18n="audits.upload_extract">Upload &amp; Extract</button>' },
    // Filter & form select options
    optEmpty('All Status', 'common.all_status'),
    optEmpty('All Severity', 'common.all_severity'),
    optEmpty('Select audit', 'audits.select_audit'),
    opt('planned', 'Planned', 'audits.planned'),
    opt('in_progress', 'In Progress', 'common.in_progress'),
    opt('fieldwork_complete', 'Fieldwork Complete', 'audits.s_fieldwork_complete'),
    opt('report_draft', 'Report Draft', 'audits.s_report_draft'),
    opt('closed', 'Closed', 'common.closed'),
    opt('critical', 'Critical', 'common.critical'),
    opt('major', 'Major', 'common.major'),
    optSelected('minor', 'Minor', 'common.minor'),
    opt('observation', 'Observation', 'common.observation'),
    opt('open', 'Open', 'common.open'),
    opt('pending_verification', 'Pending Verification', 'common.pending_verification'),
    opt('verified_closed', 'Verified Closed', 'common.verified_closed'),
    opt('internal', 'Internal Audit', 'audits.t_internal'),
    opt('external', 'External Audit', 'audits.t_external'),
    opt('regulatory', 'Regulatory Audit', 'audits.t_regulatory'),
    opt('certification', 'Certification Audit', 'audits.t_certification'),
    opt('surveillance', 'Surveillance Audit', 'audits.t_surveillance'),
    opt('nonconformity', 'Nonconformity', 'audits.c_nonconformity'),
    opt('opportunity_for_improvement', 'Opportunity for Improvement', 'audits.c_opportunity'),
    opt('good_practice', 'Good Practice', 'audits.c_good_practice'),
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
    // Modal h3 titles (kpis.html uses id="modalTitle" for one)
    { from: '<h3 id="modalTitle" class="text-lg font-semibold text-gray-900">Add KPI</h3>',
      to: '<h3 id="modalTitle" class="text-lg font-semibold text-gray-900" data-i18n="kpis.add_kpi_modal">Add KPI</h3>' },
    h3lg('KPI Details', 'kpis.kpi_details'),
    // Form labels (Add KPI modal)
    lbl('KPI Name', 'kpis.f_kpi_name'),
    lbl('KPI Code', 'kpis.f_kpi_code'),
    lbl('Description', 'kpis.f_description'),
    lbl('Owner', 'kpis.f_owner'),
    lbl('Category', 'kpis.f_category'),
    lbl('Formula', 'kpis.f_formula'),
    lbl('Unit', 'kpis.f_unit'),
    lbl('Frequency', 'kpis.f_frequency'),
    lbl('Target', 'kpis.f_target'),
    lbl('Green ≥', 'kpis.f_green'),
    lbl('Amber ≥', 'kpis.f_amber'),
    lbl('Red Below', 'kpis.f_red'),
    lbl('Direction', 'kpis.f_direction'),
    // Submit button
    btnSubmit('px-4 py-2 bg-purple-700 text-white rounded-lg hover:bg-purple-800', 'Save KPI', 'kpis.save_kpi'),
    // Filter & form select options
    optEmpty('All Owners', 'kpis.all_owners'),
    optEmpty('All Statuses', 'common.all_statuses'),
    opt('quality_manager', 'Sara (Quality Manager)', 'kpis.o_quality_manager'),
    opt('grc_manager', 'Maram (GRC Manager)', 'kpis.o_grc_manager'),
    opt('governance_officer', 'Sample User (Governance Officer)', 'kpis.o_governance_officer'),
    opt('shared', 'Shared KPIs', 'kpis.o_shared_kpis'),
    opt('shared', 'Shared', 'kpis.o_shared'),
    opt('green', 'On Target', 'kpis.s_on_target'),
    opt('yellow', 'At Risk', 'kpis.s_at_risk'),
    opt('red', 'Below Target', 'kpis.s_below_target'),
    opt('governance', 'Governance', 'kpis.c_governance'),
    opt('risk', 'Risk', 'kpis.c_risk'),
    opt('compliance', 'Compliance', 'kpis.c_compliance'),
    opt('audit', 'Audit', 'kpis.c_audit'),
    opt('quality', 'Quality', 'kpis.c_quality'),
    opt('vendor', 'Vendor', 'kpis.c_vendor'),
    opt('training', 'Training', 'kpis.c_training'),
    opt('ai', 'AI', 'kpis.c_ai'),
    opt('daily', 'Daily', 'kpis.fr_daily'),
    opt('weekly', 'Weekly', 'kpis.fr_weekly'),
    optSelected('monthly', 'Monthly', 'kpis.fr_monthly'),
    opt('quarterly', 'Quarterly', 'kpis.fr_quarterly'),
    opt('annual', 'Annual', 'kpis.fr_annual'),
    opt('higher_is_better', 'Higher is Better', 'kpis.d_higher'),
    opt('lower_is_better', 'Lower is Better', 'kpis.d_lower'),
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
    // Modal h3 titles
    h3lg('Add New Risk', 'risks.add_new_risk'),
    h3lg('Risk Details', 'risks.risk_details'),
    // Risk register table headers
    thLeft('ID', 'risks.col_id'),
    thLeft('Risk Title', 'risks.col_risk_title'),
    thLeft('Category', 'common.category'),
    thLeft('Owner', 'common.owner'),
    thCenter('Score', 'common.score'),
    thCenter('Level', 'risks.col_level'),
    thCenter('Treatment', 'risks.col_treatment'),
    thCenter('Status', 'common.status'),
    thCenter('Actions', 'common.actions'),
    // From / To labels above filters
    { from: '<label class="text-gray-500">From:</label>', to: '<label class="text-gray-500" data-i18n="common.from">From:</label>' },
    { from: '<label class="text-gray-500">To:</label>', to: '<label class="text-gray-500" data-i18n="common.to">To:</label>' },
    // Form labels - add risk modal
    lbl('Risk Title *', 'risks.f_risk_title'),
    lbl('Description', 'risks.f_description'),
    lbl('Category *', 'risks.f_category'),
    lbl('Risk Source', 'risks.f_risk_source'),
    lbl('Impact Score (1-5) *', 'risks.f_impact'),
    lbl('Likelihood Score (1-5) *', 'risks.f_likelihood'),
    lbl('Risk Owner', 'risks.f_owner'),
    lbl('Owner Department', 'risks.f_owner_dept'),
    lbl('Treatment Strategy', 'risks.f_treatment_strategy'),
    lbl('Review Frequency', 'risks.f_review_frequency'),
    lbl('Treatment Description', 'risks.f_treatment_desc'),
    // Submit button
    btnSubmit('px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700', 'Add Risk', 'risks.add_risk'),
    // Filter & form select options
    optEmpty('All Status', 'common.all_status'),
    optEmpty('All Categories', 'common.all_categories'),
    optEmpty('All Levels', 'common.all_levels'),
    optEmpty('Select category', 'risks.select_category'),
    optEmpty('Select impact', 'risks.select_impact'),
    optEmpty('Select likelihood', 'risks.select_likelihood'),
    optEmpty('Select department', 'risks.select_department'),
    opt('open', 'Open', 'common.open'),
    opt('in_treatment', 'In Treatment', 'risks.s_in_treatment'),
    opt('monitoring', 'Monitoring', 'risks.s_monitoring'),
    opt('escalated', 'Escalated', 'risks.s_escalated'),
    opt('closed', 'Closed', 'common.closed'),
    opt('critical', 'Critical', 'common.critical'),
    opt('high', 'High', 'common.high'),
    opt('medium', 'Medium', 'common.medium'),
    opt('low', 'Low', 'common.low'),
    opt('operational', 'Operational', 'risks.cat_operational'),
    opt('legal', 'Legal', 'risks.cat_legal'),
    opt('financial', 'Financial', 'risks.cat_financial'),
    opt('data_privacy', 'Data Privacy (PDPL)', 'risks.cat_data_privacy'),
    opt('information_security', 'Information Security', 'risks.cat_info_security'),
    opt('fraud', 'Fraud', 'risks.cat_fraud'),
    opt('vendor', 'Vendor/Third-Party', 'risks.cat_vendor'),
    opt('1', '1 - Negligible', 'risks.i_1'),
    opt('2', '2 - Minor', 'risks.i_2'),
    opt('3', '3 - Moderate', 'risks.i_3'),
    opt('4', '4 - Significant', 'risks.i_4'),
    opt('5', '5 - Catastrophic', 'risks.i_5'),
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
    // Compliance status pills (KPI tiles)
    { from: '>Compliant</div>', to: ' data-i18n="compliance.compliant">Compliant</div>' },
    { from: '>Partially Compliant</div>', to: ' data-i18n="compliance.partially_compliant">Partially Compliant</div>' },
    { from: '>Non-Compliant</div>', to: ' data-i18n="compliance.non_compliant">Non-Compliant</div>' },
    { from: '>Not Assessed</div>', to: ' data-i18n="compliance.not_assessed">Not Assessed</div>' },
    // Modal h3 titles
    h3xl('Add Compliance Obligation', 'compliance.add_obligation_modal'),
    h3xl('Record Compliance Assessment', 'compliance.record_assessment'),
    // Obligations Register table headers
    thLeft('Code', 'compliance.col_code'),
    thLeft('Obligation', 'compliance.col_obligation'),
    thLeft('Domain', 'compliance.col_domain'),
    thCenter('Priority', 'compliance.col_priority'),
    thCenter('Status', 'compliance.col_status'),
    thCenter('Score', 'compliance.col_score'),
    thLeft('Last Assessed', 'compliance.col_last_assessed'),
    thCenter('Actions', 'compliance.col_actions'),
    // Form labels - add obligation modal
    lbl('Obligation Code *', 'compliance.f_obligation_code'),
    lbl('Regulation *', 'compliance.f_regulation'),
    lbl('Article Reference', 'compliance.f_article_ref'),
    lbl('Title *', 'compliance.f_title'),
    lbl('Description *', 'compliance.f_description'),
    lbl('Priority *', 'compliance.f_priority'),
    lbl('Requirement Type', 'compliance.f_requirement_type'),
    lbl('Frequency', 'compliance.f_frequency'),
    lbl('Responsible Department', 'compliance.f_responsible_dept'),
    lbl('Responsible Role', 'compliance.f_responsible_role'),
    lbl('Evidence Requirements', 'compliance.f_evidence_req'),
    // Form labels - record assessment modal
    lbl('Compliance Status *', 'compliance.f_compliance_status'),
    lbl('Assessed By *', 'compliance.f_assessed_by'),
    lbl('Evidence Provided', 'compliance.f_evidence_provided'),
    lbl('Gaps Identified', 'compliance.f_gaps'),
    lbl('Comments', 'compliance.f_comments'),
    // Submit button
    btnSubmit('px-4 py-2 bg-green-700 text-white rounded-lg hover:bg-green-800', 'Create Obligation', 'compliance.create_obligation'),
    // Filter & form select options
    optEmpty('All Statuses', 'common.all_statuses'),
    optEmpty('All Regulations', 'compliance.all_regulations'),
    optEmpty('Select regulation', 'compliance.select_regulation'),
    opt('compliant', 'Compliant', 'compliance.s_compliant'),
    opt('in_progress', 'In Progress', 'compliance.s_in_progress'),
    opt('non_compliant', 'Non-Compliant', 'compliance.s_non_compliant'),
    opt('pending', 'Pending', 'compliance.s_pending'),
    opt('partially_compliant', 'Partially Compliant', 'compliance.s_partially_compliant'),
    opt('not_assessed', 'Not Assessed', 'compliance.s_not_assessed'),
    opt('critical', 'Critical', 'compliance.p_critical'),
    opt('high', 'High', 'compliance.p_high'),
    optSelected('medium', 'Medium', 'compliance.p_medium'),
    opt('low', 'Low', 'compliance.p_low'),
    opt('mandatory', 'Mandatory', 'compliance.rt_mandatory'),
    opt('recommended', 'Recommended', 'compliance.rt_recommended'),
    opt('optional', 'Optional', 'compliance.rt_optional'),
    opt('continuous', 'Continuous', 'compliance.fr_continuous'),
    opt('monthly', 'Monthly', 'compliance.fr_monthly'),
    opt('quarterly', 'Quarterly', 'compliance.fr_quarterly'),
    optSelected('annual', 'Annual', 'compliance.fr_annual'),
  ],
  'crm.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'crm.title', 'CRM Data Hub'),
    { from: '<p class="text-gray-500 text-sm mt-1">Live CRM data enriched with quality scores &amp; duplicate detection</p>', to: '<p class="text-gray-500 text-sm mt-1" data-i18n="crm.subtitle">Live CRM data enriched with quality scores &amp; duplicate detection</p>' },
    { from: 'data-testid="tab-leads">Leads</button>', to: 'data-testid="tab-leads" data-i18n="crm.tab_leads">Leads</button>' },
    { from: 'data-testid="tab-deals">Deals</button>', to: 'data-testid="tab-deals" data-i18n="crm.tab_deals">Deals</button>' },
    { from: 'data-testid="tab-contacts">Contacts</button>', to: 'data-testid="tab-contacts" data-i18n="crm.tab_contacts">Contacts</button>' },
    { from: 'data-testid="tab-accounts">Accounts</button>', to: 'data-testid="tab-accounts" data-i18n="crm.tab_accounts">Accounts</button>' },
    { from: '<span>Highlight Issues</span>', to: '<span data-i18n="crm.highlight_issues">Highlight Issues</span>' },
    { from: '<span>Hide Junk</span>', to: '<span data-i18n="crm.hide_junk">Hide Junk</span>' },
    { from: '<h2 class="text-lg font-semibold text-gray-900 mb-3">How to Read This View</h2>', to: '<h2 class="text-lg font-semibold text-gray-900 mb-3" data-i18n="crm.sec_how_to_read">How to Read This View</h2>' },
    { from: '<p class="text-gray-500">Loading CRM data...</p>', to: '<p class="text-gray-500" data-i18n="crm.loading_data">Loading CRM data...</p>' },
    { from: '<p class="text-sm text-gray-600">Cross-referencing with Duplicate Radar...</p>', to: '<p class="text-sm text-gray-600" data-i18n="crm.crossref">Cross-referencing with Duplicate Radar...</p>' },
    { from: '>Records Shown</div>', to: ' data-i18n="crm.records_shown">Records Shown</div>' },
    { from: '>Clean Records</div>', to: ' data-i18n="crm.clean_records">Clean Records</div>' },
    { from: '>With Issues</div>', to: ' data-i18n="crm.with_issues">With Issues</div>' },
    { from: '>Junk / Spam</div>', to: ' data-i18n="crm.junk_spam">Junk / Spam</div>' },
    { from: '>In Dup. Clusters</div>', to: ' data-i18n="crm.in_dup_clusters">In Dup. Clusters</div>' },
    h2lg('How to Read This View', 'crm.sec_how_to_read'),
    { from: '<h3 class="font-medium text-gray-700 mb-2">Quality Scores</h3>', to: '<h3 class="font-medium text-gray-700 mb-2" data-i18n="crm.sec_quality_scores">Quality Scores</h3>' },
    { from: '<h3 class="font-medium text-gray-700 mb-2">Duplicate Indicators</h3>', to: '<h3 class="font-medium text-gray-700 mb-2" data-i18n="crm.sec_duplicate_indicators">Duplicate Indicators</h3>' },
    { from: '<h3 class="font-medium text-gray-700 mb-2">Row Highlights</h3>', to: '<h3 class="font-medium text-gray-700 mb-2" data-i18n="crm.sec_row_highlights">Row Highlights</h3>' },
    { from: '<h3 id="detailTitle" class="text-lg font-bold text-gray-900">Record Details</h3>', to: '<h3 id="detailTitle" class="text-lg font-bold text-gray-900" data-i18n="crm.sec_record_details">Record Details</h3>' },
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
    { from: '<h3 class="text-lg font-semibold mb-4">Duplicates by Source</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="duplicates.sec_by_source">Duplicates by Source</h3>' },
    { from: '<h3 class="text-lg font-semibold mb-4">Similarity Score Distribution</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="duplicates.sec_similarity">Similarity Score Distribution</h3>' },
    { from: '<h3 class="text-lg font-semibold">Top Match Signal Sources</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="duplicates.sec_top_signals">Top Match Signal Sources</h3>' },
    { from: '<h3 class="text-lg font-semibold">Top Clusters by Pipeline Inflation</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="duplicates.sec_top_clusters">Top Clusters by Pipeline Inflation</h3>' },
    { from: '<h3 class="text-lg font-semibold mb-4">Data Hygiene KPIs</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="duplicates.sec_hygiene">Data Hygiene KPIs</h3>' },
    kpiLabelDiv('Duplicate Lead Rate', 'duplicates.kpi_dup_lead_rate'),
    kpiLabelDiv('Duplicate Deal Rate', 'duplicates.kpi_dup_deal_rate'),
    kpiLabelDiv('Domains with Multiple Deals', 'duplicates.kpi_multi_deals'),
    kpiLabelDiv('Active Clusters', 'duplicates.kpi_active_clusters'),
    lbl('Domain', 'duplicates.f_domain'),
    lbl('Mobile / Phone', 'duplicates.f_phone'),
    lbl('Company Name', 'duplicates.f_company'),
    lbl('Contract / Record #', 'duplicates.f_contract'),
    lbl('Email Address', 'duplicates.f_email'),
    lbl('Lead/Deal Name', 'duplicates.f_lead_name'),
    lbl('Owner Email', 'duplicates.f_owner'),
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
    // Modal h3 titles
    h3xl('Register New Vendor', 'vendors.register_new'),
    h3xl('Vendor Risk Assessment', 'vendors.assessment_modal'),
    // Vendor registry table headers
    thLeft('Code', 'vendors.col_code'),
    thLeft('Vendor', 'vendors.col_vendor'),
    thCenter('Category', 'vendors.col_category'),
    thCenter('Criticality', 'vendors.col_criticality'),
    thCenter('Risk Score', 'vendors.col_risk_score'),
    thCenter('Status', 'vendors.col_status'),
    // Remediation tracker table headers
    thLeft('Remediation', 'vendors.col_remediation'),
    thCenter('Priority', 'vendors.col_priority'),
    thLeft('Assigned To', 'vendors.col_assigned_to'),
    thCenter('Due Date', 'vendors.col_due_date'),
    // Form labels - register vendor modal
    lbl('Vendor Code *', 'vendors.f_vendor_code'),
    lbl('Vendor Name *', 'vendors.f_vendor_name'),
    lbl('Description', 'vendors.f_description'),
    lbl('Category *', 'vendors.f_category'),
    lbl('Criticality *', 'vendors.f_criticality'),
    lbl('Data Access Level', 'vendors.f_data_access'),
    lbl('Contract Start', 'vendors.f_contract_start'),
    lbl('Contract End', 'vendors.f_contract_end'),
    lbl('Contract Value', 'vendors.f_contract_value'),
    lbl('Contact Name', 'vendors.f_contact_name'),
    lbl('Contact Email', 'vendors.f_contact_email'),
    lbl('Country', 'vendors.f_country'),
    lbl('Services Provided', 'vendors.f_services'),
    lbl('Owner Name', 'vendors.f_owner_name'),
    lbl('Owner Department', 'vendors.f_owner_dept'),
    // Form labels - assessment modal
    lbl('Vendor *', 'vendors.f_vendor_required'),
    lbl('Assessment Type *', 'vendors.f_assessment_type'),
    lbl('Assessor *', 'vendors.f_assessor'),
    lbl('Next Assessment Date', 'vendors.f_next_assessment'),
    lblGray('Security', 'vendors.f_security'),
    lblGray('Financial', 'vendors.f_financial'),
    lblGray('Operational', 'vendors.f_operational'),
    lblGray('Compliance', 'vendors.f_compliance'),
    lbl('Security Findings', 'vendors.f_security_findings'),
    lbl('Financial Findings', 'vendors.f_financial_findings'),
    lbl('Operational Findings', 'vendors.f_operational_findings'),
    lbl('Compliance Findings', 'vendors.f_compliance_findings'),
    lbl('Recommendations', 'vendors.f_recommendations'),
    lbl('Status', 'vendors.f_status'),
    // Submit buttons
    btnSubmit('px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700', 'Register Vendor', 'vendors.register_vendor'),
    // Filter & form select options
    optEmpty('All Criticality', 'vendors.all_criticality'),
    optEmpty('All Status', 'vendors.all_status'),
    optEmpty('All Priority', 'vendors.all_priority'),
    optEmpty('Select vendor...', 'vendors.select_vendor'),
    opt('critical', 'Critical', 'common.critical'),
    opt('high', 'High', 'common.high'),
    optSelected('medium', 'Medium', 'common.medium'),
    opt('medium', 'Medium', 'common.medium'),
    opt('low', 'Low', 'common.low'),
    opt('active', 'Active', 'vendors.s_active'),
    opt('pending_approval', 'Pending', 'vendors.s_pending'),
    opt('probation', 'Probation', 'vendors.s_probation'),
    opt('open', 'Open', 'common.open'),
    opt('in_progress', 'In Progress', 'common.in_progress'),
    opt('pending_verification', 'Pending Verification', 'common.pending_verification'),
    opt('closed', 'Closed', 'common.closed'),
    opt('technology', 'Technology', 'vendors.cat_technology'),
    opt('consulting', 'Consulting', 'vendors.cat_consulting'),
    opt('manufacturing', 'Manufacturing', 'vendors.cat_manufacturing'),
    opt('logistics', 'Logistics', 'vendors.cat_logistics'),
    opt('financial', 'Financial', 'vendors.cat_financial'),
    opt('professional_services', 'Professional Services', 'vendors.cat_professional'),
    opt('other', 'Other', 'vendors.cat_other'),
    opt('none', 'None', 'vendors.da_none'),
    opt('limited', 'Limited', 'vendors.da_limited'),
    opt('sensitive', 'Sensitive', 'vendors.da_sensitive'),
    opt('initial', 'Initial Assessment', 'vendors.at_initial'),
    opt('periodic', 'Periodic Review', 'vendors.at_periodic'),
    opt('triggered', 'Triggered (Incident)', 'vendors.at_triggered'),
    opt('exit', 'Exit Assessment', 'vendors.at_exit'),
  ],
  'reviews.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'reviews.title', 'Management Review'),
    { from: '>ISO 9001 Clause 9.3 — Management review meetings, decisions, and action tracking<', to: ' data-i18n="reviews.subtitle">ISO 9001 Clause 9.3 — Management review meetings, decisions, and action tracking<' },
    { from: '>Total Actions</div>', to: ' data-i18n="reviews.total_actions">Total Actions</div>' },
    { from: '<h2 class="text-lg font-bold" id="modalTitle">New Management Review</h2>', to: '<h2 class="text-lg font-bold" id="modalTitle" data-i18n="reviews.new_review_modal">New Management Review</h2>' },
    { from: '<h2 class="text-lg font-bold" id="detailTitle">Review Details</h2>', to: '<h2 class="text-lg font-bold" id="detailTitle" data-i18n="reviews.review_details">Review Details</h2>' },
    thLeft('Review #', 'reviews.col_review_no'),
    thLeft('Title', 'common.title'),
    thLeft('Date', 'common.date'),
    thLeft('Chair', 'reviews.col_chair'),
    thLeft('Status', 'common.status'),
    thLeft('Actions', 'common.actions'),
    thLeft('Next Review', 'reviews.col_next_review'),
    lbl('Title *', 'reviews.f_title'),
    lbl('Review Date *', 'reviews.f_review_date'),
    lbl('Chair *', 'reviews.f_chair'),
    lbl('Status', 'reviews.f_status'),
    lbl('Attendees (comma-separated)', 'reviews.f_attendees'),
    lbl('Next Review Date', 'reviews.f_next_review'),
    lbl('Minutes / Notes', 'reviews.f_minutes'),
    lbl('Output Summary / Decisions', 'reviews.f_output'),
    btnSubmit('px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700', 'Save Review', 'reviews.save_review'),
    optEmpty('All Statuses', 'reviews.all_statuses'),
    optEmpty('All Years', 'reviews.all_years'),
    opt('planned', 'Planned', 'reviews.s_planned'),
    opt('in_progress', 'In Progress', 'common.in_progress'),
    opt('completed', 'Completed', 'reviews.completed'),
    opt('cancelled', 'Cancelled', 'reviews.s_cancelled'),
  ],
  'external-audits.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'external_audits.title', 'External Audits'),
    { from: '>Certificate Register</h2>', to: ' data-i18n="external_audits.cert_register">Certificate Register</h2>' },
    { from: '>Readiness Checklist</h2>', to: ' data-i18n="external_audits.readiness_checklist">Readiness Checklist</h2>' },
    h3bold('New External Audit', 'external_audits.new_external_modal'),
    h3bold('Register Certificate', 'external_audits.register_cert_modal'),
    lblFontMed('Title *', 'external_audits.f_title'),
    lblFontMed('Kind *', 'external_audits.f_kind'),
    lblFontMed('Standard', 'external_audits.f_standard'),
    lblFontMed('Certification Body', 'external_audits.f_cert_body'),
    lblFontMed('Auditor', 'external_audits.f_auditor'),
    lblFontMed('Planned Start', 'external_audits.f_planned_start'),
    lblFontMed('Planned End', 'external_audits.f_planned_end'),
    lblFontMed('Scope', 'external_audits.f_scope'),
    lblFontMed('Audit *', 'external_audits.f_audit'),
    lblFontMed('Cert # *', 'external_audits.f_cert_no'),
    lblFontMed('Standard *', 'external_audits.f_standard_req'),
    lblFontMed('Certification Body *', 'external_audits.f_cert_body_req'),
    lblFontMed('Issued', 'external_audits.f_issued'),
    lblFontMed('Expires', 'external_audits.f_expires'),
    btnSubmit('px-4 py-2 bg-purple-700 text-white rounded-lg hover:bg-purple-800', 'Create', 'external_audits.btn_create'),
    btnSubmit('px-4 py-2 bg-indigo-700 text-white rounded-lg hover:bg-indigo-800', 'Register', 'external_audits.register_btn'),
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
    h3lg('Create New Document', 'policies.create_doc'),
    h3lg('Document Details', 'policies.doc_details'),
    thLeft('Doc #', 'policies.col_doc_no'),
    thLeft('Title', 'common.title'),
    thLeft('Category', 'common.category'),
    thCenter('Type', 'common.type'),
    thCenter('Ver', 'policies.col_ver'),
    thCenter('Confid.', 'policies.col_confid'),
    thCenter('Status', 'common.status'),
    thCenter('Actions', 'common.actions'),
    lbl('Document Type *', 'policies.f_doc_type'),
    lbl('Document Number *', 'policies.f_doc_number'),
    lbl('Policy Number *', 'policies.f_policy_number'),
    lbl('Category *', 'policies.f_category'),
    lbl('Title *', 'policies.f_title'),
    lbl('Description', 'policies.f_description'),
    lbl('Owner Name', 'policies.f_owner_name'),
    lbl('Owner Department', 'policies.f_owner_dept'),
    lbl('Confidentiality', 'policies.f_confidentiality'),
    lbl('Retention Period', 'policies.f_retention'),
    lbl('Tags', 'policies.f_tags'),
    lbl('Document Content', 'policies.f_content'),
    lbl('Ack. Frequency', 'policies.f_ack_frequency'),
    { from: '<button type="submit" class="px-4 py-2 bg-blue-700 text-white rounded-lg hover:bg-blue-800" data-testid="button-submit-create">Create Document</button>', to: '<button type="submit" class="px-4 py-2 bg-blue-700 text-white rounded-lg hover:bg-blue-800" data-testid="button-submit-create" data-i18n="policies.create_btn">Create Document</button>' },
    optEmpty('All Types', 'policies.all_types'),
    optEmpty('All Status', 'policies.all_status'),
    optEmpty('All Categories', 'policies.all_categories'),
    opt('policy', 'Policy', 'policies.t_policy'),
    opt('procedure', 'Procedure', 'policies.t_procedure'),
    opt('work_instruction', 'Work Instruction', 'policies.t_work_instruction'),
    opt('sop', 'SOP', 'policies.t_sop'),
    opt('form', 'Form', 'policies.t_form'),
    opt('template', 'Template', 'policies.t_template'),
    opt('manual', 'Manual', 'policies.t_manual'),
    opt('guideline', 'Guideline', 'policies.t_guideline'),
    opt('archived', 'Archived', 'policies.s_archived'),
    opt('governance', 'Governance', 'policies.cat_governance'),
    opt('operational', 'Operational', 'policies.cat_operational'),
    opt('hr', 'HR', 'policies.cat_hr'),
    opt('it', 'IT', 'policies.cat_it'),
    opt('compliance', 'Compliance', 'policies.cat_compliance'),
    opt('security', 'Security', 'policies.cat_security'),
    opt('quality', 'Quality', 'policies.cat_quality'),
    opt('finance', 'Finance', 'policies.cat_finance'),
  ],
  'qms.html': [
    kpiLabel('Open CAPA', 'qms.kpi_open_capa'),
    kpiLabel('Open NC', 'qms.kpi_open_nc'),
    kpiLabel('First Pass Yield', 'qms.kpi_fpy'),
    kpiLabel('CAPA Effectiveness', 'qms.kpi_capa_eff'),
    kpiLabel('Pending Triggers', 'qms.kpi_pending_triggers'),
    kpiLabel('Decisions Pending', 'qms.kpi_decisions_pending'),
    kpiLabel('Acknowledged', 'qms.kpi_acknowledged'),
    kpiLabel('Actioned', 'qms.kpi_actioned'),
    h3lg('New Nonconformance', 'qms.new_nc'),
    lbl('Title *', 'qms.f_nc_title'),
    lbl('Description', 'qms.f_nc_description'),
    lbl('Type *', 'qms.f_nc_type'),
    lbl('Severity *', 'qms.f_nc_severity'),
    lbl('Source', 'qms.f_nc_source'),
    lbl('Assigned To', 'qms.f_nc_assigned'),
    { from: '<button type="submit" data-testid="button-submit-nc" class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">Create NC</button>', to: '<button type="submit" data-testid="button-submit-nc" class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700" data-i18n="qms.create_nc">Create NC</button>' },
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
    { from: '<h3 class="text-lg font-semibold text-gray-900 mb-4">Team by Department</h3>', to: '<h3 class="text-lg font-semibold text-gray-900 mb-4" data-i18n="team.sec_by_dept">Team by Department</h3>' },
    { from: '<h3 class="text-lg font-semibold text-gray-900 mb-4">Project Status</h3>', to: '<h3 class="text-lg font-semibold text-gray-900 mb-4" data-i18n="team.sec_project_status">Project Status</h3>' },
    { from: '<h3 class="text-lg font-semibold text-gray-900 mb-4">Team Status</h3>', to: '<h3 class="text-lg font-semibold text-gray-900 mb-4" data-i18n="team.sec_team_status">Team Status</h3>' },
    { from: '<h3 class="text-lg font-semibold text-gray-900 mb-4">Top Performers</h3>', to: '<h3 class="text-lg font-semibold text-gray-900 mb-4" data-i18n="team.sec_top_performers">Top Performers</h3>' },
    h3lg('Team Members', 'team.sec_members'),
    h3lg('Training Courses Catalog', 'team.sec_courses'),
    { from: '<h3 class="text-lg font-semibold text-gray-900 mb-4">Training Compliance Matrix</h3>', to: '<h3 class="text-lg font-semibold text-gray-900 mb-4" data-i18n="team.sec_compliance_matrix">Training Compliance Matrix</h3>' },
    h3lg('Project Assignments', 'team.sec_assignments'),
    thLeft('Name', 'common.name'),
    thLeft('Role', 'common.role'),
    thLeft('Department', 'common.department'),
    thLeft('Status', 'common.status'),
    thLeft('Performance', 'common.performance'),
    thLeft('Training', 'common.training'),
    thLeft('Course Name', 'common.course_name'),
    thLeft('Duration', 'common.duration'),
    thLeft('Passing Score', 'common.passing_score'),
    thLeft('Assigned To', 'common.assigned_to'),
    thLeft('Actions', 'common.actions'),
  ],
  'scorecard.html': [
    setI18n('<h1 id="employeeName" class="text-3xl font-bold text-gray-900">', 'scorecard.title', 'Sample User'),
    { from: '<span class="text-sm text-gray-500 ml-2">Scorecard</span>', to: '<span class="text-sm text-gray-500 ml-2" data-i18n="scorecard.sec_label">Scorecard</span>' },
    { from: '<h3 class="text-lg font-semibold text-gray-700 mb-4 text-center">Weighted Score</h3>', to: '<h3 class="text-lg font-semibold text-gray-700 mb-4 text-center" data-i18n="scorecard.sec_weighted">Weighted Score</h3>' },
    { from: '<span class="text-sm text-gray-500">Weighted %</span>', to: '<span class="text-sm text-gray-500" data-i18n="scorecard.kpi_weighted_pct">Weighted %</span>' },
    { from: '<h3 class="text-lg font-semibold text-gray-700 mb-4 text-center">Overall Score</h3>', to: '<h3 class="text-lg font-semibold text-gray-700 mb-4 text-center" data-i18n="scorecard.sec_overall">Overall Score</h3>' },
    { from: '<span class="text-sm text-gray-500">Average %</span>', to: '<span class="text-sm text-gray-500" data-i18n="scorecard.kpi_avg_pct">Average %</span>' },
    h3lg('KPI Status Summary', 'scorecard.sec_kpi_summary'),
  ],
  'tablef.html': [
    ...tabBtn('overview', 'Overview', 'tablef.tab_overview'),
    ...tabBtn('department', 'Department View', 'tablef.tab_dept'),
    ...tabBtn('kpimanager', 'KPI Manager', 'tablef.tab_kpi_mgr'),
    ...tabBtn('insights', 'AI Insights', 'tablef.tab_ai'),
    ...tabBtn('access', 'Access & Roles', 'tablef.tab_access'),
    { from: '<div class="text-sm text-gray-500 mb-1">Total KPIs</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="tablef.total_kpis">Total KPIs</div>' },
    { from: '<div class="text-sm text-gray-500 mb-1">KPIs Met</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="tablef.kpis_met">KPIs Met</div>' },
    { from: '<div class="text-sm text-gray-500 mb-1">Met + Improving</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="tablef.met_improving">Met + Improving</div>' },
    { from: '<div class="text-sm text-gray-500 mb-1">COPC 50/75 Status</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="tablef.copc_status">COPC 50/75 Status</div>' },
    { from: '<div class="text-sm text-gray-500 mb-1">At Risk Depts</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="tablef.at_risk_depts">At Risk Depts</div>' },
    { from: '<h3 class="text-lg font-semibold mb-4">COPC Compliance by Department</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="tablef.sec_compliance">COPC Compliance by Department</h3>' },
    { from: '<h3 class="text-lg font-semibold mb-4">KPI Status Distribution</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="tablef.sec_status_dist">KPI Status Distribution</h3>' },
    { from: '<h3 class="text-lg font-semibold">Department Summary</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="tablef.sec_dept_summary">Department Summary</h3>' },
    { from: '<h3 class="text-lg font-semibold">KPI Performance Matrix</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="tablef.sec_perf_matrix">KPI Performance Matrix</h3>' },
    { from: '<h3 class="font-semibold">Critical Risks</h3>', to: '<h3 class="font-semibold" data-i18n="tablef.sec_critical_risks">Critical Risks</h3>' },
    { from: '<h3 class="font-semibold">AI Recommendations</h3>', to: '<h3 class="font-semibold" data-i18n="tablef.sec_ai_recs">AI Recommendations</h3>' },
  ],
  'projects.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'projects.title', 'PMP Project Portfolio'),
    { from: '>Project Management Professional Framework<', to: ' data-i18n="projects.subtitle">Project Management Professional Framework<' },
    { from: '>Total Projects</div>', to: ' data-i18n="projects.total_projects">Total Projects</div>' },
    { from: '>Avg SPI</div>', to: ' data-i18n="projects.avg_spi">Avg SPI</div>' },
    { from: '>Avg CPI</div>', to: ' data-i18n="projects.avg_cpi">Avg CPI</div>' },
    { from: '>At Risk</div>', to: ' data-i18n="projects.at_risk">At Risk</div>' },
    { from: '>High Risks</div>', to: ' data-i18n="projects.high_risks">High Risks</div>' },
    thLeft('Project', 'projects.col_project'),
    thLeft('Priority', 'common.priority'),
    thLeft('Progress', 'projects.col_progress'),
    thLeft('SPI', 'projects.col_spi'),
    thLeft('CPI', 'projects.col_cpi'),
    thLeft('Risk', 'projects.col_risk'),
    thLeft('Category', 'common.category'),
    thLeft('Score', 'projects.col_score'),
    thLeft('Owner', 'common.owner'),
    thLeft('Milestone', 'projects.col_milestone'),
    thLeft('Type', 'common.type'),
    thLeft('Planned', 'projects.col_planned'),
    thLeft('Actual', 'projects.col_actual'),
    thLeft('Variance', 'projects.col_variance'),
    thLeft('Name', 'common.name'),
    thLeft('Role', 'common.role'),
    thLeft('Influence', 'projects.col_influence'),
    thLeft('Interest', 'projects.col_interest'),
    thLeft('Engagement', 'projects.col_engagement'),
    thLeft('Title', 'common.title'),
    thLeft('Vendor', 'projects.col_vendor'),
    thLeft('Value', 'projects.col_value'),
    { from: '<h3 class="text-lg font-semibold mb-4">Projects by Status</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="projects.sec_by_status">Projects by Status</h3>' },
    { from: '<h3 class="text-lg font-semibold mb-4">Projects by Priority</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="projects.sec_by_priority">Projects by Priority</h3>' },
    { from: '<h3 class="text-lg font-semibold mb-4">Budget Overview</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="projects.sec_budget">Budget Overview</h3>' },
    { from: '<h3 class="text-lg font-semibold">Risk Register</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="projects.sec_risk_register">Risk Register</h3>' },
    { from: '<h3 class="text-lg font-semibold">Project Milestones Timeline</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="projects.sec_milestones">Project Milestones Timeline</h3>' },
    { from: '<h3 class="text-lg font-semibold">Stakeholder Register</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="projects.sec_stakeholders">Stakeholder Register</h3>' },
    { from: '<h3 class="text-lg font-semibold">Procurement Management</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="projects.sec_procurement">Procurement Management</h3>' },
  ],
  'calls.html': [
    ...tabBtn('overview', 'Overview', 'calls.tab_overview'),
    ...tabBtn('calls', 'Call Records', 'calls.tab_records'),
    ...tabBtn('sources', 'Data Sources', 'calls.tab_sources'),
    ...tabBtn('evaluate', 'SDR Evaluation', 'calls.tab_sdr'),
    ...tabBtn('scorecards', 'Scorecards', 'calls.tab_scorecards'),
    ...tabBtn('compliance', 'CRM Compliance', 'calls.tab_compliance'),
    ...tabBtn('analytics', 'Analytics', 'calls.tab_analytics'),
    { from: '<div class="text-sm text-gray-500 mb-1">Total Calls</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="calls.kpi_total_calls">Total Calls</div>' },
    { from: '<div class="text-sm text-gray-500 mb-1">Analyzed</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="calls.kpi_analyzed">Analyzed</div>' },
    { from: '<div class="text-sm text-gray-500 mb-1">Avg Sentiment</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="calls.kpi_avg_sentiment">Avg Sentiment</div>' },
    { from: '<div class="text-sm text-gray-500 mb-1">Avg QA Score</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="calls.kpi_avg_qa">Avg QA Score</div>' },
    { from: '<div class="text-sm text-gray-500 mb-1">Compliance Rate</div>', to: '<div class="text-sm text-gray-500 mb-1" data-i18n="calls.kpi_compliance_rate">Compliance Rate</div>' },
    kpiLabelDiv('Notes Updated', 'calls.col_notes_updated'),
    kpiLabelDiv('Call Logged', 'calls.col_call_logged'),
    kpiLabelDiv('Task Created', 'calls.col_task_created'),
    kpiLabelDiv('Stage Updated', 'calls.col_stage_updated'),
    kpiLabelDiv('Fully Compliant', 'calls.col_fully_compliant'),
    { from: '<h3 class="text-lg font-semibold mb-4">Calls by Source</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="calls.sec_calls_by_source">Calls by Source</h3>' },
    { from: '<h3 class="text-lg font-semibold mb-4">Calls by Agent</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="calls.sec_calls_by_agent">Calls by Agent</h3>' },
    { from: '<h3 class="text-lg font-semibold">CRM Compliance Breakdown</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="calls.sec_crm_compliance">CRM Compliance Breakdown</h3>' },
    { from: '<h3 class="text-lg font-semibold">Call Records</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="calls.sec_records">Call Records</h3>' },
    { from: '<h3 class="text-lg font-semibold mb-4">Recent Uploads</h3>', to: '<h3 class="text-lg font-semibold mb-4" data-i18n="calls.sec_recent_uploads">Recent Uploads</h3>' },
    { from: '<h3 class="text-lg font-semibold">Select Call to Evaluate</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="calls.sec_select_call">Select Call to Evaluate</h3>' },
    { from: '<h3 class="text-lg font-semibold text-white">Five9 Integration</h3>', to: '<h3 class="text-lg font-semibold text-white" data-i18n="calls.sec_five9">Five9 Integration</h3>' },
    { from: '<h3 class="text-lg font-semibold text-white">Manual Call Upload</h3>', to: '<h3 class="text-lg font-semibold text-white" data-i18n="calls.sec_manual_upload">Manual Call Upload</h3>' },
    { from: '<h3 class="text-lg font-semibold text-white">Bulk Call Recordings Upload</h3>', to: '<h3 class="text-lg font-semibold text-white" data-i18n="calls.sec_bulk_upload">Bulk Call Recordings Upload</h3>' },
    { from: '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Call ID</th>', to: '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase" data-i18n="calls.col_call_id">Call ID</th>' },
    { from: '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>', to: '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase" data-i18n="calls.col_source">Source</th>' },
    { from: '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Contact</th>', to: '<th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase" data-i18n="calls.col_contact">Contact</th>' },
    { from: '<th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Direction</th>', to: '<th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase" data-i18n="calls.col_direction">Direction</th>' },
    { from: '<th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Duration</th>', to: '<th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase" data-i18n="calls.col_duration">Duration</th>' },
    { from: '<th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Date</th>', to: '<th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase" data-i18n="calls.col_date">Date</th>' },
    lbl('Agent Name *', 'calls.f_agent_name'),
    lbl('Agent Email *', 'calls.f_agent_email'),
    lbl('Contact Name', 'calls.f_contact_name'),
    lbl('Call Direction', 'calls.f_call_direction'),
    lbl('Lead ID (Optional)', 'calls.f_lead_id'),
    lbl('Call Date', 'calls.f_call_date'),
    lbl('Default Agent Email *', 'calls.f_default_agent'),
    lbl('Five9 Domain', 'calls.f_five9_domain'),
    lbl('API Username', 'calls.f_api_username'),
    lbl('API Password', 'calls.f_api_password'),
    { from: '<h4 class="text-sm font-medium text-gray-700">Selected Files</h4>', to: '<h4 class="text-sm font-medium text-gray-700" data-i18n="calls.f_selected_files">Selected Files</h4>' },
  ],
  'users.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'users.title', 'Users & Access Control'),
    { from: '>Manage user invitations, approvals, and permissions<', to: ' data-i18n="users.subtitle">Manage user invitations, approvals, and permissions<' },
    { from: '>Total Users</div>', to: ' data-i18n="users.total_users">Total Users</div>' },
    { from: '<h3 class="font-semibold">Pending Access Requests</h3>', to: '<h3 class="font-semibold" data-i18n="users.sec_pending">Pending Access Requests</h3>' },
    { from: '<h3 class="font-semibold">Active Users</h3>', to: '<h3 class="font-semibold" data-i18n="users.sec_active">Active Users</h3>' },
    { from: '<h3 class="font-semibold">All Users</h3>', to: '<h3 class="font-semibold" data-i18n="users.sec_all">All Users</h3>' },
    { from: '<h3 class="font-semibold">Sent Invitations</h3>', to: '<h3 class="font-semibold" data-i18n="users.sec_invitations">Sent Invitations</h3>' },
    { from: '<h3 class="font-semibold mb-4">Default Role Permissions</h3>', to: '<h3 class="font-semibold mb-4" data-i18n="users.sec_roles">Default Role Permissions</h3>' },
    { from: '<h3 class="font-semibold">Access Audit Log</h3>', to: '<h3 class="font-semibold" data-i18n="users.sec_audit">Access Audit Log</h3>' },
    { from: '<h3 class="text-lg font-semibold">Invite New User</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="users.invite_modal">Invite New User</h3>' },
    { from: '<h3 class="text-lg font-semibold">User Details & Permissions</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="users.details_modal">User Details & Permissions</h3>' },
    thLeft('Name', 'common.name'),
    thLeft('Email', 'common.email'),
    thLeft('Role', 'common.role'),
    thLeft('Team', 'common.team'),
    thLeft('Last Login', 'common.last_login'),
    thLeft('Status', 'common.status'),
    thLeft('Expires', 'common.expires'),
    thLeft('Invited By', 'users.col_invited_by'),
    thLeft('Event', 'users.col_event'),
    thLeft('Target', 'users.col_target'),
    thLeft('Action', 'users.col_action'),
    thLeft('Performed By', 'users.col_performed_by'),
    thLeft('Timestamp', 'users.col_timestamp'),
    thLeft('Actions', 'common.actions'),
    lblNoColor('Full Name', 'users.f_full_name'),
    lblNoColor('Invitation Expires In', 'users.invite_expires'),
    btnSubmit('px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700', 'Send Invitation', 'users.send_invitation'),
  ],
  'admin.html': [
    h2lg('System Audit Trail', 'admin.tab_audit'),
    lblMb2('CRM Module', 'admin.crm_module'),
    lblMb2('Team', 'common.team'),
    lblMb2('Scorecard Name', 'admin.scorecard_name'),
    lblMb2('Linked Governance Doc', 'admin.linked_doc'),
    lbl('Target (%)', 'admin.f_target'),
    lbl('Severity', 'common.severity'),
    lbl('Evaluation Logic (how AI checks it)', 'admin.f_eval_logic'),
    lbl('Evidence Fields (CRM fields to check)', 'admin.f_evidence_fields'),
    lbl('Scorecard Name', 'admin.scorecard_name'),
    lbl('Description', 'common.description'),
    lbl('CRM Module', 'admin.crm_module'),
    lbl('Team', 'common.team'),
    lbl('Version', 'admin.f_version'),
    btnSubmit('px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700', 'Save Attribute', 'admin.save_attribute'),
    btnSubmit('px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700', 'Create Scorecard', 'admin.create_scorecard'),
  ],
  'ai-approvals.html': [
    setI18n('<h1 class="text-2xl font-semibold text-gray-900">', 'ai_approvals.title', 'AI Approvals Queue'),
  ],
  'ai-ops.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'ai_ops.title', 'AI Operations'),
    { from: '>Token usage, cost trends, latency, and error telemetry across all AI agents.<', to: ' data-i18n="ai_ops.subtitle">Token usage, cost trends, latency, and error telemetry across all AI agents.<' },
    { from: '<p class="text-xs text-gray-500 uppercase tracking-wide">24h Cost (USD)</p>', to: '<p class="text-xs text-gray-500 uppercase tracking-wide" data-i18n="ai_ops.kpi_cost">24h Cost (USD)</p>' },
    { from: '<p class="text-xs text-gray-500 uppercase tracking-wide">24h Calls</p>', to: '<p class="text-xs text-gray-500 uppercase tracking-wide" data-i18n="ai_ops.kpi_calls">24h Calls</p>' },
    { from: '<p class="text-xs text-gray-500 uppercase tracking-wide">24h Errors</p>', to: '<p class="text-xs text-gray-500 uppercase tracking-wide" data-i18n="ai_ops.kpi_errors">24h Errors</p>' },
    { from: '<p class="text-xs text-gray-500 uppercase tracking-wide">Avg Latency</p>', to: '<p class="text-xs text-gray-500 uppercase tracking-wide" data-i18n="ai_ops.kpi_latency">Avg Latency</p>' },
    h2lg('Weekly Cost Trend', 'ai_ops.sec_weekly_cost'),
    h2lg('Prompt Version Comparison', 'ai_ops.sec_prompt_comparison'),
    h2lg('Top Tool Calls by Cost — last 7 days', 'ai_ops.sec_top_tools'),
    h2lg('AI Consultant Feedback', 'ai_ops.sec_feedback'),
    h2lg('Tool-health alert thresholds', 'ai_ops.sec_thresholds'),
    { from: '<th class="px-3 py-2">Agent</th>', to: '<th class="px-3 py-2" data-i18n="ai_ops.col_agent">Agent</th>' },
    { from: '<th class="px-3 py-2">Tool</th>', to: '<th class="px-3 py-2" data-i18n="ai_ops.col_tool">Tool</th>' },
    { from: '<th class="px-3 py-2">Time</th>', to: '<th class="px-3 py-2" data-i18n="ai_ops.col_time">Time</th>' },
    { from: '<th class="px-3 py-2 text-right">Latency</th>', to: '<th class="px-3 py-2 text-right" data-i18n="ai_ops.col_latency">Latency</th>' },
    { from: '<th class="px-3 py-2">Model</th>', to: '<th class="px-3 py-2" data-i18n="ai_ops.col_model">Model</th>' },
  ],
  'health.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900" data-testid="text-page-title">', 'health.title', 'Platform Health Pulse'),
    { from: '<div class="text-sm text-gray-500 uppercase tracking-wider">Passing</div>', to: '<div class="text-sm text-gray-500 uppercase tracking-wider" data-i18n="health.kpi_passing">Passing</div>' },
    { from: '<div class="text-sm text-gray-500 uppercase tracking-wider">Warnings</div>', to: '<div class="text-sm text-gray-500 uppercase tracking-wider" data-i18n="health.kpi_warnings">Warnings</div>' },
    { from: '<div class="text-sm text-gray-500 uppercase tracking-wider">Failures</div>', to: '<div class="text-sm text-gray-500 uppercase tracking-wider" data-i18n="health.kpi_failures">Failures</div>' },
    h2lg('Run history', 'health.sec_history'),
    h2lg('Latest run · per-check breakdown', 'health.sec_breakdown'),
    { from: '<p class="text-gray-600 text-sm mt-1">Continuous platform-wide health checks. Each run executes the full battery of assertions; degraded or failing runs trigger notifications automatically.</p>', to: '<p class="text-gray-600 text-sm mt-1" data-i18n="health.subtitle">Continuous platform-wide health checks. Each run executes the full battery of assertions; degraded or failing runs trigger notifications automatically.</p>' },
    { from: '<button id="btn-refresh" data-testid="button-refresh" class="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded text-sm hover:bg-gray-50">', to: '<button id="btn-refresh" data-testid="button-refresh" data-i18n="common.refresh" class="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded text-sm hover:bg-gray-50">' },
    { from: '<button id="btn-run" data-testid="button-run-now" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed">', to: '<button id="btn-run" data-testid="button-run-now" data-i18n="health.run_now" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed">' },
    { from: '<div id="loading-state" class="bg-white rounded-xl shadow p-8 text-center text-gray-500">\n            Loading latest pulse...\n        </div>', to: '<div id="loading-state" data-i18n="health.loading_pulse" class="bg-white rounded-xl shadow p-8 text-center text-gray-500">\n            Loading latest pulse...\n        </div>' },
    { from: '<div class="text-gray-400 text-lg mb-2">No pulse runs yet</div>', to: '<div class="text-gray-400 text-lg mb-2" data-i18n="health.empty_title">No pulse runs yet</div>' },
    { from: `<div class="font-semibold">Couldn't load Health Pulse data</div>`, to: `<div class="font-semibold" data-i18n="health.error_title">Couldn't load Health Pulse data</div>` },
    { from: '<div class="text-sm opacity-80 uppercase tracking-wider">Overall Status</div>', to: '<div class="text-sm opacity-80 uppercase tracking-wider" data-i18n="health.kpi_overall">Overall Status</div>' },
    { from: '<div class="text-sm text-gray-500 mt-2">checks healthy</div>', to: '<div class="text-sm text-gray-500 mt-2" data-i18n="health.checks_healthy">checks healthy</div>' },
    { from: '<div class="text-sm text-gray-500 mt-2">need attention</div>', to: '<div class="text-sm text-gray-500 mt-2" data-i18n="health.need_attention">need attention</div>' },
    { from: '<p class="text-sm text-gray-500">Last 50 runs · pass / warn / fail counts over time</p>', to: '<p class="text-sm text-gray-500" data-i18n="health.history_subtitle">Last 50 runs · pass / warn / fail counts over time</p>' },
    { from: '<p class="text-sm text-gray-500">Click a row to inspect details</p>', to: '<p class="text-sm text-gray-500" data-i18n="health.click_row">Click a row to inspect details</p>' },
  ],
  'logs.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'logs.title', 'System Event Logs'),
    kpiLabel('Total Logs', 'logs.total_logs'),
    kpiLabel('Last 24 Hours', 'logs.last_24h'),
    kpiLabel('Critical Events', 'logs.critical_events'),
    kpiLabel('AI Actions', 'logs.ai_actions'),
    section('h3', 'text-lg font-semibold text-gray-900 mb-4', 'Log Activity (Last 7 Days)', 'logs.sec_activity'),
    section('h3', 'text-lg font-semibold text-gray-900 mb-4', 'Filters', 'logs.sec_filters'),
    h3lg('Event Logs', 'logs.sec_logs'),
    lbl('From Date', 'logs.from_date'),
    lbl('To Date', 'logs.to_date'),
    lbl('Action Type', 'logs.action_type'),
    lbl('Entity Type', 'logs.entity_type'),
    lbl('Module', 'common.module'),
    lbl('Severity', 'common.severity'),
    lbl('AI Involved', 'logs.ai_involved'),
    lbl('Search', 'common.search'),
  ],
  'migration.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'migration.title', 'Data Migration Engine'),
    { from: '>Total Jobs</div>', to: ' data-i18n="migration.total_jobs">Total Jobs</div>' },
    { from: '>Records Imported</div>', to: ' data-i18n="migration.records_imported">Records Imported</div>' },
    { from: '>Duplicates Detected</div>', to: ' data-i18n="migration.duplicates_detected">Duplicates Detected</div>' },
    h2lg('Migration Jobs', 'migration.sec_jobs'),
    h2lg('Quick Import Guide', 'migration.sec_quick_guide'),
    section('h2', 'text-lg font-semibold text-gray-900 mb-4', 'Import by Module', 'migration.sec_by_module'),
    section('h2', 'text-lg font-semibold text-gray-900 mb-4', 'Available Templates', 'migration.sec_templates'),
    section('h2', 'text-lg font-semibold text-gray-900 mb-4', 'Deduplication Rules', 'migration.sec_dedup'),
    h3xl('Import Data', 'migration.import_data'),
    { from: '<h3 class="font-medium text-gray-900 mb-1">Select Module</h3>', to: '<h3 class="font-medium text-gray-900 mb-1" data-i18n="migration.step_select">Select Module</h3>' },
    { from: '<h3 class="font-medium text-gray-900 mb-1">Upload File</h3>', to: '<h3 class="font-medium text-gray-900 mb-1" data-i18n="migration.step_upload">Upload File</h3>' },
    { from: '<h3 class="font-medium text-gray-900 mb-1">Map Fields</h3>', to: '<h3 class="font-medium text-gray-900 mb-1" data-i18n="migration.step_map">Map Fields</h3>' },
    { from: '<h3 class="font-medium text-gray-900 mb-1">Import & Validate</h3>', to: '<h3 class="font-medium text-gray-900 mb-1" data-i18n="migration.step_validate">Import &amp; Validate</h3>' },
    thLeft('Job Code', 'migration.col_job_code'),
    thLeft('Name', 'common.name'),
    thCenter('Module', 'common.module'),
    thCenter('Records', 'migration.col_records'),
    thCenter('Status', 'common.status'),
    thCenter('Date', 'common.date'),
    lbl('Job Name *', 'migration.f_job_name'),
    lbl('Target Module *', 'migration.target_module'),
    lbl('Description', 'common.description'),
    lbl('Source Type *', 'migration.source_type'),
    lbl('Upload File', 'migration.f_upload_file'),
    btnSubmit('px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700', 'Create Import Job', 'migration.create_job'),
  ],
  'onboarding.html': [
    setI18n('<h1 class="text-3xl font-bold mb-2">', 'onboarding.title', 'Welcome to ExampleOrg Quality & Investment System'),
    kpiLabel('Total Users', 'onboarding.total_users'),
    kpiLabel('Video Watched', 'onboarding.video_watched'),
    kpiLabel('Tour Completed', 'onboarding.tour_completed'),
    kpiLabel('Skipped', 'onboarding.skipped'),
    { from: '<h2 class="text-2xl font-bold text-gray-900 mb-4">Your Onboarding Progress</h2>', to: '<h2 class="text-2xl font-bold text-gray-900 mb-4" data-i18n="onboarding.sec_progress">Your Onboarding Progress</h2>' },
    { from: '<h3 class="text-lg font-semibold text-gray-900 mb-4">Onboarding Statistics (Admin View)</h3>', to: '<h3 class="text-lg font-semibold text-gray-900 mb-4" data-i18n="onboarding.sec_stats">Onboarding Statistics (Admin View)</h3>' },
    { from: '<button data-on-click="playVideo" class="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg transition">\n                                    Play Video\n                                </button>', to: '<button data-on-click="playVideo" data-i18n="onboarding.play_video" class="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg transition">\n                                    Play Video\n                                </button>' },
    { from: `<h3 class="font-semibold text-blue-800 mb-2">What you'll learn:</h3>`, to: `<h3 class="font-semibold text-blue-800 mb-2" data-i18n="onboarding.sec_what_learn">What you'll learn:</h3>` },
    { from: '<button data-on-click="skipVideo" class="text-gray-500 hover:text-gray-700 px-4 py-2 transition">\n                        Skip for now\n                    </button>', to: '<button data-on-click="skipVideo" data-i18n="onboarding.skip_now" class="text-gray-500 hover:text-gray-700 px-4 py-2 transition">\n                        Skip for now\n                    </button>' },
    { from: '<span>Start Guided Tour</span>', to: '<span data-i18n="onboarding.start_tour">Start Guided Tour</span>' },
    { from: '<p class="font-medium text-amber-800">Demo Mode Active</p>', to: '<p class="font-medium text-amber-800" data-i18n="onboarding.demo_mode_active">Demo Mode Active</p>' },
    { from: '<span class="font-medium text-indigo-700">Watch Introduction Video</span>', to: '<span class="font-medium text-indigo-700" data-i18n="onboarding.watch_video">Watch Introduction Video</span>' },
    { from: '<span class="font-medium text-purple-700">Restart Guided Tour</span>', to: '<span class="font-medium text-purple-700" data-i18n="onboarding.restart_tour">Restart Guided Tour</span>' },
    { from: '<span class="font-medium text-green-700">Submit New Initiative</span>', to: '<span class="font-medium text-green-700" data-i18n="onboarding.submit_initiative">Submit New Initiative</span>' },
    { from: '<h4 class="font-medium text-gray-900 mb-2">Demo Links</h4>', to: '<h4 class="font-medium text-gray-900 mb-2" data-i18n="onboarding.demo_links">Demo Links</h4>' },
    { from: '<button data-on-click="createDemoLink" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm transition mb-4">\n                    Generate New Demo Link\n                </button>', to: '<button data-on-click="createDemoLink" data-i18n="onboarding.generate_demo" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm transition mb-4">\n                    Generate New Demo Link\n                </button>' },
  ],
  'feedback.html': [
    setI18n('<h1 class="text-3xl font-bold text-gray-900">', 'feedback.title', 'Team Feedback Center'),
    kpiLabel('Total Feedback', 'feedback.total_feedback'),
    kpiLabel('Avg. Rating', 'feedback.avg_rating'),
    kpiLabel('Ease of Use', 'feedback.ease_of_use'),
    kpiLabel('Dashboards Rated', 'feedback.dashboards_rated'),
    h2lg('Feedback by Dashboard', 'feedback.sec_by_dashboard'),
    h2lg('Rating Distribution', 'feedback.sec_rating_dist'),
    h2lg('All Feedback', 'feedback.sec_all'),
    { from: '<h3 class="text-xl font-semibold text-white">Share Your Feedback</h3>', to: '<h3 class="text-xl font-semibold text-white" data-i18n="feedback.f_share_heading">Share Your Feedback</h3>' },
    lbl('Your Name *', 'feedback.f_name'),
    lbl('Your Role', 'feedback.f_role'),
    lbl('Dashboard *', 'feedback.f_dashboard'),
    lbl('Overall Rating *', 'feedback.f_rating'),
    lbl('Ease of Use', 'feedback.f_ease_of_use'),
    lbl('Comments', 'feedback.f_comments'),
    lbl('Suggestions', 'feedback.f_suggestions'),
    { from: '<p class="text-gray-600 mt-2">View and analyze feedback from Sara, Maram, and your team members across all dashboards</p>', to: '<p class="text-gray-600 mt-2" data-i18n="feedback.subtitle">View and analyze feedback from Sara, Maram, and your team members across all dashboards</p>' },
    { from: '<option value="">All Dashboards</option>', to: '<option value="" data-i18n="feedback.opt_all_dashboards">All Dashboards</option>' },
    { from: '<button data-on-click="loadFeedback" class="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700 transition text-sm">\n                            Refresh\n                        </button>', to: '<button data-on-click="loadFeedback" data-i18n="common.refresh" class="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700 transition text-sm">\n                            Refresh\n                        </button>' },
    { from: '<p>No feedback yet. Ask your team to share their thoughts!</p>', to: '<p data-i18n="feedback.no_feedback">No feedback yet. Ask your team to share their thoughts!</p>', replaceAll: true },
    { from: '<button type="button" data-on-click="closeFeedbackModal" class="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">Cancel</button>', to: '<button type="button" data-on-click="closeFeedbackModal" data-i18n="common.cancel" class="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">Cancel</button>' },
    { from: '<button type="submit" class="px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 font-medium">Submit Feedback</button>', to: '<button type="submit" data-i18n="feedback.submit_feedback" class="px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 font-medium">Submit Feedback</button>' },
  ],
  'sop.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'sop.title', 'Standard Operating Procedure'),
  ],
  'pdpl.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'pdpl.title', 'PDPL Compliance Dashboard'),
    { from: '>Personal Data Protection Law - Privacy by Design<', to: ' data-i18n="pdpl.subtitle">Personal Data Protection Law - Privacy by Design<' },
    { from: '<div class="text-sm text-gray-500">Data Inventory</div>', to: '<div class="text-sm text-gray-500" data-i18n="pdpl.kpi_inventory">Data Inventory</div>' },
    { from: '<div class="text-sm text-gray-500">DSAR Requests</div>', to: '<div class="text-sm text-gray-500" data-i18n="pdpl.kpi_dsar">DSAR Requests</div>' },
    { from: '<div class="text-sm text-gray-500">Retention Policies</div>', to: '<div class="text-sm text-gray-500" data-i18n="pdpl.kpi_retention">Retention Policies</div>' },
    { from: '<div class="text-sm text-gray-500">Open Incidents</div>', to: '<div class="text-sm text-gray-500" data-i18n="pdpl.kpi_incidents">Open Incidents</div>' },
    { from: '<div class="text-sm text-gray-500">AI Guardrails</div>', to: '<div class="text-sm text-gray-500" data-i18n="pdpl.kpi_guardrails">AI Guardrails</div>' },
    { from: '<div class="text-sm text-gray-500">Compliance Score</div>', to: '<div class="text-sm text-gray-500" data-i18n="pdpl.kpi_score">Compliance Score</div>' },
    { from: '<h3 class="text-lg font-semibold">Personal Data Inventory</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="pdpl.sec_inventory">Personal Data Inventory</h3>' },
    { from: '<h3 class="text-lg font-semibold">Data Retention Policies</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="pdpl.sec_retention">Data Retention Policies</h3>' },
    { from: '<h3 class="text-lg font-semibold">Data Subject Access Requests</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="pdpl.sec_dsar">Data Subject Access Requests</h3>' },
    { from: '<h3 class="text-lg font-semibold">Data Incidents</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="pdpl.sec_incidents">Data Incidents</h3>' },
    { from: '<h3 class="text-lg font-semibold">AI PII Guardrails</h3>', to: '<h3 class="text-lg font-semibold" data-i18n="pdpl.sec_guardrails">AI PII Guardrails</h3>' },
  ],
  'roi.html': [
    kpiLabel('Total Initiatives', 'roi.total_initiatives'),
    kpiLabel('Average ROI', 'roi.avg_roi'),
    kpiLabel('Total NPV', 'roi.total_npv'),
    kpiLabel('Avg Payback', 'roi.avg_payback'),
    { from: '<h3 class="text-lg font-semibold text-gray-900 mb-4">AI Recommendations</h3>', to: '<h3 class="text-lg font-semibold text-gray-900 mb-4" data-i18n="roi.sec_ai_recs">AI Recommendations</h3>' },
    { from: '<h3 class="text-lg font-semibold text-gray-900 mb-4">NPV by Department</h3>', to: '<h3 class="text-lg font-semibold text-gray-900 mb-4" data-i18n="roi.sec_npv_by_dept">NPV by Department</h3>' },
    h3lg('Initiatives', 'roi.sec_initiatives'),
    { from: '<th class="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Project</th>', to: '<th class="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase" data-i18n="roi.col_project">Project</th>' },
    { from: '<th class="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Department</th>', to: '<th class="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase" data-i18n="common.department">Department</th>' },
    { from: '<th class="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase">ROI %</th>', to: '<th class="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase" data-i18n="roi.col_roi">ROI %</th>' },
    { from: '<th class="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase">NPV (SAR)</th>', to: '<th class="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase" data-i18n="roi.col_npv">NPV (SAR)</th>' },
    { from: '<th class="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Payback</th>', to: '<th class="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase" data-i18n="roi.col_payback">Payback</th>' },
    { from: '<th class="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase">AI Recommendation</th>', to: '<th class="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase" data-i18n="roi.col_ai_rec">AI Recommendation</th>' },
    { from: '<th class="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>', to: '<th class="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase" data-i18n="common.status">Status</th>' },
    { from: '<h2 class="text-xl font-bold text-gray-900">New ROI Initiative - Hybrid Model</h2>', to: '<h2 class="text-xl font-bold text-gray-900" data-i18n="roi.modal_new">New ROI Initiative - Hybrid Model</h2>' },
    lbl('Initiative Name *', 'roi.f_initiative_name'),
    lbl('Priority', 'common.priority'),
    lbl('Problem Statement', 'roi.f_problem'),
  ],
  'intake.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'intake.title', 'Manual Audit Intake Workspace'),
    { from: '<h2 class="font-semibold text-gray-900">Upload Off-Platform Audit Report</h2>', to: '<h2 class="font-semibold text-gray-900" data-i18n="intake.sec_upload">Upload Off-Platform Audit Report</h2>' },
    { from: '<h2 class="font-semibold text-gray-900">Intakes</h2>', to: '<h2 class="font-semibold text-gray-900" data-i18n="intake.sec_intakes">Intakes</h2>' },
    { from: '<th class="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase">Code</th>', to: '<th class="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase" data-i18n="intake.col_code">Code</th>' },
    { from: '<th class="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase">Title</th>', to: '<th class="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase" data-i18n="common.title">Title</th>' },
    { from: '<th class="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase">Department</th>', to: '<th class="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase" data-i18n="common.department">Department</th>' },
    { from: '<th class="px-4 py-2 text-center text-xs font-semibold text-gray-600 uppercase">Status</th>', to: '<th class="px-4 py-2 text-center text-xs font-semibold text-gray-600 uppercase" data-i18n="common.status">Status</th>' },
    { from: '<th class="px-4 py-2 text-center text-xs font-semibold text-gray-600 uppercase">Findings</th>', to: '<th class="px-4 py-2 text-center text-xs font-semibold text-gray-600 uppercase" data-i18n="intake.col_findings">Findings</th>' },
    { from: '<th class="px-4 py-2 text-center text-xs font-semibold text-gray-600 uppercase">Uploaded</th>', to: '<th class="px-4 py-2 text-center text-xs font-semibold text-gray-600 uppercase" data-i18n="intake.col_uploaded">Uploaded</th>' },
  ],
  'infographic.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'infographic.title', 'Infographic Generator'),
    { from: '<h2 class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">1 · Choose a section</h2>', to: '<h2 class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4" data-i18n="infographic.sec_choose">1 · Choose a section</h2>' },
    { from: '<h2 class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">2 · Generate &amp; share</h2>', to: '<h2 class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4" data-i18n="infographic.sec_generate">2 · Generate &amp; share</h2>' },
    { from: '<h2 class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4">3 · Preview</h2>', to: '<h2 class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-4" data-i18n="infographic.sec_preview">3 · Preview</h2>' },
    { from: '<h3 class="text-lg font-bold text-slate-900">Send to Slack</h3>', to: '<h3 class="text-lg font-bold text-slate-900" data-i18n="infographic.h3_slack">Send to Slack</h3>' },
    { from: '<h3 class="text-lg font-bold text-slate-900">Send via Email</h3>', to: '<h3 class="text-lg font-bold text-slate-900" data-i18n="infographic.h3_email">Send via Email</h3>' },
  ],
  'guide.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'guide.title', 'Welcome to ExampleOrg'),
  ],
  'index.html': [
    setI18n('<h1 class="text-2xl font-bold text-gray-900">', 'index.title', 'Quality Dashboard'),
    { from: '>Overall Quality Score</div>', to: ' data-i18n="index.kpi_quality">Overall Quality Score</div>' },
    { from: '>Critical Issues</div>', to: ' data-i18n="index.kpi_critical">Critical Issues</div>' },
    { from: '>Total Records Audited</div>', to: ' data-i18n="index.kpi_records">Total Records Audited</div>' },
    { from: '>Compliance Rate</div>', to: ' data-i18n="index.kpi_compliance">Compliance Rate</div>' },
  ],
  'accept-invite.html': [
    setI18n('<h1 class="text-2xl font-bold">', 'accept_invite.title', 'ExampleOrg Platform'),
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
