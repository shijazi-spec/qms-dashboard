import { MastraError } from "@mastra/core/error";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getSessionFromCookie } from "../routes/authRoutes";
import { sanitizeRequestBody } from "../../utils/inputSanitizer";
import { checkRateLimit, parseClientIp } from "../../utils/rateLimiter";
import { hasValidAdminApiKey } from "../../utils/rbacMiddleware";
import { deepRedactSecretLikeStrings, redactSecretLikeStrings } from "../../utils/eventLogsDatabase";

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

// PUBLIC_PATHS lists the URL paths that bypass `checkPageAuth` (HTML routes)
// and `checkApiAuth` (API routes) entirely. EVERY entry here grants
// UNAUTHENTICATED access to the matching route(s) — adding to this list is a
// privilege-escalation vector and must be justified.
//
// MATCHING RULES (see `isPublicPath` below):
//   * Entries WITHOUT a trailing `/` match the URL path EXACTLY.
//   * Entries WITH a trailing `/` match the literal prefix (i.e. that path
//     and any subpath beneath it).
//
// FOOT-GUN HISTORY: prior to this list's audit (task #447), matching used
// `urlPath.startsWith(p)` for every entry. That meant `/api/health` silently
// allowed unauthenticated access to `/api/health-index` (an unrelated
// quality-metrics endpoint with no handler-side auth) and would have done
// the same for any future `/api/health-foo` route. Always prefer EXACT entries
// unless the prefix is genuinely a subtree, and in that case write the entry
// with an explicit trailing `/` so a sibling path can never be swallowed by
// accident.
//
// Audit cross-reference (task #447): every entry has a documented reason for
// being public. Removed since previous audit:
//   - `/sop`, `/api/sop`  — the WalaPlus SOP doc is classified "Internal Use
//     Only / Distribution: All platform users (internal)"; it has no business
//     being readable without a session. The handlers in sopRoutes.ts now
//     enforce session-or-admin-key on their own as defense-in-depth.
//   - `/test/slack`, `/webhooks/slack`, `/api/webhooks/slack` — defined in
//     `src/triggers/slackTriggers.ts` but that module is never imported, so
//     the routes don't exist. Stale entries were removed; if Slack triggers
//     are ever wired up, the webhook + diagnostic routes must be re-evaluated
//     for auth on a per-route basis (the diagnostic SSE route in particular
//     opens DMs and posts messages to Slack — never make it public).
//   - `/api/telemetry/pageview` — no such route exists in the codebase.
const PUBLIC_PATHS = [
  // ---- Auth flow (login, OIDC callback, logout) ----
  '/login',                         // login page (rendered before sign-in)
  '/api/login',                     // POST: legacy email/password login
  '/api/callback',                  // OIDC redirect target from the IDP
  '/api/logout',                    // GET: clears cookies + IDP redirect
  '/api/auth/',                     // /api/auth/me + /api/auth/logout — each
                                    // handler returns 401/clears cookies on
                                    // its own, so the bypass is harmless.

  // ---- Admin-key bootstrap (cookie issuance + clear) ----
  // Listed as two EXACT entries instead of one `/api/admin/auth` prefix
  // because a future `/api/admin/auth-something` must NOT inherit the
  // bypass automatically.
  '/api/admin/auth',                // POST: exchange ADMIN_API_KEY → cookie
  '/api/admin/auth/logout',         // POST: clears admin_key cookie

  // ---- Invitation acceptance (caller has no session yet) ----
  '/accept-invite',                 // landing page invitees see pre-session
  '/api/invitations/validate/',     // .../validate/:token — token IS the auth
  '/api/invitations/accept',        // POST: completes the invite, then issues
                                    // a session cookie

  // ---- Static assets (CSS / JS / locale JSON — cookies don't gate these) ----
  '/css/',
  '/js/',
  '/dashboard/tailwind.css',
  '/dashboard/i18n/',               // /dashboard/i18n/:lang locale JSON

  // ---- Streaming-download service worker + its iframe-trigger URL pattern ----
  // The SW file must load without an auth redirect (browsers fetch it
  // independently of cookies). The trigger URL is intercepted by the SW
  // before reaching the network, so the public allowlist is just defensive
  // 404 plumbing for browsers without SW support.
  '/streaming-download-sw.js',
  '/_stream-download/',

  // ---- Operational health checks (uptime monitoring) ----
  // EXACT entry — must NOT swallow `/api/health-index` (a quality-metrics
  // endpoint that aggregates audit/NC/CAPA data and was previously exposed
  // by a `startsWith` foot-gun) or `/api/health/pulse*` (which has its own
  // admin-only `authorize()` check, but we still keep this entry exact so
  // the bypass never applies to either route).
  '/api/health',
  '/api/smoke',                     // smoke test for orchestrator

  // ---- Anonymous language preference (so unauthenticated visitors can
  // still pick a UI language before signing in) ----
  '/api/user/language-preference',

  // ---- Accessibility statement (WCAG / regulator-facing public page) ----
  '/a11y',
];

const MASTRA_INTERNAL_PREFIXES = ['/api/workflows/', '/api/memory/'];

function getAllowedOrigins(): string[] {
  return (process.env.REPLIT_DOMAINS || '').split(',')
    .map((d: string) => `https://${d.trim()}`)
    .filter(Boolean);
}

function isPublicPath(urlPath: string): boolean {
  // See PUBLIC_PATHS comment for matching rules. Entries ending in `/` are
  // subtree (prefix) matches; everything else must match exactly. This
  // intentionally rejects substring matches like
  //   urlPath = '/api/health-index', entry = '/api/health'
  // which previously slipped through the unguarded `startsWith`.
  return PUBLIC_PATHS.some(p =>
    p.endsWith('/') ? urlPath.startsWith(p) : urlPath === p,
  );
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

/**
 * Symmetric defense for the API-response boundary.  We already scrub
 * credential-shaped substrings before WRITING anything to the database
 * (event_logs, change_history, ai_pending_actions) via
 * `redactSecretLikeStrings` / `deepRedactSecretLikeStrings`.  However, when
 * a tool or a downstream SDK fails and echoes the credential back in its
 * exception message (e.g. "Invalid token sk-live-…"), the route's catch
 * block typically returns `c.json({ error: 'Failed to …', details: error.message }, 500)`
 * — so the secret can still reach the user-facing HTTP response and a
 * client-side toast even though it would be redacted at write time.
 *
 * `redactSecretsInResponse(c)` runs after `next()` and walks the response
 * body of any 4xx/5xx JSON response, replacing credential-shaped substrings
 * in every string leaf with `REDACTED_SENTINEL`.  This is intentionally a
 * *post-processor* rather than something each route has to remember to
 * call, so a new route or a future contributor can't forget to sanitise
 * the catch path and reintroduce the leak.
 *
 * Only error responses are scanned — successful 2xx bodies are passed
 * through untouched (they're real entity payloads, not free-form error
 * text, and walking a multi-MB list response on every request would be
 * wasted work).  Non-JSON responses (HTML pages, file streams, redirects)
 * are also skipped.
 */
export async function redactSecretsInResponse(c: any): Promise<void> {
  const res = c?.res;
  if (!res) return;
  const status = res.status;
  if (typeof status !== 'number' || status < 400) return;
  const contentType = (res.headers?.get?.('Content-Type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return;
  let text: string;
  try {
    text = await res.clone().text();
  } catch (_) {
    return;
  }
  if (!text) return;
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // Body is JSON-typed but not parseable — fall back to a string-level
    // scrub so a raw error blob can't leak credentials either.
    const scrubbed = redactSecretLikeStrings(text) as string;
    if (scrubbed === text) return;
    c.res = new Response(scrubbed, { status: res.status, headers: res.headers });
    return;
  }
  const redacted = deepRedactSecretLikeStrings(parsed);
  const redactedJson = JSON.stringify(redacted);
  if (redactedJson === text) return;
  c.res = new Response(redactedJson, { status: res.status, headers: res.headers });
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
          // Surface a redacted version of the message so a credential echoed
          // back by an upstream SDK can't leak through Inngest/Mastra's
          // error-rendering path.
          const safe = redactSecretLikeStrings(error.message) as string;
          throw new NonRetriableError(safe, { cause: error });
        }
      } else if (error instanceof z.ZodError) {
        const safe = redactSecretLikeStrings(error.message) as string;
        throw new NonRetriableError(safe, { cause: error });
      }
      // We do NOT need to rewrap `error.message` for credential redaction
      // here. The Mastra deployer installs an `app.onError` (see
      // node_modules/@mastra/deployer/dist/server/index.js — `errorHandler`)
      // which catches every uncaught throw at Hono's per-dispatch level and
      // converts it into a Response BEFORE this catch block can re-throw:
      //   - non-HTTPException → `c.json({ error: "Internal Server Error" }, 500)`
      //     (a static body — `error.message` never reaches the wire), and
      //   - HTTPException     → `c.json({ error: err.message }, status)` —
      //     whose body still flows through `redactSecretsInResponse(c)` below
      //     (the `await next()` above resolves normally because Hono's
      //     onError has already produced a Response, not re-thrown), so any
      //     credential echoed in `err.message` is scrubbed there.
      // A previous version of this file rewrapped the throw with
      // `redactErrorForRethrow(error)` to defend a "default Hono error
      // renderer" path that does not exist in our stack — task #538
      // confirmed the rewrap was dead code in production. Re-throwing the
      // original preserves stack/name/cause for the Mastra logger above.
      throw error;
    }

    if (isApi && !publicPath && !mastraInternal && c.res.status === 404) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }

    // Symmetric with storage-side defense: scrub credential-shaped substrings
    // out of any 4xx/5xx JSON error body before it leaves the server. See
    // `redactSecretsInResponse` doc-comment for rationale.
    await redactSecretsInResponse(c);

    await injectCspNonce(c, cspNonce);
  },
];
