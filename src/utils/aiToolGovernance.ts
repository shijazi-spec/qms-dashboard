/**
 * AI Tool Governance policy.
 *
 * Central declaration of:
 *   - which AI tools write to the platform and therefore need human approval
 *   - the risk level assigned to each tool
 *   - the compliance controls each tool is asked to satisfy (so the approver
 *     sees exactly WHY they're being asked to sign off)
 *   - a human-friendly label + preview builder for each tool
 *
 * Changing a tool from "requires_approval: true" to "false" is a governance
 * decision and MUST be reviewed against PDPL Art. 16, PCI DSS §12.3.1,
 * ISO 27001:2022 A.5.37 and ISO 9001:2015 §8.5.1.
 *
 * The gate can be bypassed globally by setting:
 *     AI_APPROVAL_GATE_ENABLED=false
 * This is intentional (kill-switch for incident response) but every bypass
 * is logged to event_logs with severity=WARNING.
 */

import type { RiskLevel } from './aiApprovalDatabase';

export interface ToolGovernancePolicy {
  /** Tool id as registered in createTool({ id: ... }) */
  toolId: string;
  /** Human-friendly label shown in the approval UI and the SOP. */
  label: string;
  /** Risk classification drives which roles can auto-approve. */
  riskLevel: RiskLevel;
  /** If false, the tool executes without approval (e.g. internal alerts). */
  requiresApproval: boolean;
  /** Compliance controls the approver is certifying by clicking Approve. */
  complianceRefs: string[];
  /**
   * Returns a short markdown preview of the payload. Must NOT include full
   * PII (phone/email) — instead mask with the helper below. Shown in the
   * inline chat card and the approvals dashboard.
   */
  buildPreview: (payload: any) => string;
  /**
   * Entity type recorded in the execution result (for cross-linking back
   * to the created NC/CAPA/Training row in event_logs).
   */
  entityType: string;
}

export function maskEmail(email?: string): string {
  if (!email) return '—';
  const [u, d] = email.split('@');
  if (!u || !d) return '***';
  return `${u.slice(0, 2)}***@${d}`;
}

export function maskPhone(phone?: string): string {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
}

function trim(s: any, n = 120): string {
  const str = String(s ?? '—');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/**
 * Registry of every AI write-tool the consultant agent can invoke.
 * Edit carefully — a missing entry means the tool will bypass the gate.
 * The wrapper throws a loud error if a gated tool has no policy row.
 */
export const TOOL_GOVERNANCE_POLICIES: Record<string, ToolGovernancePolicy> = {
  'create-nonconformance': {
    toolId: 'create-nonconformance',
    label: 'Create Nonconformance (NC)',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-009 (Nonconformity, Violation and Corrective Action Process)',
      'WP-SOP-011 (Automated Decision and Processing Process)',
      'WP-DOC-004 (AI Adoption Guidelines)',
      'ISO 9001:2015 §10.2',
      'PDPL Art. 16',
    ],
    entityType: 'nonconformance',
    buildPreview: (p: any) =>
      [
        `**Title:** ${trim(p?.title)}`,
        `**Severity:** ${p?.severity ?? 'n/a'}`,
        `**Type:** ${p?.ncType ?? 'n/a'}`,
        p?.category ? `**Category:** ${p.category}` : null,
        p?.sourceReference ? `**Source:** ${trim(p.sourceReference, 80)}` : null,
        p?.description ? `\n${trim(p.description, 280)}` : null,
      ].filter(Boolean).join('\n'),
  },

  'create-capa': {
    toolId: 'create-capa',
    label: 'Create CAPA (Corrective/Preventive Action)',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-009 (Nonconformity, Violation and Corrective Action Process)',
      'WP-SOP-011 (Automated Decision and Processing Process)',
      'WP-DOC-008 (Accountability Framework)',
      'ISO 9001:2015 §10.2',
      'PCI DSS v4.0 §12.10.6',
    ],
    entityType: 'capa',
    buildPreview: (p: any) =>
      [
        `**Title:** ${trim(p?.title)}`,
        `**Type:** ${p?.capaType ?? 'n/a'}`,
        `**Severity:** ${p?.severity ?? 'n/a'}`,
        `**Priority:** ${p?.priority ?? 'medium'}`,
        p?.assignedTo ? `**Assigned to:** ${p.assignedTo}` : null,
        p?.targetDate ? `**Target date:** ${p.targetDate}` : null,
        p?.description ? `\n${trim(p.description, 280)}` : null,
      ].filter(Boolean).join('\n'),
  },

  'update-capa': {
    toolId: 'update-capa',
    label: 'Update CAPA record',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-019 (Control of Documented Information Process)',
      'WP-SOP-009 (Nonconformity, Violation and Corrective Action Process)',
      'WP-SOP-011 (Automated Decision and Processing Process)',
      'ISO 9001:2015 §7.5.3',
    ],
    entityType: 'capa',
    buildPreview: (p: any) =>
      [
        `**CAPA ID:** ${p?.capaId ?? p?.capaNumber ?? 'n/a'}`,
        p?.status ? `**New status:** ${p.status}` : null,
        p?.rootCause ? `**Root cause:** ${trim(p.rootCause, 200)}` : null,
        p?.correctiveAction ? `**Corrective action:** ${trim(p.correctiveAction, 200)}` : null,
        p?.preventiveAction ? `**Preventive action:** ${trim(p.preventiveAction, 200)}` : null,
      ].filter(Boolean).join('\n'),
  },

  'add-capa-action': {
    toolId: 'add-capa-action',
    label: 'Add CAPA Action Item',
    riskLevel: 'medium',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-009 (Nonconformity, Violation and Corrective Action Process)',
      'WP-SOP-011 (Automated Decision and Processing Process)',
      'ISO 9001:2015 §10.2',
    ],
    entityType: 'capa_action_item',
    buildPreview: (p: any) =>
      [
        `**CAPA ID:** ${p?.capaId ?? 'n/a'}`,
        `**Action:** ${trim(p?.actionDescription, 200)}`,
        p?.assignedTo ? `**Assigned to:** ${p.assignedTo}` : null,
        p?.targetDate ? `**Target date:** ${p.targetDate}` : null,
      ].filter(Boolean).join('\n'),
  },

  'create-training': {
    toolId: 'create-training',
    label: 'Create Training Record',
    riskLevel: 'medium',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-017 (Information Security Competence Development Process)',
      'WP-FORM-032 (Training and Awareness Record)',
      'WP-FORM-003 (Competence Development Questionnaire)',
      'ISO 9001:2015 §7.2',
    ],
    entityType: 'training',
    buildPreview: (p: any) =>
      [
        `**Title:** ${trim(p?.title)}`,
        `**Type:** ${p?.trainingType ?? 'n/a'}`,
        p?.targetDepartment ? `**Department:** ${p.targetDepartment}` : null,
        p?.mandatoryFor ? `**Mandatory for:** ${p.mandatoryFor}` : null,
        p?.description ? `\n${trim(p.description, 240)}` : null,
      ].filter(Boolean).join('\n'),
  },

  'assign-training': {
    toolId: 'assign-training',
    label: 'Assign Training to team member',
    riskLevel: 'medium',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-017 (Information Security Competence Development Process)',
      'WP-SOP-011 (Automated Decision and Processing Process)',
      'ISO 9001:2015 §7.2',
      'PDPL Art. 16',
    ],
    entityType: 'training_assignment',
    buildPreview: (p: any) =>
      [
        `**Training:** ${p?.trainingId ?? p?.trainingTitle ?? 'n/a'}`,
        `**Assignee:** ${maskEmail(p?.assigneeEmail)}${p?.assigneeName ? ` (${p.assigneeName})` : ''}`,
        p?.dueDate ? `**Due date:** ${p.dueDate}` : null,
      ].filter(Boolean).join('\n'),
  },

  'complete-training': {
    toolId: 'complete-training',
    label: 'Mark Training as Completed',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-017 (Information Security Competence Development Process)',
      'WP-SOP-019 (Control of Documented Information Process)',
      'WP-FORM-032 (Training and Awareness Record)',
      'ISO 9001:2015 §7.2',
    ],
    entityType: 'training_assignment',
    buildPreview: (p: any) =>
      [
        `**Assignment:** ${p?.assignmentId ?? 'n/a'}`,
        p?.completionDate ? `**Completed on:** ${p.completionDate}` : null,
        p?.evidenceUrl ? `**Evidence:** ${trim(p.evidenceUrl, 100)}` : null,
        p?.score != null ? `**Score:** ${p.score}` : null,
      ].filter(Boolean).join('\n'),
  },

  'manage-checklist': {
    toolId: 'manage-checklist',
    label: 'Manage Compliance Checklist (create/delete/modify)',
    riskLevel: 'medium',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-019 (Control of Documented Information Process)',
      'WP-SOP-008 (Compliance Monitoring and Measurement Process)',
      'WP-FORM-044 (AI Tool Approval Checklist)',
    ],
    entityType: 'checklist',
    buildPreview: (p: any) =>
      [
        `**Action:** ${p?.action ?? 'n/a'}`,
        p?.checklistName ? `**Checklist:** ${trim(p.checklistName, 120)}` : null,
        p?.checklistId ? `**Checklist ID:** ${p.checklistId}` : null,
        Array.isArray(p?.items) ? `**Items:** ${p.items.length}` : null,
      ].filter(Boolean).join('\n'),
  },

  // --- tools explicitly exempted from the gate ---
  //
  // Every entry below sets `requiresApproval: false` because the tool
  // either (a) only reads from the platform, (b) only emits an internal
  // notification, or (c) is owned by a background workflow whose own
  // governance covers the side-effect. They are included here so the
  // static policy-coverage check (`tests/aiToolPolicyCoverage.test.ts`)
  // confirms every `createTool({ id })` in `src/mastra/tools/` has a
  // matching governance entry — there is no allowlist escape hatch.
  // A new tool that adds a write or external side-effect MUST flip
  // `requiresApproval` to `true`, raise the risk level, and add the
  // appropriate `complianceRefs`.
  'create-alert': {
    toolId: 'create-alert',
    label: 'Create internal AI alert',
    riskLevel: 'low',
    requiresApproval: false, // internal notification only, no external side-effect
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — internal notification surface, no external side-effect',
    ],
    entityType: 'alert',
    buildPreview: (p: any) => `${p?.severity ?? 'info'}: ${trim(p?.title, 100)}`,
  },

  // --- read-only platform queries / analytics ---
  'query-platform-data': {
    toolId: 'query-platform-data',
    label: 'Query platform data (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only query, no platform write',
    ],
    entityType: 'platform_query',
    buildPreview: (p: any) =>
      `Module: ${p?.module ?? '—'}` +
      (p?.status ? ` · status=${p.status}` : '') +
      (p?.severity ? ` · severity=${p.severity}` : '') +
      (typeof p?.limit === 'number' ? ` · limit=${p.limit}` : ''),
  },

  'analyze-nonconformities': {
    toolId: 'analyze-nonconformities',
    label: 'Analyze nonconformity patterns (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only NC analytics',
    ],
    entityType: 'nc_analysis',
    buildPreview: (p: any) =>
      `Analysis: ${p?.analysisType ?? '—'}` +
      (typeof p?.dayRange === 'number' ? ` · last ${p.dayRange} days` : ''),
  },

  'suggest-improvements': {
    toolId: 'suggest-improvements',
    label: 'Suggest quality improvements (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only quality analytics',
    ],
    entityType: 'improvement_suggestion',
    buildPreview: (p: any) =>
      `Focus: ${p?.focusArea ?? '—'}` +
      (typeof p?.dayRange === 'number' ? ` · last ${p.dayRange} days` : ''),
  },

  'suggest-obligation-mapping': {
    toolId: 'suggest-obligation-mapping',
    label: 'Suggest obligation mapping for document (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only mapping suggestions',
      'WP-SOP-019 (Control of Documented Information Process) — user reviews and accepts',
    ],
    entityType: 'obligation_mapping_suggestion',
    buildPreview: (p: any) =>
      `Document: #${p?.documentId ?? '—'}` +
      (typeof p?.topN === 'number' ? ` · top ${p.topN}` : ' · top 5'),
  },

  'check-regulation-compliance': {
    toolId: 'check-regulation-compliance',
    label: 'Check regulation compliance score (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only compliance scoring',
    ],
    entityType: 'compliance_check',
    buildPreview: (p: any) => `Regulation: ${p?.regulation ?? 'all'}`,
  },

  'review-document': {
    toolId: 'review-document',
    label: 'Review governance document (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only document review',
    ],
    entityType: 'document_review',
    buildPreview: (p: any) =>
      `Type: ${p?.documentType ?? '—'}` +
      (p?.documentId ? ` · doc #${p.documentId}` : ' · all active'),
  },

  'monitor-risks': {
    toolId: 'monitor-risks',
    label: 'Monitor risk register (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only risk monitoring',
    ],
    entityType: 'risk_check',
    buildPreview: (p: any) =>
      `Check: ${p?.checkType ?? '—'}` +
      (typeof p?.riskThreshold === 'number'
        ? ` · threshold=${p.riskThreshold}`
        : ''),
  },

  'monitor-kpis': {
    toolId: 'monitor-kpis',
    label: 'Monitor KPI performance (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only KPI monitoring',
    ],
    entityType: 'kpi_check',
    buildPreview: (p: any) =>
      `Check: ${p?.checkType ?? '—'}` +
      (typeof p?.periodCount === 'number' ? ` · last ${p.periodCount} periods` : ''),
  },

  'search-knowledge-base': {
    toolId: 'search-knowledge-base',
    label: 'Search regulatory knowledge base (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only KB lookup',
    ],
    entityType: 'kb_search',
    buildPreview: (p: any) =>
      `Action: ${p?.action ?? '—'}` +
      (p?.query ? ` · "${trim(p.query, 60)}"` : '') +
      (p?.documentType ? ` · type=${p.documentType}` : ''),
  },

  'get-nonconformance-list': {
    toolId: 'get-nonconformance-list',
    label: 'List nonconformances (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only NC list',
    ],
    entityType: 'nc_list',
    buildPreview: (p: any) =>
      `NC list` +
      (p?.status ? ` · status=${p.status}` : '') +
      (p?.severity ? ` · severity=${p.severity}` : '') +
      (typeof p?.limit === 'number' ? ` · limit=${p.limit}` : ''),
  },

  'get-capa-list': {
    toolId: 'get-capa-list',
    label: 'List CAPA records (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only CAPA list',
    ],
    entityType: 'capa_list',
    buildPreview: (p: any) =>
      `CAPA list` +
      (p?.status ? ` · status=${p.status}` : '') +
      (p?.severity ? ` · severity=${p.severity}` : '') +
      (p?.assignedTo ? ` · assignee=${trim(p.assignedTo, 40)}` : ''),
  },

  'get-capa-details': {
    toolId: 'get-capa-details',
    label: 'Get CAPA details (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only CAPA detail',
    ],
    entityType: 'capa_detail',
    buildPreview: (p: any) => `CAPA #${p?.capaId ?? '—'}`,
  },

  'get-training-list': {
    toolId: 'get-training-list',
    label: 'List training records (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only training list',
    ],
    entityType: 'training_list',
    buildPreview: (p: any) =>
      `Training list` +
      (p?.trainingType ? ` · type=${p.trainingType}` : '') +
      (typeof p?.isActive === 'boolean' ? ` · active=${p.isActive}` : ''),
  },

  'get-training-assignments': {
    toolId: 'get-training-assignments',
    label: 'List training assignments (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only training assignment list',
    ],
    entityType: 'training_assignment_list',
    buildPreview: (p: any) =>
      `Training assignments` +
      (p?.employeeId ? ` · employee=${trim(p.employeeId, 40)}` : '') +
      (p?.status ? ` · status=${p.status}` : ''),
  },

  'run-checklist': {
    toolId: 'run-checklist',
    label: 'Run audit checklist (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only audit checklist execution',
    ],
    entityType: 'checklist_run',
    buildPreview: (p: any) =>
      `Action: ${p?.action ?? '—'}` +
      (p?.checklistId ? ` · checklist #${p.checklistId}` : '') +
      (p?.standard ? ` · standard=${trim(p.standard, 60)}` : ''),
  },

  // --- read-only / external-data ingestion (no platform write) ---
  'call-analysis-tool': {
    toolId: 'call-analysis-tool',
    label: 'Analyze call transcript (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only call analysis, no CRM write',
    ],
    entityType: 'call_analysis',
    buildPreview: (p: any) =>
      `Call #${p?.call_record_id ?? '—'} · ${p?.agent_type ?? 'sdr'}` +
      (typeof p?.include_qa_scoring === 'boolean'
        ? ` · qa=${p.include_qa_scoring}`
        : ''),
  },

  'call-ingest-tool': {
    toolId: 'call-ingest-tool',
    label: 'Ingest call recording metadata (read-only catalog)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — call catalog only, no CRM write',
    ],
    entityType: 'call_ingest',
    buildPreview: (p: any) =>
      `Source: ${p?.source ?? '—'} · call=${trim(p?.call_id, 40)}` +
      (p?.direction ? ` · ${p.direction}` : ''),
  },

  'meeting-mom-tool': {
    toolId: 'meeting-mom-tool',
    label: 'Generate meeting minutes (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only MoM generation',
    ],
    entityType: 'meeting_mom',
    buildPreview: (p: any) =>
      `Meeting: ${trim(p?.meeting_title, 80)}` +
      (p?.meeting_date ? ` · ${trim(p.meeting_date, 20)}` : ''),
  },

  'fetch-calendar-events': {
    toolId: 'fetch-calendar-events',
    label: 'Fetch Google Calendar events (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only calendar fetch',
    ],
    entityType: 'calendar_fetch',
    buildPreview: (p: any) =>
      `Range: ${p?.startDate ?? '—'} → ${p?.endDate ?? '—'}` +
      (p?.calendarId ? ` · cal=${trim(p.calendarId, 40)}` : ''),
  },

  'list-calendars': {
    toolId: 'list-calendars',
    label: 'List Google Calendars (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only calendar list',
    ],
    entityType: 'calendar_list',
    buildPreview: () => `List all available calendars`,
  },

  'audit-crm-hygiene': {
    toolId: 'audit-crm-hygiene',
    label: 'Audit CRM hygiene (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only CRM audit, no Zoho write',
    ],
    entityType: 'crm_audit',
    buildPreview: (p: any) =>
      `Modules: ${Array.isArray(p?.modules) ? p.modules.join(', ') : '—'}` +
      (typeof p?.pageSize === 'number' ? ` · pageSize=${p.pageSize}` : '') +
      (Array.isArray(p?.customRules) && p.customRules.length
        ? ` · ${p.customRules.length} custom rule(s)`
        : ''),
  },

  'check-crm-activity': {
    toolId: 'check-crm-activity',
    label: 'Check CRM activity inactivity (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only CRM activity check',
    ],
    entityType: 'crm_activity_check',
    buildPreview: (p: any) =>
      `CRM activity check` +
      (Array.isArray(p?.modules) ? ` · modules=${p.modules.join(', ')}` : '') +
      (typeof p?.inactivityDays === 'number'
        ? ` · idle≥${p.inactivityDays}d`
        : ''),
  },

  'crm-compliance-tool': {
    toolId: 'crm-compliance-tool',
    label: 'Check CRM compliance for a call (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only CRM compliance check',
    ],
    entityType: 'crm_compliance_check',
    buildPreview: (p: any) =>
      `Call #${p?.call_record_id ?? '—'}` +
      (p?.lead_id ? ` · lead=${trim(p.lead_id, 24)}` : '') +
      (p?.deal_id ? ` · deal=${trim(p.deal_id, 24)}` : '') +
      (typeof p?.check_window_hours === 'number'
        ? ` · window=${p.check_window_hours}h`
        : ''),
  },

  'evaluate-deals': {
    toolId: 'evaluate-deals',
    label: 'Evaluate batch of deals (read-only scoring)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only deal scoring; downstream NC/CAPA creation is gated separately',
    ],
    entityType: 'deal_evaluation',
    buildPreview: (p: any) =>
      `Source: ${p?.source ?? '—'}` +
      (Array.isArray(p?.dealIds) ? ` · ${p.dealIds.length} deal(s)` : '') +
      (typeof p?.pageSize === 'number' ? ` · pageSize=${p.pageSize}` : ''),
  },

  'evaluate-single-deal': {
    toolId: 'evaluate-single-deal',
    label: 'Evaluate a single deal (read-only scoring)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only single-deal scoring',
    ],
    entityType: 'deal_evaluation_single',
    buildPreview: (p: any) =>
      `Deal: ${trim(p?.dealId ?? p?.deal_id, 40)}`,
  },

  // --- email-out tools used by background workflows only ---
  // These are NOT wrapped with the chat-driven approval gate because
  // the workflow that owns them is itself governed (cron schedule,
  // recipient allowlist). They are listed here so the static check
  // confirms the policy decision was made deliberately.
  'send-quality-report': {
    toolId: 'send-quality-report',
    label: 'Send quality report email (background workflow)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-SOP-009 (Nonconformity, Violation and Corrective Action Process) — periodic quality report',
      'WP-DOC-004 (AI Adoption Guidelines) — background workflow, recipient allowlist governs distribution',
    ],
    entityType: 'quality_report_email',
    buildPreview: (p: any) =>
      `Report: ${trim(p?.reportTitle, 100)}` +
      (typeof p?.qualityScores?.overallScore === 'number'
        ? ` · overall=${p.qualityScores.overallScore}`
        : ''),
  },

  'send-alert': {
    toolId: 'send-alert',
    label: 'Send alert email (background workflow)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — background alert workflow, recipient allowlist governs distribution',
    ],
    entityType: 'alert_email',
    buildPreview: (p: any) =>
      `${p?.severity ?? 'info'}: ${trim(p?.subject ?? p?.title, 100)}`,
  },

  // --- scaffolding / docs ---
  'example-tool': {
    toolId: 'example-tool',
    label: 'Example scaffolding tool (no platform effect)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — scaffolding only, no platform read or write',
    ],
    entityType: 'example',
    buildPreview: (p: any) =>
      `Message: ${trim(p?.message, 100)}` +
      (typeof p?.count === 'number' ? ` · count=${p.count}` : ''),
  },
};

export function getPolicy(toolId: string): ToolGovernancePolicy | null {
  return TOOL_GOVERNANCE_POLICIES[toolId] || null;
}

/* ------------------------------------------------------------------------- *
 * Read-only audit view of the governance registry.
 *
 * Powers the "Tool Governance" section on the AI Operations admin page
 * (Task #651). Returns every registered tool, classified by its current
 * gate disposition so auditors can see at a glance which AI tools require
 * human approval, which are auto-approved by tier, and which bypass the
 * gate entirely (read-only / internal-notification / background workflow).
 *
 * Buckets:
 *   - gatedHigh    — requiresApproval && riskLevel === 'high'
 *   - gatedMedium  — requiresApproval && riskLevel === 'medium'
 *   - gatedLow     — requiresApproval && riskLevel === 'low'
 *   - exemptReadOnly  — !requiresApproval AND policy advertises a read-only
 *                       posture (label suffix "(read-only)" OR compliance
 *                       ref contains the literal "read-only").
 *   - exemptOther     — !requiresApproval and not read-only — covers
 *                       internal alerts, background email workflows, and
 *                       scaffolding fixtures whose side-effect is governed
 *                       elsewhere.
 *
 * The bucketing is derived from the same TOOL_GOVERNANCE_POLICIES the
 * runtime gate consults, so this view can never drift from the file.
 * ------------------------------------------------------------------------- */

export type ToolGovernanceBucket =
  | 'gatedHigh'
  | 'gatedMedium'
  | 'gatedLow'
  | 'exemptReadOnly'
  | 'exemptOther';

export interface ToolGovernanceRow {
  toolId: string;
  label: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  complianceRefs: string[];
  entityType: string;
  bucket: ToolGovernanceBucket;
}

export interface ToolGovernanceOverview {
  totalTools: number;
  counts: Record<ToolGovernanceBucket, number>;
  groups: Record<ToolGovernanceBucket, ToolGovernanceRow[]>;
}

function classifyPolicy(p: ToolGovernancePolicy): ToolGovernanceBucket {
  if (p.requiresApproval) {
    if (p.riskLevel === 'high' || p.riskLevel === 'critical') return 'gatedHigh';
    if (p.riskLevel === 'medium') return 'gatedMedium';
    return 'gatedLow';
  }
  const labelSaysReadOnly = /\(read-only\)/i.test(p.label);
  const refSaysReadOnly = (p.complianceRefs || []).some((r) =>
    /read-only/i.test(r),
  );
  return labelSaysReadOnly || refSaysReadOnly ? 'exemptReadOnly' : 'exemptOther';
}

export function getToolGovernanceOverview(): ToolGovernanceOverview {
  const groups: Record<ToolGovernanceBucket, ToolGovernanceRow[]> = {
    gatedHigh: [],
    gatedMedium: [],
    gatedLow: [],
    exemptReadOnly: [],
    exemptOther: [],
  };
  const policies = Object.values(TOOL_GOVERNANCE_POLICIES);
  for (const p of policies) {
    const bucket = classifyPolicy(p);
    groups[bucket].push({
      toolId: p.toolId,
      label: p.label,
      riskLevel: p.riskLevel,
      requiresApproval: p.requiresApproval,
      complianceRefs: [...(p.complianceRefs || [])],
      entityType: p.entityType,
      bucket,
    });
  }
  for (const key of Object.keys(groups) as ToolGovernanceBucket[]) {
    groups[key].sort((a, b) => a.toolId.localeCompare(b.toolId));
  }
  const counts: Record<ToolGovernanceBucket, number> = {
    gatedHigh: groups.gatedHigh.length,
    gatedMedium: groups.gatedMedium.length,
    gatedLow: groups.gatedLow.length,
    exemptReadOnly: groups.exemptReadOnly.length,
    exemptOther: groups.exemptOther.length,
  };
  return { totalTools: policies.length, counts, groups };
}

/* ------------------------------------------------------------------------- *
 * Auto-approval resolution
 *
 * A user can be granted auto-approval up to a certain risk level. We map
 * risk tiers to numeric ranks so "low" can auto-approve only LOW, whereas
 * "high" can auto-approve LOW/MEDIUM/HIGH (but never CRITICAL — CRITICAL
 * always requires an explicit human click, by design).
 * ------------------------------------------------------------------------- */

const RISK_RANK: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export type AutoApproveTier = 'never' | 'low' | 'medium' | 'high';

const TIER_RANK: Record<AutoApproveTier, number> = {
  never: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export interface UserApprovalContext {
  userId: number | null;
  email: string | null;
  role: string | null;
  /** Defaults to 'never' for safety. Read from users table column ai_auto_approve_tier. */
  autoApproveTier?: AutoApproveTier;
}

export function shouldAutoApprove(
  policy: ToolGovernancePolicy,
  user: UserApprovalContext
): boolean {
  if (!policy.requiresApproval) return true;                        // explicit exemption
  if (policy.riskLevel === 'critical') return false;                // critical is always manual
  const tier = user.autoApproveTier ?? 'never';
  return TIER_RANK[tier] >= RISK_RANK[policy.riskLevel];
}

export function isGateEnabled(): boolean {
  return process.env.AI_APPROVAL_GATE_ENABLED !== 'false';
}

/* ------------------------------------------------------------------------- *
 * Approver role policy.
 *
 * Per the governance decision (see WP-DOC-005 Segregation of Duties Guidelines
 * and WP-DOC-008 Accountability Framework), only Quality Managers and
 * platform admins may approve gated AI actions across ALL risk tiers.
 *
 * This is the stricter-than-necessary choice for the initial rollout; once
 * WP-DOC-005 is ratified we can relax to "Dept Lead for MEDIUM, QM for HIGH"
 * by expanding APPROVER_ROLES_BY_RISK below — no other code needs to change.
 * ------------------------------------------------------------------------- */

/**
 * Roles permitted to approve/reject pending AI actions, keyed by risk.
 * "admin" is always allowed as a break-glass role.
 *
 * Current policy (2026-04, document control phase): Quality Manager handles
 * every tier. Read the effective config via getApproverRolesFor(riskLevel).
 */
export const APPROVER_ROLES_BY_RISK: Record<RiskLevel, string[]> = {
  low:      ['quality_manager', 'head_of_operations_quality', 'admin'],
  medium:   ['quality_manager', 'head_of_operations_quality', 'admin'],
  high:     ['quality_manager', 'head_of_operations_quality', 'admin'],
  critical: ['quality_manager', 'head_of_operations_quality', 'admin'],
};

export function getApproverRolesFor(riskLevel: RiskLevel): string[] {
  return APPROVER_ROLES_BY_RISK[riskLevel] || ['admin'];
}

export function isAllowedApprover(riskLevel: RiskLevel, userRole: string | null | undefined): boolean {
  if (!userRole) return false;
  return getApproverRolesFor(riskLevel).includes(userRole);
}

