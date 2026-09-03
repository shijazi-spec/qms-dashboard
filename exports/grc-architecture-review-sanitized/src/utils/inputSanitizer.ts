const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const HTML_TAG_REGEX = /<[^>]*>/g;
const SCRIPT_PATTERNS = [
  /javascript:/gi,
  /on\w+\s*=/gi,
  /eval\s*\(/gi,
  /expression\s*\(/gi,
];

const CSV_FORMULA_CHARS = /^[=+\-@\t\r]/;

const MAX_LENGTHS: Record<string, number> = {
  title: 255,
  risk_title: 255,
  name: 255,
  full_name: 255,
  project_name: 255,
  vendor_code: 100,
  audit_code: 100,
  regulation_code: 100,
  finding_code: 100,
  obligation_code: 100,
  pack_name: 255,
  action_title: 255,
  email: 255,
  description: 5000,
  comments: 5000,
  suggestions: 5000,
  closure_notes: 5000,
  reason: 5000,
  access_reason: 5000,
  escalation_reason: 5000,
};

const MAX_GENERAL_TEXT = 10000;

function stripHtmlTags(value: string): string {
  let cleaned = value.replace(HTML_TAG_REGEX, '');
  for (const pattern of SCRIPT_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.trim();
}

function sanitizeCsvFormula(value: string): string {
  if (CSV_FORMULA_CHARS.test(value)) {
    return "'" + value;
  }
  return value;
}

function sanitizeValue(value: any, key?: string): any {
  if (typeof value === 'string') {
    let cleaned = stripHtmlTags(value);
    cleaned = sanitizeCsvFormula(cleaned);
    if (key) {
      const maxLen = MAX_LENGTHS[key] || MAX_GENERAL_TEXT;
      if (cleaned.length > maxLen) {
        cleaned = cleaned.substring(0, maxLen);
      }
    } else if (cleaned.length > MAX_GENERAL_TEXT) {
      cleaned = cleaned.substring(0, MAX_GENERAL_TEXT);
    }
    return cleaned;
  }
  if (Array.isArray(value)) {
    return value.map(v => sanitizeValue(v));
  }
  if (value !== null && typeof value === 'object') {
    return sanitizeObject(value);
  }
  return value;
}

export function sanitizeObject(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => sanitizeValue(v));

  const cleaned: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    cleaned[key] = sanitizeValue(obj[key], key);
  }
  return cleaned;
}

const ALLOWED_FIELDS: Record<string, Set<string>> = {
  risks: new Set([
    'risk_title', 'risk_description', 'risk_category', 'risk_owner', 'department',
    'status', 'likelihood_score', 'impact_score', 'risk_score', 'mitigation_strategy',
    'residual_risk', 'review_date', 'source', 'regulation', 'control_ids', 'tags',
    'ai_detected', 'ai_confidence', 'ai_suggestions', 'ai_recommended_controls',
    'treatment_plan', 'treatment_status', 'treatment_due_date', 'treatment_owner',
    'escalation_reason', 'closure_notes', 'justification', 'reason',
    'action_title', 'action_type', 'assigned_to', 'due_date', 'priority', 'notes',
  ]),
  vendors: new Set([
    'vendor_code', 'name', 'category', 'status', 'risk_level', 'contact_name',
    'contact_email', 'contact_phone', 'contract_start', 'contract_end',
    'contract_value', 'services', 'certifications', 'compliance_status',
    'last_assessment_date', 'next_assessment_date', 'notes', 'sla_details',
    'description', 'department', 'location', 'tags',
  ]),
  // NOTE: this list is applied to EVERY JSON body on /api/policies/* by the
  // middleware, so a field missing here is silently deleted before the handler
  // sees it. It was missing `policy_number`, which POST /api/policies REQUIRES
  // — so every create returned "Missing required fields", from the Document
  // Control UI as well as the API, and no new controlled document could be
  // added at all. The names below are the ones the create form actually posts
  // (dashboard/policies.html) plus the document-control metadata columns.
  //
  // Deliberately NOT here: file_path / file_name / file_size / file_mime_type.
  // Those may only be set by POST /api/policies/:id/upload, so that a JSON body
  // can never rebind a document to another module's file. The create handler
  // strips them too — this is the outer of the two gates, keep both.
  policies: new Set([
    'title', 'description', 'category', 'status', 'version', 'effective_date',
    'review_date', 'owner', 'approver', 'department', 'regulation', 'tags',
    'content', 'scope', 'objectives', 'references', 'revision_notes',
    'grc_comments', 'owners', 'acknowledgment_required',
    'transition_to', 'comments',
    // The lifecycle endpoints read these NAMES, not the ones above:
    // /transition requires `new_status` (`transition_to` was never read by any
    // handler), /set-owners requires operational_owner + compliance_owner,
    // /acknowledge reads user_email, and the review-cycle routes read
    // policy_id + scheduled_date. Each was stripped, so every one of those
    // endpoints answered "Missing required fields" no matter what was sent —
    // a published document could not even be archived, which is the only route
    // to deleting one.
    'new_status', 'operational_owner', 'operational_owner_email',
    'compliance_owner', 'compliance_owner_email',
    'user_email', 'policy_id', 'scheduled_date',
    'policy_number', 'document_number', 'document_type',
    'owner_name', 'owner_department', 'approver_name',
    'confidentiality', 'content_text', 'retention_period',
    'requires_acknowledgment', 'acknowledgment_frequency',
    'expiry_date', 'change_summary', 'supersedes_id', 'parent_policy_id',
  ]),
  audits: new Set([
    'audit_code', 'title', 'audit_type', 'status', 'auditor', 'department',
    'scheduled_date', 'completion_date', 'scope', 'methodology', 'findings_summary',
    'overall_score', 'people_score', 'process_score', 'technology_score',
    'recommendations', 'notes', 'description', 'checklist',
    'finding_code', 'finding_title', 'finding_description', 'severity', 'remediation',
    'pack_name', 'evidence_type', 'evidence_url', 'evidence_description',
  ]),
  roi: new Set([
    'project_name', 'department', 'owner', 'description', 'status',
    'implementation_cost', 'license_cost', 'training_cost', 'maintenance_cost',
    'fully_loaded_salary', 'annual_cost', 'monthly_cost', 'total_cost',
    'cost_per_error', 'error_rate', 'errors_per_month', 'calculated_error_savings',
    'revenue_increase', 'cost_savings', 'calculated_revenue_impact',
    'total_investment', 'net_benefit', 'roi_percentage', 'payback_months',
    'npv', 'irr', 'risk_adjusted_roi', 'tags', 'notes',
    'manpower', 'errorCosts', 'revenueImpact', 'implementation', 'riskInputs', 'platformCosts',
  ]),
  compliance: new Set([
    'regulation_code', 'title', 'description', 'category', 'status',
    'effective_date', 'review_date', 'authority', 'scope', 'requirements',
    'control_id', 'control_code', 'control_name', 'control_description',
    'control_type', 'implementation_status', 'owner', 'evidence_url',
    'obligation_code', 'obligation_text', 'compliance_status', 'due_date',
    'responsible_party', 'notes', 'tags', 'department',
    'capa_type', 'root_cause', 'corrective_action', 'preventive_action',
    'assigned_to', 'priority', 'target_date',
  ]),
  users: new Set([
    'email', 'full_name', 'role', 'team', 'department', 'status',
    'password', 'access_reason', 'permission_overrides', 'reason',
  ]),
  invitations: new Set([
    'email', 'role', 'department', 'team', 'invited_by', 'message',
    'token', 'password', 'full_name', 'access_reason',
  ]),
  calls: new Set([
    'call_id', 'source', 'recording_url', 'lead_id', 'deal_id',
    'contact_name', 'agent_email', 'agent_name', 'direction',
    'duration_seconds', 'call_date', 'metadata', 'status',
    'domain', 'username', 'password',
  ]),
};

function getModuleFromPath(path: string): string | null {
  const match = path.match(/^\/api\/([a-z\-]+)/);
  if (!match) return null;
  const segment = match[1];
  if (segment === 'call-intelligence' || segment === 'calls') return 'calls';
  if (ALLOWED_FIELDS[segment]) return segment;
  return null;
}

export function filterAllowedFields(body: any, apiPath: string): any {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const moduleName = getModuleFromPath(apiPath);
  if (!moduleName) return body;
  const allowed = ALLOWED_FIELDS[moduleName];
  if (!allowed) return body;
  const filtered: Record<string, any> = {};
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) {
      filtered[key] = body[key];
    }
  }
  return filtered;
}

export function sanitizeRequestBody(body: any, apiPath?: string): any {
  if (!body || typeof body !== 'object') return body;
  let sanitized = sanitizeObject(body);
  if (apiPath) {
    sanitized = filterAllowedFields(sanitized, apiPath);
  }
  return sanitized;
}

const ROI_FINANCIAL_FIELDS = new Set([
  'fully_loaded_salary', 'annual_cost', 'monthly_cost', 'total_cost',
  'implementation_cost', 'license_cost', 'training_cost', 'maintenance_cost',
  'cost_per_error', 'error_rate', 'errors_per_month', 'calculated_error_savings',
  'revenue_increase', 'cost_savings', 'calculated_revenue_impact',
  'total_investment', 'net_benefit', 'roi_percentage', 'payback_months',
  'npv', 'irr', 'risk_adjusted_roi',
]);

export function validateROIFinancials(body: any): string | null {
  if (!body || typeof body !== 'object') return null;
  for (const key of Object.keys(body)) {
    if (ROI_FINANCIAL_FIELDS.has(key)) {
      const val = body[key];
      if (val !== undefined && val !== null) {
        if (typeof val !== 'number' || isNaN(val)) {
          return 'Invalid financial values provided';
        }
        if (val < 0) {
          return 'Financial values must not be negative';
        }
        if (val > <REDACTED_PHONE>{
          return 'Financial values exceed maximum allowed range';
        }
      }
    }
  }
  return null;
}

const PASSWORD_POLICY = {
  minLength: 12,
  requireUppercase: /[A-Z]/,
  requireLowercase: /[a-z]/,
  requireNumber: /[0-9]/,
  requireSpecial: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/,
};

export function validatePassword(password: string): string | null {
  if (!password || typeof password !== 'string') {
    return 'Password does not meet the required policy';
  }
  if (password.length < PASSWORD_POLICY.minLength ||
      !PASSWORD_POLICY.requireUppercase.test(password) ||
      !PASSWORD_POLICY.requireLowercase.test(password) ||
      !PASSWORD_POLICY.requireNumber.test(password) ||
      !PASSWORD_POLICY.requireSpecial.test(password)) {
    return 'Password does not meet the required policy';
  }
  return null;
}

export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('duplicate key') || msg.includes('23505')) {
      return 'A record with this identifier already exists';
    }
    if (msg.includes('violates') || msg.includes('constraint')) {
      return 'The request violates data constraints';
    }
    if (msg.includes('syntax error') || msg.includes('column') || msg.includes('relation')) {
      return 'An internal error occurred';
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
      return 'Service temporarily unavailable';
    }
    if (msg.includes('EmailProvider') || msg.includes('SMTP') || msg.includes('email')) {
      return 'Email service temporarily unavailable';
    }
  }
  return 'An internal error occurred';
}

export function escapeCSVValue(value: any): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  let safe = str;
  if (CSV_FORMULA_CHARS.test(safe)) {
    safe = "'" + safe;
  }
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
