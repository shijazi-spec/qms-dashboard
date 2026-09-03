/**
 * CRMProvider Lead Status & Deal Stage Aging (Task #825)
 * ===============================================
 *
 * Derives "how long has this record been sitting in its current
 * Lead_Status / Stage?" from CRMProvider's modification history rather than the
 * record's overall `Modified_Time`.
 *
 *   - Deals: pulled from CRMProvider's built-in `Stage_History` related list.
 *   - Leads: pulled from the v2 `<id>/__changelog` audit endpoint
 *     filtered to the `Lead_Status` field.
 *
 * Both fall back to the record's `Created_Time` when no audit entry
 * exists and freeze aging at the entry timestamp when the current
 * status/stage is configured as terminal (`Closed Won`, `Junk Lead`, …).
 * All timestamps are normalised to UTC ISO; aging is computed in whole
 * UTC days.
 *
 * The CRMProvider-fetching path goes through `makeCRMProviderRequest` in
 * `src/utils/CRMProviderCRM.ts`, so OAuth caching, the 401-then-refresh retry,
 * and the structured error surface match the rest of the platform.
 *
 * The pure math (`computeAging`, `pickLatestStageHistoryEntry`,
 * `pickLatestStatusTimelineEntry`) is exported separately so unit tests
 * can exercise the spec edge cases without a live CRMProvider client.
 */

import { logger } from "./logger";
import {
  fetchAllCRMProviderRecords,
  fetchDealStageHistory,
  fetchLeadStatusChangelog,
  type CRMProviderCRMRecord,
  type CRMProviderChangelogRow,
  type CRMProviderStageHistoryRow,
} from "./CRMProviderCRM";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Terminal-state config ────────────────────────────────────────────────────

const DEFAULT_TERMINAL_DEAL_STAGES = ["Closed Won", "Closed Lost"];
const DEFAULT_TERMINAL_LEAD_STATUSES = [
  "Closed Won",
  "Closed Lost",
  "Junk Lead",
  "Lost Lead",
  "Converted",
];

function parseListEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function getTerminalDealStages(): string[] {
  return parseListEnv("CRMProvider_TERMINAL_DEAL_STAGES", DEFAULT_TERMINAL_DEAL_STAGES);
}
export function getTerminalLeadStatuses(): string[] {
  return parseListEnv("CRMProvider_TERMINAL_LEAD_STATUSES", DEFAULT_TERMINAL_LEAD_STATUSES);
}

function isTerminalValue(value: string, terminals: string[]): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return terminals.some((t) => t.trim().toLowerCase() === v);
}

// ─── Thresholds (used by the dashboard view + API ?minDays= filter) ──────────

const DEFAULT_LEAD_THRESHOLD_DAYS = 14;
const DEFAULT_DEAL_THRESHOLD_DAYS = 30;

export function getLeadAgingThreshold(): number {
  const n = parseInt(process.env.CRMProvider_LEAD_AGING_THRESHOLD_DAYS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEAD_THRESHOLD_DAYS;
}
export function getDealAgingThreshold(): number {
  const n = parseInt(process.env.CRMProvider_DEAL_AGING_THRESHOLD_DAYS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEAL_THRESHOLD_DAYS;
}

// ─── Pure math (unit-test surface) ────────────────────────────────────────────

export interface AgingResult {
  value: string;
  enteredAt: string;
  agingDays: number;
  isTerminal: boolean;
  source: "history" | "created" | "unknown";
}

export function toUtcIso(input: string | Date | null | undefined): string | null {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function daysBetweenUtc(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.floor(Math.max(0, to - from) / MS_PER_DAY);
}

export interface ComputeAgingInput {
  currentValue: string;
  enteredAtFromHistory?: string | null;
  createdTime?: string | null;
  now?: Date | string;
  terminalValues: string[];
}

export function computeAging(input: ComputeAgingInput): AgingResult {
  const nowIso = toUtcIso(input.now ?? new Date()) ?? new Date().toISOString();
  const fromHistory = toUtcIso(input.enteredAtFromHistory ?? null);
  const fromCreated = toUtcIso(input.createdTime ?? null);

  let enteredAt: string | null = fromHistory;
  let source: AgingResult["source"] = "history";
  if (!enteredAt) {
    enteredAt = fromCreated;
    source = enteredAt ? "created" : "unknown";
  }

  const isTerminal = isTerminalValue(input.currentValue, input.terminalValues);
  // Freeze terminal aging at the entry timestamp so a Closed Won deal
  // doesn't accumulate "stale" aging forever.
  const effectiveNow = isTerminal && enteredAt ? enteredAt : nowIso;
  const agingDays = enteredAt ? daysBetweenUtc(enteredAt, effectiveNow) : 0;

  return {
    value: input.currentValue,
    enteredAt: enteredAt ?? "",
    agingDays,
    isTerminal,
    source,
  };
}

export function pickLatestStageHistoryEntry(
  history: CRMProviderStageHistoryRow[],
  currentStage: string,
): { Stage: string; enteredAt: string } | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const target = (currentStage || "").trim().toLowerCase();
  if (!target) return null;
  let best: { Stage: string; enteredAt: string; ts: number } | null = null;
  for (const row of history) {
    const stage = (row.Stage || "").trim();
    if (stage.toLowerCase() !== target) continue;
    const tsIso = toUtcIso(row.Modified_Time || row.Last_Modified_Time || null);
    if (!tsIso) continue;
    const ts = new Date(tsIso).getTime();
    if (!best || ts > best.ts) best = { Stage: stage, enteredAt: tsIso, ts };
  }
  return best ? { Stage: best.Stage, enteredAt: best.enteredAt } : null;
}

export function pickLatestStatusTimelineEntry(
  timeline: CRMProviderChangelogRow[],
  fieldApiName: string,
  currentValue: string,
): { value: string; enteredAt: string } | null {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  const target = (currentValue || "").trim().toLowerCase();
  if (!target) return null;
  let best: { value: string; enteredAt: string; ts: number } | null = null;
  for (const row of timeline) {
    if (row.field?.api_name !== fieldApiName) continue;
    const v = String(row.value?.current ?? "").trim();
    if (v.toLowerCase() !== target) continue;
    const tsIso = toUtcIso(row.audited_time || null);
    if (!tsIso) continue;
    const ts = new Date(tsIso).getTime();
    if (!best || ts > best.ts) best = { value: v, enteredAt: tsIso, ts };
  }
  return best ? { value: best.value, enteredAt: best.enteredAt } : null;
}

// ─── Fetcher dependency interface (testability) ──────────────────────────────
//
// Routes and unit tests inject these so we don't hit the real CRMProvider client.
// The default implementation just delegates to the helpers in CRMProviderCRM.ts.

export interface AgingFetchers {
  fetchDealStageHistoryById(dealId: string): Promise<{
    history: CRMProviderStageHistoryRow[];
    currentStage: string;
    createdTime: string | null;
    dealName: string;
    owner: string;
  }>;
  fetchLeadStatusTimelineById(leadId: string): Promise<{
    timeline: CRMProviderChangelogRow[];
    currentStatus: string;
    createdTime: string | null;
    leadName: string;
    owner: string;
  }>;
  /** Page-based listing of records for the active pipeline. */
  listDealsPage(page: number, perPage: number): Promise<CRMProviderCRMRecord[]>;
  listLeadsPage(page: number, perPage: number): Promise<CRMProviderCRMRecord[]>;
}

async function defaultDealRecord(dealId: string) {
  const recs = await fetchAllCRMProviderRecords("Deals", {
    criteria: `(id:equals:${dealId})`,
    maxRecords: 1,
  });
  return recs[0]?.data || {};
}
async function defaultLeadRecord(leadId: string) {
  const recs = await fetchAllCRMProviderRecords("Leads", {
    criteria: `(id:equals:${leadId})`,
    maxRecords: 1,
  });
  return recs[0]?.data || {};
}

export const defaultAgingFetchers: AgingFetchers = {
  async fetchDealStageHistoryById(dealId: string) {
    const [deal, history] = await Promise.all([
      defaultDealRecord(dealId),
      fetchDealStageHistory(dealId),
    ]);
    return {
      history,
      currentStage: String(deal.Stage || ""),
      createdTime: deal.Created_Time || null,
      dealName: String(deal.Deal_Name || ""),
      owner: String(deal.Owner?.name || deal.Owner?.id || ""),
    };
  },
  async fetchLeadStatusTimelineById(leadId: string) {
    const [lead, timeline] = await Promise.all([
      defaultLeadRecord(leadId),
      fetchLeadStatusChangelog(leadId),
    ]);
    const fullName =
      String(lead.Full_Name || `${lead.First_Name || ""} ${lead.Last_Name || ""}`).trim();
    return {
      timeline,
      currentStatus: String(lead.Lead_Status || ""),
      createdTime: lead.Created_Time || null,
      leadName: fullName,
      owner: String(lead.Owner?.name || lead.Owner?.id || ""),
    };
  },
  async listDealsPage(page: number, perPage: number) {
    const { fetchCRMProviderRecords } = await import("./CRMProviderCRM");
    return fetchCRMProviderRecords("Deals", {
      page,
      perPage,
      sortBy: "Modified_Time",
      sortOrder: "asc",
      fields: ["Deal_Name", "Stage", "Owner", "Created_Time", "Modified_Time"],
    });
  },
  async listLeadsPage(page: number, perPage: number) {
    const { fetchCRMProviderRecords } = await import("./CRMProviderCRM");
    return fetchCRMProviderRecords("Leads", {
      page,
      perPage,
      sortBy: "Modified_Time",
      sortOrder: "asc",
      fields: ["Full_Name", "First_Name", "Last_Name", "Lead_Status", "Owner", "Created_Time", "Modified_Time"],
    });
  },
};

// ─── Single-record API ────────────────────────────────────────────────────────

export interface DealStageAging extends AgingResult {
  dealId: string;
  dealName: string;
  owner: string;
  stage: string;
  /** Domain-specific alias of {@link AgingResult.agingDays} for Deals. */
  stageAging: number;
  /** Domain-specific alias of {@link AgingResult.enteredAt} for Deals. */
  stageEnteredAt: string;
}

export interface LeadStatusAging extends AgingResult {
  leadId: string;
  leadName: string;
  owner: string;
  status: string;
  /** Domain-specific alias of {@link AgingResult.agingDays} for Leads. */
  statusAging: number;
  /** Domain-specific alias of {@link AgingResult.enteredAt} for Leads. */
  statusEnteredAt: string;
}

export async function getDealStageAging(
  dealId: string,
  fetchers: AgingFetchers = defaultAgingFetchers,
): Promise<DealStageAging> {
  const { history, currentStage, createdTime, dealName, owner } =
    await fetchers.fetchDealStageHistoryById(dealId);
  const latest = pickLatestStageHistoryEntry(history, currentStage);
  const result = computeAging({
    currentValue: currentStage,
    enteredAtFromHistory: latest?.enteredAt ?? null,
    createdTime,
    terminalValues: getTerminalDealStages(),
  });
  return {
    dealId,
    dealName,
    owner,
    stage: currentStage,
    ...result,
    stageAging: result.agingDays,
    stageEnteredAt: result.enteredAt,
  };
}

export async function getLeadStatusAging(
  leadId: string,
  fetchers: AgingFetchers = defaultAgingFetchers,
): Promise<LeadStatusAging> {
  const { timeline, currentStatus, createdTime, leadName, owner } =
    await fetchers.fetchLeadStatusTimelineById(leadId);
  const latest = pickLatestStatusTimelineEntry(timeline, "Lead_Status", currentStatus);
  const result = computeAging({
    currentValue: currentStatus,
    enteredAtFromHistory: latest?.enteredAt ?? null,
    createdTime,
    terminalValues: getTerminalLeadStatuses(),
  });
  return {
    leadId,
    leadName,
    owner,
    status: currentStatus,
    ...result,
    statusAging: result.agingDays,
    statusEnteredAt: result.enteredAt,
  };
}

// ─── Per-record TTL cache + bounded-concurrency fan-out ──────────────────────
//
// 5-minute TTL keyed by record id. The platform does not (yet) ship a shared
// memoization util in `src/utils/`; the CRM stack uses ad-hoc Maps in several
// places (see `cachedAccessToken` in CRMProviderCRM.ts). This is intentionally minimal
// and lives next to its only caller. Cache eviction is implicit on TTL expiry.

const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry<T> { value: T; expiresAt: number; }
const dealCache = new Map<string, CacheEntry<DealStageAging>>();
const leadCache = new Map<string, CacheEntry<LeadStatusAging>>();

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const e = map.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) { map.delete(key); return null; }
  return e.value;
}
function setCached<T>(map: Map<string, CacheEntry<T>>, key: string, value: T) {
  map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}
/** Test-only: clear the per-record caches between tests. */
export function _clearAgingCaches(): void {
  dealCache.clear();
  leadCache.clear();
}

const FANOUT_CONCURRENCY = 4;
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/**
 * Public batched fan-out for Deals — used by the list endpoints, CRM Hub
 * column (#826) and the upcoming stalled-record alerts cron (#827).
 * Concurrency 4, 5-min per-id TTL cache, per-id failure isolation.
 */
export async function getStageAgingForDeals(
  ids: string[],
  fetchers: AgingFetchers = defaultAgingFetchers,
): Promise<DealStageAging[]> {
  return fanoutDeals(ids, fetchers);
}

/** See `getStageAgingForDeals` — same contract for Leads. */
export async function getStatusAgingForLeads(
  ids: string[],
  fetchers: AgingFetchers = defaultAgingFetchers,
): Promise<LeadStatusAging[]> {
  return fanoutLeads(ids, fetchers);
}

async function fanoutDeals(ids: string[], fetchers: AgingFetchers): Promise<DealStageAging[]> {
  return mapWithConcurrency(ids, FANOUT_CONCURRENCY, async (id) => {
    const cached = getCached(dealCache, id);
    if (cached) return cached;
    try {
      const r = await getDealStageAging(id, fetchers);
      setCached(dealCache, id, r);
      return r;
    } catch (err: any) {
      logger.warn(`[CRMProviderAging] Deal ${id} failed: ${err?.message || err}`);
      return {
        dealId: id, dealName: "", owner: "", stage: "", value: "",
        enteredAt: "", agingDays: 0, isTerminal: false, source: "unknown" as const,
        stageAging: 0, stageEnteredAt: "",
      };
    }
  });
}

async function fanoutLeads(ids: string[], fetchers: AgingFetchers): Promise<LeadStatusAging[]> {
  return mapWithConcurrency(ids, FANOUT_CONCURRENCY, async (id) => {
    const cached = getCached(leadCache, id);
    if (cached) return cached;
    try {
      const r = await getLeadStatusAging(id, fetchers);
      setCached(leadCache, id, r);
      return r;
    } catch (err: any) {
      logger.warn(`[CRMProviderAging] Lead ${id} failed: ${err?.message || err}`);
      return {
        leadId: id, leadName: "", owner: "", status: "", value: "",
        enteredAt: "", agingDays: 0, isTerminal: false, source: "unknown" as const,
        statusAging: 0, statusEnteredAt: "",
      };
    }
  });
}

// ─── Paginated list endpoints ────────────────────────────────────────────────
//
// Caller does NOT need to supply ids. We page CRMProvider ourselves (sorted by
// `Modified_Time asc` so the most-stale records surface first), compute aging
// for the page, optionally drop terminal/below-threshold rows, then sort the
// remaining items by `agingDays desc`. The cursor is the next CRMProvider page
// number; an empty cursor means we've reached the end.

export interface ListAgingOptions {
  /** Number of records per CRMProvider page to scan (default 50, max 200). */
  limit?: number;
  /** CRMProvider page number (1-based). Use the `nextCursor` from the previous response. */
  cursor?: string | number;
  /** Filter out items with agingDays below this. */
  minDays?: number;
  /** Whether to include terminal-state records (default false). */
  includeTerminal?: boolean;
}

export interface ListAgingResponse<T> {
  items: T[];
  nextCursor: string | null;
  threshold: number;
  scanned: number;
}

function clampLimit(raw: number | undefined): number {
  const n = Number.isFinite(raw) && raw! > 0 ? Math.floor(raw!) : 50;
  return Math.min(Math.max(n, 1), 200);
}

function parseCursorPage(cursor: string | number | undefined): number {
  if (cursor === undefined || cursor === null || cursor === "") return 1;
  const n = typeof cursor === "number" ? cursor : parseInt(String(cursor), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function sortByAgingDesc<T extends { agingDays: number }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => b.agingDays - a.agingDays);
}

export async function listDealsAging(
  opts: ListAgingOptions = {},
  fetchers: AgingFetchers = defaultAgingFetchers,
): Promise<ListAgingResponse<DealStageAging>> {
  const limit = clampLimit(opts.limit);
  const page = parseCursorPage(opts.cursor);
  const minDays = Number.isFinite(opts.minDays) && opts.minDays! >= 0 ? opts.minDays! : 0;
  const includeTerminal = !!opts.includeTerminal;

  const records = await fetchers.listDealsPage(page, limit);
  const ids = records.map((r) => r.id).filter(Boolean);
  const aging = await fanoutDeals(ids, fetchers);

  // Splice in Owner/Name from the listing in case the per-record fetch is a
  // stub (tests) — `getDealStageAging` already populates them in production.
  const byId = new Map(aging.map((a) => [a.dealId, a]));
  for (const rec of records) {
    const a = byId.get(rec.id);
    if (!a) continue;
    if (!a.dealName) a.dealName = String(rec.data?.Deal_Name || "");
    if (!a.owner) a.owner = String(rec.owner || "");
  }

  const filtered = aging.filter(
    (r) => (includeTerminal || !r.isTerminal) && r.agingDays >= minDays,
  );
  const items = sortByAgingDesc(filtered);
  const nextCursor = records.length === limit ? String(page + 1) : null;
  return { items, nextCursor, threshold: getDealAgingThreshold(), scanned: records.length };
}

export async function listLeadsAging(
  opts: ListAgingOptions = {},
  fetchers: AgingFetchers = defaultAgingFetchers,
): Promise<ListAgingResponse<LeadStatusAging>> {
  const limit = clampLimit(opts.limit);
  const page = parseCursorPage(opts.cursor);
  const minDays = Number.isFinite(opts.minDays) && opts.minDays! >= 0 ? opts.minDays! : 0;
  const includeTerminal = !!opts.includeTerminal;

  const records = await fetchers.listLeadsPage(page, limit);
  const ids = records.map((r) => r.id).filter(Boolean);
  const aging = await fanoutLeads(ids, fetchers);

  const byId = new Map(aging.map((a) => [a.leadId, a]));
  for (const rec of records) {
    const a = byId.get(rec.id);
    if (!a) continue;
    if (!a.leadName) {
      const fn = String(rec.data?.Full_Name || `${rec.data?.First_Name || ""} ${rec.data?.Last_Name || ""}`).trim();
      a.leadName = fn;
    }
    if (!a.owner) a.owner = String(rec.owner || "");
  }

  const filtered = aging.filter(
    (r) => (includeTerminal || !r.isTerminal) && r.agingDays >= minDays,
  );
  const items = sortByAgingDesc(filtered);
  const nextCursor = records.length === limit ? String(page + 1) : null;
  return { items, nextCursor, threshold: getLeadAgingThreshold(), scanned: records.length };
}
