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

export function sanitizeRequestBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  return sanitizeObject(body);
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
          return `Field '${key}' must be a valid number`;
        }
        if (val < 0) {
          return `Field '${key}' must not be negative`;
        }
        if (val > 999999999999) {
          return `Field '${key}' exceeds maximum allowed value`;
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
    return 'Password is required';
  }
  if (password.length < PASSWORD_POLICY.minLength) {
    return `Password must be at least ${PASSWORD_POLICY.minLength} characters`;
  }
  if (!PASSWORD_POLICY.requireUppercase.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!PASSWORD_POLICY.requireLowercase.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!PASSWORD_POLICY.requireNumber.test(password)) {
    return 'Password must contain at least one number';
  }
  if (!PASSWORD_POLICY.requireSpecial.test(password)) {
    return 'Password must contain at least one special character';
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
    if (msg.includes('Resend') || msg.includes('SMTP') || msg.includes('email')) {
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
