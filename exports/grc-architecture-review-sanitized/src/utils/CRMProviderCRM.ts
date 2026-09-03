import { z } from "zod";
import { logger } from './logger';

export const CRMProviderCRMRecordSchema = z.object({
  id: z.string(),
  module: z.string(),
  owner: z.string().optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  <REDACTED_SCHEME> z.record(z.any()),
});

export type CRMProviderCRMRecord = z.infer<typeof CRMProviderCRMRecordSchema>;

export interface CRMProviderAPIConfig {
  accessToken: <REDACTED_SECRET>
  apiDomain: string;
}

export interface CRMProviderOAuthConfig {
  clientId: string;
  clientSecret: <REDACTED_SECRET>
  refreshToken: <REDACTED_SECRET>
  accountsUrl: string;
}

export interface HygieneIssue {
  recordId: string;
  module: string;
  issueType: string;
  fieldName?: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  suggestedFix?: string;
}

export interface CRMDataSummary {
  module: string;
  totalRecords: number;
  recordsWithIssues: number;
  issues: HygieneIssue[];
  lastActivityDate?: string;
}

let cachedAccessToken: string | null = null;
let tokenExpiresAt: number = 0;
let pendingRefresh: Promise<string> | null = null;
let lastRefreshAttempt: number = 0;
const MIN_REFRESH_INTERVAL_MS = 5000;

// Rate-limit cooldown — when CRMProvider's OAuth endpoint returns the
// "too many requests continuously" 400, we MUST stop calling it.
// Until this fix, every subsequent caller saw `cachedAccessToken === null`
// and triggered another refreshAccessToken(), which hit CRMProvider again,
// which kept the per-account quota permanently exhausted. The duplicate
// radar (and every other CRMProvider-dependent feature) therefore never recovered
// without a process restart.
//
// `CRMProviderRateLimitedUntil` is the wall-clock instant at which it is safe to
// try again. While `Date.now() < CRMProviderRateLimitedUntil`, getValidAccessToken
// throws an `isCRMProviderRateLimited` error WITHOUT making a network call, so
// callers fail fast with a clear message and CRMProvider's quota can actually
// drain. The cooldown is set from the `Retry-After` header when present,
// otherwise from CRMProvider_RATE_LIMIT_COOLDOWN_MS (default 5 minutes — CRMProvider's
// per-account OAuth quotas are minute-scale, so anything shorter just
// re-triggers the storm).
let CRMProviderRateLimitedUntil: number = 0;
// Generation counter — incremented every time a 429 sets the cooldown.
// refreshAccessToken() snapshots this before its network call and only
// clears `CRMProviderRateLimitedUntil` on success if the snapshot still matches.
// Without this, a parallel attempt that succeeds AFTER another attempt
// got rate-limited would prematurely clear the new cooldown window and
// reopen the storm. Pairs with the `pendingRefresh` recheck in
// getValidAccessToken() — together they close the singleflight gap.
let rateLimitEpoch: number = 0;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = (() => {
  const fromEnv = Number(process.env.CRMProvider_RATE_LIMIT_COOLDOWN_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 5 * 60 * 1000;
})();

function buildRateLimitedError(retryAfterMs: number): Error & {
  isCRMProviderRateLimited: true;
  httpStatus: number;
  rateLimitedUntil: number;
} {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const err = new Error(
    `CRMProvider OAuth is temporarily rate-limited (too many token refresh attempts). Wait ~${seconds}s and try again.`,
  ) as Error & {
    isCRMProviderRateLimited: true;
    httpStatus: number;
    rateLimitedUntil: number;
  };
  err.isCRMProviderRateLimited = true;
  err.httpStatus = 429;
  err.rateLimitedUntil = CRMProviderRateLimitedUntil;
  return err;
}

/**
 * Exposed for tests and the /api/CRMProvider/connection-status dashboard. NEVER
 * read this directly inside the module — always go through getValidAccessToken
 * so the cooldown is enforced uniformly.
 */
export function getCRMProviderRateLimitState(): { rateLimited: boolean; cooldownMsRemaining: number } {
  const remaining = CRMProviderRateLimitedUntil - Date.now();
  return {
    rateLimited: remaining > 0,
    cooldownMsRemaining: remaining > 0 ? remaining : 0,
  };
}

// ── Interactive-activity auto-yield (Sample User 2026-07-12) ─────────────────────
// CRMProvider enforces ONE rate limit for the whole org, so a running background sync
// (thousands of GETs) starves an operator's Apply/merge/backfill writes — they
// 429 and "retry every minute" forever. We stamp the clock whenever an
// interactive CRMProvider WRITE happens; the background page fetcher
// (fetchAllCRMProviderRecords) then PAUSES for a few seconds between page batches so
// the operator's write gets the rate-limit headroom. When the operator is idle
// the sync runs full speed. Env-tunable; set either to 0 to disable.
let _lastInteractiveCRMProviderAt = 0;
export function markInteractiveCRMProviderActivity(): void {
  _lastInteractiveCRMProviderAt = Date.now();
}
export function interactiveYieldMs(): number {
  const w = Number(process.env.CRMProvider_INTERACTIVE_YIELD_WINDOW_MS);
  const p = Number(process.env.CRMProvider_INTERACTIVE_YIELD_PAUSE_MS);
  const windowMs = Number.isFinite(w) && w >= 0 ? w : 20_000;
  const pauseMs = Number.isFinite(p) && p >= 0 ? p : 4_000;
  if (windowMs === 0 || pauseMs === 0) return 0;
  return Date.now() - _lastInteractiveCRMProviderAt < windowMs ? pauseMs : 0;
}

/**
 * Hard environment gate for duplicate-radar LIVE CRMProvider writes (apply, undo,
 * bulk-close, …). Dev and prod run on SEPARATE databases but SHARE the same
 * CRMProvider credentials, so any non-prod write would mutate the real CRM org. This
 * is the single source of truth reused by every duplicate-radar write path.
 * Escape hatch (`RESOLUTION_ALLOW_WRITES_OUTSIDE_PROD=true`) is for a dedicated
 * non-prod CRMProvider org only.
 */
export function CRMProviderWritesAllowedInEnv(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.RESOLUTION_ALLOW_WRITES_OUTSIDE_PROD === "true"
  );
}

function getCRMProviderOAuthConfig(): CRMProviderOAuthConfig | null {
  const clientId = process.env.CRMProvider_CLIENT_ID_NEW || process.env.CRMProvider_CLIENT_ID;
  const clientSecret = process.env.CRMProvider_CLIENT_SECRET;
  const refreshToken = process.env.CRMProvider_REFRESH_TOKEN;
  const accountsUrl = process.env.CRMProvider_ACCOUNTS_URL || '<REDACTED_URL>';
  
  if (clientId && clientSecret && refreshToken) {
    return { clientId, clientSecret, refreshToken, accountsUrl };
  }
  return null;
}

async function refreshAccessToken(): Promise<string> {
  const oauthConfig = getCRMProviderOAuthConfig();

  if (!oauthConfig) {
    throw new Error('CRM integration not configured. Please contact your administrator.');
  }

  // Snapshot the rate-limit epoch BEFORE the network call. If another
  // parallel refresh observes a 429 and bumps the epoch while this call
  // is in flight, we must NOT clear its cooldown on our success — the
  // newer 429 takes precedence.
  const epochAtStart = rateLimitEpoch;
  
  logger.info('🔄 [CRMProviderCRM] Refreshing access token...');
  
  const params = new URLSearchParams({
    refresh_token: <REDACTED_SECRET>
    client_id: oauthConfig.clientId,
    client_secret: <REDACTED_SECRET>
    grant_type: 'refresh_token',
  });
  
  const response = await fetch(`${oauthConfig.accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    logger.error('❌ [CRMProviderCRM] Token refresh failed', { httpStatus: response.status, errorText });
    // CRMProvider returns HTTP 400 with body {"error":"Access Denied","error_description":"You
    // have made too many requests continuously..."} when the OAuth endpoint is in its
    // per-account cooldown. The body is the only signal — the status code is the same
    // generic 400 used for malformed requests. Tag the error so callers (the duplicate
    // radar scan, the consultant tool, etc.) can surface a clear "CRMProvider is rate-limited,
    // try again later" message instead of letting it look like a credential / code bug.
    const isRateLimited = /too many requests|rate.?limit/i.test(errorText);
    if (isRateLimited) {
      // Set the module-level cooldown so subsequent getValidAccessToken()
      // calls short-circuit WITHOUT another network round-trip. Without
      // this, every retry by every CRMProvider-dependent feature keeps hitting
      // the OAuth endpoint, which keeps the quota permanently exhausted.
      // Honor `Retry-After` (seconds, per RFC 7231) if CRMProvider sends it;
      // otherwise fall back to the configured default.
      const retryAfterHeader = response.headers.get('retry-after');
      let cooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS;
      if (retryAfterHeader) {
        const parsed = Number(retryAfterHeader);
        if (Number.isFinite(parsed) && parsed > 0) {
          cooldownMs = Math.max(cooldownMs, parsed * 1000);
        }
      }
      CRMProviderRateLimitedUntil = Date.now() + cooldownMs;
      rateLimitEpoch++;
      logger.warn(
        `🛑 [CRMProviderCRM] OAuth rate-limited — cooling down for ${Math.round(cooldownMs / 1000)}s before any further token refresh attempts.`,
      );
      throw buildRateLimitedError(cooldownMs);
    }
    // Do NOT attach the raw CRMProvider body to the thrown error — the body is
    // already logged above (subject to the redaction sweep), and re-attaching
    // it as a property risks structured-log sinks re-serializing it through
    // less-redacted paths. The normalized message + httpStatus is enough for
    // callers to branch on, and the redacted log line is the source of truth.
    const err: Error & { httpStatus?: number } = new Error(
      `Failed to refresh CRMProvider access token: ${response.status}`,
    );
    err.httpStatus = response.status;
    throw err;
  }
  
  const data = await response.json();
  
  if (data.error) {
    logger.error('❌ [CRMProviderCRM] Token refresh error', { CRMProviderError: data.error });
    throw new Error(`CRMProvider token refresh error: ${data.error}`);
  }
  
  if (!data.access_token) {
    throw new Error('No access_token in CRMProvider refresh response');
  }
  
  cachedAccessToken = <REDACTED_SECRET>
  tokenExpiresAt = <REDACTED_SECRET>
  // Conditionally clear the cooldown — only if no parallel attempt bumped
  // the epoch (i.e. observed a 429) while we were in flight. Otherwise
  // a stale success would prematurely reopen the floodgates against a
  // freshly-set cooldown window.
  if (rateLimitEpoch === epochAtStart) {
    CRMProviderRateLimitedUntil = 0;
  }

  logger.info(`✅ [CRMProviderCRM] Access token refreshed successfully, expires in ${data.expires_in} seconds`);

  return data.access_token;
}

function isTokenExpired(): boolean {
  return Date.now() >= tokenExpiresAt;
}

export async function getValidAccessToken(): Promise<string> {
  const oauthConfig = getCRMProviderOAuthConfig();
  
  if (oauthConfig) {
    if (cachedAccessToken && !isTokenExpired()) {
      return cachedAccessToken;
    }
    // Fail fast while CRMProvider's OAuth endpoint is in its cooldown window —
    // no network call, no further quota burn. This is the single guard
    // that prevents the "duplicate radar shows no data" failure mode
    // observed in production logs: a previous storm of parallel refresh
    // calls poisoned the per-account quota, and every subsequent feature
    // re-triggered the same 400 because nothing remembered the cooldown.
    const cooldownRemaining = CRMProviderRateLimitedUntil - Date.now();
    if (cooldownRemaining > 0) {
      throw buildRateLimitedError(cooldownRemaining);
    }
    if (pendingRefresh) {
      return await pendingRefresh;
    }
    const now = Date.now();
    if (now - lastRefreshAttempt < MIN_REFRESH_INTERVAL_MS) {
      if (cachedAccessToken) return cachedAccessToken;
      await new Promise(r => setTimeout(r, MIN_REFRESH_INTERVAL_MS - (now - lastRefreshAttempt)));
      // Re-check the cooldown after the sleep — a concurrent caller may
      // have hit a 429 while we were waiting.
      const stillCoolingDown = CRMProviderRateLimitedUntil - Date.now();
      if (stillCoolingDown > 0) {
        throw buildRateLimitedError(stillCoolingDown);
      }
      // Also re-check pendingRefresh — multiple sleepers can wake at the
      // same time; without this, each would launch its own refresh and
      // re-create the storm we're trying to prevent. Honor the in-flight
      // one and a successful refresh would also be cached for the rest.
      if (cachedAccessToken && !isTokenExpired()) {
        return cachedAccessToken;
      }
      if (pendingRefresh) {
        return await pendingRefresh;
      }
    }
    lastRefreshAttempt = Date.now();
    pendingRefresh = refreshAccessToken().finally(() => { pendingRefresh = null; });
    return await pendingRefresh;
  }
  
  const staticToken = process.env.CRMProvider_ACCESS_TOKEN;
  if (staticToken) {
    logger.info('⚠️ [CRMProviderCRM] Using static CRMProvider_ACCESS_TOKEN (no auto-refresh configured)');
    return staticToken;
  }
  
  throw new Error('CRM integration not configured. Please contact your administrator.');
}

async function getCRMProviderAccessToken(): Promise<CRMProviderAPIConfig> {
  const accessToken = await getValidAccessToken();
  const apiDomain = process.env.CRMProvider_API_DOMAIN || '<REDACTED_URL>';
  
  return { accessToken, apiDomain };
}

async function makeCRMProviderRequest<T>(
  requestFn: (config: CRMProviderAPIConfig) => Promise<Response>,
  parseResponse: (response: Response) => Promise<T>
): Promise<T> {
  let config = await getCRMProviderAccessToken();
  let response = await requestFn(config);
  
  if (response.status === 401) {
    logger.info('🔄 [CRMProviderCRM] Access token expired (401), attempting refresh...');

    cachedAccessToken = <REDACTED_SECRET>
    tokenExpiresAt = <REDACTED_SECRET>

    const oauthConfig = getCRMProviderOAuthConfig();
    if (oauthConfig) {
      // Route through getValidAccessToken (not refreshAccessToken directly)
      // so the rate-limit cooldown and singleflight are honored. Calling
      // refreshAccessToken() here would bypass both, which historically
      // turned a single 401 retry into another OAuth quota hit during
      // cooldown windows.
      config = await getCRMProviderAccessToken();
      response = await requestFn(config);

      if (response.status === 401) {
        throw new Error('CRMProvider API authentication failed after token refresh. Please verify your OAuth credentials.');
      }
    } else {
      throw new Error('CRM authentication failed. Please contact your administrator.');
    }
  }
  
  return parseResponse(response);
}

export function getCRMProviderConnectionStatus(): {
  configured: boolean;
  connected?: boolean;
  autoRefresh: boolean;
  tokenCached: <REDACTED_SECRET>
  tokenExpired: <REDACTED_SECRET>
  rateLimited: boolean;
  cooldownMsRemaining: number;
  message: string;
} {
  const oauthConfig = getCRMProviderOAuthConfig();
  const hasStaticToken = !!process.env.CRMProvider_ACCESS_TOKEN;
  const rateLimit = getCRMProviderRateLimitState();

  if (oauthConfig) {
    return {
      configured: true,
      connected: !!cachedAccessToken && !isTokenExpired(),
      autoRefresh: true,
      tokenCached: <REDACTED_SECRET>
      tokenExpired: <REDACTED_SECRET>
      rateLimited: rateLimit.rateLimited,
      cooldownMsRemaining: rateLimit.cooldownMsRemaining,
      message: rateLimit.rateLimited
        ? `CRMProvider OAuth is cooling down — ~${Math.ceil(rateLimit.cooldownMsRemaining / 1000)}s remaining`
        : 'CRMProvider CRM configured with OAuth auto-refresh',
    };
  }

  if (hasStaticToken) {
    return {
      configured: true,
      connected: true,
      autoRefresh: false,
      tokenCached: <REDACTED_SECRET>
      tokenExpired: <REDACTED_SECRET>
      rateLimited: false,
      cooldownMsRemaining: 0,
      message: 'CRMProvider CRM configured with static token (no auto-refresh)',
    };
  }

  return {
    configured: false,
    connected: false,
    autoRefresh: false,
    tokenCached: <REDACTED_SECRET>
    tokenExpired: <REDACTED_SECRET>
    rateLimited: false,
    cooldownMsRemaining: 0,
    message: 'CRM integration not configured. Please contact your administrator.',
  };
}

/**
 * Format a timestamp the way CRMProvider's date-time HEADERS expect it (2026-08-30).
 *
 * CRMProvider documents If-Modified-Since as ISO8601 WITH a UTC offset and NO
 * sub-second part, e.g. `2019-07-01T10:00:00+05:30`. JavaScript's
 * `Date.toISOString()` emits `2026-08-30T14:36:24.442Z` — milliseconds plus a
 * `Z` — which CRMProvider does not parse. And when CRMProvider cannot parse a request
 * parameter it does NOT error: it SILENTLY IGNORES it and returns everything
 * (the same trap that made `criteria` a no-op on the list endpoint, proven
 * 2026-08-17). That turned the Duplicate Radar's "incremental" sync into a FULL
 * corpus pull on every run — ~70k Contacts in 47 minutes, ~27k Deals in 27 —
 * which in turn meant the last module (Leads) never finished, so its watermark
 * never advanced and the backlog compounded.
 *
 * Emits `YYYY-MM-DDTHH:MM:SS±HH:MM` in the ORG's timezone (CRMProvider_ORG_TIMEZONE,
 * default Asia/Riyadh). Returns "" for an unparseable input so a bad value
 * drops the header (full fetch) rather than sending garbage.
 */
export function toCRMProviderDateTimeHeader(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  // Emit the ORG's LOCAL wall-clock plus its own offset (Sample User 2026-08-30).
  // `+00:00` is only correct if CRMProvider honours the offset; if it ever read the
  // wall-clock as org-local instead, a UTC value would silently widen the
  // window by the org's offset (3h for KSA) and re-pull hours of extra records
  // every run. Local-time-plus-its-own-offset is correct under BOTH readings:
  // same instant when the offset is honoured, and already-local when it isn't.
  // Timezone is env-tunable (CRMProvider_ORG_TIMEZONE); the offset is derived per
  // instant, so a DST org stays correct across the change.
  const tz = process.env.CRMProvider_ORG_TIMEZONE || "Asia/Riyadh";
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    // Some ICU builds render midnight as "24" — normalise it.
    const hour = parts.hour === "24" ? "00" : parts.hour;
    const wall = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
    // Offset = (that wall-clock read as UTC) − (the real instant).
    const offsetMin = Math.round(
      (Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(hour),
        Number(parts.minute),
        Number(parts.second),
      ) -
        d.getTime()) /
        60000,
    );
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${wall}${sign}${hh}:${mm}`;
  } catch {
    // Unknown timezone id → fall back to UTC rather than dropping the window.
    return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
  }
}

export async function fetchCRMProviderRecords(
  module: string,
  params: {
    page?: number;
    perPage?: number;
    fields?: string[];
    /**
     * CRMProvider search criteria, e.g. `(Lead_Source:equals:Web)`. Setting this
     * switches the request to the `/search` endpoint, because CRMProvider v2 honours
     * criteria ONLY there — on the list endpoint it is silently ignored.
     *
     * Consequences of using /search, all CRMProvider's, not ours:
     *  - `sortBy`/`sortOrder` are NOT supported; results are unordered.
     *  - `ifModifiedSince` does not apply. Use criteria OR incremental, not both.
     *  - CRMProvider caps search at ~2000 records (10 pages x 200); a filter expected
     *    to match more than that needs the list endpoint plus local filtering.
     *  - Zero matches come back as 204, already handled as an empty page.
     */
    criteria?: string;
    /** Ignored when `criteria` is set — /search does not support sorting. */
    sortBy?: string;
    /** Ignored when `criteria` is set — /search does not support sorting. */
    sortOrder?: 'asc' | 'desc';
    /**
     * ISO8601 timestamp. When set, sends the CRMProvider `If-Modified-Since` header so
     * the LIST endpoint returns ONLY records modified at/after this time — the
     * reliable incremental-sync mechanism. CRMProvider replies 304 when nothing
     * changed, which we treat as an empty page. Mutually exclusive with
     * `criteria` (which routes to /search, where this header does nothing).
     */
    ifModifiedSince?: string;
  } = {}
): Promise<CRMProviderCRMRecord[]> {
  // CRITERIA MUST GO TO /search — NOT the list endpoint.
  //
  // CRMProvider v2 honours `criteria` ONLY on `/crm/v2/{module}/search`. Sent to the
  // plain list endpoint it is SILENTLY IGNORED: no error, no warning, just
  // unfiltered rows capped by page size. Every caller that passed a filter was
  // therefore reading whatever CRMProvider returned first — including `id:equals:<id>`
  // lookups, which read as "fetch this record" and returned a DIFFERENT one.
  //
  // Proven live 2026-08-17: GET /api/CRMProvider/activities/Deals/<id> returned
  // byte-identical results (same counts, same task ids, same subjects) for two
  // unrelated deals, because its What_Id filter did nothing.
  //
  // The list path below is deliberately left untouched — the Duplicate Radar's
  // incremental sync depends on it and on the If-Modified-Since header, which
  // is the documented workaround someone already adopted for exactly this
  // limitation (see the ifModifiedSince doc above). No caller passes both.
  const useSearch = !!params.criteria;

  const queryParams = new URLSearchParams();
  if (params.page) queryParams.set('page', params.page.toString());
  if (params.perPage) queryParams.set('per_page', params.perPage.toString());
  if (params.fields?.length) queryParams.set('fields', params.fields.join(','));
  if (useSearch) {
    queryParams.set('criteria', params.criteria as string);
    // /search supports criteria|email|phone|word + fields + page + per_page.
    // sort_by/sort_order are NOT supported there, so results come back
    // unordered. Warn rather than drop silently — a caller that relied on
    // "newest first" (e.g. the CRMProvider Calls import) needs to know its ordering
    // assumption no longer holds now that its filter actually applies.
    if (params.sortBy || params.sortOrder) {
      logger.warn(
        `⚠️ [CRMProviderCRM] ${module}: sort_by/sort_order are not supported by the /search endpoint — ignoring them. The criteria filter now genuinely applies, so ordering is undefined.`,
      );
    }
    if (params.ifModifiedSince) {
      logger.warn(
        `⚠️ [CRMProviderCRM] ${module}: If-Modified-Since cannot be combined with criteria — /search returns all matches. Use ONE of them, not both.`,
      );
    }
  } else {
    if (params.sortBy) queryParams.set('sort_by', params.sortBy);
    if (params.sortOrder) queryParams.set('sort_order', params.sortOrder);
  }

  return makeCRMProviderRequest(
    async (config) => {
      const path = useSearch ? `${module}/search` : module;
      const url = `${config.apiDomain}/crm/v2/${path}?${queryParams.toString()}`;
      const headers: Record<string, string> = {
        'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
        'Content-Type': 'application/json',
      };
      // Only meaningful on the list endpoint; /search ignores it. MUST be in
      // CRMProvider's header format — a value it cannot parse is silently ignored and
      // the whole corpus comes back (see toCRMProviderDateTimeHeader).
      if (params.ifModifiedSince && !useSearch) {
        const since = toCRMProviderDateTimeHeader(params.ifModifiedSince);
        if (since) headers['If-Modified-Since'] = since;
        else
          logger.warn(
            `⚠️ [CRMProviderCRM] ${module}: unparseable ifModifiedSince "${params.ifModifiedSince}" — dropping the header (this page will fetch unfiltered).`,
          );
      }
      return fetch(url, { method: 'GET', headers });
    },
    async (response) => {
      // 304 Not Modified — incremental fetch with nothing changed for this
      // page. Not an error; treat as an empty page so pagination stops cleanly.
      if (response.status === 304) return [];
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`CRMProvider CRM API error: ${response.status} - ${error.message || response.statusText}`);
      }
      // CRMProvider returns 204 (No Content) or sometimes an empty 200 body when the
      // requested page is past the last page of results. Treat any empty/
      // unparseable body as "no records" instead of crashing on JSON.parse.
      if (response.status === 204) return [];
      const text = await response.text();
      if (!text || !text.trim()) return [];
      let <REDACTED_SCHEME> any;
      try {
        data = JSON.parse(text);
      } catch {
        logger.warn(`⚠️ [CRMProviderCRM] Non-JSON response on ${module} (status ${response.status}); treating as empty page`);
        return [];
      }
      
      return (data.data || []).map((record: any) => ({
        id: record.id,
        module,
        owner: record.Owner?.name || record.Owner?.id,
        createdTime: record.Created_Time,
        modifiedTime: record.Modified_Time,
        <REDACTED_SCHEME> record,
      }));
    }
  );
}

export async function fetchAllCRMProviderRecords(
  module: string,
  params: {
    fields?: string[];
    criteria?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    maxRecords?: number;
    /** ISO8601 — incremental sync: only records modified at/after this time.
     *  Forwarded to fetchCRMProviderRecords as the `If-Modified-Since` header. */
    ifModifiedSince?: string;
    /** Live progress callback — fired after each parallel page batch with the
     *  running total fetched + the next page number. Lets the Duplicate Radar
     *  progress bar/chips show real counts during a long (rate-limited) fetch
     *  instead of sitting frozen. Never throws into the fetch loop. */
    onProgress?: (fetched: number, page: number) => void;
  } = {}
): Promise<CRMProviderCRMRecord[]> {
  const allRecords: CRMProviderCRMRecord[] = [];
  const perPage = 200;
  let page = 1;
  let hasMore = true;
  const maxRecords = params.maxRecords || Infinity;
  
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  
  // PERF: pages are now fetched in parallel batches of CONCURRENCY. With ~30k
  // records (~150 pages) this drops cold fetches from ~40s to ~10s. Each batch
  // stops the loop early if any page returns < perPage records (last page) or
  // 0 records (overshoot). Order is preserved because we slice by page index.
  // PERF / MEMORY: per-module page concurrency. Default 4 keeps cold fetches
  // fast on a healthy host, but on memory-tight tiers six concurrent module
  // fetches × 4 pages × 200 records each can pin >600MB and OOM-kill the
  // process. Set CRMProvider_FETCH_CONCURRENCY=1 (or 2) on the server env to
  // throttle without redeploying code.
  const envConc = parseInt(process.env.CRMProvider_FETCH_CONCURRENCY || "", 10);
  const CONCURRENCY =
    Number.isFinite(envConc) && envConc >= 1 && envConc <= 8 ? envConc : 3;
  logger.info(
    `📊 [CRMProviderCRM] Fetching all ${module} records with parallel pagination (CONCURRENCY=${CONCURRENCY})...`,
  );

  const fetchPageWithRetry = async (pageNum: number): Promise<CRMProviderCRMRecord[]> => {
    let retries = 0;
    // More retries + jittered backoff so a transient 429 recovers instead of
    // failing the whole module (which showed up as "Deals: error" etc.).
    const maxRetries = 5;
    while (true) {
      try {
        return await fetchCRMProviderRecords(module, {
          page: pageNum,
        perPage,
        fields: params.fields,
        criteria: params.criteria,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
        ifModifiedSince: params.ifModifiedSince,
      });
      } catch (error: any) {
        if (error.message?.includes('204') || error.message?.includes('No Content')) {
          return [];
        }
        if (error.message?.includes('429') || error.status === 429 || error.message?.includes('rate limit') || error.message?.includes('Too Many')) {
          retries++;
          if (retries > maxRetries) {
            logger.error(`❌ [CRMProviderCRM] Rate limit exceeded after ${maxRetries} retries for ${module} page ${pageNum}`);
            throw error;
          }
          const backoffMs = retries * 5000 + Math.floor(Math.random() * 1500);
          logger.warn(`⚠️ [CRMProviderCRM] Rate limited (429) on ${module} page ${pageNum}, retry ${retries}/${maxRetries} in ${Math.round(backoffMs/1000)}s`);
          await sleep(backoffMs);
          continue;
        }
        throw error;
      }
    }
  };

  while (hasMore && allRecords.length < maxRecords) {
    const batch: number[] = [];
    for (let i = 0; i < CONCURRENCY; i++) batch.push(page + i);
    const results = await Promise.all(batch.map(fetchPageWithRetry));

    for (let i = 0; i < results.length; i++) {
      const records = results[i];
      const pageNum = batch[i];
      if (records.length === 0) {
        hasMore = false;
        break;
      }
        allRecords.push(...records);
      logger.info(`📊 [CRMProviderCRM] Fetched page ${pageNum}: ${records.length} records (total: ${allRecords.length})`);
        if (records.length < perPage) {
          hasMore = false;
        break;
      }
      if (allRecords.length >= maxRecords) {
        hasMore = false;
        break;
      }
    }

    page += CONCURRENCY;
    if (params.onProgress) {
      try {
        params.onProgress(allRecords.length, page);
      } catch {
        /* progress reporting must never break the fetch */
      }
    }
    if (hasMore) {
      // Auto-yield to the operator: if an interactive CRMProvider WRITE happened in the
      // last few seconds, pause this background paging so their action gets the
      // org's rate limit instead of losing every retry to the sync. Falls back
      // to the normal 150ms breather when nobody is actively working.
      const yieldMs = interactiveYieldMs();
      await sleep(yieldMs > 0 ? yieldMs : 150);
    }
  }

  if (allRecords.length > maxRecords) allRecords.length = maxRecords;
  logger.info(`✅ [CRMProviderCRM] Total ${module} records fetched: ${allRecords.length}`);
  return allRecords;
}

// ─── Attachments (related list) ──────────────────────────────────────────────
export interface CRMProviderAttachmentMeta {
  id: string;
  fileName: string;
  fileSizeBytes: number | null;
  attachmentType: string | null;
  linkUrl: string | null;
  createdByName: string | null;
  createdByEmail: string | null;
  createdTime: string | null;
  modifiedTime: string | null;
}

// ─── Modification-history fetchers (Task #825) ────────────────────────────────
//
// Power the Lead Status / Deal Stage aging metrics. Both helpers go through
// `makeCRMProviderRequest` so they share OAuth token caching, the 401-then-refresh
// retry path, and the structured error surface used by the rest of this
// module.

export interface CRMProviderStageHistoryRow {
  id?: string;
  Stage?: string;
  Modified_Time?: string;
  Last_Modified_Time?: string;
  Stage_Duration?: number;
}

export async function fetchDealStageHistory(
  dealId: string,
): Promise<CRMProviderStageHistoryRow[]> {
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/Deals/${encodeURIComponent(dealId)}/Stage_History?per_page=200`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    },
    async (response) => {
      // CRMProvider returns 204 when the related list is empty for the record.
      if (response.status === 204) return [];
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`CRMProvider Stage_History API error: ${response.status} - ${error.message || response.statusText}`);
      }
      const text = await response.text();
      if (!text || !text.trim()) return [];
      const data = JSON.parse(text);
      return (data.data || []) as CRMProviderStageHistoryRow[];
    },
  );
}

// Fetch a single record by ID directly from CRMProvider. Unlike the bulk
// /crm/v2/{Module} endpoint, the single-record endpoint is real-time and
// not subject to CRMProvider's bulk-read eventual-consistency lag. Use this when
// a user reports that the cache shows stale field values for a specific
// record (e.g. Phase, Company_Domain on a CS Lifecycle violation).
export async function fetchCRMProviderRecordById(
  module: string,
  recordId: string,
): Promise<CRMProviderCRMRecord | null> {
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/${encodeURIComponent(recordId)}`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    },
    async (response) => {
      if (response.status === 204 || response.status === 404) return null;
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`CRMProvider ${module} fetch error: ${response.status} - ${error.message || response.statusText}`);
      }
      const text = await response.text();
      if (!text || !text.trim()) return null;
      const data = JSON.parse(text);
      const record = (data.data || [])[0];
      if (!record) return null;
      return {
        id: record.id,
        module,
        owner: record.Owner?.name || record.Owner?.id,
        createdTime: record.Created_Time,
        modifiedTime: record.Modified_Time,
        <REDACTED_SCHEME> record,
      };
    },
  );
}

/**
 * Fetch records from a parent record's related list. Wraps the
 * /crm/v2/{parentModule}/{parentId}/{relatedListName} endpoint.
 *
 * Used by the Contact → Deal walk in sdrCallLinking to catch Deals
 * where the Contact participates only via "Contact Roles" (CRMProvider's
 * many-to-many junction), not as the primary Contact_Name. The
 * criteria search `(Contact_Name:equals:...)` returns only primary-
 * Contact Deals; this related-list endpoint returns the union of
 * primary + Contact-Roles relationships.
 *
 * Returns the same CRMProviderCRMRecord shape as fetchCRMProviderRecords so the
 * caller can dealToMatch / leadToMatch the output uniformly.
 * Empty array on 204 / missing related list (no records).
 */
export async function fetchCRMProviderRelatedRecords(
  parentModule: string,
  parentId: string,
  relatedListName: string,
  params: { perPage?: number } = {}
): Promise<CRMProviderCRMRecord[]> {
  const queryParams = new URLSearchParams();
  if (params.perPage) queryParams.set('per_page', params.perPage.toString());

  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${parentModule}/${encodeURIComponent(parentId)}/${encodeURIComponent(relatedListName)}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    },
    async (response) => {
      // 204 = empty related list, 404 = parent record missing.
      // Treat both as "no related records" — callers handle that
      // gracefully (they fall through to the next match path).
      if (response.status === 204 || response.status === 404) return [];
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`CRMProvider related-list error: ${parentModule}/${parentId}/${relatedListName} → ${response.status} - ${error.message || response.statusText}`);
      }
      const text = await response.text();
      if (!text || !text.trim()) return [];
      let <REDACTED_SCHEME> any;
      try { data = JSON.parse(text); }
      catch {
        logger.warn(`⚠️ [CRMProviderCRM] Non-JSON related-list response on ${parentModule}/${parentId}/${relatedListName}`);
        return [];
      }
      return (data.data || []).map((record: any) => ({
        id: record.id,
        module: relatedListName,
        owner: record.Owner?.name || record.Owner?.id,
        createdTime: record.Created_Time,
        modifiedTime: record.Modified_Time,
        <REDACTED_SCHEME> record,
      }));
    }
  );
}

export interface CRMProviderChangelogRow {
  audited_time?: string;
  field?: { api_name?: string; display_label?: string };
  value?: { current?: string; previous?: string };
}

export async function fetchLeadStatusChangelog(
  leadId: string,
): Promise<CRMProviderChangelogRow[]> {
  return makeCRMProviderRequest(
    async (config) => {
      const params = new URLSearchParams({ per_page: '200', fields: 'Lead_Status' });
      const url = `${config.apiDomain}/crm/v2/Leads/${encodeURIComponent(leadId)}/__changelog?${params.toString()}`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    },
    async (response) => {
      if (response.status === 204) return [];
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`CRMProvider Lead Timeline API error: ${response.status} - ${error.message || response.statusText}`);
      }
      const text = await response.text();
      if (!text || !text.trim()) return [];
      const data = JSON.parse(text);
      return (data.data || []) as CRMProviderChangelogRow[];
    },
  );
}

export async function fetchRecordAttachments(
  module: string,
  recordId: string
): Promise<CRMProviderAttachmentMeta[]> {
  // Retry on CRMProvider 429 ("too many requests") with backoff. The Deal-Compliance
  // "Run Scan" fires one attachment call PER deal (hundreds), and they collide
  // with any concurrent full/incremental sync — without this the rows showed
  // "err: Too many requests". Mirrors the 429 handling in fetchAllCRMProviderRecords.
  const maxRetries = 4;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; ; attempt++) {
    try {
      return await makeCRMProviderRequest(
        async (config) => {
          const url = `${config.apiDomain}/crm/v2/${module}/${recordId}/Attachments?per_page=200`;
          return fetch(url, {
            method: 'GET',
            headers: {
              'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
              'Content-Type': 'application/json',
            },
          });
        },
        async (response) => {
          if (response.status === 204) return [];
          if (!response.ok) {
            const txt = await response.text().catch(() => '');
            throw new Error(`CRMProvider Attachments API error: ${response.status} - ${txt.slice(0, 200)}`);
          }
          const text = await response.text();
          if (!text || !text.trim()) return [];
          let <REDACTED_SCHEME> any;
          try { data = JSON.parse(text); } catch { return []; }
          return ((data.data || []) as any[]).map((a) => ({
            id: a.id,
            fileName: a.File_Name || '',
            fileSizeBytes: a.Size != null ? Number(a.Size) : null,
            attachmentType: a.$type || a.$attachment_type || null,
            linkUrl: a.$link_url || null,
            createdByName: a.Created_By?.name || null,
            createdByEmail: a.Created_By?.email || null,
            createdTime: a.Created_Time || null,
            modifiedTime: a.Modified_Time || null,
          }));
        }
      );
    } catch (e: any) {
      const msg = String(e?.message || e);
      const is429 = /\b429\b|too many requests|rate.?limit/i.test(msg);
      if (is429 && attempt < maxRetries) {
        await sleep((attempt + 1) * 2500); // 2.5s, 5s, 7.5s, 10s
        continue;
      }
      throw e;
    }
  }
}

// Records that CRMProvider has deleted, recycled, or merged. type=all covers
// recycle-bin, permanent deletions, AND merges (returns type='merged' with
// merged_into.id). This is the only way to detect a CRMProvider-side merge: a
// Modified_Time filter never returns deleted records, so the duplicate radar
// would otherwise keep showing the "ghost" of the merged-away record forever.
export interface CRMProviderDeletedRecord {
  id: string;
  type: 'recycle' | 'permanent' | 'merged' | string;
  displayName?: string;
  deletedTime?: string;
  mergedIntoId?: string;
}

export async function fetchDeletedCRMProviderRecords(
  module: string,
  params: {
    type?: 'all' | 'recycle' | 'permanent';
    modifiedSince?: Date | string;
    maxRecords?: number;
  } = {}
): Promise<CRMProviderDeletedRecord[]> {
  const type = params.type || 'all';
  const perPage = 200;
  const maxRecords = params.maxRecords || Infinity;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const ifModifiedSince = params.modifiedSince
    ? (typeof params.modifiedSince === 'string'
        ? new Date(params.modifiedSince)
        : params.modifiedSince
      ).toISOString()
    : null;

  const all: CRMProviderDeletedRecord[] = [];
  let page = 1;
  let hasMore = true;

  logger.info(
    `🗑️ [CRMProviderCRM] Fetching deleted ${module} records (type=${type}` +
      (ifModifiedSince ? `, since=${ifModifiedSince}` : '') +
      ')',
  );

  while (hasMore && all.length < maxRecords) {
    let retries = 0;
    const maxRetries = 3;

    while (retries <= maxRetries) {
      try {
        const queryParams = new URLSearchParams({
          type,
          page: String(page),
          per_page: String(perPage),
        });

        const response = await makeCRMProviderRequest(
          async (config) => {
            const url = `${config.apiDomain}/crm/v2/${module}/deleted?${queryParams.toString()}`;
            const headers: Record<string, string> = {
              'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
              'Content-Type': 'application/json',
            };
            // CRMProvider header format — see toCRMProviderDateTimeHeader (a value CRMProvider cannot
            // parse is silently ignored and every deleted record comes back).
            if (ifModifiedSince) {
              const since = toCRMProviderDateTimeHeader(ifModifiedSince);
              if (since) headers['If-Modified-Since'] = since;
            }
            return fetch(url, { method: 'GET', headers });
          },
          async (res) => {
            // 204 / 304 = nothing deleted in window
            if (res.status === 204 || res.status === 304) return { <REDACTED_SCHEME> [], info: null };
            if (!res.ok) {
              const errBody = await res.json().catch(() => ({}));
              throw new Error(
                `CRMProvider deleted API error: ${res.status} - ${errBody.message || res.statusText}`,
              );
            }
            return res.json();
          },
        );

        const rows: any[] = (response as any)?.data || [];
        if (rows.length === 0) {
          hasMore = false;
          break;
        }
        for (const r of rows) {
          all.push({
            id: r.id,
            type: r.type,
            displayName: r.display_name,
            deletedTime: r.deleted_time,
            mergedIntoId: r.merged_into?.id,
          });
        }
        const more = (response as any)?.info?.more_records;
        if (!more || rows.length < perPage) {
        hasMore = false;
      } else {
          page++;
        }
        await sleep(150);
        break;
      } catch (error: any) {
        if (error.message?.includes('429') || error.status === 429) {
          retries++;
          if (retries > maxRetries) throw error;
          await sleep(retries * 5000);
          continue;
        }
        throw error;
      }
    }
  }
  
  logger.info(`✅ [CRMProviderCRM] Found ${all.length} deleted/merged ${module} record(s)`);
  return all;
}

export async function searchCRMProviderRecords(
  module: string,
  searchCriteria: string
): Promise<CRMProviderCRMRecord[]> {
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/search?criteria=${encodeURIComponent(searchCriteria)}`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    },
    async (response) => {
      if (!response.ok) {
        if (response.status === 204) {
          return [];
        }
        const error = await response.json().catch(() => ({}));
        throw new Error(`CRMProvider CRM search error: ${response.status} - ${error.message || response.statusText}`);
      }

      // CRMProvider search returns 204 No Content (empty body) when NOTHING matches —
      // and 204 is response.ok, so we must handle it before parsing or
      // response.json() throws "Unexpected end of JSON input" on the empty body.
      if (response.status === 204) return [];
      const text = await response.text();
      if (!text || !text.trim()) return [];
      const data = JSON.parse(text);

      return (data.data || []).map((record: any) => ({
        id: record.id,
        module,
        owner: record.Owner?.name || record.Owner?.id,
        createdTime: record.Created_Time,
        modifiedTime: record.Modified_Time,
        <REDACTED_SCHEME> record,
      }));
    }
  );
}

/** Return the CRMProvider id of an existing Contact with this exact email, or null.
 * Used by the Preflight push before adding a contact to an EXISTING account,
 * so we don't create a duplicate contact for someone already in the CRM. On
 * any error we return null (treat as not-found) so a real contact is never
 * silently dropped — the worst case is a duplicate the radar can merge. */
export async function findContactIdByEmail(email: string): Promise<string | null> {
  const e = String(email || "").trim();
  if (!e) return null;
  try {
    const rows = await searchCRMProviderRecords("Contacts", `(Email:equals:${e})`);
    return rows[0]?.id ? String(rows[0].id) : null;
  } catch {
    return null;
  }
}

/** Batched existence check: map of lowercased email → existing Contact id, for
 * the emails that already exist in CRMProvider. Searches in OR-chunks of 10 (far fewer
 * round-trips than one-per-email). THROWS on a genuine CRMProvider error (after one
 * retry per chunk) — the Preflight A1 push calls this BEFORE creating anything,
 * so a failure aborts cleanly with zero records written, rather than silently
 * treating everyone as "new" and creating duplicates of existing contacts. */
export async function findRecordIdsByEmails(module: string, emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const clean = Array.from(new Set(emails.map(e => String(e || "").trim()).filter(Boolean)));
  const CHUNK = 10;
  for (let s = 0; s < clean.length; s += CHUNK) {
    const chunk = clean.slice(s, s + CHUNK);
    const criteria = chunk.map(e => `(Email:equals:${e})`).join("or");
    let rows: CRMProviderCRMRecord[] | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2 && rows === null; attempt++) {
      try { rows = await searchCRMProviderRecords(module, criteria); }
      catch (e) { lastErr = e; rows = null; }
    }
    if (rows === null) {
      throw new Error(`${module} email lookup failed: ${lastErr?.message || String(lastErr)}`);
    }
    for (const r of rows) {
      const em = String(r.data?.Email || "").trim().toLowerCase();
      if (em && r.id && !out.has(em)) out.set(em, String(r.id));
    }
  }
  return out;
}

/** Contacts-module wrapper (the Preflight push's pre-create dedup check). */
export async function findContactIdsByEmails(emails: string[]): Promise<Map<string, string>> {
  return findRecordIdsByEmails("Contacts", emails);
}

/** Find a record id by exact First+Last name — used by the Title backfill for
 * phone-only leads that have no email to match on. Returns the id ONLY when the
 * search yields EXACTLY ONE record (a unique match), so an ambiguous name never
 * gets the wrong title. Returns null on 0, >1, or error. */
export async function findRecordIdByName(module: string, firstName: string, lastName: string): Promise<string | null> {
  const last = String(lastName || "").trim();
  if (!last) return null;
  const first = String(firstName || "").trim();
  const criteria = first
    ? `(Last_Name:equals:${last})and(First_Name:equals:${first})`
    : `(Last_Name:equals:${last})`;
  try {
    const rows = await searchCRMProviderRecords(module, criteria);
    return rows.length === 1 && rows[0]?.id ? String(rows[0].id) : null;
  } catch {
    return null;
  }
}

/** BATCHED unique name → id resolver (the fast replacement for calling
 * findRecordIdByName once per row, which timed out the Title backfill on big
 * slices). OR-chunks the Last_Name search, then returns a Map keyed by
 * `${last}|${first}` (lowercased) → id ONLY when exactly one CRM record has that
 * first+last — same uniqueness guard as findRecordIdByName, but one search per
 * ~10 names instead of one per row. Best-effort: a bad chunk is skipped. */
export function fullNameKey(first: string, last: string): string {
  return `${String(last || "").trim().toLowerCase()}|${String(first || "").trim().toLowerCase()}`;
}
export async function findRecordIdsByFullNames(
  module: string,
  names: Array<{ first: string; last: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const lasts = Array.from(new Set(
    names.map(n => String(n.last || "").trim()).filter(isSafeCriteriaValue),
  ));
  if (lasts.length === 0) return out;
  const idByKey = new Map<string, string>();
  const countByKey = new Map<string, number>();
  const CHUNK = 10;
  for (let s = 0; s < lasts.length; s += CHUNK) {
    const chunk = lasts.slice(s, s + CHUNK);
    const criteria = chunk.map(l => `(Last_Name:equals:${l})`).join("or");
    let rows: CRMProviderCRMRecord[] | null = null;
    for (let attempt = 0; attempt < 2 && rows === null; attempt++) {
      try { rows = await searchCRMProviderRecords(module, criteria); }
      catch { rows = null; }
    }
    if (rows === null) continue; // best-effort — skip a bad chunk, never abort
    for (const r of rows) {
      if (!r.id) continue;
      const k = fullNameKey(String(r.data?.First_Name || ""), String(r.data?.Last_Name || ""));
      countByKey.set(k, (countByKey.get(k) || 0) + 1);
      if (!idByKey.has(k)) idByKey.set(k, String(r.id));
    }
  }
  for (const n of names) {
    const k = fullNameKey(n.first, n.last);
    if (countByKey.get(k) === 1) out.set(k, idByKey.get(k)!);
  }
  return out;
}

/** Normalize a phone to a comparable key: digits only, with a leading Saudi
 * country code (966 / 00966) or leading zero stripped, so "+966 55…", "0055…",
 * "9665…" and "55…" all collapse to the same local number. Returns "" for
 * fewer than 7 digits (too short to be a reliable match). Exported so the
 * Preflight push can key its phone-dedup map the same way it looks up. */
export function normalizePhoneKey(phone: string): string {
  let d = String(phone || "").replace(/\D+/g, "");
  if (!d) return "";
  if (d.startsWith("00966")) d = d.slice(5);
  else if (d.startsWith("966")) d = d.slice(3);
  d = d.replace(/^0+/, "");
  return d.length >= 7 ? d : "";
}

/** True when a value is safe to embed literally in a CRMProvider search criteria —
 * parentheses/commas are criteria grouping syntax and there is no documented
 * escape, so values containing them are excluded from equals-searches (they
 * fall back to another signal, e.g. domain). */
function isSafeCriteriaValue(v: string): boolean {
  return !!v && !/[(),]/.test(v);
}

/** Batched existence check by PHONE — map of normalized-phone-key → existing
 * record id. Searches Phone AND Mobile in OR-chunks. Same THROW-on-error
 * contract as findRecordIdsByEmails so the push aborts cleanly rather than
 * silently duplicating. This is what protects phone-only contacts (no email),
 * which the email check cannot see — the exact gap that duplicated the
 * Mawsool contacts on every retry. */
export async function findRecordIdsByPhones(module: string, phones: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Build search VARIANTS. CRMProvider `equals` is an EXACT string match, but CRMProvider
  // auto-normalizes phones on save ("<REDACTED_PHONE>" → "<REDACTED_PHONE>"), so a
  // record is almost always stored in a DIFFERENT format than the Excel cell.
  // Searching only the raw Excel value therefore misses them — the exact reason
  // the backfill could never fill no-email leads (they can only be matched by
  // phone). Search the NORMALIZED digit key (what CRMProvider actually stores), plus a
  // clean digit-form raw when it differs. A space-laden raw ("+966 54 …") can
  // never equal a space-free stored value, so it is dropped, not searched.
  // Results are still keyed by normalizePhoneKey below, so the caller matches
  // regardless of stored format.
  const values = new Set<string>();
  for (const p of phones) {
    const rawStr = String(p || "").trim();
    const key = normalizePhoneKey(rawStr);
    if (key) values.add(key);
    if (rawStr && !/\s/.test(rawStr) && isSafeCriteriaValue(rawStr) && rawStr !== key) values.add(rawStr);
  }
  const raw = Array.from(values);
  const CHUNK = 5;
  for (let s = 0; s < raw.length; s += CHUNK) {
    const chunk = raw.slice(s, s + CHUNK);
    const criteria = chunk.map(p => `(Phone:equals:${p})or(Mobile:equals:${p})`).join("or");
    let rows: CRMProviderCRMRecord[] | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2 && rows === null; attempt++) {
      try { rows = await searchCRMProviderRecords(module, criteria); }
      catch (e) { lastErr = e; rows = null; }
    }
    if (rows === null) throw new Error(`${module} phone lookup failed: ${lastErr?.message || String(lastErr)}`);
    for (const r of rows) {
      for (const key of [normalizePhoneKey(r.data?.Phone), normalizePhoneKey(r.data?.Mobile)]) {
        if (key && r.id && !out.has(key)) out.set(key, String(r.id));
      }
    }
  }
  return out;
}

/** Batched Account existence check by DOMAIN (Website contains the domain).
 * Map of lowercased queried-domain → existing Account id. `contains` catches
 * <REDACTED_URL> <REDACTED_HOST>, <REDACTED_HOST>/… . OR-chunks of 5 (contains is heavier).
 * THROWS on a genuine CRMProvider error after one retry so the push aborts cleanly
 * rather than creating a duplicate account. Domains carry no criteria-special
 * characters, so the query is always well-formed. */
export async function findAccountIdsByDomains(domains: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Only search values shaped like a real domain (letters/digits/dot/hyphen).
  // A malformed "domain" (a space, comma, parenthesis, Arabic text, a whole
  // company name mistakenly in the domain field, …) breaks CRMProvider's criteria
  // syntax → "400 Invalid query formed" and fails the WHOLE push. Dropping a
  // bad value here just means that company falls back to the name/cluster
  // resolver — never data loss.
  const clean = Array.from(new Set(
    domains
      .map(d => String(d || "").trim().toLowerCase())
      .filter(d => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d)),
  ));
  const CHUNK = 5;
  for (let s = 0; s < clean.length; s += CHUNK) {
    const chunk = clean.slice(s, s + CHUNK);
    const criteria = chunk.map(d => `(Website:contains:${d})`).join("or");
    let rows: CRMProviderCRMRecord[] | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2 && rows === null; attempt++) {
      try { rows = await searchCRMProviderRecords("Accounts", criteria); }
      catch (e) { lastErr = e; rows = null; }
    }
    // BEST-EFFORT: a single bad chunk (e.g. a value that still trips CRMProvider's
    // criteria parser → 400) must NOT abort the whole push. Skip this chunk and
    // keep going — the affected companies fall back to the name / cluster /
    // domain-or-name resolvers. (This lookup is an idempotency helper, not the
    // sole account source.) Only the domain hits from good chunks are used.
    if (rows === null) {
      try { logger.warn("[findAccountIdsByDomains] chunk skipped:", lastErr?.message || String(lastErr)); } catch { /* noop */ }
      continue;
    }
    for (const r of rows) {
      const web = String(r.data?.Website || "").trim().toLowerCase();
      if (!web || !r.id) continue;
      for (const d of chunk) {
        if (web.includes(d) && !out.has(d)) out.set(d, String(r.id));
      }
    }
  }
  return out;
}

/** Batched Account existence check by EXACT name. Map of lowercased name →
 * Account id. Names with parentheses/commas are skipped (criteria-unsafe) and
 * rely on the domain signal instead. OR-chunks of 10. THROWS on a genuine
 * CRMProvider error after one retry. */
export async function findAccountIdsByNames(names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const clean = Array.from(new Set(names.map(n => String(n || "").trim()).filter(isSafeCriteriaValue)));
  const CHUNK = 10;
  for (let s = 0; s < clean.length; s += CHUNK) {
    const chunk = clean.slice(s, s + CHUNK);
    const criteria = chunk.map(n => `(Account_Name:equals:${n})`).join("or");
    let rows: CRMProviderCRMRecord[] | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2 && rows === null; attempt++) {
      try { rows = await searchCRMProviderRecords("Accounts", criteria); }
      catch (e) { lastErr = e; rows = null; }
    }
    // Best-effort like findAccountIdsByDomains — a bad chunk skips, never aborts
    // the push (the company falls back to the domain / cluster resolver).
    if (rows === null) {
      try { logger.warn("[findAccountIdsByNames] chunk skipped:", lastErr?.message || String(lastErr)); } catch { /* noop */ }
      continue;
    }
    for (const r of rows) {
      const nm = String(r.data?.Account_Name || "").trim().toLowerCase();
      if (nm && r.id && !out.has(nm)) out.set(nm, String(r.id));
    }
  }
  return out;
}

/** Markers that identify a CLOSED deal stage (won or lost). A deal whose Stage
 * contains any of these is treated as closed; anything else is "open/in-progress". */
const CLOSED_STAGE_MARKERS = (process.env.PREFLIGHT_CLOSED_STAGE_MARKERS ||
  "closed,lost,won,paid,agreement signed,terminat,cancel,churn,dropped")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
function isClosedStage(stage: string): boolean {
  const st = String(stage || "").trim().toLowerCase();
  return !!st && CLOSED_STAGE_MARKERS.some(m => st.includes(m));
}

/** Best-effort set of "accountId::dealNameLower" for OPEN deals that already
 * exist, so the push never creates a second identical Deal under the same
 * account on a retry — while an OLD CLOSED deal (lost/terminated) with the same
 * name does NOT block a legitimate new/re-engagement deal. Best-effort (a
 * lookup failure just means we might create a duplicate the radar can merge —
 * never data loss), so it swallows errors. Criteria-unsafe names are skipped. */
export async function findExistingDealKeys(
  pairs: Array<{ accountId: string; name: string }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const names = Array.from(new Set(pairs.map(p => String(p.name || "").trim()).filter(isSafeCriteriaValue)));
  const CHUNK = 10;
  for (let s = 0; s < names.length; s += CHUNK) {
    const chunk = names.slice(s, s + CHUNK);
    const criteria = chunk.map(n => `(Deal_Name:equals:${n})`).join("or");
    let rows: CRMProviderCRMRecord[] = [];
    try { rows = await searchCRMProviderRecords("Deals", criteria); } catch { rows = []; }
    for (const r of rows) {
      const acc = String(r.data?.Account_Name?.id || "");
      const nm = String(r.data?.Deal_Name || "").trim().toLowerCase();
      // Only an OPEN same-name deal blocks — a closed/lost old deal does not.
      if (acc && nm && !isClosedStage(r.data?.Stage)) out.add(`${acc}::${nm}`);
    }
  }
  return out;
}

/** Live check: which of these account ids are LIVE clients — an account with a
 * customer Deal (signed/paid, or carrying Customer-Success renewal/churn data)
 * that is NOT churned. The churn/renewal fields live on the Deal (CS section):
 *   PREFLIGHT_CHURN_DATE_FIELD   (default Churn_Date)
 *   PREFLIGHT_RENEWAL_DATE_FIELD (default Renewal_Date)
 *
 * Timeline rule (Sample User): a customer deal counts as CHURNED only when its churn
 * date is the most recent event — i.e. churn date is set AND (there is no
 * renewal date, or the churn date is AFTER the renewal date). If churn is empty,
 * or a renewal is dated on/after the churn (they came back), the deal is LIVE.
 * An account is a live client if ANY of its customer deals is live → REJECTED.
 * A past client (all customer deals churned-after-renewal) or a never-converted
 * account is NOT live → it gets the re-engagement / new deal.
 *
 * Best-effort per account: a lookup failure falls back to NOT-live (→ push),
 * since the import gate + open-same-name dedup are the other safety nets. */
export async function getLiveClientAccounts(accountIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const signed = (process.env.PREFLIGHT_SIGNED_STAGES || "Agreement Signed,Paid")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const churnField = process.env.PREFLIGHT_CHURN_DATE_FIELD || "Churn_Date";
  const renewalField = process.env.PREFLIGHT_RENEWAL_DATE_FIELD || "Renewal_Date";
  const parseDate = (v: any): number | null => {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  };
  const ids = Array.from(new Set(accountIds.map(i => String(i || "").trim()).filter(Boolean)));
  for (const accId of ids) {
    try {
      const deals: any[] = await makeCRMProviderRequest(
        async (config) => fetch(
          `${config.apiDomain}/crm/v2/Accounts/${accId}/Deals?fields=Stage,${churnField},${renewalField}&per_page=200`,
          { method: "GET", headers: { Authorization: `CRMProvider-oauthtoken ${config.accessToken}`, "Content-Type": "application/json" } },
        ),
        async (response) => {
          if (response.status === 204) return [];
          if (!response.ok) throw new Error(`Account ${accId} deals: ${response.status}`);
          const t = await response.text();
          if (!t || !t.trim()) return [];
          return JSON.parse(t).data || [];
        },
      );
      let live = false;
      for (const d of deals) {
        const st = String(d?.Stage || "").trim().toLowerCase();
        const churn = parseDate(d?.[churnField]);
        const renewal = parseDate(d?.[renewalField]);
        // A "customer deal" = signed/paid stage, or carries CS renewal/churn data.
        const isCustomerDeal = signed.some(sig => st === sig || st.includes(sig)) || churn != null || renewal != null;
        if (!isCustomerDeal) continue;
        // Churned only when churn is the most recent event.
        const churned = churn != null && (renewal == null || churn > renewal);
        if (!churned) { live = true; break; } // a live (non-churned) customer deal
      }
      if (live) out.add(accId);
    } catch { /* best-effort: treat as NOT a live client → push */ }
  }
  return out;
}

/** A live deal that makes a company "active" (blocks a Preflight re-import). */
export interface ActiveDealHit {
  accountId: string | null;
  dealId: string;
  dealName: string;
  owner: string | null;
  stage: string;
  /** open = still being worked in the pipeline; customer = signed/paid and NOT churned. */
  kind: "open" | "customer";
  /** Product segment of the deal, when it could be determined from the live
   *  record (layout → pipeline → marketplace-stage). null = unknown; the caller
   *  refines it from the local mirror before deciding to block. */
  segment: "marketplace" | "Example Organization" | "ExampleOrg" | null;
}

/** Fields + rules shared by every "is this deal active?" check. */
function _pfChurnField() {
  return process.env.PREFLIGHT_CHURN_DATE_FIELD || "Churn_Date";
}
function _pfRenewalField() {
  return process.env.PREFLIGHT_RENEWAL_DATE_FIELD || "Renewal_Date";
}
function _pfCustomerStages(): string[] {
  return (process.env.PREFLIGHT_SIGNED_STAGES || "Agreement Signed,Paid")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .concat(["closed won", "client activated", "transferred to cs"]);
}
const _PF_DEAD_STAGE_RE = /lost|dropped|cancel/;
function _pfParseDate(v: any): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

/**
 * Classify ONE raw CRMProvider Deal record. Returns "open" | "customer" if the deal
 * makes its company active, or null if it does not (no/dead stage, explicitly
 * Terminated, or churned on the timeline). Shared by the account-related-list
 * check and the deal-search check so both use identical rules.
 */
function _classifyActiveDeal(d: any): "open" | "customer" | null {
  const st = String(d?.Stage || "").trim().toLowerCase();
  if (!st || _PF_DEAD_STAGE_RE.test(st)) return null; // no stage or dead
  const phase = String(d?.Phase || "").trim().toLowerCase();
  if (phase.includes("terminat")) return null; // explicitly churned
  const churn = _pfParseDate(d?.[_pfChurnField()]);
  const renewal = _pfParseDate(d?.[_pfRenewalField()]);
  if (churn != null && (renewal == null || churn > renewal)) return null; // churned
  const isCustomer =
    _pfCustomerStages().some((sig) => st === sig || st.includes(sig)) ||
    churn != null ||
    renewal != null;
  return isCustomer ? "customer" : "open";
}

/** Normalized ASCII core of a name (lowercase, alphanumerics only) for a
 * conservative containment guard on deal-search false positives. */
function _pfNameCore(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Stages that only exist on the MARKETPLACE pipeline (Sample User 2026-08-30) — the
 *  last-resort segment signal when a live record carries neither Layout nor
 *  Pipeline. Env-extendable: PREFLIGHT_MARKETPLACE_STAGES. */
function _pfMarketplaceStages(): string[] {
  return (
    process.env.PREFLIGHT_MARKETPLACE_STAGES ||
    "Partner Active,Welcome Communications"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ""))
    .filter(Boolean);
}

/**
 * Product segment of a live CRMProvider Deal (Sample User 2026-08-30). Preflight vets B2B /
 * ExampleOrg-corporate imports, so a deal on the MARKETPLACE or Example Organization (B2C)
 * motion must NOT block a B2B approach — the same company can legitimately be
 * approached as a ExampleOrg corporate client. Mirrors classifyLayoutSegment's
 * substring rules (kept local to avoid a duplicateRadarDatabase import cycle).
 * Returns null when the live record carries no segment signal at all; the
 * caller then refines from the local mirror rather than guessing.
 */
function _pfDealSegment(d: any): "marketplace" | "Example Organization" | "ExampleOrg" | null {
  const norm = (v: any) =>
    String(
      v && typeof v === "object" ? (v.name ?? v.display_label ?? "") : (v ?? ""),
    )
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const bySubstring = (s: string) => {
    if (!s) return null;
    if (s.includes("marketplace") || s.includes("partneraccount")) return "marketplace" as const;
    if (s.includes("Example Organization")) return "Example Organization" as const;
    return "ExampleOrg" as const;
  };
  const layout = norm(d?.$layout) || norm(d?.Layout);
  if (layout) return bySubstring(layout);
  const pipeline = norm(d?.Pipeline);
  if (pipeline) return bySubstring(pipeline);
  const stage = norm(d?.Stage);
  if (stage && _pfMarketplaceStages().includes(stage)) return "marketplace";
  return null; // unknown — caller refines from the mirror
}

/**
 * LIVE verification (Sample User 2026-08-03) — does this Account currently carry an
 * ACTIVE deal? Used by the Preflight to double-check a "past client, cool-off
 * elapsed → PASS" verdict against CRMProvider before telling Sales it is safe to
 * re-import, because the local CS/Termination mirror goes stale (a company can
 * have re-signed, or have been mis-tagged as a client it never became).
 *
 * ACTIVE = an OPEN-pipeline deal (a non-empty Stage that is neither a customer
 * stage nor a dead stage) OR a CURRENT-CUSTOMER deal (signed / paid / won /
 * client-activated / transferred-to-cs, or carrying CS churn/renewal data) that
 * is NOT churned. Churn is read the SAME way as getLiveClientAccounts — churn is
 * the most-recent event on the timeline — PLUS an explicit Phase = "Termination".
 * A past client (every deal closed-lost / cancelled / churned) returns null, so
 * it stays importable past the cool-off.
 *
 * Best-effort: a lookup error returns null so an API hiccup never blocks an
 * import on its own (the mirror-based rules are the backstop).
 */
export async function findActiveDealForAccount(
  accountId: string,
): Promise<ActiveDealHit | null> {
  const id = String(accountId || "").trim();
  if (!id) return null;
  const churnField = _pfChurnField();
  const renewalField = _pfRenewalField();
  // Throws on a hard API error so the caller can tell "checked, none active"
  // from "could not check" (a CRMProvider hiccup must never masquerade as verified).
  const deals: any[] = await makeCRMProviderRequest(
    async (config) =>
      fetch(
        `${config.apiDomain}/crm/v2/Accounts/${encodeURIComponent(id)}/Deals?fields=Deal_Name,Stage,Owner,Phase,${churnField},${renewalField}&per_page=200`,
        {
          method: "GET",
          headers: {
            Authorization: `CRMProvider-oauthtoken ${config.accessToken}`,
            "Content-Type": "application/json",
          },
        },
      ),
    async (response) => {
      if (response.status === 204) return [];
      if (!response.ok) throw new Error(`Account ${id} deals: ${response.status}`);
      const t = await response.text();
      if (!t || !t.trim()) return [];
      return JSON.parse(t).data || [];
    },
  );
  let openHit: ActiveDealHit | null = null;
  let customerHit: ActiveDealHit | null = null;
  for (const d of deals) {
    const kind = _classifyActiveDeal(d);
    if (!kind) continue;
    // SCOPE (Sample User 2026-08-30): Preflight vets B2B / ExampleOrg-corporate imports,
    // so a MARKETPLACE or Example Organization (B2C) deal must NOT block — the company can
    // still be approached as a ExampleOrg B2B client. Skip it and keep scanning
    // in case the account also carries a real ExampleOrg deal.
    const segment = _pfDealSegment(d);
    if (segment === "marketplace" || segment === "Example Organization") continue;
    const hit: ActiveDealHit = {
      accountId: id,
      dealId: String(d?.id || "").trim(),
      dealName: String(d?.Deal_Name || "").trim() || String(d?.id || ""),
      owner: d?.Owner?.name || d?.Owner?.id || null,
      stage: String(d?.Stage || "").trim(),
      kind,
      segment,
    };
    // An OPEN deal (someone is actively working it) is the strongest signal —
    // return it immediately. Otherwise remember a live-customer deal and keep
    // scanning in case an open one appears.
    if (kind === "open") {
      openHit = hit;
      break;
    }
    if (!customerHit) customerHit = hit;
  }
  return openHit || customerHit;
}

/**
 * LIVE verification by COMPANY NAME (Sample User 2026-08-04) — the account-related-list
 * check misses when a deal's Account carries no matching domain and the mirror's
 * name is punctuated differently (e.g. Account "Example Organization - طيران الرياض" vs the
 * inbound "Example Organization | طيران الرياض"). CRMProvider's global word-search indexes
 * Deal_Name AND the Account_Name shown on the deal, so searching the company's
 * distinctive name finds the live deal directly, regardless of account linkage.
 *
 * A normalized-ASCII containment guard keeps out false positives: a returned
 * deal counts only when its Deal_Name / Account_Name core contains the company
 * core (or vice-versa). Names with a <4-char ASCII core are too generic to
 * search safely and return null. Throws on a hard API error (caller treats that
 * as "could not verify"). Returns the first ACTIVE deal, preferring an OPEN one.
 */
export async function findActiveDealByCompany(input: {
  companyName?: string | null;
  domain?: string | null;
}): Promise<ActiveDealHit | null> {
  const raw = String(input.companyName || "").trim();
  // Use the Latin/leading segment before a separator as the search term
  // ("Example Organization | طيران الرياض" → "Example Organization"); fall back to the whole string.
  const term = (raw.split(/[|\/]|\s-\s/)[0] || raw).trim();
  const companyCore = _pfNameCore(raw) || _pfNameCore(term);
  if (companyCore.length < 4) return null; // too generic to search by name safely
  const churnField = _pfChurnField();
  const renewalField = _pfRenewalField();
  const searchTerm = term.length >= 3 ? term : raw;
  const deals: any[] = await makeCRMProviderRequest(
    async (config) =>
      fetch(
        `${config.apiDomain}/crm/v2/Deals/search?word=${encodeURIComponent(searchTerm)}&fields=Deal_Name,Stage,Owner,Phase,Account_Name,${churnField},${renewalField}&per_page=200`,
        {
          method: "GET",
          headers: {
            Authorization: `CRMProvider-oauthtoken ${config.accessToken}`,
            "Content-Type": "application/json",
          },
        },
      ),
    async (response) => {
      if (response.status === 204) return [];
      if (!response.ok) throw new Error(`Deals search "${searchTerm}": ${response.status}`);
      const t = await response.text();
      if (!t || !t.trim()) return [];
      return JSON.parse(t).data || [];
    },
  );
  let openHit: ActiveDealHit | null = null;
  let customerHit: ActiveDealHit | null = null;
  for (const d of deals) {
    // Containment guard — the returned deal must actually be THIS company.
    const dealCore = _pfNameCore(
      String(d?.Deal_Name || "") + " " + String(d?.Account_Name?.name || ""),
    );
    if (!dealCore.includes(companyCore) && !companyCore.includes(dealCore.slice(0, companyCore.length)))
      continue;
    const kind = _classifyActiveDeal(d);
    if (!kind) continue;
    // Same B2B scope as the account path — marketplace / Example Organization never blocks.
    const segment = _pfDealSegment(d);
    if (segment === "marketplace" || segment === "Example Organization") continue;
    const hit: ActiveDealHit = {
      accountId: d?.Account_Name?.id ? String(d.Account_Name.id) : null,
      dealId: String(d?.id || "").trim(),
      dealName: String(d?.Deal_Name || "").trim() || String(d?.id || ""),
      owner: d?.Owner?.name || d?.Owner?.id || null,
      stage: String(d?.Stage || "").trim(),
      kind,
      segment,
    };
    if (kind === "open") {
      openHit = hit;
      break;
    }
    if (!customerHit) customerHit = hit;
  }
  return openHit || customerHit;
}

/**
 * LIVE verification for a COMPANY — checks a set of candidate Account ids (the
 * caller passes the mirror-discovered accounts for this domain/name) PLUS any
 * Account that CRMProvider's global search links to the company's email DOMAIN, so a
 * re-sign under a NEW Account is caught too. Returns the first ACTIVE deal
 * found. `checked` is true when at least one Account was queried WITHOUT a hard
 * API error — the caller uses it to tell "verified: none active" apart from
 * "could not verify" (never let a CRMProvider hiccup pass as verified). Bounded so the
 * per-row verification can't hammer the API.
 */
export async function verifyCompanyActiveDeal(input: {
  accountIds?: Array<string | null | undefined>;
  domain?: string | null;
}): Promise<{ hit: ActiveDealHit | null; checked: boolean }> {
  const ids = new Set<string>();
  for (const a of input.accountIds || []) {
    const s = String(a || "").trim();
    if (s) ids.add(s);
  }
  const dom = String(input.domain || "").trim().toLowerCase();
  // Domains are distinctive enough to resolve extra Accounts safely; company
  // names are NOT (too many false collisions), so we deliberately do NOT
  // name-search Accounts here — the caller's mirror-discovered ids cover names.
  if (dom) {
    try {
      const accts = await searchCRMProviderRecordsByWord("Accounts", dom);
      for (const r of accts.slice(0, 5)) if (r.id) ids.add(String(r.id));
    } catch {
      /* best-effort — the domain net is optional */
    }
  }
  let checked = false;
  for (const id of Array.from(ids).slice(0, 10)) {
    try {
      const hit = await findActiveDealForAccount(id);
      checked = true; // this account was queried successfully
      if (hit) return { hit, checked: true };
    } catch {
      /* this account errored — keep trying the others */
    }
  }
  return { hit: null, checked };
}

/** Bulk UPDATE (CRMProvider v2 PUT /crm/v2/{module}). Each record MUST carry `id`
 * plus the fields to change. Chunks at 100; returns per-record outcomes
 * positionally aligned to input (same shape as createCRMProviderRecordsBulk). Used by
 * the title backfill to set Title on already-created Leads/Contacts. */
export async function updateCRMProviderRecordsBulk(
  module: string,
  records: Array<Record<string, any>>,
): Promise<BulkCreateOutcome[]> {
  markInteractiveCRMProviderActivity();
  if (records.length === 0) return [];
  const BATCH = 100;
  const outcomes: BulkCreateOutcome[] = [];
  for (let start = 0; start < records.length; start += BATCH) {
    const chunk = records.slice(start, start + BATCH);
    logger.info(`✏️ [CRMProviderCRM] Bulk updating ${chunk.length} ${module} (offset ${start}/${records.length})`);
    try {
      const <REDACTED_SCHEME> any = await makeCRMProviderRequest(
        async (config) => fetch(`${config.apiDomain}/crm/v2/${module}`, {
          method: 'PUT',
          headers: {
            Authorization: `CRMProvider-oauthtoken ${config.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ <REDACTED_SCHEME> chunk }),
        }),
        async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok && response.status !== 207) {
            throw new Error(`CRMProvider bulk update error: ${response.status} - ${body?.message || response.statusText}`);
          }
          return body;
        },
      );
      const rows: any[] = Array.isArray(data?.data) ? data.data : [];
      for (let i = 0; i < chunk.length; i++) {
        const r = rows[i] || {};
        outcomes.push(r.status === 'success'
          ? { index: start + i, status: 'success', id: r.details?.id ?? undefined, code: r.code, message: r.message, details: r.details }
          : { index: start + i, status: 'error', code: r.code || 'UNKNOWN', message: r.message || 'Failed', details: r.details });
      }
    } catch (e: any) {
      for (let i = 0; i < chunk.length; i++) {
        outcomes.push({ index: start + i, status: 'error', code: 'BATCH_ERROR', message: e?.message || String(e) });
      }
    }
  }
  return outcomes;
}

/**
 * Word-based search — same indexed lookup the CRMProvider UI uses for the
 * "Global Search" box at the top of the CRM. Searches every indexed
 * field on the module (phone, mobile, email, name, etc.) for a
 * substring match against `word`. Far more permissive than the
 * structured `criteria=` search and the right tool for phone-number
 * lookup because CRMProvider's phone fields ARE indexed for global search but
 * do NOT support the `contains` operator on criteria-based search.
 *
 * Reference: the 2026-05-28 root-cause investigation found a Lead
 * (القحطاني نوره, phone <REDACTED_PHONE> that the criteria-based
 * `Phone:contains:<REDACTED_PHONE>` search missed but the UI global search
 * found instantly. That gap drove this helper into existence.
 */
export async function searchCRMProviderRecordsByWord(
  module: string,
  word: string,
): Promise<CRMProviderCRMRecord[]> {
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/search?word=${encodeURIComponent(word)}`;
      return fetch(url, {
        method: "GET",
        headers: {
          Authorization: `CRMProvider-oauthtoken ${config.accessToken}`,
          "Content-Type": "application/json",
        },
      });
    },
    async (response) => {
      if (!response.ok) {
        if (response.status === 204) {
          return [];
        }
        const error = await response.json().catch(() => ({}));
        throw new Error(
          `CRMProvider CRM word search error: ${response.status} - ${
            error.message || response.statusText
          }`,
        );
      }

      const data = await response.json();

      return (data.data || []).map((record: any) => ({
        id: record.id,
        module,
        owner: record.Owner?.name || record.Owner?.id,
        createdTime: record.Created_Time,
        modifiedTime: record.Modified_Time,
        <REDACTED_SCHEME> record,
      }));
    },
  );
}

export function analyzeRecordHygiene(
  record: CRMProviderCRMRecord,
  governanceRules: GovernanceRule[]
): HygieneIssue[] {
  const issues: HygieneIssue[] = [];
  
  for (const rule of governanceRules) {
    if (rule.module !== record.module && rule.module !== '*') continue;
    
    if (rule.stageCondition && rule.stageCondition.length > 0) {
      const stageFieldName = rule.stageField || 'Stage';
      const recordStage = String(record.data[stageFieldName] || '').toLowerCase().replace(/\s+/g, '_');
      const matchesStage = rule.stageCondition.some(s => recordStage === s.toLowerCase().replace(/\s+/g, '_'));
      if (!matchesStage) continue;
    }
    
    if (rule.sourceCondition && rule.sourceCondition.length > 0) {
      const sourceFieldName = rule.sourceField || 'Lead_Source';
      const recordSource = String(record.data[sourceFieldName] || '').toLowerCase();
      const matchesSource = rule.sourceCondition.some(s => recordSource.includes(s.toLowerCase()));
      if (!matchesSource) continue;
    }
    
    const value = record.data[rule.fieldName];
    
    switch (rule.ruleType) {
      case 'required':
        if (!value || (typeof value === 'string' && value.trim() === '')) {
          issues.push({
            recordId: record.id,
            module: record.module,
            issueType: 'missing_required_field',
            fieldName: rule.fieldName,
            description: rule.description || `Missing required field: ${rule.fieldName}`,
            severity: rule.severity || 'high',
            suggestedFix: `Fill in the ${rule.fieldName} field`,
          });
        }
        break;
        
      case 'format':
        if (value && rule.pattern) {
          const regex = new RegExp(rule.pattern);
          if (!regex.test(String(value))) {
            issues.push({
              recordId: record.id,
              module: record.module,
              issueType: 'invalid_format',
              fieldName: rule.fieldName,
              description: rule.description || `Invalid format for field: ${rule.fieldName}`,
              severity: rule.severity || 'medium',
              suggestedFix: rule.suggestedFix || `Correct the format of ${rule.fieldName}`,
            });
          }
        }
        break;
        
      case 'enum':
        if (value && rule.allowedValues && !rule.allowedValues.includes(String(value))) {
          issues.push({
            recordId: record.id,
            module: record.module,
            issueType: 'invalid_value',
            fieldName: rule.fieldName,
            description: rule.description || `Invalid value for field: ${rule.fieldName}`,
            severity: rule.severity || 'medium',
            suggestedFix: `Set ${rule.fieldName} to one of: ${rule.allowedValues.join(', ')}`,
          });
        }
        break;
        
      case 'custom':
        if (rule.validator && !rule.validator(value, record)) {
          issues.push({
            recordId: record.id,
            module: record.module,
            issueType: 'governance_violation',
            fieldName: rule.fieldName,
            description: rule.description || `Governance rule violated for: ${rule.fieldName}`,
            severity: rule.severity || 'medium',
            suggestedFix: rule.suggestedFix,
          });
        }
        break;
    }
  }
  
  return issues;
}

export interface GovernanceRule {
  module: string;
  fieldName: string;
  ruleType: 'required' | 'format' | 'enum' | 'custom';
  description?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  pattern?: string;
  allowedValues?: string[];
  validator?: (value: any, record: CRMProviderCRMRecord) => boolean;
  suggestedFix?: string;
  stageCondition?: string[];
  stageField?: string;
  sourceCondition?: string[];
  sourceField?: string;
}

export const DEFAULT_GOVERNANCE_RULES: GovernanceRule[] = [
  // ═══════════════════════════════════════════════════════════
  //  UNIVERSAL RULES (all modules)
  // ═══════════════════════════════════════════════════════════
  { module: '*', fieldName: 'Owner', ruleType: 'required', description: 'Record must have an owner', severity: 'high' },

  // ═══════════════════════════════════════════════════════════
  //  DEALS — always required
  // ═══════════════════════════════════════════════════════════
  { module: 'Deals', fieldName: 'Deal_Name', ruleType: 'required', description: 'Deal must have a name', severity: 'critical' },
  { module: 'Deals', fieldName: 'Stage', ruleType: 'required', description: 'Deal must have a stage', severity: 'critical' },
  // Amount: not required for outbound deals still in early ("New Deal"/"Qualification") stage
  // — those fields are gathered later in the pipeline per Sales SOP.
  { module: 'Deals', fieldName: 'Amount', ruleType: 'custom',
    validator: (v, rec) => {
      const isFilled = v != null && !(typeof v === 'string' && v.trim() === '');
      if (isFilled) return true;
      const src = String(rec.data?.Lead_Source || '').toLowerCase();
      const stage = String(rec.data?.Stage || '').toLowerCase().replace(/\s+/g, '_');
      const isOutbound = src.includes('outbound') || src.includes('cold');
      const isEarlyStage = stage === '' || stage === 'new_deal' || stage === 'qualification';
      return isOutbound && isEarlyStage;
    },
    description: 'Deal must have an amount', severity: 'high',
    suggestedFix: 'Fill in the Amount field' },
  // Closing date: per business rule, only required once the deal reaches the
  // Agreement Signed stage (or beyond). Earlier stages don't need a date yet.
  { module: 'Deals', fieldName: 'Closing_Date', ruleType: 'required',
    stageCondition: ['Agreement Signed', 'Closed Won', 'Closed Lost'],
    description: 'Deal must have a closing date', severity: 'high' },
  { module: 'Deals', fieldName: 'Account_Name', ruleType: 'required', description: 'Deal must be linked to an Account', severity: 'high' },
  { module: 'Deals', fieldName: 'Contact_Name', ruleType: 'required', description: 'Deal must have a Contact linked', severity: 'high' },
  // Pipeline rule REMOVED — CRMProvider CRM enforces Pipeline at the schema level
  // (a deal cannot exist without one), so flagging "missing Pipeline" was a
  // false positive. The Pipeline value is still surfaced as a column in the
  // All-Issues view for visibility.
  { module: 'Deals', fieldName: 'Lead_Source', ruleType: 'required', description: 'Deal must have a lead source', severity: 'medium' },
  // No_of_Employees: same outbound + early-stage exemption as Amount.
  { module: 'Deals', fieldName: 'No_of_Employees', ruleType: 'custom',
    validator: (v, rec) => {
      const isFilled = v != null && !(typeof v === 'string' && v.trim() === '');
      if (isFilled) return true;
      const src = String(rec.data?.Lead_Source || '').toLowerCase();
      const stage = String(rec.data?.Stage || '').toLowerCase().replace(/\s+/g, '_');
      const isOutbound = src.includes('outbound') || src.includes('cold');
      const isEarlyStage = stage === '' || stage === 'new_deal' || stage === 'qualification';
      return isOutbound && isEarlyStage;
    },
    description: 'Deal must have number of employees for qualification', severity: 'high',
    suggestedFix: 'Fill in the No_of_Employees field' },
  // Region: only the City and KSA region fields count. Pass if either is filled
  // (covers field labels "Region (City)" and "Region (KSA)" — CRMProvider API names
  // commonly Region_City / Region_KSA, with City as a SDR fallback).
  { module: 'Deals', fieldName: 'Region', ruleType: 'custom',
    validator: (_v, rec) => {
      const candidates = ['Region_City', 'Region_KSA', 'City', 'Region'];
      return candidates.some(f => {
        const val = rec.data?.[f];
        return val != null && !(typeof val === 'string' && val.trim() === '');
      });
    },
    description: 'Deal must have a region per qualification criteria (Region (City) or Region (KSA))',
    severity: 'medium',
    suggestedFix: 'Fill in the Region (City) or Region (KSA) field' },
  // Industry: same outbound + early-stage exemption as Amount.
  { module: 'Deals', fieldName: 'Industry', ruleType: 'custom',
    validator: (v, rec) => {
      const isFilled = v != null && !(typeof v === 'string' && v.trim() === '');
      if (isFilled) return true;
      const src = String(rec.data?.Lead_Source || '').toLowerCase();
      const stage = String(rec.data?.Stage || '').toLowerCase().replace(/\s+/g, '_');
      const isOutbound = src.includes('outbound') || src.includes('cold');
      const isEarlyStage = stage === '' || stage === 'new_deal' || stage === 'qualification';
      return isOutbound && isEarlyStage;
    },
    description: 'Deal must have an industry classification', severity: 'medium',
    suggestedFix: 'Fill in the Industry field' },
  { module: 'Deals', fieldName: 'Stage', ruleType: 'enum',
    allowedValues: ['Qualification', 'Meeting', 'Proposal', 'Agreement Signed', 'On Hold', 'Closed Won', 'Closed Lost'],
    description: 'Deal stage must be a valid SOP-defined value', severity: 'critical' },

  // DEALS — Proposal stage conditional fields (Sales SOP items 1, 3, 4)
  { module: 'Deals', fieldName: 'Probability', ruleType: 'custom', stageCondition: ['Proposal', 'Agreement Signed', 'Closed Won'],
    validator: (v) => v != null && Number(v) > 0 && Number(v) <= 100,
    description: 'Deal Probability must be set (1-100%) at Proposal stage or later', severity: 'high' },
  { module: 'Deals', fieldName: 'Bundle_Type', ruleType: 'required', stageCondition: ['Proposal', 'Agreement Signed', 'Closed Won'],
    description: 'Bundle Type is required from Proposal stage per Sales SOP', severity: 'high' },
  { module: 'Deals', fieldName: 'Discount', ruleType: 'custom', stageCondition: ['Proposal', 'Agreement Signed', 'Closed Won'],
    validator: (v) => v == null || v === '' || v === 0 || (Number(v) >= 0 && Number(v) <= 100),
    description: 'Discount% must be 0-100 if set from Proposal stage per Sales SOP', severity: 'medium',
    suggestedFix: 'Set Discount to a value between 0 and 100' },

  // DEALS — On Hold stage conditional fields (Sales SOP item 2)
  { module: 'Deals', fieldName: 'On_Hold_Reason', ruleType: 'required', stageCondition: ['On Hold'],
    description: 'On Hold Reason is mandatory when deal is in On Hold stage per Sales SOP', severity: 'critical' },
  { module: 'Deals', fieldName: 'On_Hold_Reason', ruleType: 'enum', stageCondition: ['On Hold'],
    allowedValues: ['Budget Constraints', 'Decision Delay', 'Internal Restructuring', 'Client Unresponsive', 'Awaiting Legal Approval', 'Competitor Evaluation', 'Other'],
    description: 'On Hold Reason must be a valid SOP-defined value', severity: 'high' },

  // DEALS — Agreement Signed stage conditional fields (Sales SOP items 5-9)
  { module: 'Deals', fieldName: 'Onboarding_Method', ruleType: 'required', stageCondition: ['Agreement Signed', 'Closed Won'],
    description: 'Onboarding Method is required from Agreement Signed per Sales SOP', severity: 'high' },
  { module: 'Deals', fieldName: 'Onboarding_Method', ruleType: 'enum', stageCondition: ['Agreement Signed', 'Closed Won'],
    allowedValues: ['Self-Onboarding', 'Assisted Onboarding', 'Dedicated Onboarding Manager'],
    description: 'Onboarding Method must be a valid SOP-defined value', severity: 'medium' },
  { module: 'Deals', fieldName: 'Contract_No_of_Employees', ruleType: 'required', stageCondition: ['Agreement Signed', 'Closed Won'],
    description: 'Contract No. of Employees required from Agreement Signed per Sales SOP', severity: 'high' },
  { module: 'Deals', fieldName: 'Trial_Period', ruleType: 'required', stageCondition: ['Agreement Signed', 'Closed Won'],
    description: 'Trial Period flag required from Agreement Signed per Sales SOP', severity: 'medium' },
  { module: 'Deals', fieldName: 'Trial_Period_Days', ruleType: 'custom', stageCondition: ['Agreement Signed', 'Closed Won'],
    validator: (v, rec) => {
      if (String(rec.data.Trial_Period || '').toLowerCase() === 'yes' || rec.data.Trial_Period === true) {
        return v != null && Number(v) > 0;
      }
      return true;
    },
    description: 'Trial Period Days must be filled if Trial Period = Yes per Sales SOP', severity: 'medium' },
  { module: 'Deals', fieldName: 'National_Address', ruleType: 'required', stageCondition: ['Agreement Signed', 'Closed Won'],
    description: 'National Address is required from Agreement Signed per Sales SOP', severity: 'high' },

  // ═══════════════════════════════════════════════════════════
  //  LEADS — SDR pipeline (full coverage per SDR SOP)
  // ═══════════════════════════════════════════════════════════
  { module: 'Leads', fieldName: 'Email', ruleType: 'required', description: 'Lead must have an email address', severity: 'high' },
  { module: 'Leads', fieldName: 'Email', ruleType: 'format', pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    description: 'Email must be in valid format', severity: 'medium' },
  { module: 'Leads', fieldName: 'Email', ruleType: 'custom',
    validator: (v) => {
      if (!v || typeof v !== 'string') return true;
      const domain = v.split('@')[1]?.toLowerCase() || '';
      const freeProviders = ['<REDACTED_HOST>', '<REDACTED_HOST>', '<REDACTED_HOST>', '<REDACTED_HOST>', '<REDACTED_HOST>', '<REDACTED_HOST>', '<REDACTED_HOST>', '<REDACTED_HOST>'];
      return !freeProviders.includes(domain);
    },
    description: 'Business email is required — free email provider detected (SDR SOP rule)', severity: 'medium',
    suggestedFix: 'Request a company/business email address from the lead' },
  { module: 'Leads', fieldName: 'Phone', ruleType: 'required', description: 'Lead must have a phone number', severity: 'high' },
  { module: 'Leads', fieldName: 'Phone', ruleType: 'format', pattern: '^\\+966',
    description: 'Phone must have KSA country code (+966) per SDR SOP', severity: 'medium',
    suggestedFix: 'Update the phone number to include KSA country code +966' },
  { module: 'Leads', fieldName: 'Lead_Source', ruleType: 'required', description: 'Lead must have a source', severity: 'medium' },
  // Strict Lead_Source enum check REMOVED — CRMProvider CRM exposes a much broader
  // picklist than the SDR SOP's short list (e.g. "Web Research", "Trade Show",
  // "Email Campaign"), so the enum kept flagging legitimately-populated leads
  // as "invalid SOP value". Any non-empty Lead_Source now passes.
  { module: 'Leads', fieldName: 'Lead_Status', ruleType: 'required', description: 'Lead must have a status', severity: 'high' },
  { module: 'Leads', fieldName: 'Lead_Status', ruleType: 'enum',
    allowedValues: ['New', 'Contacted', 'Contacting', 'Qualified', 'Not Qualified', 'Junk', 'On Hold', 'Converted', 'Nurturing'],
    description: 'Lead Status must be a valid SOP-defined value', severity: 'high' },
  { module: 'Leads', fieldName: 'Company', ruleType: 'required', description: 'Company name is mandatory per SDR SOP', severity: 'high' },
  { module: 'Leads', fieldName: 'First_Name', ruleType: 'required', description: 'Lead first name is required per SDR SOP', severity: 'high' },
  { module: 'Leads', fieldName: 'Last_Name', ruleType: 'required', description: 'Lead last name is required per SDR SOP', severity: 'high' },
  { module: 'Leads', fieldName: 'Designation', ruleType: 'required', description: 'Job title/designation is required per SDR SOP', severity: 'medium' },
  { module: 'Leads', fieldName: 'City', ruleType: 'required', description: 'Region (City) must not be empty per SDR SOP', severity: 'medium',
    suggestedFix: 'Fill in the City field with the lead region/city' },
  { module: 'Leads', fieldName: 'No_of_Employees', ruleType: 'required', description: 'Number of employees is required per SDR SOP', severity: 'medium' },
  { module: 'Leads', fieldName: 'Industry', ruleType: 'required', description: 'Industry is required per SDR SOP', severity: 'medium' },

  // LEADS — Outbound source conditional fields (SDR SOP items 1-2)
  { module: 'Leads', fieldName: 'Outgoing_Call_Result', ruleType: 'required',
    stageCondition: ['Contacted', 'Contacting', 'Qualified', 'Not Qualified', 'On Hold', 'Converted', 'Nurturing'],
    stageField: 'Lead_Status', sourceCondition: ['Outbound', 'Cold Call'],
    description: 'Outgoing Call Result required for outbound leads from Contacting stage (SDR SOP)', severity: 'high' },
  { module: 'Leads', fieldName: 'Outgoing_Call_Result', ruleType: 'enum',
    stageCondition: ['Contacted', 'Contacting', 'Qualified', 'Not Qualified', 'On Hold', 'Converted', 'Nurturing'],
    stageField: 'Lead_Status', sourceCondition: ['Outbound', 'Cold Call'],
    allowedValues: ['Connected', 'Not Answered', 'Voicemail', 'Wrong Number', 'Call Back Later', 'Not Interested'],
    description: 'Outgoing Call Result must be a valid SOP value (SDR SOP)', severity: 'medium' },
  { module: 'Leads', fieldName: 'Not_Qualified_Reason', ruleType: 'required',
    stageCondition: ['Not Qualified'], stageField: 'Lead_Status', sourceCondition: ['Outbound', 'Cold Call'],
    description: 'Not Qualified Reason required for outbound disqualified leads (SDR SOP)', severity: 'high' },

  // LEADS — All-source fields from Contacting stage onward (SDR SOP items 6-7)
  { module: 'Leads', fieldName: 'Tag', ruleType: 'required',
    stageCondition: ['Contacted', 'Contacting', 'Qualified', 'Not Qualified', 'On Hold', 'Converted', 'Nurturing'],
    stageField: 'Lead_Status',
    description: 'Lead Tag/Category required from Contacting stage (SDR SOP)', severity: 'medium' },
  // Notes/Description: preferential (low severity), not mandatory. Surfaced as
  // a soft hint for leads at Contacting stage or beyond — except brand-new
  // leads ("New" status) where notes are not yet expected.
  { module: 'Leads', fieldName: 'Description', ruleType: 'required',
    stageCondition: ['Contacted', 'Contacting', 'Qualified', 'Not Qualified', 'On Hold', 'Converted', 'Nurturing'],
    stageField: 'Lead_Status',
    description: 'Notes/Description preferred from Contacting stage onward (SDR SOP — informational)',
    severity: 'low',
    suggestedFix: 'Add a note/description to track the qualification trail (preferential, not mandatory)' },

  // ═══════════════════════════════════════════════════════════
  //  CONTACTS
  // ═══════════════════════════════════════════════════════════
  { module: 'Contacts', fieldName: 'First_Name', ruleType: 'required', description: 'Contact must have a first name', severity: 'high' },
  { module: 'Contacts', fieldName: 'Last_Name', ruleType: 'required', description: 'Contact must have a last name', severity: 'critical' },
  { module: 'Contacts', fieldName: 'Email', ruleType: 'required', description: 'Contact must have an email address', severity: 'high' },
  { module: 'Contacts', fieldName: 'Email', ruleType: 'format', pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', description: 'Email must be in valid format', severity: 'medium' },
  { module: 'Contacts', fieldName: 'Phone', ruleType: 'required', description: 'Contact must have a phone number', severity: 'medium' },
  { module: 'Contacts', fieldName: 'Account_Name', ruleType: 'required', description: 'Contact must be linked to an Account', severity: 'high' },
  { module: 'Contacts', fieldName: 'Title', ruleType: 'required', description: 'Contact must have a job title', severity: 'low' },

  // ═══════════════════════════════════════════════════════════
  //  ACCOUNTS — 20 Account Hygiene Rules (New)
  // ═══════════════════════════════════════════════════════════
  { module: 'Accounts', fieldName: 'Account_Name', ruleType: 'required', description: 'Account must have a name', severity: 'critical' },
  { module: 'Accounts', fieldName: 'Account_Type', ruleType: 'required', description: 'Account type is required', severity: 'high' },
  { module: 'Accounts', fieldName: 'Account_Type', ruleType: 'enum',
    allowedValues: ['Customer', 'Prospect', 'Partner', 'Vendor', 'Reseller', 'Competitor', 'Other'],
    description: 'Account Type must be a valid classification', severity: 'medium' },
  { module: 'Accounts', fieldName: 'Industry', ruleType: 'required', description: 'Industry classification is required', severity: 'high' },
  { module: 'Accounts', fieldName: 'Phone', ruleType: 'required', description: 'Account must have a phone number', severity: 'medium' },
  { module: 'Accounts', fieldName: 'Website', ruleType: 'required', description: 'Account must have a website', severity: 'low' },
  { module: 'Accounts', fieldName: 'Billing_City', ruleType: 'required', description: 'Billing City is required for invoicing', severity: 'high' },
  { module: 'Accounts', fieldName: 'Billing_Country', ruleType: 'required', description: 'Billing Country is required', severity: 'high' },
  { module: 'Accounts', fieldName: 'Employees', ruleType: 'required', description: 'Employee count is required for segmentation', severity: 'medium' },
  { module: 'Accounts', fieldName: 'Annual_Revenue', ruleType: 'required', description: 'Annual Revenue helps with account tier classification', severity: 'low' },
  { module: 'Accounts', fieldName: 'Account_Number', ruleType: 'required', description: 'Account Number is needed for finance reconciliation', severity: 'medium' },
  { module: 'Accounts', fieldName: 'Rating', ruleType: 'required', description: 'Account Rating helps prioritization', severity: 'low' },
  { module: 'Accounts', fieldName: 'SIC_Code', ruleType: 'required', description: 'SIC Code needed for industry classification compliance', severity: 'low' },
  { module: 'Accounts', fieldName: 'Ownership', ruleType: 'required', description: 'Ownership type needed for governance', severity: 'low' },
  { module: 'Accounts', fieldName: 'Description', ruleType: 'required', description: 'Account description provides business context', severity: 'low' },
  { module: 'Accounts', fieldName: 'Account_Name', ruleType: 'custom',
    validator: (v) => {
      if (!v || typeof v !== 'string') return true;
      const normalized = v.toLowerCase().replace(/[^a-z0-9]/g, '');
      const generic = ['test', 'sample', 'demo', 'na', 'none', 'tbd', 'unknown', 'xxx', 'abc', 'temp'];
      return !generic.includes(normalized);
    },
    description: 'Account name must not be generic/placeholder (test, sample, N/A, etc.)', severity: 'high',
    suggestedFix: 'Replace generic account name with the actual company name' },
  { module: 'Accounts', fieldName: 'Phone', ruleType: 'format', pattern: '^\\+',
    description: 'Account phone should include country code', severity: 'low' },
  { module: 'Accounts', fieldName: 'Email', ruleType: 'custom',
    validator: (v) => {
      if (!v || typeof v !== 'string') return true;
      const domain = v.split('@')[1]?.toLowerCase() || '';
      const freeProviders = ['<REDACTED_HOST>', '<REDACTED_HOST>', '<REDACTED_HOST>', '<REDACTED_HOST>'];
      return !freeProviders.includes(domain);
    },
    description: 'Account email should be a business domain, not free provider', severity: 'medium' },
  { module: 'Accounts', fieldName: 'Billing_Street', ruleType: 'required', description: 'Billing Street address needed for invoicing', severity: 'medium' },
  { module: 'Accounts', fieldName: 'Shipping_City', ruleType: 'custom',
    validator: (v, rec) => {
      const bt = rec.data.Account_Type;
      if (bt === 'Customer') return !!v;
      return true;
    },
    description: 'Shipping City is required for Customer accounts', severity: 'medium',
    suggestedFix: 'Fill in the Shipping City for customer accounts' },
];

export function calculateQualityScores(
  issues: HygieneIssue[],
  totalRecords: number
): {
  peopleScore: number;
  processScore: number;
  governanceScore: number;
  overallScore: number;
} {
  if (totalRecords === 0) {
    return { peopleScore: 100, processScore: 100, governanceScore: 100, overallScore: 100 };
  }
  
  const criticalIssues = issues.filter(i => i.severity === 'critical').length;
  const highIssues = issues.filter(i => i.severity === 'high').length;
  const mediumIssues = issues.filter(i => i.severity === 'medium').length;
  const lowIssues = issues.filter(i => i.severity === 'low').length;
  
  const totalWeightedIssues = (criticalIssues * 4) + (highIssues * 3) + (mediumIssues * 2) + lowIssues;
  const maxPossibleWeight = totalRecords * 4;
  
  const baseScore = Math.max(0, 100 - (totalWeightedIssues / maxPossibleWeight * 100));
  
  const missingFieldIssues = issues.filter(i => i.issueType === 'missing_required_field').length;
  const formatIssues = issues.filter(i => i.issueType === 'invalid_format').length;
  const invalidValueIssues = issues.filter(i => i.issueType === 'invalid_value').length;
  const governanceIssues = issues.filter(i => i.issueType === 'governance_violation').length;
  
  const processRelatedIssues = formatIssues + invalidValueIssues;

  const decayScore = (issueCount: number) => 100 * Math.exp(-0.5 * issueCount / totalRecords);

  const peopleScore = Math.max(0, decayScore(missingFieldIssues));
  const processScore = Math.max(0, decayScore(processRelatedIssues));
  const governanceScore = Math.max(0, decayScore(governanceIssues) - (criticalIssues / totalRecords * 10));
  
  const overallScore = (peopleScore * 0.3 + processScore * 0.3 + governanceScore * 0.4);
  
  return {
    peopleScore: Math.round(peopleScore * 10) / 10,
    processScore: Math.round(processScore * 10) / 10,
    governanceScore: Math.round(governanceScore * 10) / 10,
    overallScore: Math.round(overallScore * 10) / 10,
  };
}

export async function updateCRMProviderRecordNotes(
  module: string,
  recordId: string,
  noteContent: string
): Promise<boolean> {
  markInteractiveCRMProviderActivity();
  logger.info(`📝 [CRMProviderCRM] Adding note to ${module}/${recordId}`);
  
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/${recordId}/Notes`;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          <REDACTED_SCHEME> [{
            Note_Title: 'SDR Call Quality Evaluation',
            Note_Content: noteContent
          }]
        })
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        logger.error('❌ [CRMProviderCRM] Failed to add note', { error });
        throw new Error(`CRMProvider API error: ${response.status} - ${error.message || response.statusText}`);
      }
      
      const data = await response.json();
      logger.info('✅ [CRMProviderCRM] Note added successfully');
      return true;
    }
  );
}

export async function updateCRMProviderRecord(
  module: string,
  recordId: string,
  updates: Record<string, any>
): Promise<any> {
  markInteractiveCRMProviderActivity();
  logger.info(`📝 [CRMProviderCRM] Updating ${module}/${recordId}`, { updatedFields: Object.keys(updates) });
  
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/${recordId}`;
      return fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          <REDACTED_SCHEME> [updates]
        })
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        logger.error('❌ [CRMProviderCRM] Failed to update record', { error });
        throw new Error(`CRMProvider API error: ${response.status} - ${error.message || response.statusText}`);
      }

      const data = await response.json();
      // CRITICAL: CRMProvider's v2 write API returns HTTP 200 even when the PER-RECORD
      // operation FAILED — the real outcome is in data[0].code/status. Without
      // this check a rejected update (DUPLICATE_DATA, INVALID_DATA, a validation
      // rule, MANDATORY_NOT_FOUND, …) was reported as "Executed successfully"
      // while NOTHING changed in CRMProvider. Surface the real CRMProvider reason instead.
      const rec = data?.data?.[0];
      const ok =
        rec &&
        (rec.code === 'SUCCESS' ||
          (typeof rec.status === 'string' && rec.status.toLowerCase() === 'success'));
      if (rec && !ok) {
        const apiName = rec?.details?.api_name ? ` [field: ${rec.details.api_name}]` : '';
        const msg = `CRMProvider rejected the update: ${rec.code || 'ERROR'} — ${rec.message || 'no message'}${apiName}`;
        logger.error('❌ [CRMProviderCRM] CRMProvider rejected record update', { rec });
        throw new Error(msg);
      }
      logger.info('✅ [CRMProviderCRM] Record updated successfully');
      return rec || data;
    }
  );
}

export async function createCRMProviderRecord(
  module: string,
  recordData: Record<string, any>
): Promise<any> {
  markInteractiveCRMProviderActivity();
  logger.info(`➕ [CRMProviderCRM] Creating record in ${module}`, { fields: Object.keys(recordData) });

  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}`;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          <REDACTED_SCHEME> [recordData]
        })
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        logger.error('❌ [CRMProviderCRM] Failed to create record', { error });
        throw new Error(`CRMProvider API error: ${response.status} - ${error.message || response.statusText}`);
      }

      const data = await response.json();
      // Same per-record guard as updateCRMProviderRecord: CRMProvider returns HTTP 200/201
      // even when the create was rejected (DUPLICATE_DATA, INVALID_DATA, …).
      const rec = data?.data?.[0];
      const ok =
        rec &&
        (rec.code === 'SUCCESS' ||
          (typeof rec.status === 'string' && rec.status.toLowerCase() === 'success'));
      if (rec && !ok) {
        const apiName = rec?.details?.api_name ? ` [field: ${rec.details.api_name}]` : '';
        const msg = `CRMProvider rejected the create: ${rec.code || 'ERROR'} — ${rec.message || 'no message'}${apiName}`;
        logger.error('❌ [CRMProviderCRM] CRMProvider rejected record create', { rec });
        throw new Error(msg);
      }
      logger.info('✅ [CRMProviderCRM] Record created successfully');
      return rec?.details || rec || data;
    }
  );
}

export interface BulkCreateOutcome {
  index: number; // input index
  status: 'success' | 'error';
  id?: string;
  code?: string;
  message?: string;
  details?: any;
}

/**
 * Bulk create records in a CRMProvider module. CRMProvider's POST /crm/v2/<module>
 * accepts up to 100 records in a single payload — this helper chunks a
 * larger input into 100-record batches and concatenates the per-record
 * outcomes so the caller sees one outcome per input row.
 *
 * Partial success is fine: CRMProvider returns 207 (multi-status) when some
 * rows succeed and some fail; the outcomes array carries per-row
 * status. We do NOT throw on a partial batch — the caller decides
 * whether to retry the failures.
 */
export async function createCRMProviderRecordsBulk(
  module: string,
  records: Array<Record<string, any>>,
): Promise<BulkCreateOutcome[]> {
  markInteractiveCRMProviderActivity();
  if (records.length === 0) return [];
  const BATCH = 100;
  const outcomes: BulkCreateOutcome[] = [];
  for (let start = 0; start < records.length; start += BATCH) {
    const chunk = records.slice(start, start + BATCH);
    logger.info(
      `➕ [CRMProviderCRM] Bulk creating ${chunk.length} ${module} (offset ${start}/${records.length})`,
    );
    try {
      const <REDACTED_SCHEME> any = await makeCRMProviderRequest(
        async (config) => {
          const url = `${config.apiDomain}/crm/v2/${module}`;
          return fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `CRMProvider-oauthtoken ${config.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ <REDACTED_SCHEME> chunk }),
          });
        },
        async (response) => {
          // CRMProvider returns 200 (all success), 201 (created), 207 (partial),
          // or non-2xx on a full failure. Parse the body regardless so
          // we capture per-row outcomes from the data[] array.
          const body = await response.json().catch(() => ({}));
          if (!response.ok && response.status !== 207) {
            throw new Error(
              `CRMProvider bulk create error: ${response.status} - ${body?.message || response.statusText}`,
            );
          }
          return body;
        },
      );
      const rows: any[] = Array.isArray(data?.data) ? data.data : [];
      for (let i = 0; i < chunk.length; i++) {
        const r = rows[i] || {};
        if (r.status === 'success') {
          outcomes.push({
            index: start + i,
            status: 'success',
            id: r.details?.id ?? undefined,
            code: r.code,
            message: r.message,
            details: r.details,
          });
        } else {
          outcomes.push({
            index: start + i,
            status: 'error',
            code: r.code || 'UNKNOWN',
            message: r.message || 'Failed',
            details: r.details,
          });
        }
      }
    } catch (e: any) {
      // Entire batch failed (network / auth / rate-limit). Mark every
      // row in the chunk as errored so the caller can retry.
      for (let i = 0; i < chunk.length; i++) {
        outcomes.push({
          index: start + i,
          status: 'error',
          code: 'BATCH_ERROR',
          message: e?.message || String(e),
        });
      }
    }
  }
  return outcomes;
}

/**
 * Fetch the layouts available on a CRMProvider module — used by the
 * Preflight Push-to-CRMProvider picker so the operator chooses where new
 * Leads land. Returns just the operator-facing fields (id, name,
 * status).
 */
export interface CRMProviderLayout {
  id: string;
  name: string;
  status: number | null;
}
export async function fetchCRMProviderLayouts(module: string): Promise<CRMProviderLayout[]> {
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/settings/layouts?module=${encodeURIComponent(module)}`;
      return fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(
          `CRMProvider Layouts API error: ${response.status} - ${error.message || response.statusText}`,
        );
      }
      if (response.status === 204) return [];
      const text = await response.text();
      if (!text || !text.trim()) return [];
      const data = JSON.parse(text);
      return (data.layouts || []).map((l: any) => ({
        id: String(l.id || ''),
        name: l.name || '(unnamed)',
        status: typeof l.status === 'number' ? l.status : null,
      }));
    },
  );
}

/** Fetch a module's field metadata — the AUTHORITATIVE api_name + required flag
 * for every field. Used to confirm exactly which fields the Preflight push must
 * fill (and their real api_names) instead of guessing from labels. */
export interface CRMProviderFieldMeta { api_name: string; label: string; required: boolean; data_type: string; }
export async function fetchCRMProviderFields(module: string): Promise<CRMProviderFieldMeta[]> {
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/settings/fields?module=${encodeURIComponent(module)}`;
      return fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`CRMProvider Fields API error: ${response.status} - ${error.message || response.statusText}`);
      }
      if (response.status === 204) return [];
      const text = await response.text();
      if (!text || !text.trim()) return [];
      const data = JSON.parse(text);
      return (data.fields || []).map((f: any) => ({
        api_name: String(f.api_name || ''),
        label: String(f.field_label || f.display_label || ''),
        required: !!(f.system_mandatory || f.required),
        data_type: String(f.data_type || ''),
      }));
    },
  );
}

export interface CRMProviderUser {
  id: string;
  full_name: string;
  email: string;
  status: string;
  role: string;
  profile: string;
}

/**
 * Fetch all active + inactive users from CRMProvider CRM.
 * Used by getUsers() to bridge CRM record Owner IDs (numeric CRMProvider IDs) to
 * the seed roster (keyed by display name). Seed wins on team/status/modules;
 * CRMProvider fills in any owners not yet on the seed.
 */
export async function fetchCRMProviderUsers(type: 'AllUsers' | 'ActiveUsers' | 'DeactiveUsers' = 'AllUsers'): Promise<CRMProviderUser[]> {
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/users?type=${type}&per_page=200`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`CRMProvider Users API error: ${response.status} - ${error.message || response.statusText}`);
      }
      if (response.status === 204) return [];
      const text = await response.text();
      if (!text || !text.trim()) return [];
      const data = JSON.parse(text);
      return (data.users || []).map((u: any) => ({
        id: String(u.id || ''),
        full_name: u.full_name || `${u.first_name || ''} ${u.last_name || ''}`.trim(),
        email: u.email || '',
        status: u.status || 'active',
        role: u.role?.name || '',
        profile: u.profile?.name || '',
      }));
    }
  );
}

export async function deleteCRMProviderRecord(
  module: string,
  recordId: string
): Promise<boolean> {
  markInteractiveCRMProviderActivity();
  logger.info(`🗑️ [CRMProviderCRM] Deleting ${module}/${recordId}`);
  
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/${recordId}`;
      return fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
        },
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        logger.error('❌ [CRMProviderCRM] Failed to delete record', { error });
        throw new Error(`CRMProvider API error: ${response.status} - ${error.message || response.statusText}`);
      }
      
      logger.info('✅ [CRMProviderCRM] Record deleted successfully');
      return true;
    }
  );
}

/**
 * Apply one or more existing tags to one or more records (CRMProvider v2
 * `actions/add_tags`). Runs under module write/update scope. The tag's COLOUR
 * is a one-time admin setup on the tag definition (Setup → Tags); this only
 * applies an existing tag by name. Used by the agentic duplicate resolver to
 * flag duplicates with `Duplicate-Delete` for the CRMProvider admin to remove.
 * Returns CRMProvider's per-record result array.
 */
export async function addCRMProviderTags(
  module: string,
  recordIds: string[],
  tagNames: string[],
): Promise<any> {
  markInteractiveCRMProviderActivity();
  const ids = recordIds.filter(Boolean).join(',');
  const tags = tagNames.filter(Boolean).map(encodeURIComponent).join(',');
  logger.info(`🏷️ [CRMProviderCRM] Adding tags [${tagNames.join(', ')}] to ${recordIds.length} ${module} record(s)`);
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/actions/add_tags?ids=${ids}&tag_names=${tags}`;
      return fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `CRMProvider-oauthtoken ${config.accessToken}` },
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        logger.error('❌ [CRMProviderCRM] Failed to add tags', { error });
        throw new Error(`CRMProvider add_tags error: ${response.status} - ${error.message || response.statusText}`);
      }
      const data = await response.json().catch(() => ({}));
      logger.info('✅ [CRMProviderCRM] Tags added');
      return data.data || data;
    },
  );
}

/** Associate contacts to a Deal's Contact Roles related list (CRMProvider v2:
 * PUT /Deals/{dealId}/Contact_Roles/{contactId}). `role` is optional — when
 * omitted we send a role-less association (matches a manually-added blank
 * Role Name). Best-effort per contact: one failure doesn't abort the rest.
 * Used by the Preflight push so ALL of a company's contacts appear under the
 * created Deal's Contact Roles (the primary is also the Deal's Contact_Name). */
export async function addDealContactRoles(
  dealId: string,
  contactIds: string[],
  role?: string | null,
): Promise<{ associated: number; failed: number }> {
  let associated = 0;
  let failed = 0;
  for (const cid of contactIds.filter(Boolean)) {
    try {
      await makeCRMProviderRequest(
        async (config) => {
          const url = `${config.apiDomain}/crm/v2/Deals/${encodeURIComponent(dealId)}/Contact_Roles/${encodeURIComponent(cid)}`;
          return fetch(url, {
            method: 'PUT',
            headers: {
              'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ <REDACTED_SCHEME> [role ? { Contact_Role: role } : {}] }),
          });
        },
        async (response) => {
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(`CRMProvider contact-role error: ${response.status} - ${error.message || response.statusText}`);
          }
          return response.json().catch(() => ({}));
        },
      );
      associated++;
    } catch (_e) {
      failed++;
      logger.warn(`⚠️ [CRMProviderCRM] contact-role associate failed: deal=${dealId} contact=${cid}`);
    }
  }
  logger.info(`🔗 [CRMProviderCRM] Deal ${dealId}: ${associated} contact role(s) associated, ${failed} failed`);
  return { associated, failed };
}

/** Remove tags from records (CRMProvider v2 `actions/remove_tags`) — rollback for addCRMProviderTags. */
export async function removeCRMProviderTags(
  module: string,
  recordIds: string[],
  tagNames: string[],
): Promise<any> {
  markInteractiveCRMProviderActivity();
  const ids = recordIds.filter(Boolean).join(',');
  const tags = tagNames.filter(Boolean).map(encodeURIComponent).join(',');
  logger.info(`🏷️ [CRMProviderCRM] Removing tags [${tagNames.join(', ')}] from ${recordIds.length} ${module} record(s)`);
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/actions/remove_tags?ids=${ids}&tag_names=${tags}`;
      return fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `CRMProvider-oauthtoken ${config.accessToken}` },
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        logger.error('❌ [CRMProviderCRM] Failed to remove tags', { error });
        throw new Error(`CRMProvider remove_tags error: ${response.status} - ${error.message || response.statusText}`);
      }
      const data = await response.json().catch(() => ({}));
      return data.data || data;
    },
  );
}

/**
 * Create a Note attached to a parent record (generic version of
 * updateCRMProviderRecordNotes). Used to (a) stamp audit context on records and
 * (b) copy a duplicate's notes onto the surviving master during reparenting
 * (CRMProvider v2 cannot move a note's parent, so we re-create it).
 */
export async function addCRMProviderNote(
  module: string,
  recordId: string,
  title: string,
  content: string,
): Promise<boolean> {
  return makeCRMProviderRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/${recordId}/Notes`;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `CRMProvider-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          <REDACTED_SCHEME> [{ Note_Title: title.slice(0, 120), Note_Content: content }],
        }),
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        logger.error('❌ [CRMProviderCRM] Failed to add note', { error });
        throw new Error(`CRMProvider note error: ${response.status} - ${error.message || response.statusText}`);
      }
      return true;
    },
  );
}
