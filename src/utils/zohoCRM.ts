import { z } from "zod";

export const ZohoCRMRecordSchema = z.object({
  id: z.string(),
  module: z.string(),
  owner: z.string().optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  data: z.record(z.any()),
});

export type ZohoCRMRecord = z.infer<typeof ZohoCRMRecordSchema>;

export interface ZohoAPIConfig {
  accessToken: string;
  apiDomain: string;
}

export interface ZohoOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
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

function getZohoOAuthConfig(): ZohoOAuthConfig | null {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const accountsUrl = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
  
  if (clientId && clientSecret && refreshToken) {
    return { clientId, clientSecret, refreshToken, accountsUrl };
  }
  return null;
}

async function refreshAccessToken(): Promise<string> {
  const oauthConfig = getZohoOAuthConfig();
  
  if (!oauthConfig) {
    throw new Error('CRM integration not configured. Please contact your administrator.');
  }
  
  console.log('🔄 [ZohoCRM] Refreshing access token...');
  
  const params = new URLSearchParams({
    refresh_token: oauthConfig.refreshToken,
    client_id: oauthConfig.clientId,
    client_secret: oauthConfig.clientSecret,
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
    console.error('❌ [ZohoCRM] Token refresh failed:', errorText);
    throw new Error(`Failed to refresh Zoho access token: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  if (data.error) {
    console.error('❌ [ZohoCRM] Token refresh error:', data.error);
    throw new Error(`Zoho token refresh error: ${data.error}`);
  }
  
  if (!data.access_token) {
    throw new Error('No access_token in Zoho refresh response');
  }
  
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 300) * 1000;
  
  console.log('✅ [ZohoCRM] Access token refreshed successfully, expires in', data.expires_in, 'seconds');
  
  return data.access_token;
}

function isTokenExpired(): boolean {
  return Date.now() >= tokenExpiresAt;
}

async function getValidAccessToken(): Promise<string> {
  const oauthConfig = getZohoOAuthConfig();
  
  if (oauthConfig) {
    if (cachedAccessToken && !isTokenExpired()) {
      return cachedAccessToken;
    }
    if (pendingRefresh) {
      return await pendingRefresh;
    }
    const now = Date.now();
    if (now - lastRefreshAttempt < MIN_REFRESH_INTERVAL_MS) {
      if (cachedAccessToken) return cachedAccessToken;
      await new Promise(r => setTimeout(r, MIN_REFRESH_INTERVAL_MS - (now - lastRefreshAttempt)));
    }
    lastRefreshAttempt = Date.now();
    pendingRefresh = refreshAccessToken().finally(() => { pendingRefresh = null; });
    return await pendingRefresh;
  }
  
  const staticToken = process.env.ZOHO_ACCESS_TOKEN;
  if (staticToken) {
    console.log('⚠️ [ZohoCRM] Using static ZOHO_ACCESS_TOKEN (no auto-refresh configured)');
    return staticToken;
  }
  
  throw new Error('CRM integration not configured. Please contact your administrator.');
}

async function getZohoAccessToken(): Promise<ZohoAPIConfig> {
  const accessToken = await getValidAccessToken();
  const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
  
  return { accessToken, apiDomain };
}

async function makeZohoRequest<T>(
  requestFn: (config: ZohoAPIConfig) => Promise<Response>,
  parseResponse: (response: Response) => Promise<T>
): Promise<T> {
  let config = await getZohoAccessToken();
  let response = await requestFn(config);
  
  if (response.status === 401) {
    console.log('🔄 [ZohoCRM] Access token expired (401), attempting refresh...');
    
    cachedAccessToken = null;
    tokenExpiresAt = 0;
    
    const oauthConfig = getZohoOAuthConfig();
    if (oauthConfig) {
      await refreshAccessToken();
      config = await getZohoAccessToken();
      response = await requestFn(config);
      
      if (response.status === 401) {
        throw new Error('Zoho API authentication failed after token refresh. Please verify your OAuth credentials.');
      }
    } else {
      throw new Error('CRM authentication failed. Please contact your administrator.');
    }
  }
  
  return parseResponse(response);
}

export function getZohoConnectionStatus(): {
  configured: boolean;
  autoRefresh: boolean;
  tokenCached: boolean;
  tokenExpired: boolean;
  message: string;
} {
  const oauthConfig = getZohoOAuthConfig();
  const hasStaticToken = !!process.env.ZOHO_ACCESS_TOKEN;
  
  if (oauthConfig) {
    return {
      configured: true,
      autoRefresh: true,
      tokenCached: !!cachedAccessToken,
      tokenExpired: isTokenExpired(),
      message: 'Zoho CRM configured with OAuth auto-refresh',
    };
  }
  
  if (hasStaticToken) {
    return {
      configured: true,
      autoRefresh: false,
      tokenCached: false,
      tokenExpired: false,
      message: 'Zoho CRM configured with static token (no auto-refresh)',
    };
  }
  
  return {
    configured: false,
    autoRefresh: false,
    tokenCached: false,
    tokenExpired: false,
    message: 'CRM integration not configured. Please contact your administrator.',
  };
}

export async function fetchZohoRecords(
  module: string,
  params: {
    page?: number;
    perPage?: number;
    fields?: string[];
    criteria?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  } = {}
): Promise<ZohoCRMRecord[]> {
  const queryParams = new URLSearchParams();
  if (params.page) queryParams.set('page', params.page.toString());
  if (params.perPage) queryParams.set('per_page', params.perPage.toString());
  if (params.fields?.length) queryParams.set('fields', params.fields.join(','));
  if (params.criteria) queryParams.set('criteria', params.criteria);
  if (params.sortBy) queryParams.set('sort_by', params.sortBy);
  if (params.sortOrder) queryParams.set('sort_order', params.sortOrder);
  
  return makeZohoRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}?${queryParams.toString()}`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`Zoho CRM API error: ${response.status} - ${error.message || response.statusText}`);
      }
      // Zoho returns 204 (No Content) or sometimes an empty 200 body when the
      // requested page is past the last page of results. Treat any empty/
      // unparseable body as "no records" instead of crashing on JSON.parse.
      if (response.status === 204) return [];
      const text = await response.text();
      if (!text || !text.trim()) return [];
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        console.warn(`⚠️ [ZohoCRM] Non-JSON response on ${module} (status ${response.status}); treating as empty page`);
        return [];
      }
      
      return (data.data || []).map((record: any) => ({
        id: record.id,
        module,
        owner: record.Owner?.name || record.Owner?.id,
        createdTime: record.Created_Time,
        modifiedTime: record.Modified_Time,
        data: record,
      }));
    }
  );
}

export async function fetchAllZohoRecords(
  module: string,
  params: {
    fields?: string[];
    criteria?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    maxRecords?: number;
  } = {}
): Promise<ZohoCRMRecord[]> {
  const allRecords: ZohoCRMRecord[] = [];
  const perPage = 200;
  let page = 1;
  let hasMore = true;
  const maxRecords = params.maxRecords || Infinity;
  
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  
  // PERF: pages are now fetched in parallel batches of CONCURRENCY. With ~30k
  // records (~150 pages) this drops cold fetches from ~40s to ~10s. Each batch
  // stops the loop early if any page returns < perPage records (last page) or
  // 0 records (overshoot). Order is preserved because we slice by page index.
  console.log(`📊 [ZohoCRM] Fetching all ${module} records with parallel pagination...`);
  const CONCURRENCY = 4;

  const fetchPageWithRetry = async (pageNum: number): Promise<ZohoCRMRecord[]> => {
    let retries = 0;
    const maxRetries = 3;
    while (true) {
      try {
        return await fetchZohoRecords(module, {
          page: pageNum,
          perPage,
          fields: params.fields,
          criteria: params.criteria,
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
        });
      } catch (error: any) {
        if (error.message?.includes('204') || error.message?.includes('No Content')) {
          return [];
        }
        if (error.message?.includes('429') || error.status === 429 || error.message?.includes('rate limit') || error.message?.includes('Too Many')) {
          retries++;
          if (retries > maxRetries) {
            console.error(`❌ [ZohoCRM] Rate limit exceeded after ${maxRetries} retries for ${module} page ${pageNum}`);
            throw error;
          }
          const backoffMs = retries * 5000;
          console.warn(`⚠️ [ZohoCRM] Rate limited (429) on ${module} page ${pageNum}, retry ${retries}/${maxRetries} in ${backoffMs/1000}s`);
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
      console.log(`📊 [ZohoCRM] Fetched page ${pageNum}: ${records.length} records (total: ${allRecords.length})`);
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
    if (hasMore) await sleep(150);
  }

  if (allRecords.length > maxRecords) allRecords.length = maxRecords;
  console.log(`✅ [ZohoCRM] Total ${module} records fetched: ${allRecords.length}`);
  return allRecords;
}

// Records that Zoho has deleted, recycled, or merged. type=all covers
// recycle-bin, permanent deletions, AND merges (returns type='merged' with
// merged_into.id). This is the only way to detect a Zoho-side merge: a
// Modified_Time filter never returns deleted records, so the duplicate radar
// would otherwise keep showing the "ghost" of the merged-away record forever.
export interface ZohoDeletedRecord {
  id: string;
  type: 'recycle' | 'permanent' | 'merged' | string;
  displayName?: string;
  deletedTime?: string;
  mergedIntoId?: string;
}

export async function fetchDeletedZohoRecords(
  module: string,
  params: {
    type?: 'all' | 'recycle' | 'permanent';
    modifiedSince?: Date | string;
    maxRecords?: number;
  } = {}
): Promise<ZohoDeletedRecord[]> {
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

  const all: ZohoDeletedRecord[] = [];
  let page = 1;
  let hasMore = true;

  console.log(
    `🗑️ [ZohoCRM] Fetching deleted ${module} records (type=${type}` +
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

        const response = await makeZohoRequest(
          async (config) => {
            const url = `${config.apiDomain}/crm/v2/${module}/deleted?${queryParams.toString()}`;
            const headers: Record<string, string> = {
              'Authorization': `Zoho-oauthtoken ${config.accessToken}`,
              'Content-Type': 'application/json',
            };
            if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;
            return fetch(url, { method: 'GET', headers });
          },
          async (res) => {
            // 204 / 304 = nothing deleted in window
            if (res.status === 204 || res.status === 304) return { data: [], info: null };
            if (!res.ok) {
              const errBody = await res.json().catch(() => ({}));
              throw new Error(
                `Zoho deleted API error: ${res.status} - ${errBody.message || res.statusText}`,
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

  console.log(`✅ [ZohoCRM] Found ${all.length} deleted/merged ${module} record(s)`);
  return all;
}

export async function searchZohoRecords(
  module: string,
  searchCriteria: string
): Promise<ZohoCRMRecord[]> {
  return makeZohoRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/search?criteria=${encodeURIComponent(searchCriteria)}`;
      return fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${config.accessToken}`,
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
        throw new Error(`Zoho CRM search error: ${response.status} - ${error.message || response.statusText}`);
      }
      
      const data = await response.json();
      
      return (data.data || []).map((record: any) => ({
        id: record.id,
        module,
        owner: record.Owner?.name || record.Owner?.id,
        createdTime: record.Created_Time,
        modifiedTime: record.Modified_Time,
        data: record,
      }));
    }
  );
}

export function analyzeRecordHygiene(
  record: ZohoCRMRecord,
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
  validator?: (value: any, record: ZohoCRMRecord) => boolean;
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
  { module: 'Deals', fieldName: 'Amount', ruleType: 'required', description: 'Deal must have an amount', severity: 'high' },
  { module: 'Deals', fieldName: 'Closing_Date', ruleType: 'required', description: 'Deal must have a closing date', severity: 'high' },
  { module: 'Deals', fieldName: 'Account_Name', ruleType: 'required', description: 'Deal must be linked to an Account', severity: 'high' },
  { module: 'Deals', fieldName: 'Contact_Name', ruleType: 'required', description: 'Deal must have a Contact linked', severity: 'high' },
  { module: 'Deals', fieldName: 'Pipeline', ruleType: 'required', description: 'Deal must have a pipeline assigned', severity: 'medium' },
  { module: 'Deals', fieldName: 'Lead_Source', ruleType: 'required', description: 'Deal must have a lead source', severity: 'medium' },
  { module: 'Deals', fieldName: 'No_of_Employees', ruleType: 'required', description: 'Deal must have number of employees for qualification', severity: 'high' },
  { module: 'Deals', fieldName: 'Region', ruleType: 'required', description: 'Deal must have a region per qualification criteria', severity: 'medium' },
  { module: 'Deals', fieldName: 'Industry', ruleType: 'required', description: 'Deal must have an industry classification', severity: 'medium' },
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
      const freeProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'aol.com', 'icloud.com', 'mail.com'];
      return !freeProviders.includes(domain);
    },
    description: 'Business email is required — free email provider detected (SDR SOP rule)', severity: 'medium',
    suggestedFix: 'Request a company/business email address from the lead' },
  { module: 'Leads', fieldName: 'Phone', ruleType: 'required', description: 'Lead must have a phone number', severity: 'high' },
  { module: 'Leads', fieldName: 'Phone', ruleType: 'format', pattern: '^\\+966',
    description: 'Phone must have KSA country code (+966) per SDR SOP', severity: 'medium',
    suggestedFix: 'Update the phone number to include KSA country code +966' },
  { module: 'Leads', fieldName: 'Lead_Source', ruleType: 'required', description: 'Lead must have a source', severity: 'medium' },
  { module: 'Leads', fieldName: 'Lead_Source', ruleType: 'enum',
    allowedValues: ['Website', 'LinkedIn', 'Referral', 'Event', 'Partner', 'Cold Call', 'Outbound', 'Inbound', 'Social Media', 'Google Ads', 'Other'],
    description: 'Lead Source must be a valid SOP-defined value', severity: 'medium' },
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
  { module: 'Leads', fieldName: 'Description', ruleType: 'required',
    stageCondition: ['Contacted', 'Contacting', 'Qualified', 'Not Qualified', 'On Hold', 'Converted', 'Nurturing'],
    stageField: 'Lead_Status',
    description: 'Notes/Description required from Contacting stage for qualification trail (SDR SOP)', severity: 'medium' },

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
  //  TASKS
  // ═══════════════════════════════════════════════════════════
  { module: 'Tasks', fieldName: 'Subject', ruleType: 'required', description: 'Task must have a subject', severity: 'high' },
  { module: 'Tasks', fieldName: 'Due_Date', ruleType: 'required', description: 'Task must have a due date', severity: 'medium' },
  { module: 'Tasks', fieldName: 'Status', ruleType: 'required', description: 'Task must have a status', severity: 'medium' },
  { module: 'Tasks', fieldName: 'Priority', ruleType: 'required', description: 'Task must have a priority assigned', severity: 'low' },

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
      const freeProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
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

export async function updateZohoRecordNotes(
  module: string,
  recordId: string,
  noteContent: string
): Promise<boolean> {
  console.log(`📝 [ZohoCRM] Adding note to ${module}/${recordId}`);
  
  return makeZohoRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/${recordId}/Notes`;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Zoho-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: [{
            Note_Title: 'SDR Call Quality Evaluation',
            Note_Content: noteContent
          }]
        })
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error('❌ [ZohoCRM] Failed to add note:', error);
        throw new Error(`Zoho API error: ${response.status} - ${error.message || response.statusText}`);
      }
      
      const data = await response.json();
      console.log('✅ [ZohoCRM] Note added successfully');
      return true;
    }
  );
}

export async function updateZohoRecord(
  module: string,
  recordId: string,
  updates: Record<string, any>
): Promise<any> {
  console.log(`📝 [ZohoCRM] Updating ${module}/${recordId}`, Object.keys(updates));
  
  return makeZohoRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/${recordId}`;
      return fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Zoho-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: [updates]
        })
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error('❌ [ZohoCRM] Failed to update record:', error);
        throw new Error(`Zoho API error: ${response.status} - ${error.message || response.statusText}`);
      }
      
      const data = await response.json();
      console.log('✅ [ZohoCRM] Record updated successfully');
      return data.data?.[0] || data;
    }
  );
}

export async function createZohoRecord(
  module: string,
  recordData: Record<string, any>
): Promise<any> {
  console.log(`➕ [ZohoCRM] Creating record in ${module}`, Object.keys(recordData));
  
  return makeZohoRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}`;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Zoho-oauthtoken ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: [recordData]
        })
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error('❌ [ZohoCRM] Failed to create record:', error);
        throw new Error(`Zoho API error: ${response.status} - ${error.message || response.statusText}`);
      }
      
      const data = await response.json();
      console.log('✅ [ZohoCRM] Record created successfully');
      return data.data?.[0]?.details || data.data?.[0] || data;
    }
  );
}

export async function deleteZohoRecord(
  module: string,
  recordId: string
): Promise<boolean> {
  console.log(`🗑️ [ZohoCRM] Deleting ${module}/${recordId}`);
  
  return makeZohoRequest(
    async (config) => {
      const url = `${config.apiDomain}/crm/v2/${module}/${recordId}`;
      return fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Zoho-oauthtoken ${config.accessToken}`,
        },
      });
    },
    async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error('❌ [ZohoCRM] Failed to delete record:', error);
        throw new Error(`Zoho API error: ${response.status} - ${error.message || response.statusText}`);
      }
      
      console.log('✅ [ZohoCRM] Record deleted successfully');
      return true;
    }
  );
}
