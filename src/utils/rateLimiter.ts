interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

const WINDOW_MS = 60 * 1000;
const READ_LIMIT = 100;
const WRITE_LIMIT = 10;
const AUTH_LIMIT = 5;
const EXPORT_LIMIT = 10;

const AUTH_PATHS = ['/api/auth/', '/api/invitations/accept', '/login', '/api/admin/auth'];
const EXPORT_PATHS = ['/export', '/pdf'];

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) {
      store.delete(key);
    }
  }
}, 60 * 1000);

function getCategory(path?: string): string {
  if (path) {
    if (AUTH_PATHS.some(p => path.startsWith(p) || path.includes(p))) return 'auth';
    if (EXPORT_PATHS.some(p => path.includes(p))) return 'export';
  }
  return 'general';
}

export function checkRateLimit(ip: string, isWrite: boolean, path?: string): { allowed: boolean; retryAfter?: number } {
  const category = getCategory(path);
  const key = category === 'auth' ? `${ip}:auth` : `${ip}:${category}:${isWrite ? 'w' : 'r'}`;
  const now = Date.now();

  let limit: number;
  if (category === 'auth') {
    limit = AUTH_LIMIT;
  } else if (category === 'export') {
    limit = EXPORT_LIMIT;
  } else {
    limit = isWrite ? WRITE_LIMIT : READ_LIMIT;
  }

  let entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(key, entry);
  }

  entry.count++;

  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}
