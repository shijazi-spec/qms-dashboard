import { fetchAllZohoRecords, type ZohoCRMRecord } from './zohoCRM';
import { logger } from './logger';

export type ParentModule = 'Leads' | 'Deals';
export type ActivityKind = 'task' | 'meeting' | 'call';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  subject: string | null;
  status: string | null;
  owner: string | null;
  dueDate: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  callType: string | null;
  callPurpose: string | null;
  callResult: string | null;
  callDuration: string | null;
  description: string | null;
  createdTime: string | null;
  modifiedTime: string | null;
}

export interface ActivitiesBucket {
  tasks: ActivityItem[];
  meetings: ActivityItem[];
  calls: ActivityItem[];
}

export interface ActivitiesResult {
  parentModule: ParentModule;
  parentId: string;
  open: ActivitiesBucket;
  closed: ActivitiesBucket;
  counts: {
    open: { tasks: number; meetings: number; calls: number };
    closed: { tasks: number; meetings: number; calls: number };
  };
  fetchedAt: string;
  errors: string[];
}

const TASK_CLOSED_STATUSES = new Set(['Completed']);

function parseDate(value: any): Date | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDurationMinutes(raw: any): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map((p) => Number(p));
    if (parts.every((n) => Number.isFinite(n))) {
      const [h = 0, m = 0, s = 0] = parts;
      return h * 60 + m + s / 60;
    }
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : 0;
}

function ownerName(record: any): string | null {
  return record?.Owner?.name || record?.Owner?.id || null;
}

function toItem(kind: ActivityKind, record: ZohoCRMRecord): ActivityItem {
  const d: any = record.data || {};
  return {
    id: record.id,
    kind,
    subject:
      d.Subject ||
      d.Event_Title ||
      d.Call_Type ||
      null,
    status: d.Status ?? null,
    owner: ownerName(d),
    dueDate: d.Due_Date ?? null,
    startDateTime: d.Start_DateTime ?? d.Call_Start_Time ?? null,
    endDateTime: d.End_DateTime ?? null,
    callType: d.Call_Type ?? null,
    callPurpose: d.Call_Purpose ?? null,
    callResult: d.Call_Result ?? null,
    callDuration:
      d.Call_Duration ?? d.Call_Duration_in_seconds ?? null,
    description: d.Description ?? null,
    createdTime: record.createdTime ?? d.Created_Time ?? null,
    modifiedTime: record.modifiedTime ?? d.Modified_Time ?? null,
  };
}

function isTaskOpen(record: ZohoCRMRecord): boolean {
  const status = (record.data as any)?.Status;
  if (typeof status === 'string' && status.trim()) {
    return !TASK_CLOSED_STATUSES.has(status.trim());
  }
  return true;
}

function isMeetingOpen(record: ZohoCRMRecord, now: number): boolean {
  const d: any = record.data || {};
  const end = parseDate(d.End_DateTime) || parseDate(d.Start_DateTime);
  if (!end) return true;
  return end.getTime() >= now;
}

function isCallOpen(record: ZohoCRMRecord, now: number): boolean {
  const d: any = record.data || {};
  const duration = parseDurationMinutes(d.Call_Duration);
  if (duration > 0) return false;
  const result = (d.Call_Result || '').toString().trim();
  if (result) return false;
  const start = parseDate(d.Call_Start_Time);
  if (start && start.getTime() > now) return true;
  if (!start) return true;
  return false;
}

const TASK_FIELDS = [
  'Subject',
  'Status',
  'Priority',
  'Due_Date',
  'Owner',
  'Description',
  'Who_Id',
  'What_Id',
  'Created_Time',
  'Modified_Time',
  'Closed_Time',
].join(',');

const EVENT_FIELDS = [
  'Event_Title',
  'Start_DateTime',
  'End_DateTime',
  'Owner',
  'Description',
  'Venue',
  'Who_Id',
  'What_Id',
  'Created_Time',
  'Modified_Time',
].join(',');

const CALL_FIELDS = [
  'Subject',
  'Call_Type',
  'Call_Purpose',
  'Call_Result',
  'Call_Start_Time',
  'Call_Duration',
  'Owner',
  'Description',
  'Who_Id',
  'What_Id',
  'Created_Time',
  'Modified_Time',
].join(',');

async function safeFetch(
  label: string,
  module: string,
  criteria: string,
  fields: string,
  errors: string[],
): Promise<ZohoCRMRecord[]> {
  try {
    return await fetchAllZohoRecords(module, {
      criteria,
      fields: fields.split(','),
      maxRecords: 500,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[zohoActivitiesReader] ${label} fetch failed: ${msg}`);
    errors.push(`${label}: ${msg}`);
    return [];
  }
}

export async function getZohoActivitiesForRecord(
  parentModule: ParentModule,
  parentId: string,
): Promise<ActivitiesResult> {
  const errors: string[] = [];
  const now = Date.now();
  const trimmedId = String(parentId || '').trim();
  if (!trimmedId) {
    throw new Error('parentId is required');
  }

  // For Leads, activities link via Who_Id. For Deals, via What_Id.
  // Some tenants also link Lead-related calls via What_Id when calls are
  // logged against a related account/deal — we fetch by the primary linkage
  // only to keep the result tightly scoped to the requested record.
  const linkageField = parentModule === 'Leads' ? 'Who_Id' : 'What_Id';
  const criteria = `(${linkageField}:equals:${trimmedId})`;

  const [tasks, events, calls] = await Promise.all([
    safeFetch('Tasks', 'Tasks', criteria, TASK_FIELDS, errors),
    safeFetch('Events', 'Events', criteria, EVENT_FIELDS, errors),
    safeFetch('Calls', 'Calls', criteria, CALL_FIELDS, errors),
  ]);

  const open: ActivitiesBucket = { tasks: [], meetings: [], calls: [] };
  const closed: ActivitiesBucket = { tasks: [], meetings: [], calls: [] };

  for (const r of tasks) {
    (isTaskOpen(r) ? open.tasks : closed.tasks).push(toItem('task', r));
  }
  for (const r of events) {
    (isMeetingOpen(r, now) ? open.meetings : closed.meetings).push(
      toItem('meeting', r),
    );
  }
  for (const r of calls) {
    (isCallOpen(r, now) ? open.calls : closed.calls).push(toItem('call', r));
  }

  return {
    parentModule,
    parentId: trimmedId,
    open,
    closed,
    counts: {
      open: {
        tasks: open.tasks.length,
        meetings: open.meetings.length,
        calls: open.calls.length,
      },
      closed: {
        tasks: closed.tasks.length,
        meetings: closed.meetings.length,
        calls: closed.calls.length,
      },
    },
    fetchedAt: new Date().toISOString(),
    errors,
  };
}
