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
    throw new Error(
      'Zoho OAuth credentials not configured. Please set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN secrets.'
    );
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
    return await refreshAccessToken();
  }
  
  const staticToken = process.env.ZOHO_ACCESS_TOKEN;
  if (staticToken) {
    console.log('⚠️ [ZohoCRM] Using static ZOHO_ACCESS_TOKEN (no auto-refresh configured)');
    return staticToken;
  }
  
  throw new Error(
    'Zoho CRM not configured. Please set either:\n' +
    '1. ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN for automatic token refresh, or\n' +
    '2. ZOHO_ACCESS_TOKEN for a static token (will expire and need manual renewal)'
  );
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
      throw new Error('Zoho access token expired. Please update ZOHO_ACCESS_TOKEN or configure OAuth with ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN.');
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
    message: 'Zoho CRM not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN for auto-refresh.',
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
  const maxRecords = params.maxRecords || 10000;
  
  console.log(`📊 [ZohoCRM] Fetching all ${module} records with pagination...`);
  
  while (hasMore && allRecords.length < maxRecords) {
    try {
      const records = await fetchZohoRecords(module, {
        page,
        perPage,
        fields: params.fields,
        criteria: params.criteria,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
      });
      
      if (records.length === 0) {
        hasMore = false;
      } else {
        allRecords.push(...records);
        console.log(`📊 [ZohoCRM] Fetched page ${page}: ${records.length} records (total: ${allRecords.length})`);
        
        if (records.length < perPage) {
          hasMore = false;
        } else {
          page++;
        }
      }
    } catch (error: any) {
      if (error.message?.includes('204') || error.message?.includes('No Content')) {
        hasMore = false;
      } else {
        throw error;
      }
    }
  }
  
  console.log(`✅ [ZohoCRM] Total ${module} records fetched: ${allRecords.length}`);
  return allRecords;
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
}

export const DEFAULT_GOVERNANCE_RULES: GovernanceRule[] = [
  {
    module: 'Leads',
    fieldName: 'Email',
    ruleType: 'required',
    description: 'Lead must have an email address',
    severity: 'high',
  },
  {
    module: 'Leads',
    fieldName: 'Email',
    ruleType: 'format',
    pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    description: 'Email must be in valid format',
    severity: 'medium',
  },
  {
    module: 'Leads',
    fieldName: 'Phone',
    ruleType: 'format',
    pattern: '^[+]?[\\d\\s\\-()]+$',
    description: 'Phone number must be in valid format',
    severity: 'low',
  },
  {
    module: 'Leads',
    fieldName: 'Lead_Source',
    ruleType: 'required',
    description: 'Lead must have a source',
    severity: 'medium',
  },
  {
    module: 'Leads',
    fieldName: 'Lead_Status',
    ruleType: 'required',
    description: 'Lead must have a status',
    severity: 'high',
  },
  {
    module: 'Deals',
    fieldName: 'Deal_Name',
    ruleType: 'required',
    description: 'Deal must have a name',
    severity: 'critical',
  },
  {
    module: 'Deals',
    fieldName: 'Stage',
    ruleType: 'required',
    description: 'Deal must have a stage',
    severity: 'critical',
  },
  {
    module: 'Deals',
    fieldName: 'Amount',
    ruleType: 'required',
    description: 'Deal must have an amount',
    severity: 'high',
  },
  {
    module: 'Deals',
    fieldName: 'Closing_Date',
    ruleType: 'required',
    description: 'Deal must have a closing date',
    severity: 'high',
  },
  {
    module: 'Contacts',
    fieldName: 'Email',
    ruleType: 'required',
    description: 'Contact must have an email address',
    severity: 'high',
  },
  {
    module: 'Contacts',
    fieldName: 'Last_Name',
    ruleType: 'required',
    description: 'Contact must have a last name',
    severity: 'critical',
  },
  {
    module: 'Tasks',
    fieldName: 'Subject',
    ruleType: 'required',
    description: 'Task must have a subject',
    severity: 'high',
  },
  {
    module: 'Tasks',
    fieldName: 'Due_Date',
    ruleType: 'required',
    description: 'Task must have a due date',
    severity: 'medium',
  },
  {
    module: '*',
    fieldName: 'Owner',
    ruleType: 'required',
    description: 'Record must have an owner',
    severity: 'high',
  },
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
  const governanceIssues = issues.filter(i => i.issueType === 'governance_violation').length;
  
  const peopleScore = Math.max(0, 100 - (missingFieldIssues / totalRecords * 50));
  const processScore = Math.max(0, 100 - (formatIssues / totalRecords * 50));
  const governanceScore = Math.max(0, 100 - (governanceIssues / totalRecords * 50) - (criticalIssues / totalRecords * 25));
  
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
