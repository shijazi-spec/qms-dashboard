import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export type DataMode = 'MOCK' | 'REAL';

const inMemoryLeads: Lead[] = [];
const inMemoryDeals: Deal[] = [];
let leadIdCounter = 100;
let dealIdCounter = 100;

export function getDataMode(): DataMode {
  const mode = process.env.DATA_MODE?.toUpperCase();
  return mode === 'REAL' ? 'REAL' : 'MOCK';
}

export function resetInMemoryData(): void {
  inMemoryLeads.length = 0;
  inMemoryDeals.length = 0;
  leadIdCounter = 100;
  dealIdCounter = 100;
}

function getMockDataPath(filename: string): string {
  const possiblePaths = [
    join(process.cwd(), 'mockdata', filename),
    join(process.cwd(), '..', 'mockdata', filename),
    `/home/runner/workspace/mockdata/${filename}`,
  ];
  
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }
  
  return possiblePaths[0];
}

function loadMockData<T>(filename: string): T {
  const path = getMockDataPath(filename);
  try {
    if (!existsSync(path)) {
      console.warn(`[MockData] File not found: ${filename} - returning empty data`);
      return getEmptyMockData(filename) as T;
    }
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.warn(`[MockData] Could not load ${filename} - returning empty data`);
    return getEmptyMockData(filename) as T;
  }
}

function getEmptyMockData(filename: string): any {
  const emptyMap: Record<string, any> = {
    'leads.json': { leads: [] },
    'deals.json': { deals: [] },
    'activities.json': { activities: [] },
    'users.json': { users: [] },
    'calendarEvents.json': { calendarEvents: [] },
    'five9Calls.json': { calls: [] },
  };
  return emptyMap[filename] || {};
}

export interface Lead {
  id: string;
  First_Name: string;
  Last_Name: string;
  Email: string;
  Phone: string;
  Company: string;
  Lead_Source: string;
  Lead_Status: string;
  Owner: string;
  Created_Time: string;
  Modified_Time: string;
  _hygiene_issue?: string;
}

export interface Deal {
  id: string;
  Deal_Name: string;
  Account_Name: string;
  Stage: string;
  Amount: number;
  Closing_Date: string;
  Owner: string;
  Lead_Source: string;
  Contact_Name: string;
  Created_Time: string;
  Modified_Time: string;
  _hygiene_issue?: string;
}

export interface Activity {
  id: string;
  Subject: string;
  Activity_Type: string;
  Related_To: string;
  Module: string;
  Owner: string;
  Due_Date: string;
  Status: string;
  Description: string;
  Created_Time: string;
  _hygiene_issue?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  team: string;
  status: string;
  created_at: string;
}

// Date range filtering interface
export interface DateRangeFilter {
  startDate: string;  // ISO date string (YYYY-MM-DD)
  endDate: string;    // ISO date string (YYYY-MM-DD)
}

// Separate date filters for created and modified dates
export interface SeparateDateFilters {
  created: { start: string | null; end: string | null };
  modified: { start: string | null; end: string | null };
}

// Coverage metrics interface
export interface AuditCoverageMetrics {
  totalRecordsInCRM: number;
  recordsInDateRange: number;
  recordsAudited: number;
  recordsExcluded: number;
  exclusionReason: string;
  dateRangeApplied: DateRangeFilter | null;
  separateFiltersApplied?: SeparateDateFilters;
}

// Helper function to check if a date is within a range
function isDateInRange(dateStr: string | undefined, start: string | null, end: string | null): boolean {
  // If no filter applied, match everything
  if (!start || !end) return true;
  
  // If filter applied but record has no date, exclude the record
  if (!dateStr || dateStr.trim() === '') {
    console.log(`📅 [DateFilter] Record excluded - missing date field`);
    return false;
  }
  
  const date = new Date(dateStr);
  // Check for invalid date
  if (isNaN(date.getTime())) {
    console.log(`📅 [DateFilter] Record excluded - invalid date: ${dateStr}`);
    return false;
  }
  
  const startDate = new Date(start);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(23, 59, 59, 999);
  
  const inRange = date >= startDate && date <= endDate;
  return inRange;
}

// Check if record matches separate date filters (AND logic between filters, if both specified)
export function isRecordInSeparateDateFilters(
  record: { Created_Time?: string; Modified_Time?: string },
  filters: SeparateDateFilters
): boolean {
  const hasCreatedFilter = filters.created.start && filters.created.end;
  const hasModifiedFilter = filters.modified.start && filters.modified.end;
  
  // No filters applied
  if (!hasCreatedFilter && !hasModifiedFilter) {
    return true;
  }
  
  // Check created date filter
  let createdMatch = true;
  if (hasCreatedFilter) {
    createdMatch = isDateInRange(record.Created_Time, filters.created.start, filters.created.end);
  }
  
  // Check modified date filter
  let modifiedMatch = true;
  if (hasModifiedFilter) {
    modifiedMatch = isDateInRange(record.Modified_Time, filters.modified.start, filters.modified.end);
  }
  
  // If both filters are set, use AND logic (record must match both)
  // If only one filter is set, only that filter applies
  if (hasCreatedFilter && hasModifiedFilter) {
    return createdMatch && modifiedMatch;
  } else if (hasCreatedFilter) {
    return createdMatch;
  } else {
    return modifiedMatch;
  }
}

// Legacy helper function for backward compatibility
export function isRecordInDateRange(
  record: { Created_Time?: string; Modified_Time?: string },
  dateRange: DateRangeFilter | null
): boolean {
  if (!dateRange || !dateRange.startDate || !dateRange.endDate) {
    return true;
  }

  const startDate = new Date(dateRange.startDate);
  startDate.setHours(0, 0, 0, 0);
  
  const endDate = new Date(dateRange.endDate);
  endDate.setHours(23, 59, 59, 999);

  const createdTime = record.Created_Time ? new Date(record.Created_Time) : null;
  const modifiedTime = record.Modified_Time ? new Date(record.Modified_Time) : null;

  const createdInRange = createdTime && createdTime >= startDate && createdTime <= endDate;
  const modifiedInRange = modifiedTime && modifiedTime >= startDate && modifiedTime <= endDate;

  return !!(createdInRange || modifiedInRange);
}

// Filter leads with separate created/modified date filters
export async function getLeadsWithSeparateFilters(filters: SeparateDateFilters): Promise<{
  leads: Lead[];
  coverage: AuditCoverageMetrics;
}> {
  const allLeads = await getLeads();
  const hasCreatedFilter = filters.created.start && filters.created.end;
  const hasModifiedFilter = filters.modified.start && filters.modified.end;
  
  if (!hasCreatedFilter && !hasModifiedFilter) {
    return {
      leads: allLeads,
      coverage: {
        totalRecordsInCRM: allLeads.length,
        recordsInDateRange: allLeads.length,
        recordsAudited: allLeads.length,
        recordsExcluded: 0,
        exclusionReason: 'No date filter applied',
        dateRangeApplied: null,
        separateFiltersApplied: filters
      }
    };
  }

  const filteredLeads = allLeads.filter(lead => isRecordInSeparateDateFilters(lead, filters));
  
  // Build exclusion reason
  const filterDesc: string[] = [];
  if (hasCreatedFilter) filterDesc.push(`Created: ${filters.created.start} to ${filters.created.end}`);
  if (hasModifiedFilter) filterDesc.push(`Modified: ${filters.modified.start} to ${filters.modified.end}`);
  
  return {
    leads: filteredLeads,
    coverage: {
      totalRecordsInCRM: allLeads.length,
      recordsInDateRange: filteredLeads.length,
      recordsAudited: filteredLeads.length,
      recordsExcluded: allLeads.length - filteredLeads.length,
      exclusionReason: `${allLeads.length - filteredLeads.length} records excluded (${filterDesc.join(', ')})`,
      dateRangeApplied: null,
      separateFiltersApplied: filters
    }
  };
}

// Filter deals with separate created/modified date filters
export async function getDealsWithSeparateFilters(filters: SeparateDateFilters): Promise<{
  deals: Deal[];
  coverage: AuditCoverageMetrics;
}> {
  const allDeals = await getDeals();
  const hasCreatedFilter = filters.created.start && filters.created.end;
  const hasModifiedFilter = filters.modified.start && filters.modified.end;
  
  if (!hasCreatedFilter && !hasModifiedFilter) {
    return {
      deals: allDeals,
      coverage: {
        totalRecordsInCRM: allDeals.length,
        recordsInDateRange: allDeals.length,
        recordsAudited: allDeals.length,
        recordsExcluded: 0,
        exclusionReason: 'No date filter applied',
        dateRangeApplied: null,
        separateFiltersApplied: filters
      }
    };
  }

  const filteredDeals = allDeals.filter(deal => isRecordInSeparateDateFilters(deal, filters));
  
  // Build exclusion reason
  const filterDesc: string[] = [];
  if (hasCreatedFilter) filterDesc.push(`Created: ${filters.created.start} to ${filters.created.end}`);
  if (hasModifiedFilter) filterDesc.push(`Modified: ${filters.modified.start} to ${filters.modified.end}`);
  
  return {
    deals: filteredDeals,
    coverage: {
      totalRecordsInCRM: allDeals.length,
      recordsInDateRange: filteredDeals.length,
      recordsAudited: filteredDeals.length,
      recordsExcluded: allDeals.length - filteredDeals.length,
      exclusionReason: `${allDeals.length - filteredDeals.length} records excluded (${filterDesc.join(', ')})`,
      dateRangeApplied: null,
      separateFiltersApplied: filters
    }
  };
}

// Legacy: Filter leads by date range with coverage metrics
export async function getLeadsWithCoverage(dateRange: DateRangeFilter | null): Promise<{
  leads: Lead[];
  coverage: AuditCoverageMetrics;
}> {
  const allLeads = await getLeads();
  
  if (!dateRange || !dateRange.startDate || !dateRange.endDate) {
    return {
      leads: allLeads,
      coverage: {
        totalRecordsInCRM: allLeads.length,
        recordsInDateRange: allLeads.length,
        recordsAudited: allLeads.length,
        recordsExcluded: 0,
        exclusionReason: 'No date filter applied',
        dateRangeApplied: null
      }
    };
  }

  const filteredLeads = allLeads.filter(lead => isRecordInDateRange(lead, dateRange));
  
  return {
    leads: filteredLeads,
    coverage: {
      totalRecordsInCRM: allLeads.length,
      recordsInDateRange: filteredLeads.length,
      recordsAudited: filteredLeads.length,
      recordsExcluded: allLeads.length - filteredLeads.length,
      exclusionReason: `${allLeads.length - filteredLeads.length} records excluded (Created/Modified outside ${dateRange.startDate} to ${dateRange.endDate})`,
      dateRangeApplied: dateRange
    }
  };
}

// Filter deals by date range with coverage metrics
export async function getDealsWithCoverage(dateRange: DateRangeFilter | null): Promise<{
  deals: Deal[];
  coverage: AuditCoverageMetrics;
}> {
  const allDeals = await getDeals();
  
  if (!dateRange || !dateRange.startDate || !dateRange.endDate) {
    return {
      deals: allDeals,
      coverage: {
        totalRecordsInCRM: allDeals.length,
        recordsInDateRange: allDeals.length,
        recordsAudited: allDeals.length,
        recordsExcluded: 0,
        exclusionReason: 'No date filter applied',
        dateRangeApplied: null
      }
    };
  }

  const filteredDeals = allDeals.filter(deal => isRecordInDateRange(deal, dateRange));
  
  return {
    deals: filteredDeals,
    coverage: {
      totalRecordsInCRM: allDeals.length,
      recordsInDateRange: filteredDeals.length,
      recordsAudited: filteredDeals.length,
      recordsExcluded: allDeals.length - filteredDeals.length,
      exclusionReason: `${allDeals.length - filteredDeals.length} records excluded (Created/Modified outside ${dateRange.startDate} to ${dateRange.endDate})`,
      dateRangeApplied: dateRange
    }
  };
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  attendees: string[];
  organizer: string;
  status: string;
  location: string;
  related_crm_record: string | null;
  _hygiene_issue?: string;
}

export interface Five9Call {
  id: string;
  session_id: string;
  agent_id: string;
  agent_name: string;
  caller_number: string;
  called_number: string;
  direction: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  disposition: string;
  call_type: string;
  recording_url: string;
  notes: string;
  related_crm_record: string | null;
  _hygiene_issue?: string;
}

export async function getLeads(): Promise<Lead[]> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const data = loadMockData<{ leads: Lead[] }>('leads.json');
    return [...data.leads, ...inMemoryLeads];
  }
  
  const { fetchAllZohoRecords } = await import('../utils/zohoCRM');
  const records = await fetchAllZohoRecords('Leads');
  return records.map((r: any) => ({
    id: r.id,
    First_Name: r.data?.First_Name || '',
    Last_Name: r.data?.Last_Name || '',
    Email: r.data?.Email || '',
    Phone: r.data?.Phone || '',
    Company: r.data?.Company || '',
    Lead_Source: r.data?.Lead_Source || '',
    Lead_Status: r.data?.Lead_Status || '',
    Owner: r.owner || r.data?.Owner?.name || r.data?.Owner?.id || '',
    Created_Time: r.createdTime || '',
    Modified_Time: r.modifiedTime || '',
  }));
}

export async function getDeals(): Promise<Deal[]> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const data = loadMockData<{ deals: Deal[] }>('deals.json');
    return [...data.deals, ...inMemoryDeals];
  }
  
  const { fetchAllZohoRecords } = await import('../utils/zohoCRM');
  const records = await fetchAllZohoRecords('Deals');
  return records.map((r: any) => ({
    id: r.id,
    Deal_Name: r.data?.Deal_Name || '',
    Account_Name: r.data?.Account_Name?.name || '',
    Stage: r.data?.Stage || '',
    Amount: r.data?.Amount || 0,
    Closing_Date: r.data?.Closing_Date || '',
    Owner: r.owner || r.data?.Owner?.name || r.data?.Owner?.id || '',
    Lead_Source: r.data?.Lead_Source || '',
    Contact_Name: r.data?.Contact_Name?.name || '',
    Created_Time: r.createdTime || '',
    Modified_Time: r.modifiedTime || '',
  }));
}

export async function getActivities(): Promise<Activity[]> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const data = loadMockData<{ activities: Activity[] }>('activities.json');
    return data.activities;
  }
  
  const { fetchZohoRecords } = await import('../utils/zohoCRM');
  const records = await fetchZohoRecords('Tasks');
  return records.map((r: any) => ({
    id: r.id,
    Subject: r.Subject || '',
    Activity_Type: r.Activity_Type || 'Task',
    Related_To: r.What_Id?.id || '',
    Module: r.What_Id?.module || '',
    Owner: r.Owner?.id || '',
    Due_Date: r.Due_Date || '',
    Status: r.Status || '',
    Description: r.Description || '',
    Created_Time: r.Created_Time || '',
  }));
}

export async function getUsers(): Promise<User[]> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const data = loadMockData<{ users: User[] }>('users.json');
    return data.users;
  }
  
  return [];
}

export async function getCalendarEvents(): Promise<CalendarEvent[]> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const data = loadMockData<{ calendarEvents: CalendarEvent[] }>('calendarEvents.json');
    return data.calendarEvents;
  }
  
  const { fetchCalendarEvents } = await import('../utils/googleCalendar');
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const events = await fetchCalendarEvents(startDate, endDate, 'primary');
  
  return events.map((e: any) => ({
    id: e.id,
    summary: e.summary || '',
    description: e.description || '',
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    attendees: e.attendees?.map((a: any) => a.email) || [],
    organizer: e.organizer?.email || '',
    status: e.status || '',
    location: e.location || '',
    related_crm_record: null,
  }));
}

export async function getFive9Calls(): Promise<Five9Call[]> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const data = loadMockData<{ calls: Five9Call[] }>('five9Calls.json');
    return data.calls;
  }
  
  return [];
}

export async function addLead(lead: Partial<Lead>): Promise<Lead> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    leadIdCounter++;
    const newLead: Lead = {
      id: `lead_sandbox_${leadIdCounter}`,
      First_Name: lead.First_Name || '',
      Last_Name: lead.Last_Name || '',
      Email: lead.Email || '',
      Phone: lead.Phone || '',
      Company: lead.Company || '',
      Lead_Source: lead.Lead_Source || '',
      Lead_Status: lead.Lead_Status || '',
      Owner: lead.Owner || '',
      Created_Time: new Date().toISOString(),
      Modified_Time: new Date().toISOString(),
      _hygiene_issue: !lead.Email ? 'Missing email' : (!lead.Lead_Source ? 'Missing lead source' : undefined),
    };
    inMemoryLeads.push(newLead);
    return newLead;
  }
  
  throw new Error('Adding leads to real CRM not implemented');
}

export async function addDeal(deal: Partial<Deal>): Promise<Deal> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    dealIdCounter++;
    const newDeal: Deal = {
      id: `deal_sandbox_${dealIdCounter}`,
      Deal_Name: deal.Deal_Name || '',
      Account_Name: deal.Account_Name || '',
      Stage: deal.Stage || '',
      Amount: deal.Amount || 0,
      Closing_Date: deal.Closing_Date || '',
      Owner: deal.Owner || '',
      Lead_Source: deal.Lead_Source || '',
      Contact_Name: deal.Contact_Name || '',
      Created_Time: new Date().toISOString(),
      Modified_Time: new Date().toISOString(),
      _hygiene_issue: !deal.Deal_Name ? 'Missing deal name' : (!deal.Stage ? 'Missing stage' : (!deal.Amount ? 'Missing amount' : undefined)),
    };
    inMemoryDeals.push(newDeal);
    return newDeal;
  }
  
  throw new Error('Adding deals to real CRM not implemented');
}

export async function updateLead(id: string, updates: Partial<Lead>): Promise<Lead | null> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const index = inMemoryLeads.findIndex(l => l.id === id);
    if (index === -1) return null;
    
    inMemoryLeads[index] = {
      ...inMemoryLeads[index],
      ...updates,
      Modified_Time: new Date().toISOString(),
    };
    return inMemoryLeads[index];
  }
  
  throw new Error('Updating leads in real CRM not implemented');
}

export async function updateDeal(id: string, updates: Partial<Deal>): Promise<Deal | null> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const index = inMemoryDeals.findIndex(d => d.id === id);
    if (index === -1) return null;
    
    inMemoryDeals[index] = {
      ...inMemoryDeals[index],
      ...updates,
      Modified_Time: new Date().toISOString(),
    };
    return inMemoryDeals[index];
  }
  
  throw new Error('Updating deals in real CRM not implemented');
}

export async function deleteLead(id: string): Promise<boolean> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const index = inMemoryLeads.findIndex(l => l.id === id);
    if (index === -1) return false;
    
    inMemoryLeads.splice(index, 1);
    return true;
  }
  
  throw new Error('Deleting leads from real CRM not implemented');
}

export async function deleteDeal(id: string): Promise<boolean> {
  const mode = getDataMode();
  
  if (mode === 'MOCK') {
    const index = inMemoryDeals.findIndex(d => d.id === id);
    if (index === -1) return false;
    
    inMemoryDeals.splice(index, 1);
    return true;
  }
  
  throw new Error('Deleting deals from real CRM not implemented');
}

export function getMockDataStats(): {
  leads: number;
  deals: number;
  activities: number;
  users: number;
  calendarEvents: number;
  calls: number;
  hygieneIssues: {
    leads: number;
    deals: number;
    activities: number;
    calendarEvents: number;
    calls: number;
  };
} {
  const fixtureLeads = loadMockData<{ leads: Lead[] }>('leads.json').leads;
  const fixtureDeals = loadMockData<{ deals: Deal[] }>('deals.json').deals;
  const activities = loadMockData<{ activities: Activity[] }>('activities.json').activities;
  const users = loadMockData<{ users: User[] }>('users.json').users;
  const calendarEvents = loadMockData<{ calendarEvents: CalendarEvent[] }>('calendarEvents.json').calendarEvents;
  const calls = loadMockData<{ calls: Five9Call[] }>('five9Calls.json').calls;
  
  const allLeads = [...fixtureLeads, ...inMemoryLeads];
  const allDeals = [...fixtureDeals, ...inMemoryDeals];
  
  return {
    leads: allLeads.length,
    deals: allDeals.length,
    activities: activities.length,
    users: users.length,
    calendarEvents: calendarEvents.length,
    calls: calls.length,
    hygieneIssues: {
      leads: allLeads.filter(l => l._hygiene_issue).length + inMemoryLeads.filter(l => !l.Email || !l.Lead_Source).length,
      deals: allDeals.filter(d => d._hygiene_issue).length + inMemoryDeals.filter(d => !d.Deal_Name || !d.Stage || !d.Amount).length,
      activities: activities.filter(a => a._hygiene_issue).length,
      calendarEvents: calendarEvents.filter(e => e._hygiene_issue).length,
      calls: calls.filter(c => c._hygiene_issue).length,
    },
  };
}

export function getInMemoryRecordCount(): { leads: number; deals: number } {
  return { leads: inMemoryLeads.length, deals: inMemoryDeals.length };
}
