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
  'create-alert': {
    toolId: 'create-alert',
    label: 'Create internal AI alert',
    riskLevel: 'low',
    requiresApproval: false, // internal notification only, no external side-effect
    complianceRefs: [],
    entityType: 'alert',
    buildPreview: (p: any) => `${p?.severity ?? 'info'}: ${trim(p?.title, 100)}`,
  },
};

export function getPolicy(toolId: string): ToolGovernancePolicy | null {
  return TOOL_GOVERNANCE_POLICIES[toolId] || null;
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

