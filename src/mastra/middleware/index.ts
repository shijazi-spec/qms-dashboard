import { MastraError } from "@mastra/core/error";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getSessionFromCookie } from "../routes/authRoutes";
import { sanitizeRequestBody } from "../../utils/inputSanitizer";
import { checkRateLimit, parseClientIp } from "../../utils/rateLimiter";
import { hasValidAdminApiKey } from "../../utils/rbacMiddleware";

// Per-IP in-memory sampler: caps how many `rate_limit_429` rows we write per
// minute per source IP so a single attacker (or misconfigured client) can't
// fill `system_events` with thousands of identical rows per minute. The cap is
// configurable via env (default 20/min/IP). Suppressed counts are folded into
// the next emitted row's metadata so ops can see the true volume.
const RATE_LIMIT_429_LOG_MAX_PER_MIN = (() => {
  const raw = process.env.RATE_LIMIT_429_LOG_MAX_PER_MIN;
  const parsed = parseInt(raw ?? '20', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
})();

interface RateLimit429SampleBucket {
  windowStartMinute: number;
  emitted: number;
  suppressed: number;
}
const rateLimit429Samples = new Map<string, RateLimit429SampleBucket>();
const RATE_LIMIT_429_SAMPLES_MAX_KEYS = 10_000;

function evictStaleSampleBuckets(currentMinute: number): void {
  // First pass: drop anything not in the current OR previous minute
  // (previous-minute buckets are kept only long enough to carry their
  // suppressed count forward — see the carryover branch below).
  for (const [k, v] of rateLimit429Samples) {
    if (v.windowStartMinute < currentMinute - 1) rateLimit429Samples.delete(k);
  }
  // Second pass: if still over budget (e.g. >10k unique IPs in a single
  // minute — a high-cardinality attack), drop previous-minute buckets too.
  // We accept losing the suppressed-count carryover for those keys in
  // exchange for hard-bounded memory.
  if (rateLimit429Samples.size > RATE_LIMIT_429_SAMPLES_MAX_KEYS) {
    for (const [k, v] of rateLimit429Samples) {
      if (v.windowStartMinute < currentMinute) rateLimit429Samples.delete(k);
      if (rateLimit429Samples.size <= RATE_LIMIT_429_SAMPLES_MAX_KEYS) break;
    }
  }
}

function evaluateRateLimit429Sampling(ip: string): { log: boolean; suppressedCarryover: number } {
  const minute = Math.floor(Date.now() / 60_000);
  const key = ip || 'unknown';
  const bucket = rateLimit429Samples.get(key);

  if (!bucket || bucket.windowStartMinute !== minute) {
    const suppressedCarryover = bucket && bucket.windowStartMinute === minute - 1 ? bucket.suppressed : 0;
    if (rateLimit429Samples.size >= RATE_LIMIT_429_SAMPLES_MAX_KEYS) {
      evictStaleSampleBuckets(minute);
      // If we're STILL at the cap (every key is from the current minute),
      // skip tracking this new IP. We still emit the log so observability
      // doesn't go dark — the only thing we lose is per-IP sampling for
      // IPs that didn't make it into the budget this minute.
      if (rateLimit429Samples.size >= RATE_LIMIT_429_SAMPLES_MAX_KEYS) {
        return { log: true, suppressedCarryover };
      }
    }
    rateLimit429Samples.set(key, { windowStartMinute: minute, emitted: 1, suppressed: 0 });
    return { log: true, suppressedCarryover };
  }

  if (bucket.emitted < RATE_LIMIT_429_LOG_MAX_PER_MIN) {
    bucket.emitted += 1;
    return { log: true, suppressedCarryover: 0 };
  }

  bucket.suppressed += 1;
  return { log: false, suppressedCarryover: 0 };
}

function logRateLimit429(urlPath: string, method: string, ip: string, retryAfter?: number): void {
  const { log, suppressedCarryover } = evaluateRateLimit429Sampling(ip);
  if (!log) return;

  // Fire-and-forget — never block the request or surface DB errors back to clients.
  import("../../utils/database")
    .then(({ logSystemEvent }) =>
      logSystemEvent({
        event_type: 'rate_limit_429',
        event_category: 'security',
        description: `429 Too Many Requests on ${method} ${urlPath}`,
        severity: 'warning',
        source: 'rateLimiter',
        metadata: {
          path: urlPath,
          method,
          ip,
          retry_after: retryAfter ?? null,
          sampling_cap_per_min: RATE_LIMIT_429_LOG_MAX_PER_MIN,
          ...(suppressedCarryover > 0 ? { suppressed_in_previous_minute: suppressedCarryover } : {}),
        },
      }),
    )
    .catch(() => { /* swallow — observability must never break the request path */ });
}

const PUBLIC_PATHS = [
  '/login', '/api/auth/', '/api/login', '/api/callback', '/api/logout',
  // NOTE: `/guide` was historically public but is now gated as an internal
  // dashboard page (see staticPageRoutes.ts and task-444). The middleware
  // must therefore run `checkPageAuth` for it so unauthenticated visitors
  // are redirected to /login instead of being served the page.
  '/sop', '/api/sop', '/accept-invite', '/css/', '/js/',
  '/dashboard/tailwind.css', '/dashboard/i18n/', '/api/invitations/validate/', '/api/invitations/accept',
  '/api/admin/auth', '/api/health', '/api/smoke', '/webhooks/slack',
  '/api/webhooks/slack', '/test/slack', '/api/telemetry/pageview', '/a11y',
  // Streaming-download service worker + its iframe-trigger URL pattern.
  // The SW file must load without an auth redirect (browsers fetch it
  // independently of cookies). The trigger URL is intercepted by the SW
  // before reaching the network, so the public allowlist is just defensive
  // 404 plumbing for browsers without SW support.
  '/streaming-download-sw.js', '/_stream-download/',
  '/api/user/language-preference',
];

const MASTRA_INTERNAL_PREFIXES = ['/api/workflows/', '/api/memory/'];

function getAllowedOrigins(): string[] {
  return (process.env.REPLIT_DOMAINS || '').split(',')
    .map((d: string) => `https://${d.trim()}`)
    .filter(Boolean);
}

function isPublicPath(urlPath: string): boolean {
  return PUBLIC_PATHS.some(p => urlPath === p || urlPath.startsWith(p));
}

function isMastraInternal(urlPath: string): boolean {
  return MASTRA_INTERNAL_PREFIXES.some(p => urlPath.startsWith(p)) ||
    (urlPath.startsWith('/api/agents/') && !urlPath.startsWith('/api/agents/performance'));
}

function handleCors(c: any, allowedOrigins: string[]): Response | null {
  const method = c.req.method;
  if (method === 'OPTIONS') {
    const origin = c.req.header('Origin') || '';
    const allowedOrigin = allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] || '');
    c.header('Access-Control-Allow-Origin', allowedOrigin);
    c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Key');
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Max-Age', '3600');
    return c.text('', 204);
  }
  const origin = c.req.header('Origin') || '';
  const resolvedOrigin = (origin && allowedOrigins.includes(origin)) ? origin : (allowedOrigins[0] || '');
  if (resolvedOrigin) {
    c.header('Access-Control-Allow-Origin', resolvedOrigin);
    c.header('Access-Control-Allow-Credentials', 'true');
  }
  return null;
}

function applySecurityHeaders(c: any, cspNonce: string): void {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${cspNonce}' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'nonce-${cspNonce}' https://fonts.googleapis.com https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self' https://replit.com https://accounts.google.com https://oauth2.googleapis.com; frame-ancestors 'none'; form-action 'self'`);
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  (c as any)._cspNonce = cspNonce;
}

function checkInngestAccess(c: any, urlPath: string): Response | null {
  if (urlPath === '/api/inngest' || urlPath.startsWith('/api/inngest')) {
    if (!hasValidAdminApiKey(c)) {
      return c.json({ error: 'Access denied' }, 403);
    }
  }
  return null;
}

function checkPageAuth(c: any): Response | null {
  const session = getSessionFromCookie(c.req.header('Cookie'));
  if (!session && !hasValidAdminApiKey(c)) {
    return c.redirect('/login');
  }
  return null;
}

async function checkApiAuth(c: any, urlPath: string, method: string): Promise<Response | null> {
  const session = getSessionFromCookie(c.req.header('Cookie'));
  const hasAdminKey = hasValidAdminApiKey(c);

  const isAuthenticated = !!(session || hasAdminKey);

  const ip = parseClientIp(c.req.header('x-forwarded-for'), c.req.header('x-real-ip'));
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const rateCheck = await checkRateLimit(ip, isWrite, urlPath, isAuthenticated, session?.userId ? String(session.userId) : undefined);
  if (!rateCheck.allowed) {
    c.header('Retry-After', String(rateCheck.retryAfter || 60));
    logRateLimit429(urlPath, method, ip, rateCheck.retryAfter);
    return c.json({ error: 'Too many requests' }, 429);
  }

  if (!session && !hasAdminKey) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  if (session && !hasAdminKey) {
    const { checkPlatformUserActive } = await import('../../utils/rbacMiddleware');
    const isActive = await checkPlatformUserActive(session.email);
    if (!isActive) {
      return c.json({ error: 'Account is not active or has been disabled' }, 403);
    }
  }

  if (urlPath.startsWith('/api/admin/') || urlPath === '/api/admin') {
    if (!hasAdminKey) {
      return c.json({ error: 'X-Admin-Key header required for admin endpoints' }, 403);
    }
  }

  if (!hasAdminKey) {
    const { enforceRoutePermission } = await import('../../utils/rbacMiddleware');
    const result = await enforceRoutePermission(c, urlPath, method);
    if (!result.allowed) {
      return c.json({ error: result.error || 'Insufficient permissions' }, 403);
    }
  }

  return null;
}

async function applyBodySanitization(c: any, urlPath: string, method: string): Promise<void> {
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return;
  try {
    const cloned = c.req.raw.clone();
    const bodyText = await cloned.text();
    let parsedBody: any;
    let isJson = false;
    try {
      parsedBody = JSON.parse(bodyText);
      isJson = true;
    } catch (_) { }
    if (isJson) {
      const sanitized = sanitizeRequestBody(parsedBody, urlPath);
      const sanitizedJson = JSON.stringify(sanitized);
      const newHeaders = new Headers(c.req.raw.headers);
      newHeaders.set('Content-Type', 'application/json');
      const newRequest = new Request(c.req.url, {
        method: c.req.method,
        headers: newHeaders,
        body: sanitizedJson,
      });
      (c.req as any).raw = newRequest;
      (c.req as any).bodyCache = {};
      (c.req as any).cachedBody = undefined;
    }
  } catch (_) { }
}

async function injectCspNonce(c: any, cspNonce: string): Promise<void> {
  const contentType = c.res.headers.get('Content-Type') || '';
  if (contentType.includes('text/html') && c.res.body) {
    try {
      const originalBody = await c.res.text();
      const nonceInjected = originalBody
        .replace(/<script(?!\s+nonce=)/gi, `<script nonce="${cspNonce}"`)
        .replace(/<style(?!\s+nonce=)(\s|>)/gi, `<style nonce="${cspNonce}"$1`);
      c.res = new Response(nonceInjected, {
        status: c.res.status,
        headers: c.res.headers,
      });
    } catch (_) { }
  }
}

export const globalMiddleware = [
  async (c: any, next: any) => {
    const mastra = c.get("mastra");
    const logger = mastra?.getLogger();
    logger?.debug("[Request]", { method: c.req.method, url: c.req.url });

    const urlPath = new URL(c.req.url).pathname;
    const method = c.req.method;
    const allowedOrigins = getAllowedOrigins();

    const corsEarlyReturn = handleCors(c, allowedOrigins);
    if (corsEarlyReturn) return corsEarlyReturn;

    const cspNonce = randomBytes(16).toString('base64');
    applySecurityHeaders(c, cspNonce);

    const inngestGuard = checkInngestAccess(c, urlPath);
    if (inngestGuard) return inngestGuard;

    const publicPath = isPublicPath(urlPath);
    const isApi = urlPath.startsWith('/api/');
    const mastraInternal = isMastraInternal(urlPath);

    if (!publicPath && !isApi) {
      const authResult = checkPageAuth(c);
      if (authResult) return authResult;
    }

    if (isApi && !publicPath && !mastraInternal) {
      const apiAuthResult = await checkApiAuth(c, urlPath, method);
      if (apiAuthResult) return apiAuthResult;
    } else if (isApi && publicPath) {
      const ip = parseClientIp(c.req.header('x-forwarded-for'), c.req.header('x-real-ip'));
      const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
      const rateCheck = await checkRateLimit(ip, isWrite, urlPath, false);
      if (!rateCheck.allowed) {
        c.header('Retry-After', String(rateCheck.retryAfter || 60));
        logRateLimit429(urlPath, method, ip, rateCheck.retryAfter);
        return c.json({ error: 'Too many requests' }, 429);
      }
    }

    if (isApi) {
      await applyBodySanitization(c, urlPath, method);
    }

    try {
      await next();
    } catch (error) {
      logger?.error("[Response]", { method: c.req.method, url: c.req.url });
      if (error instanceof MastraError) {
        if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
          throw new NonRetriableError(error.message, { cause: error });
        }
      } else if (error instanceof z.ZodError) {
        throw new NonRetriableError(error.message, { cause: error });
      }
      throw error;
    }

    if (isApi && !publicPath && !mastraInternal && c.res.status === 404) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }

    await injectCspNonce(c, cspNonce);
  },
];
