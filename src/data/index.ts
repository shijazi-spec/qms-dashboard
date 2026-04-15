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
  Layout: string;
  Products: string;
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
  Layout: string;
  Products: string;
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

export interface DateRangeFilter {
  startDate: string;
  endDate: string;
}

export interface SeparateDateFilters {
  created: { start: string | null; end: string | null };
  modified: { start: string | null; end: string | null };
}

export interface AuditCoverageMetrics {
  totalRecordsInCRM: number;
  recordsInDateRange: number;
  recordsAudited: number;
  recordsExcluded: number;
  exclusionReason: string;
  dateRangeApplied: DateRangeFilter | null;
  separateFiltersApplied?: SeparateDateFilters;
}

function isDateInRange(dateStr: string | undefined, start: string | null, end: string | null): boolean {
  if (!start || !end) return true;
  if (!dateStr || dateStr.trim() === '') return false;
  
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;
  
  const startDate = new Date(start);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(23, 59, 59, 999);
  
  return date >= startDate && date <= endDate;
}

export function isRecordInSeparateDateFilters(
  record: { Created_Time?: string; Modified_Time?: string },
  filters: SeparateDateFilters
): boolean {
  const hasCreatedFilter = filters.created.start && filters.created.end;
  const hasModifiedFilter = filters.modified.start && filters.modified.end;
  
  if (!hasCreatedFilter && !hasModifiedFilter) return true;
  
  let createdMatch = true;
  if (hasCreatedFilter) {
    createdMatch = isDateInRange(record.Created_Time, filters.created.start, filters.created.end);
  }
  
  let modifiedMatch = true;
  if (hasModifiedFilter) {
    modifiedMatch = isDateInRange(record.Modified_Time, filters.modified.start, filters.modified.end);
  }
  
  if (hasCreatedFilter && hasModifiedFilter) {
    return createdMatch && modifiedMatch;
  } else if (hasCreatedFilter) {
    return createdMatch;
  } else {
    return modifiedMatch;
  }
}

export function isRecordInDateRange(
  record: { Created_Time?: string; Modified_Time?: string },
  dateRange: DateRangeFilter | null
): boolean {
  if (!dateRange || !dateRange.startDate || !dateRange.endDate) return true;

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

export async function getLeadsWithSeparateFilters(filters: SeparateDateFilters, maxRecords?: number): Promise<{
  leads: Lead[];
  coverage: AuditCoverageMetrics;
}> {
  const allLeads = await getLeads(maxRecords);
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

export async function getDealsWithSeparateFilters(filters: SeparateDateFilters, maxRecords?: number): Promise<{
  deals: Deal[];
  coverage: AuditCoverageMetrics;
}> {
  const allDeals = await getDeals(maxRecords);
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

export async function getLeads(maxRecords?: number): Promise<Lead[]> {
  const { fetchAllZohoRecords } = await import('../utils/zohoCRM');
  const records = await fetchAllZohoRecords('Leads', { maxRecords, sortBy: 'Modified_Time', sortOrder: 'desc' });
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
    Layout: r.data?.Layout?.name || r.data?.Layout || '',
    Products: (Array.isArray(r.data?.Product_Details) && r.data.Product_Details.length > 0)
      ? r.data.Product_Details.map((p: any) => p.product?.name || '').filter(Boolean).join(', ')
      : (r.data?.Product_Name || r.data?.Product || ''),
    Created_Time: r.createdTime || '',
    Modified_Time: r.modifiedTime || '',
  }));
}

export async function getDeals(maxRecords?: number): Promise<Deal[]> {
  const { fetchAllZohoRecords } = await import('../utils/zohoCRM');
  const records = await fetchAllZohoRecords('Deals', { maxRecords, sortBy: 'Modified_Time', sortOrder: 'desc' });
  return records.map((r: any) => ({
    id: r.id,
    Deal_Name: r.data?.Deal_Name || '',
    Account_Name: r.data?.Account_Name?.name || '',
    Stage: r.data?.Stage || '',
    Amount: r.data?.Amount || 0,
    Closing_Date: r.data?.Closing_Date || '',
    Owner: r.owner || r.data?.Owner?.name || r.data?.Owner?.id || '',
    Layout: r.data?.Layout?.name || r.data?.Layout || '',
    Products: (Array.isArray(r.data?.Product_Details) && r.data.Product_Details.length > 0)
      ? r.data.Product_Details.map((p: any) => p.product?.name || '').filter(Boolean).join(', ')
      : (r.data?.Product_Name || r.data?.Product || ''),
    Lead_Source: r.data?.Lead_Source || '',
    Contact_Name: r.data?.Contact_Name?.name || '',
    Created_Time: r.createdTime || '',
    Modified_Time: r.modifiedTime || '',
  }));
}

export async function getActivities(): Promise<Activity[]> {
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
  return [];
}

export async function getCalendarEvents(): Promise<CalendarEvent[]> {
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
  return [];
}

export async function addLead(lead: Partial<Lead>): Promise<Lead> {
  const { createZohoRecord } = await import('../utils/zohoCRM');
  const result = await createZohoRecord('Leads', {
    First_Name: lead.First_Name || '',
    Last_Name: lead.Last_Name || '',
    Email: lead.Email || '',
    Phone: lead.Phone || '',
    Company: lead.Company || '',
    Lead_Source: lead.Lead_Source || '',
    Lead_Status: lead.Lead_Status || 'Not Contacted',
  });
  return {
    id: result?.id || `lead_${Date.now()}`,
    First_Name: lead.First_Name || '',
    Last_Name: lead.Last_Name || '',
    Email: lead.Email || '',
    Phone: lead.Phone || '',
    Company: lead.Company || '',
    Lead_Source: lead.Lead_Source || '',
    Lead_Status: lead.Lead_Status || 'Not Contacted',
    Owner: lead.Owner || '',
    Created_Time: new Date().toISOString(),
    Modified_Time: new Date().toISOString(),
  };
}

export async function addDeal(deal: Partial<Deal>): Promise<Deal> {
  const { createZohoRecord } = await import('../utils/zohoCRM');
  const result = await createZohoRecord('Deals', {
    Deal_Name: deal.Deal_Name || '',
    Account_Name: deal.Account_Name || '',
    Stage: deal.Stage || 'New Deal',
    Amount: deal.Amount || 0,
    Closing_Date: deal.Closing_Date || '',
    Lead_Source: deal.Lead_Source || '',
  });
  return {
    id: result?.id || `deal_${Date.now()}`,
    Deal_Name: deal.Deal_Name || '',
    Account_Name: deal.Account_Name || '',
    Stage: deal.Stage || 'New Deal',
    Amount: deal.Amount || 0,
    Closing_Date: deal.Closing_Date || '',
    Owner: deal.Owner || '',
    Lead_Source: deal.Lead_Source || '',
    Contact_Name: deal.Contact_Name || '',
    Created_Time: new Date().toISOString(),
    Modified_Time: new Date().toISOString(),
  };
}

export async function updateLead(id: string, updates: Partial<Lead>): Promise<Lead | null> {
  const { updateZohoRecord } = await import('../utils/zohoCRM');
  await updateZohoRecord('Leads', id, updates);
  return {
    id,
    First_Name: updates.First_Name || '',
    Last_Name: updates.Last_Name || '',
    Email: updates.Email || '',
    Phone: updates.Phone || '',
    Company: updates.Company || '',
    Lead_Source: updates.Lead_Source || '',
    Lead_Status: updates.Lead_Status || '',
    Owner: updates.Owner || '',
    Created_Time: '',
    Modified_Time: new Date().toISOString(),
  };
}

export async function updateDeal(id: string, updates: Partial<Deal>): Promise<Deal | null> {
  const { updateZohoRecord } = await import('../utils/zohoCRM');
  await updateZohoRecord('Deals', id, updates);
  return {
    id,
    Deal_Name: updates.Deal_Name || '',
    Account_Name: updates.Account_Name || '',
    Stage: updates.Stage || '',
    Amount: updates.Amount || 0,
    Closing_Date: updates.Closing_Date || '',
    Owner: updates.Owner || '',
    Lead_Source: updates.Lead_Source || '',
    Contact_Name: updates.Contact_Name || '',
    Created_Time: '',
    Modified_Time: new Date().toISOString(),
  };
}

export async function deleteLead(id: string): Promise<boolean> {
  const { deleteZohoRecord } = await import('../utils/zohoCRM');
  await deleteZohoRecord('Leads', id);
  return true;
}

export async function deleteDeal(id: string): Promise<boolean> {
  const { deleteZohoRecord } = await import('../utils/zohoCRM');
  await deleteZohoRecord('Deals', id);
  return true;
}
