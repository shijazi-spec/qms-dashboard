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

  'tag-records-for-removal': {
    toolId: 'tag-records-for-removal',
    label: 'Tag Zoho records for removal',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-011 (Automated Decision and Processing Process)',
      'WP-DOC-004 (AI Adoption Guidelines)',
      'ISO 9001:2015 §7.5 (Control of documented information)',
      'PDPL Art. 18 (Data minimization / erasure)',
    ],
    entityType: 'zoho_tag',
    buildPreview: (p: any) =>
      [
        `**Module:** ${p?.module ?? 'n/a'}`,
        `**Tag:** ${p?.tag ?? 'Duplicate-Delete'}`,
        `**Records:** ${(p?.recordIds || []).length} record(s) flagged for admin removal`,
        p?.reason ? `**Reason:** ${trim(p.reason, 200)}` : null,
      ].filter(Boolean).join('\n'),
  },

  'merge-records': {
    toolId: 'merge-records',
    label: 'Merge duplicate Zoho records (migrate-then-tag)',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-011 (Automated Decision and Processing Process)',
      'WP-DOC-004 (AI Adoption Guidelines)',
      'ISO 9001:2015 §7.5 (Control of documented information)',
    ],
    entityType: 'zoho_merge',
    buildPreview: (p: any) =>
      [
        `**Module:** ${p?.module ?? 'n/a'}`,
        `**Survivor (keep):** ${p?.survivorZohoId ?? 'n/a'}`,
        `**Merge in + tag Duplicate-Delete:** ${(p?.duplicateZohoIds || []).length} record(s)`,
        p?.reason ? `**Reason:** ${trim(p.reason, 200)}` : null,
      ].filter(Boolean).join('\n'),
  },
  'untag-records': {
    toolId: 'untag-records',
    label: 'Remove a tag from Zoho records (e.g. Duplicate-Delete)',
    riskLevel: 'medium',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-011 (Automated Decision and Processing Process)',
      'WP-DOC-004 (AI Adoption Guidelines)',
      'ISO 9001:2015 §7.5 (Control of documented information)',
    ],
    entityType: 'zoho_untag',
    buildPreview: (p: any) =>
      [
        `**Module:** ${p?.module ?? 'n/a'}`,
        `**Remove tag:** ${p?.tag ?? 'Duplicate-Delete'}`,
        `**Records:** ${(p?.recordIds || []).length} record(s)`,
        p?.reason ? `**Reason:** ${trim(p.reason, 200)}` : null,
      ].filter(Boolean).join('\n'),
  },
  'link-records-to-account': {
    toolId: 'link-records-to-account',
    label: 'Link Contacts/Deals to an Account (set Account_Name)',
    riskLevel: 'medium',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-011 (Automated Decision and Processing Process)',
      'WP-DOC-004 (AI Adoption Guidelines)',
      'ISO 9001:2015 §7.5 (Control of documented information)',
    ],
    entityType: 'zoho_link',
    buildPreview: (p: any) =>
      [
        `**Module:** ${p?.module ?? 'n/a'}`,
        `**Link to Account:** ${p?.accountZohoId ?? 'n/a'}`,
        `**Records:** ${(p?.recordIds || []).length} record(s) to relink`,
        p?.reason ? `**Reason:** ${trim(p.reason, 200)}` : null,
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
    buildPreview: (p: any) => {
      const lines: string[] = [
        `**Action:** ${p?.action ?? 'n/a'}`,
      ];
      if (p?.checklistName) lines.push(`**Checklist:** ${trim(p.checklistName, 120)}`);
      if (p?.checklistId) lines.push(`**Checklist ID:** ${p.checklistId}`);
      if (Array.isArray(p?.items)) {
        lines.push(`**Items:** ${p.items.length}`);
        // Surface the modules and any embedded SQL so approvers can see what
        // data sources will be queried before authorising a create action.
        const modulesUsed: string[] = [];
        const sqlSnippets: string[] = [];
        for (const item of p.items) {
          if (item?.module_to_query && !modulesUsed.includes(item.module_to_query)) {
            modulesUsed.push(item.module_to_query);
          }
          if (item?.check_type === 'data_query' && item?.query_config?.sql) {
            sqlSnippets.push(trim(String(item.query_config.sql), 120));
          }
        }
        if (modulesUsed.length > 0) lines.push(`**Modules queried:** ${modulesUsed.join(', ')}`);
        if (sqlSnippets.length > 0) lines.push(`**Custom SQL (data_query items):**\n${sqlSnippets.map(s => `  - ${s}`).join('\n')}`);
      }
      return lines.filter(Boolean).join('\n');
    },
  },

  'duplicate-resolution': {
    toolId: 'duplicate-resolution',
    label: 'Resolve duplicate cluster (migrate fields + tag duplicates)',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: [
      'ISO 9001:2015 §8.5.1 (Control of production and service provision)',
      'ISO 9001:2015 §7.5 (Documented information)',
      'ISO 27001 A.8.3 (Non-repudiation — acts on behalf of Sarah Hijazi)',
      'PDPL (contact/lead personal data)',
    ],
    entityType: 'duplicate_cluster',
    buildPreview: (p: any) => {
      const plan = p?.plan ?? {};
      const lines: string[] = [
        `**Module:** ${p?.module ?? plan.module ?? 'n/a'}`,
        `**Cluster:** #${p?.clusterId ?? plan.clusterId ?? 'n/a'}`,
        `**Survivor:** ${trim(String(plan.masterName ?? 'n/a'), 120)}`,
        `**Duplicates to tag:** ${Array.isArray(plan.duplicateZohoIds) ? plan.duplicateZohoIds.length : 0}`,
        `**Field migrations:** ${Array.isArray(plan.fieldDecisions) ? plan.fieldDecisions.length : 0}`,
      ];
      if (plan.linkAccountZohoId) lines.push(`**Link to account:** ${trim(String(plan.linkAccountZohoId), 60)}`);
      if (Array.isArray(p?.reasons) && p.reasons.length) {
        lines.push(`**Why escalated:** ${trim(p.reasons.slice(0, 3).join('; '), 240)}`);
      }
      return lines.filter(Boolean).join('\n');
    },
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

  // --- Duplicate Radar read-only status tools (no writes; reads only) ---
  'lookup-entity': {
    toolId: 'lookup-entity',
    label: 'CRM entity lookup (company/person/domain/email/phone)',
    riskLevel: 'low',
    requiresApproval: false, // read-only Zoho search across modules
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only CRM lookup; surfaces contact data only to the authorized caller'],
    entityType: 'crm_lookup',
    buildPreview: (p: any) => `Lookup: ${trim(p?.query, 80)}`,
  },
  'cs-lifecycle-status': {
    toolId: 'cs-lifecycle-status',
    label: 'CS Lifecycle status (deals by phase / renewal)',
    riskLevel: 'low',
    requiresApproval: false, // read-only
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only CS lifecycle status'],
    entityType: 'cs_lifecycle_status',
    buildPreview: () => 'CS Lifecycle status',
  },
  'executive-summary': {
    toolId: 'executive-summary',
    label: 'Executive Summary (platform-wide duplicate KPIs)',
    riskLevel: 'low',
    requiresApproval: false, // read-only aggregate tiles
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only KPI summary'],
    entityType: 'executive_summary',
    buildPreview: () => 'Executive duplicate-radar summary',
  },
  'cs-pipeline-overlap-status': {
    toolId: 'cs-pipeline-overlap-status',
    label: 'CS Pipeline Overlap status (block/review/warn)',
    riskLevel: 'low',
    requiresApproval: false, // read-only
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only CS overlap counts'],
    entityType: 'cs_overlap_status',
    buildPreview: () => 'CS Pipeline Overlap status',
  },
  'cross-module-overlap-status': {
    toolId: 'cross-module-overlap-status',
    label: 'Cross-Module Overlap status (same company across modules)',
    riskLevel: 'low',
    requiresApproval: false, // read-only counts
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only cross-module counts'],
    entityType: 'cross_module_status',
    buildPreview: () => 'Cross-Module Overlap status',
  },
  'account-hints-status': {
    toolId: 'account-hints-status',
    label: 'Account Hints status (pending/applied/dismissed)',
    riskLevel: 'low',
    requiresApproval: false, // read-only counts
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only account-hints counts'],
    entityType: 'account_hints_status',
    buildPreview: () => 'Account Hints status',
  },
  'deal-compliance-status': {
    toolId: 'deal-compliance-status',
    label: 'Deal Compliance status (documents present/missing)',
    riskLevel: 'low',
    requiresApproval: false, // read-only counts
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only deal-compliance counts'],
    entityType: 'deal_compliance_status',
    buildPreview: () => 'Deal Compliance status',
  },
  'agent-activity': {
    toolId: 'agent-activity',
    label: 'Agent Activity log (autonomous resolution audit trail)',
    riskLevel: 'low',
    requiresApproval: false, // read-only audit trail
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only agent-activity log'],
    entityType: 'agent_activity',
    buildPreview: () => 'Agent Activity log',
  },
  'manual-action-audit': {
    toolId: 'manual-action-audit',
    label: 'Manual Actions audit (operator merge/resolve actions)',
    riskLevel: 'low',
    requiresApproval: false, // read-only audit trail
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only manual-action audit'],
    entityType: 'manual_action_audit',
    buildPreview: () => 'Manual Actions audit',
  },
  'owner-accountability': {
    toolId: 'owner-accountability',
    label: 'Owner Accountability (duplicates by owner)',
    riskLevel: 'low',
    requiresApproval: false, // read-only aggregate
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only owner aggregate'],
    entityType: 'owner_accountability',
    buildPreview: () => 'Duplicates by owner',
  },
  'preflight-check': {
    toolId: 'preflight-check',
    label: 'Preflight create-verdict (duplicate / CS overlap)',
    riskLevel: 'low',
    requiresApproval: false, // read-only verdict; creates nothing
    complianceRefs: ['WP-DOC-004 (AI Adoption Guidelines) — read-only pre-create verdict; no record is created'],
    entityType: 'preflight_verdict',
    buildPreview: (p: any) => `Preflight: ${trim(p?.company_name || p?.domain || p?.email || p?.phone, 80)}`,
  },

  'duplicate-resolution-assistant': {
    toolId: 'duplicate-resolution-assistant',
    label: 'Duplicate-resolution assistant (status / rules / preview)',
    riskLevel: 'low',
    // Exempt: reads (status/grades/rules/plan-preview) + teaching a learning
    // rule. The only write is to the agent's OWN routing rulebook
    // (duplicate_resolution_rules) — it never touches Zoho and is fully
    // reversible from the Rules view. The Zoho-writing path stays gated by
    // the separate high-risk 'duplicate-resolution' policy.
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read + own-rulebook write, no external side-effect',
      'ISO 9001:2015 §10.3 (continual improvement — captures operator guidance)',
    ],
    entityType: 'duplicate_cluster',
    buildPreview: (p: any) =>
      `Action: ${p?.action ?? '—'}` +
      (p?.module ? ` · ${p.module}` : '') +
      (p?.clusterId ? ` · cluster #${p.clusterId}` : '') +
      (p?.decision ? ` · ${p.decision}` : ''),
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

  // --- call intelligence / lead matching (read-only) ---
  'match-lead-by-phone': {
    toolId: 'match-lead-by-phone',
    label: 'Match Zoho CRM leads by phone (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only Zoho Leads lookup, no platform write',
    ],
    entityType: 'lead_phone_match',
    buildPreview: (p: any) =>
      `Phone: ${trim(p?.phone, 40) || '—'}` +
      (typeof p?.max_records === 'number' ? ` · scan up to ${p.max_records}` : ''),
  },

  'reconcile-call': {
    toolId: 'reconcile-call',
    label: 'Reconcile call transcript vs. evaluation (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only call intelligence reconciliation, no platform write',
    ],
    entityType: 'call_reconciliation',
    buildPreview: (p: any) =>
      `Call #${p?.call_record_id ?? '—'}`,
  },

  // Read-only Duplicate-Radar lookup that answers "can SDR/Marketing
  // contact this domain right now?" by enumerating Deal records for the
  // domain. Returns a verdict (block/review/allow) plus per-deal signals.
  // No platform write — the verdict is advisory and the operator still
  // initiates any outreach via existing CRM tooling.
  'check-communication-eligibility': {
    toolId: 'check-communication-eligibility',
    label: 'Check communication eligibility for a domain (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only Duplicate Radar lookup, no platform write',
      'PDPL Art. 16 — no PII enrichment; verdict only',
    ],
    entityType: 'communication_eligibility_check',
    buildPreview: (p: any) =>
      `Domain: ${trim(p?.domain, 80) || '—'}`,
  },

  // Imports Google Drive audio files as call_records. WRITES platform
  // data (call_records inserts) — gated. Dry-run mode is supported by
  // the tool itself; the preview surfaces the folder/query so the
  // approver can sanity-check before the agent flips dry_run to false.
  'drive-call-import': {
    toolId: 'drive-call-import',
    label: 'Import call recordings from Google Drive',
    riskLevel: 'medium',
    requiresApproval: true,
    complianceRefs: [
      'WP-SOP-011 (Automated Decision and Processing Process) — agent-triggered write to call_records',
      'WP-DOC-004 (AI Adoption Guidelines)',
      'PDPL Art. 16 — call recordings may contain PII; ingestion source must be approved',
    ],
    entityType: 'call_drive_import',
    buildPreview: (p: any) =>
      [
        p?.folder_id ? `**Folder:** ${trim(p.folder_id, 80)}` : '**Folder:** (env default)',
        p?.query ? `**Query:** ${trim(p.query, 120)}` : null,
        typeof p?.page_size === 'number' ? `**Page size:** ${p.page_size}` : null,
        p?.agent_email ? `**Agent email tag:** ${trim(p.agent_email, 80)}` : null,
        p?.dry_run ? '**Mode:** dry-run (no writes)' : '**Mode:** WILL CREATE call_records',
      ].filter(Boolean).join('\n'),
  },

  // Read-only catalog of how calls enter the platform and the CRM
  // phone-match scope. Pure in-process config read — no DB, no
  // external API.
  'get-import-sources': {
    toolId: 'get-import-sources',
    label: 'Get call import-source catalog (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only catalog query, no platform write',
    ],
    entityType: 'import_source_catalog',
    buildPreview: () =>
      'Returns the canonical Five9 / bulk-upload / Google Drive channel catalog plus the SDR↔CRM phone-match scope. No inputs; pure config read.',
  },

  // Pure-function evaluator: scores a transcript against the loaded
  // SDR Governance 2.1 JSON ruleset. No DB or external side-effect —
  // returns governance issues for the caller to log/display.
  'evaluate-sdr-governance': {
    toolId: 'evaluate-sdr-governance',
    label: 'Evaluate SDR governance rules against a transcript (read-only)',
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — read-only ruleset evaluation, no platform write',
    ],
    entityType: 'sdr_governance_evaluation',
    buildPreview: (p: any) => {
      const len = typeof p?.transcript_text === 'string' ? p.transcript_text.length : 0;
      return `Transcript chars: ${len}`;
    },
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

/**
 * Resolve a tool's policy, synthesizing a SAFE read-only default for any tool
 * that has no explicit entry. This is the "self-registration" guard so a new
 * read-only radar tool (added in the Replit editor, say) never blocks a publish
 * on the governance-coverage gate.
 *
 * SECURITY: the default is read-only (requiresApproval: false). It is therefore
 * ONLY safe for tools that are NOT approval-gated. `getPolicy()` (used by
 * `withApprovalGate`) deliberately stays strict and returns null for unknown
 * tools — so a WRITE tool wrapped with the gate still MUST have an explicit
 * policy (defaulting a write tool to no-approval would be a security hole).
 * Use THIS function only for coverage/audit/read paths, never to gate writes.
 */
export function getEffectiveToolGovernancePolicy(
  toolId: string,
): ToolGovernancePolicy {
  const explicit = TOOL_GOVERNANCE_POLICIES[toolId];
  if (explicit) return explicit;
  return {
    toolId,
    label: `${toolId} (auto-classified read-only)`,
    riskLevel: 'low',
    requiresApproval: false,
    complianceRefs: [
      'WP-DOC-004 (AI Adoption Guidelines) — auto-classified read-only; add an explicit TOOL_GOVERNANCE_POLICIES entry to override',
    ],
    entityType: 'auto_read_only',
    buildPreview: () => `${toolId} (read-only)`,
  };
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

