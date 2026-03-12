const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const HTML_TAG_REGEX = /<[^>]*>/g;
const SCRIPT_PATTERNS = [
  /javascript:/gi,
  /on\w+\s*=/gi,
  /eval\s*\(/gi,
  /expression\s*\(/gi,
];

function stripHtmlTags(value: string): string {
  let cleaned = value.replace(HTML_TAG_REGEX, '');
  for (const pattern of SCRIPT_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.trim();
}

function sanitizeValue(value: any): any {
  if (typeof value === 'string') {
    return stripHtmlTags(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === 'object') {
    return sanitizeObject(value);
  }
  return value;
}

export function sanitizeObject(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeValue);

  const cleaned: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    cleaned[key] = sanitizeValue(obj[key]);
  }
  return cleaned;
}

export function sanitizeRequestBody(body: any): any {
  if (!body || typeof body !== 'object') return body;
  return sanitizeObject(body);
}
