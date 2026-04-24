import { MastraError } from "@mastra/core/error";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getSessionFromCookie } from "../routes/authRoutes";
import { sanitizeRequestBody } from "../../utils/inputSanitizer";
import { checkRateLimit, parseClientIp } from "../../utils/rateLimiter";
import { hasValidAdminApiKey } from "../../utils/rbacMiddleware";

const PUBLIC_PATHS = [
  '/login', '/api/auth/', '/api/login', '/api/callback', '/api/logout',
  '/guide', '/sop', '/api/sop', '/accept-invite', '/css/', '/js/',
  '/dashboard/tailwind.css', '/api/invitations/validate/', '/api/invitations/accept',
  '/api/admin/auth', '/api/health', '/api/smoke', '/webhooks/slack',
  '/api/webhooks/slack', '/test/slack', '/api/telemetry/pageview', '/a11y',
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
  c.header('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${cspNonce}' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self' https://replit.com https://accounts.google.com https://oauth2.googleapis.com; frame-ancestors 'none'; form-action 'self'`);
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
      const nonceInjected = originalBody.replace(/<script(?!\s+nonce=)/gi, `<script nonce="${cspNonce}"`);
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
