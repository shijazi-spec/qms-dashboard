import { join } from "path";
import { readFileSync, existsSync } from "fs";
import {
  requireRoleOrKey,
  unauthorizedResponse,
} from "../../utils/rbacMiddleware";

const DUPLICATE_RADAR_READ_ROLES = [
  "admin",
  "grc_manager",
  "ai_specialist",
  "head_of_operations_quality",
  "quality_manager",
  "bu_owner",
  "executive",
] as const;

async function requireDuplicateRadarAccess(c: any) {
  return requireRoleOrKey(c, [...DUPLICATE_RADAR_READ_ROLES]);
}

// ---------------------------------------------------------------------------
// Preflight Structured Push helpers — smarter primary-contact selection +
// a Deal Description noting the other reachable contacts on the account.
// Pure (no Zoho/DB access) so they're safe to use in both the dry-run
// preview and the real-run payload builders.
// ---------------------------------------------------------------------------

// Seniority ladder for choosing a Deal's PRIMARY contact (Contact_Name).
// Higher = more senior (Sample User 2026-07-04). Owner / Founder / Partner sit at the
// top WITH C-level, then VP → Director → Head → Manager → everyone else.
function seniorityRank(title?: string | null): number {
  const t = String(title || "").toLowerCase();
  if (!t.trim()) return 0;
  if (/\bowner\b|\bfounder\b|\bco[-\s]?founder\b|\bpartner\b|\bproprietor\b|\bpresident\b|\bchair(?:man|woman|person)?\b/.test(t)) return 6;
  if (/\bchief\b|\bceo\b|\bcfo\b|\bcoo\b|\bcto\b|\bcio\b|\bcmo\b|\bcco\b|\bchro\b|\bcpo\b|\bcxo\b/.test(t)) return 6;
  if (/\bvp\b|\bvice[-\s]?president\b|\bevp\b|\bsvp\b/.test(t)) return 5;
  if (/\bmanaging\s+director\b|\bdirector\b/.test(t)) return 4;
  if (/\bhead\b/.test(t)) return 3;
  if (/\bmanager\b|\bsupervisor\b|\blead\b/.test(t)) return 2;
  return 1; // has a title but no recognised seniority keyword
}

// Pick a company's PRIMARY contact (the Deal's Contact_Name): the MOST SENIOR
// by title. Tie-break prefers a contact that HAS an email (reliable deal↔contact
// linkage), then original order. (Was: first email-bearing, ignoring seniority.)
function pickPrimaryContact<T extends { email?: string | null; title?: string | null }>(contacts: T[]): T | null {
  if (!contacts || contacts.length === 0) return null;
  let best: T | null = null;
  let bestRank = -1;
  let bestHasEmail = false;
  for (const r of contacts) {
    const rank = seniorityRank(r?.title);
    const hasEmail = !!String(r?.email || "").trim();
    if (best === null || rank > bestRank || (rank === bestRank && hasEmail && !bestHasEmail)) {
      best = r; bestRank = rank; bestHasEmail = hasEmail;
    }
  }
  return best || contacts[0];
}

// Build a plain-text Deal Description naming the primary contact and listing
// any OTHER contacts on the account (name + email + phone) so the sales
// agent knows who else can be reached. Returns "" when there's only one
// contact (callers should omit Description in that case).
function buildOtherContactsDescription(
  contacts: Array<{ contact_name?: string | null; email?: string | null; phone?: string | null }>,
  primary: { contact_name?: string | null; email?: string | null; phone?: string | null } | null,
): string {
  if (!contacts || contacts.length <= 1) return "";
  const label = (r: { contact_name?: string | null; email?: string | null; phone?: string | null } | null | undefined, fallback: string): string => {
    if (!r) return fallback;
    const name = String(r.contact_name || "").trim() || fallback;
    const reach = [String(r.email || "").trim(), String(r.phone || "").trim()].filter(Boolean).join(" / ");
    return reach ? `${name} (${reach})` : name;
  };
  const others = contacts.filter(r => r !== primary);
  const othersText = others.map(r => label(r, "(unnamed contact)")).join("; ");
  return `Primary contact: ${label(primary, "(unnamed contact)")}. Other contact(s) on this account: ${othersText}.`;
}

// Layer 1 of the push resolution ladder: for each row, resolve an EXISTING
// Zoho Account by the contact's real EMAIL domain first (the reliable employer
// signal), then the row's own domain, then its company name. Sets
// matched_account_zoho_id so the planner routes matched contacts to A1 (LINK to
// existing) instead of creating a new account or rejecting them — guaranteeing
// a person who belongs to an account we already have is never lost. Lookups are
// deduped per key. Rows that already carry a matched id are left untouched.
async function enrichRowsWithExistingAccounts(
  spRows: any[],
): Promise<{ rows: any[]; via: Map<number, string>; possibleClientOf: (row: any) => { zohoId: string; name: string } | null }> {
  const { getAccountDirectory } = await import("../../utils/duplicateRadarDatabase");
  const { realDomainRoot, normalizeCoreName, significantTokens, domainRootToken } =
    await import("../../utils/preflightStructuredPush");
  // ONE query loads the whole account directory; all matching is in-memory.
  const dir = await getAccountDirectory();

  // Fuzzy indexes for the "possible existing client" FLAG (never auto-links —
  // that stays on exact matches; this only warns for human verification).
  const byCore = new Map<string, { zohoId: string; name: string }>();
  const byNameToken = new Map<string, { zohoId: string; name: string }>();
  for (const ref of dir.byId.values()) {
    const core = normalizeCoreName(ref.name);
    if (core.length >= 4 && !byCore.has(core)) byCore.set(core, ref);
    for (const tok of significantTokens(ref.name)) if (!byNameToken.has(tok)) byNameToken.set(tok, ref);
  }
  // Warn only for rows that did NOT auto-match (else they'd be A1 already).
  const possibleClientOf = (row: any): { zohoId: string; name: string } | null => {
    if (String(row?.matched_account_zoho_id || "").trim()) return null;
    const core = normalizeCoreName(row?.company);
    if (core.length >= 4 && byCore.has(core)) return byCore.get(core)!;
    const root = domainRootToken(row?.domain) || domainRootToken(row?.email);
    if (root && root.length >= 4 && byNameToken.has(root)) return byNameToken.get(root)!;
    return null;
  };
  const byDomain = (d: string | null): { zohoId: string; name: string } | null =>
    d ? dir.byDomain.get(d) || null : null;
  const byName = (n: string): { zohoId: string; name: string } | null => {
    const k = String(n || "").trim().toLowerCase();
    return k.length >= 3 ? dir.byName.get(k) || null : null;
  };
  const via = new Map<number, string>();
  const rows: any[] = [];
  for (const r of spRows) {
    const presetId = String(r.matched_account_zoho_id || "").trim();
    if (presetId) {
      via.set(r.row_index, "preset");
      // Fill the account NAME for a preset id (from the preflight CS match)
      // so the UI shows "<Account>" instead of a bare id.
      if (!String(r.matched_account_name || "").trim()) {
        const known = dir.byId.get(presetId);
        rows.push(known ? { ...r, matched_account_name: known.name } : r);
      } else {
        rows.push(r);
      }
      continue;
    }
    const emailDom = realDomainRoot(r.email);
    const rowDom = realDomainRoot(r.domain);
    let ref: { zohoId: string; name: string } | null = null;
    let matchedVia = "";
    if (emailDom) { ref = byDomain(emailDom); if (ref) matchedVia = "email_domain"; }
    if (!ref && rowDom) { ref = byDomain(rowDom); if (ref) matchedVia = "row_domain"; }
    if (!ref && String(r.company || "").trim().length >= 3) { ref = byName(r.company); if (ref) matchedVia = "company_name"; }
    if (ref) { via.set(r.row_index, matchedVia); rows.push({ ...r, matched_account_zoho_id: ref.zohoId, matched_account_name: ref.name }); }
    else rows.push(r);
  }
  return { rows, via, possibleClientOf };
}

/**
 * Valid AI-status chip values. ONE list, shared by every route that accepts the
 * chip — parseRecordTabFilters had its own copy while /filtered-clusters read
 * no chip at all, so the per-tab endpoints filtered and the cluster grid did
 * not.
 */
const AI_STATUS_VALUES = [
  "active",
  "tagged_pending",
  "resolved",
  "dismissed",
  "all",
];

// Parse the shared Advanced Filters query params used by the per-tab record
// endpoints (leads/deals/contacts/accounts). The Module filter is intentionally
// omitted: each record tab already pins its own module, so module selection is
// driven by which tab is active, not by this query param.
function parseRecordTabFilters(url: URL): {
  start_date?: string;
  end_date?: string;
  period_year?: number;
  period_quarter?: number;
  owners?: string[];
  layouts?: string[];
  pipelines?: string[];
  stages?: string[];
  confidence_level?: string;
  domain?: string;
  ai_status?: string;
  segment?: "all" | "marketplace" | "corporate" | "ExampleOrg" | "walaone";
  sort?: string;
  dir?: "asc" | "desc";
} {
  const csv = (key: string): string[] | undefined => {
    const raw = url.searchParams.get(key);
    if (!raw) return undefined;
    const vals = raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return vals.length > 0 ? vals : undefined;
  };
  // AI-status chip: active (untouched) | tagged_pending | resolved | all.
  // Whitelist enforced server-side so the DB query can't see unknown values.
  const rawAi = (url.searchParams.get("ai_status") || "").trim();
  const ai_status = AI_STATUS_VALUES.includes(rawAi)
    ? rawAi
    : undefined;
  // Corporate/Marketplace segment chip — same whitelist contract as
  // ai_status above, mirrors DuplicateFilters["segment"] (database.ts:143).
  // Anything else (including absent/"all") means no constraint.
  const rawSegment = (url.searchParams.get("segment") || "").trim();
  const segment = ["marketplace", "corporate", "ExampleOrg", "walaone"].includes(rawSegment)
    ? (rawSegment as "marketplace" | "corporate" | "ExampleOrg" | "walaone")
    : undefined;
  // Column sort — same contract as /api/duplicates/clusters (sort/dir read
  // here, validated against RECORD_SORT_COLUMNS down in
  // getDuplicateRecordsByType; an unrecognized `sort` falls back to the
  // existing default there, so no whitelist duplication is needed at this
  // route layer). dir is normalized to lowercase; the DB layer validates it
  // to exactly ASC/DESC before it ever reaches SQL.
  const rawDir = (url.searchParams.get("dir") || "").trim().toLowerCase();
  const dir = rawDir === "asc" || rawDir === "desc" ? (rawDir as "asc" | "desc") : undefined;
  // Quarter / year chip — parsed once here so every duplicate tab that goes
  // through this helper honours it identically. Implausible values are dropped
  // rather than passed on, so a bad query string falls back to "all time"
  // instead of silently filtering to an empty window.
  const pyRaw = parseInt(url.searchParams.get("period_year") || "", 10);
  const pqRaw = parseInt(url.searchParams.get("period_quarter") || "", 10);
  const period_year = pyRaw >= 2000 && pyRaw <= 2100 ? pyRaw : undefined;
  const period_quarter =
    period_year && pqRaw >= 1 && pqRaw <= 4 ? pqRaw : undefined;
  return {
    start_date: url.searchParams.get("start_date") || undefined,
    end_date: url.searchParams.get("end_date") || undefined,
    period_year,
    period_quarter,
    owners: csv("owners"),
    layouts: csv("layouts"),
    pipelines: csv("pipelines"),
    stages: csv("stages"),
    confidence_level: url.searchParams.get("confidence_level") || undefined,
    domain: url.searchParams.get("domain") || undefined,
    ai_status,
    segment,
    sort: url.searchParams.get("sort") || undefined,
    dir,
  };
}

// Shared loader for the four record-tab endpoints (leads/deals/contacts/
// accounts). On-open live-verify (Sample User 2026-07-15): the inline record lists
// draw straight from the mirror, so a record already DELETED in Zoho could
// still show a row until a sweep reached it — same class of ghost the cluster
// preview had. When the tab requests ?verify=1 we live-check the records in
// the clusters shown on THIS page against Zoho, prune the ghosts + mark
// converted leads, recompute those clusters' stats, then re-read — so the list
// only shows records that still exist in the CRM. Bounded to the visible page's
// clusters + a hard record cap so it can't hammer Zoho; failure is non-fatal
// (the list still renders from the mirror).
async function loadRecordTabWithVerify(
  recordType: "lead" | "deal" | "contact" | "account",
  url: URL,
): Promise<{ limit: number; offset: number; result: { groups: any[]; total: number } }> {
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const filters = parseRecordTabFilters(url);
  let result = await getDuplicateRecordsByType(recordType, {
    limit,
    offset,
    ...filters,
  });
  if (url.searchParams.get("verify") === "1" && result.groups.length > 0) {
    try {
      const cids = result.groups
        .map((g: any) => Number(g.id))
        .filter((n: number) => Number.isFinite(n));
      if (cids.length > 0) {
        const { reconcileDeletedRecords } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        const rc = await reconcileDeletedRecords({
          module: recordType,
          clusterIds: cids,
          limit: 150,
        });
        if (rc.pruned > 0 || rc.converted > 0) {
          try {
            const { updateClusterStats } = await import(
              "../../utils/duplicateRadarDatabase"
            );
            await Promise.all(
              cids.map((id: number) => updateClusterStats(id).catch(() => {})),
            );
          } catch {
            /* best-effort stats refresh */
          }
          result = await getDuplicateRecordsByType(recordType, {
            limit,
            offset,
            ...filters,
          });
        }
      }
    } catch (e: any) {
      logger.warn(
        `[record-tab ${recordType}] on-open verify failed (non-fatal): ${e?.message || e}`,
      );
    }
  }
  return { limit, offset, result };
}

import {
  initDuplicateRadarTables,
  getAllClusters,
  getClusterCount,
  getClusterById,
  getClusterMixedSignal,
  getRecordsByClusterId,
  splitRecordsIntoNewCluster,
  splitRecordsIntoNewClusterInTx,
  updateClusterStats,
  getClusterSummary,
  getDuplicatesByOwner,
  getDuplicatesBySource,
  updateClusterStatus,
  createDetectionLog,
  getDetectionLogs,
  createExportLog,
  clearMockData,
  getKPIMetrics,
  addRecordToCluster,
  upsertRecord,
  findOrCreateClusterByDomain,
  searchDuplicates,
  createCluster,
  clearAllDuplicateData,
  truncateAllDuplicateData,
  backfillResolutionLedger,
  restoreLedgerResolvedClusterStatus,
  reconcileAutoMergedContactDeletions,
  captureDuplicateProgressSnapshot,
  getDuplicateProgressSeries,
  cleanupStaleRecords,
  cleanupOrphanClusters,
  markRecordsStalePendingByIds,
  removeRecordsByZohoIds,
  getClusterRecordTypeMeta,
  getSyncState,
  getAllClustersByInflation,
  getOwnerOpenDeals,
  bulkUpdateOwnerDeals,
  reconcileCrmIds,
  verifyCrmIdsInZoho,
  getClustersBySignal,
  findOrCreateClusterByCompany,
  getSeparationParticipants,
  upsertDealDocCompliance,
  getDealDocCompliance,
  normalizeCompanyName,
  extractDomain,
  normalizePhone,
  resolveCluster,
  bulkResolve,
  getMergeHistory,
  getTaggedRecordDbIdsByCluster,
  bulkSplitContactClustersByStrictRule,
  markPrimaryRecord,
  getOwnerAccountability,
  getPacketSettings,
  checkForDuplicates,
  getEnhancedSummary,
  getLastScanDate,
  getDuplicateRecordsByType,
  getExportRecords,
  autoResolveClusters,
  generateSmartRecommendations,
  getAllSyncStates,
  upsertSyncState,
  getDistinctOwners,
  getDistinctLayouts,
  getDistinctDomains,
  getDistinctPipelines,
  getDistinctStages,
  getDistinctProducts,
  getFilteredClusters,
  getFilteredSummary,
  upsertTask,
  getTasksForRecords,
  getTaskCountForCluster,
  pool as sharedDuplicateRadarPool,
} from "../../utils/duplicateRadarDatabase";

import type { DuplicateFilters } from "../../utils/duplicateRadarDatabase";
import { extractCsFieldsFromRawData } from "../../utils/duplicateRadarCsOverlap";

import {
  fetchAllZohoRecords,
  fetchDeletedZohoRecords,
  fetchZohoRecordById,
  fetchRecordAttachments,
  fetchZohoRelatedRecords,
  removeZohoTags,
} from "../../utils/zohoCRM";
import {
  DEAL_COMPLIANCE_STAGES,
  requiredDocsForStage,
  evaluateDocCompliance,
} from "../../utils/dealComplianceCheck";

import { logger } from "../../utils/logger";
import {
  buildMergePlan,
  MODULE_RECORD_TYPE,
  type CrmModule,
} from "../../utils/duplicateMergePlanner";

const AGENTIC_MODULES: CrmModule[] = ["Accounts", "Leads", "Deals", "Contacts"];
/** Parse + validate the `module` field from a request body; defaults Accounts. */
function parseAgenticModule(body: any): CrmModule {
  const m = typeof body?.module === "string" ? body.module : "Accounts";
  return (AGENTIC_MODULES as string[]).includes(m) ? (m as CrmModule) : "Accounts";
}
import { executeMergePlan } from "../../utils/duplicateMergeExecutor";
import {
  recordResolutionEvent,
  getResolutionLearnings,
  getResolutionActivity,
} from "../../utils/duplicateResolutionLearning";
import {
  runAutonomousResolution,
  runResolutionForCluster,
  undoClusterResolution,
  getResolutionRunConfig,
  resolveResolutionRunConfig,
  setResolutionSetting,
  isResolutionSlackConfigured,
  sendResolutionSlackTest,
  postResolutionMessage,
  buildExecutiveBriefText,
  postWeeklyExecBrief,
  postResolutionDigest,
  cleanupZeroResolutionPings,
  ADAM_NOTIFICATION_SCHEDULE,
  getModuleResolutionBreakdown,
  type ResolutionMode,
} from "../../utils/duplicateResolutionRunner";

// Management tier allowed to flip the agent's mode / kill switch (writes to Zoho).
const AUTONOMOUS_RESOLUTION_MANAGE_ROLES = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
] as const;
import {
  listResolutionRules,
  recordResolutionRule,
  setResolutionRuleEnabled,
  type RuleDecision,
} from "../../utils/duplicateResolutionRules";
import { getGradeHistory } from "../../utils/duplicateResolutionGrades";
// Default to fetching the entire module so duplicate detection reflects the
// real CRM. Set DUPLICATE_SCAN_LIMIT to a positive integer to re-cap (useful
// for staging or when Zoho daily-credit budget is tight). An unset, blank,
// "0", or non-numeric value means "no cap" → fetchAllZohoRecords treats
// Infinity as "page until Zoho says more_records=false".
const SCAN_MAX_PER_MODULE = (() => {
  const raw = process.env.DUPLICATE_SCAN_LIMIT;
  if (!raw) return Infinity;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

interface ScanState {
  status: "idle" | "scanning" | "completed" | "failed";
  progress: string;
  startedAt: number | null;
  /** Heartbeat: last time the scan emitted forward progress. Staleness is judged
   * from THIS, not startedAt — a long-but-progressing sync (e.g. a 68k-contact
   * full pull) is healthy and must NOT be reset just for running > 20 min. */
  lastProgressAt: number | null;
  completedAt: number | null;
  result: any | null;
  error: string | null;
  moduleStatuses: Record<string, string>;
  recordCounts: Record<string, number>;
  percentage: number;
}

const scanState: ScanState = {
  status: "idle",
  progress: "",
  startedAt: null,
  lastProgressAt: null,
  completedAt: null,
  result: null,
  error: null,
  moduleStatuses: {},
  recordCounts: {},
  percentage: 0,
};

// Monotonic scan "generation" — each run captures its number at start; a run
// only writes terminal state if it's still the current generation. This fences
// a stale background run (released below) from clobbering a newer run's state.
let scanGeneration = 0;

// A scan that's been "scanning" longer than this is treated as stalled and its
// lock can be reclaimed (e.g. the process was killed mid-run, or Zoho hung).
const STALE_SCAN_MS = (() => {
  const n = parseInt(process.env.DUPLICATE_SCAN_STALE_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000; // default 20 min
})();

/**
 * Gate for starting a new scan. Returns a block reason when a HEALTHY scan is
 * still running; otherwise releases a stale (or force-reset) "scanning" lock
 * and returns null so the caller proceeds. The released run, if still alive in
 * the background, is fenced by scanGeneration so it can't clobber the new run.
 */
function blockOrClearScan(force: boolean): { error: string; ageMinutes: number } | null {
  if (scanState.status !== "scanning") return null;
  // Staleness is measured from the LAST PROGRESS heartbeat, not the scan's start.
  // A sync that's still emitting progress is healthy no matter how long it has
  // run (a full 68k-contact pull legitimately takes far longer than 20 min); only
  // one that has made NO progress for STALE_SCAN_MS is treated as hung. This stops
  // the restart loop where every cron/fallback trigger killed an in-flight long
  // sync, so Contacts never finished and its baseline never saved.
  const heartbeat = scanState.lastProgressAt || scanState.startedAt;
  const idleMs = heartbeat ? Date.now() - heartbeat : Infinity;
  const ageMs = scanState.startedAt ? Date.now() - scanState.startedAt : Infinity;
  const ageMinutes = Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : 0;
  const idleMinutes = Number.isFinite(idleMs) ? Math.round(idleMs / 60000) : 0;
  if (!force && idleMs < STALE_SCAN_MS) {
    return { error: "A scan is already in progress", ageMinutes };
  }
  logger.warn(
    `🧹 [DuplicateRadar] Releasing ${force ? "force-reset" : "stale"} scan lock (running ${ageMinutes}m, idle ${idleMinutes}m, no progress) — starting fresh`,
  );
  scanState.status = "failed";
  scanState.error = force
    ? "Reset by admin"
    : `Auto-reset: previous scan stalled (${ageMinutes}m)`;
  return null;
}

// SSE listeners for C1: real-time progress
let sseClients: Array<{
  id: string;
  controller: ReadableStreamDefaultController;
}> = [];

function broadcastSSE(event: string, data: any) {
  // Heartbeat: a "progress" emit (fetch %/scoring) OR a "module" emit (fired
  // every 200 records during the per-record write loop) means the scan is alive
  // and moving forward. blockOrClearScan reads lastProgressAt so a long-but-
  // progressing sync is never mistaken for a stalled one and reset — the bug that
  // made the 68k-Contacts pull restart forever and never complete (Sample User 2026-06-30).
  if (scanState.status === "scanning" && (event === "progress" || event === "module")) {
    scanState.lastProgressAt = Date.now();
  }
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter((client) => {
    try {
      client.controller.enqueue(new TextEncoder().encode(msg));
      return true;
    } catch {
      return false;
    }
  });
}

interface ExtractedRecord {
  companyName: string;
  email: string;
  phone: string;
  recordName: string;
  domain: string | null;
  ownerName: string;
  ownerEmail: string;
  status: string;
  stage?: string;
  dealValue?: number;
  source: string;
  createdTime: string;
  modifiedTime: string;
  layoutName?: string;
  layoutId?: string;
  zohoModule?: string;
  pipeline?: string;
  products?: string;
  mobile?: string;
  contactName?: string;
  accountName?: string;
  crNumber?: string;
  vatNumber?: string;
  website?: string;
  country?: string;
  region?: string;
  industry?: string;
  noOfEmployees?: number;
  title?: string;
  leadType?: string;
  govType?: string;
  accountType?: string;
}

// Errors that indicate the database is in a state where NO record will ever
// succeed — schema drift, missing column, missing extension, exhausted
// connection pool, etc. When we hit one of these, swallowing it per-record
// just lets the loop "complete" with 0 writes and stamps the sync chip green.
// That is the exact silent-failure mode that made the radar look empty in
// May 2026. Treat these as fatal: bubble out so the whole scan fails loudly.
function isFatalPersistenceError(err: any): boolean {
  const msg = String(err?.message || err || "");
  const code = String(err?.code || "");
  // Postgres SQLSTATE class:
  //   42xxx — syntax error / schema mismatch (missing column, undefined func)
  //   53xxx — out of resources (connection pool exhausted, disk full)
  //   57xxx — operator intervention (admin shutdown, query canceled)
  //   58xxx — system error
  //   08xxx — connection exception
  if (/^(08|42|53|57|58)\d{3}$/.test(code)) return true;
  // Generic "column does not exist" / "relation does not exist" string match
  // for cases where the driver doesn't surface the SQLSTATE code cleanly.
  if (/column .* does not exist/i.test(msg)) return true;
  if (/relation .* does not exist/i.test(msg)) return true;
  if (/no such column/i.test(msg)) return true;
  if (/connection terminated/i.test(msg)) return true;
  if (/too many connections/i.test(msg)) return true;
  return false;
}

async function processModule(
  moduleName: string,
  recordType: "lead" | "deal" | "contact" | "account",
  clustersUpdated: Set<number>,
  extractRecord: (record: any) => ExtractedRecord,
  // Incremental sync: when set (ISO8601), only records modified at/after this
  // time are fetched from Zoho (via the If-Modified-Since header). undefined =
  // full pull (first sync, or an explicit "Rebuild all").
  ifModifiedSince?: string,
  // Live progress reporter — receives this module's completion fraction (0..1)
  // as it fetches then writes, so the caller can advance the shared 10→60%
  // "fetch band" smoothly instead of leaving it frozen at 10% until every
  // module's parallel Promise.all settles. Never throws into the loop.
  onProgress?: (frac: number) => void,
): Promise<{ count: number; written: number; skipped: number }> {
  const t0 = Date.now();
  let records: any[] = [];
  scanState.moduleStatuses[moduleName] = "fetching";
  broadcastSSE("module", { module: moduleName, status: "fetching" });

  try {
    await upsertSyncState(moduleName, 0, "syncing");
    records = await fetchAllZohoRecords(moduleName, {
      maxRecords: SCAN_MAX_PER_MODULE,
      ifModifiedSince,
      // Surface live page counts: update the chip with the running fetched
      // total and nudge the fetch band (asymptotic — we don't know the total
      // page count up front, so approach ~0.45 of this module's slice).
      onProgress: (fetched, page) => {
        scanState.recordCounts[moduleName] = fetched;
        broadcastSSE("module", {
          module: moduleName,
          status: "fetching",
          count: fetched,
        });
        if (onProgress) onProgress(Math.min(0.45, 0.45 * (1 - 1 / (1 + page / 12))));
      },
    });
  } catch (e: any) {
    logger.error(`Error fetching ${moduleName}:`, e);
    scanState.moduleStatuses[moduleName] = "error";
    broadcastSSE("module", { module: moduleName, status: "error" });
    await upsertSyncState(moduleName, 0, "failed");
    // Resilience (Sample User 2026-06-23): a module that rate-limits / errors is
    // already marked "failed" above (its chip shows "0 (failed)"), so DON'T
    // abort the whole scan — let the OTHER modules finish and ADVANCE THEIR
    // cursors. This breaks the stuck-sync cycle: when one huge module (e.g.
    // Leads) can't complete in one window, the smaller modules still sync, and
    // the next run only retries the failed one against a fresh cursor instead
    // of re-pulling everything from scratch every time. (Previously a single
    // rate-limit threw and failed the entire run, so nothing ever advanced.)
    return { count: 0, written: 0, skipped: 0 };
  }

  logger.info(
    `📥 [DuplicateRadar] Fetched ${records.length} ${moduleName} from Zoho`,
  );
  scanState.moduleStatuses[moduleName] = "processing";
  scanState.recordCounts[moduleName] = records.length;
  broadcastSSE("module", {
    module: moduleName,
    status: "processing",
    count: records.length,
  });
  // Fetch sub-phase done — the write sub-phase fills the remaining half of
  // this module's slice (0.5 → 1.0), reported exactly by written/total below.
  if (onProgress) onProgress(0.5);

  // ── FAST-PATH PREFETCH (Sample User 2026-07-06 — sync speedup) ─────────────────
  // The incremental sync re-pulls every record touched since the last sync.
  // During a bulk migration that's tens of thousands of rows whose clustering
  // IDENTITY (company / domain / email / phone / name) did NOT change — only
  // mutable fields (title, owner, stage…) did. Re-running the ~5-query
  // findOrCreateClusterByCompany for each is wasted work. Prefetch the already-
  // stored identity for this batch in ONE chunked query (JOINed to
  // duplicate_clusters so a dangling cluster_id is never reused); when a
  // record's identity is unchanged AND it isn't in the separation ledger, reuse
  // its current cluster — the deterministic clusterer would return that same
  // cluster — and go straight to the idempotent upsert. Pure optimisation: a
  // new record, ANY identity change, or a separated record falls through to the
  // full clusterer, so cluster assignment is byte-for-byte unchanged.
  const _existingById = new Map<string, any>();
  let _sepParticipants: Set<string> = new Set();
  try {
    _sepParticipants = await getSeparationParticipants();
  } catch {
    /* no participants cache → those records simply take the full clusterer */
  }
  try {
    const { pool } = await import("../../utils/duplicateRadarDatabase");
    const _ids = records.map((r) => r.id).filter((x): x is string => !!x);
    const PF_CHUNK = 5000;
    for (let i = 0; i < _ids.length; i += PF_CHUNK) {
      const slice = _ids.slice(i, i + PF_CHUNK);
      const ex = await pool.query(
        `SELECT dr.zoho_record_id AS z, dr.cluster_id, dr.company_name, dr.domain,
                dr.email, dr.phone, dr.record_name,
                dr.deal_value, dr.owner_name, dr.owner_email
           FROM duplicate_records dr
           JOIN duplicate_clusters dc ON dc.id = dr.cluster_id
          WHERE dr.zoho_record_id = ANY($1::text[])`,
        [slice],
      );
      for (const row of ex.rows) _existingById.set(row.z, row);
    }
  } catch (e) {
    logger.warn(
      `[DuplicateRadar] ${moduleName}: fast-path prefetch skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
    _existingById.clear();
  }
  // RAW-equal identity ⟹ normalized-equal ⟹ the clusterer returns the same
  // cluster. Conservative: a cosmetic-only difference just falls to the slow path.
  const _identityUnchanged = (stored: any, d: ExtractedRecord): boolean => {
    if (!stored) return false;
    const s = (v: any) => (v == null ? "" : String(v));
    const lc = (v: any) => s(v).toLowerCase();
    return (
      s(stored.company_name) === s(d.companyName) &&
      s(stored.domain) === s(d.domain) &&
      lc(stored.email) === lc(d.email) &&
      s(stored.phone) === s(d.phone) &&
      s(stored.record_name) === s(d.recordName)
    );
  };
  // Incremental scoring (Sample User 2026-07-08): a re-fetched record with UNCHANGED
  // identity still lands in the same cluster, but updateClusterStats only moves
  // the cluster's counts/confidence/owners/inflation when a SCORING-relevant
  // field changed — deal_value or owner. modified_date alone (the reason the
  // incremental fetch even returned this record) changes no material stat. So
  // when identity + these are unchanged we reuse the cluster AND skip re-scoring
  // it, collapsing the scoring phase from "score every touched cluster" (92k+)
  // to "score only the ones that actually moved".
  const _scoringUnchanged = (stored: any, d: ExtractedRecord): boolean => {
    const num = (v: any) => {
      const n = parseFloat(String(v));
      return Number.isFinite(n) ? n : 0;
    };
    const s = (v: any) => (v == null ? "" : String(v));
    return (
      num(stored.deal_value) === num(d.dealValue) &&
      s(stored.owner_name) === s(d.ownerName) &&
      s(stored.owner_email).toLowerCase() === s(d.ownerEmail).toLowerCase()
    );
  };

  let written = 0;
  let skipped = 0;
  let droppedNoCompany = 0;
  let reusedCluster = 0;
  let <REDACTED_TOKEN> = 0;
  let processedInLoop = 0;
  for (const record of records) {
    try {
      const data = extractRecord(record);
      if (!data.companyName || data.companyName === "Unknown") {
        // Previously a silent `continue`. Now we count it so the post-loop
        // summary can flag a Zoho layout that doesn't populate Company /
        // Account_Name / Last_Name as expected — that was the only other
        // explanation for an apparently-successful sync with 0 writes.
        droppedNoCompany++;
        continue;
      }

      // Fast path: unchanged identity + not separated → reuse current cluster.
      const _prev = record.id ? _existingById.get(record.id) : null;
      let _clusterId: number;
      // Whether this record's write should trigger a cluster re-score. A brand-
      // new record, a moved/changed record, or a scoring-field change → yes. An
      // identity- AND scoring-unchanged re-fetch → no (its cluster is untouched).
      let _rescore = true;
      if (_prev && !_sepParticipants.has(record.id) && _identityUnchanged(_prev, data)) {
        _clusterId = _prev.cluster_id as number;
        reusedCluster++;
        if (_scoringUnchanged(_prev, data)) {
          _rescore = false;
          <REDACTED_TOKEN>++;
        }
      } else {
        const cluster = await findOrCreateClusterByCompany(
          data.companyName,
          data.domain || undefined,
          data.phone || undefined,
          data.email || undefined,
          // Pass recordType + recordName so contacts route to the strict
          // ≥2-attribute path; every other module keeps the legacy
          // company-name clustering behaviour verbatim.
          recordType,
          data.recordName,
          // Zoho id → lets the clusterer honor the separation ledger so a record
          // the operator split/dismissed apart is never silently re-fused.
          record.id,
        );
        _clusterId = cluster.id!;
        // If this record MOVED out of a previous cluster (its identity changed
        // and it re-clustered elsewhere), the OLD cluster lost a member — queue
        // it for re-scoring too so its counts/inflation don't go stale.
        if (
          _prev &&
          _prev.cluster_id != null &&
          Number(_prev.cluster_id) !== _clusterId
        ) {
          clustersUpdated.add(Number(_prev.cluster_id));
        }
      }

      await upsertRecord({
        cluster_id: _clusterId,
        record_type: recordType,
        zoho_record_id: record.id,
        record_name: data.recordName,
        company_name: data.companyName,
        email: data.email || undefined,
        domain: data.domain || undefined,
        phone: data.phone || undefined,
        mobile: data.mobile || undefined,
        owner_name: data.ownerName,
        owner_email: data.ownerEmail,
        status: data.status,
        stage: data.stage,
        deal_value: data.dealValue,
        source: data.source,
        created_date: data.createdTime
          ? new Date(data.createdTime)
          : new Date(),
        modified_date: data.modifiedTime
          ? new Date(data.modifiedTime)
          : new Date(),
        is_primary: false,
        confidence_score: 0,
        is_mock_data: false,
        raw_data: record.data,
        layout_name: data.layoutName,
        layout_id: data.layoutId,
        zoho_module: data.zohoModule || moduleName,
        pipeline: data.pipeline,
        products: data.products,
        contact_name: data.contactName,
        account_name: data.accountName,
        cr_number: data.crNumber,
        vat_number: data.vatNumber,
        website: data.website,
        country: data.country,
        region: data.region,
        industry: data.industry,
        no_of_employees: data.noOfEmployees,
        title: data.title,
        lead_type: data.leadType,
        gov_type: data.govType,
        account_type: data.accountType,
      });

      written++;
      // Only queue the cluster for re-scoring when something material changed —
      // see _rescore above. Unchanged re-fetches leave their cluster's stats as-is.
      if (_rescore) clustersUpdated.add(_clusterId);
    } catch (recordErr: any) {
      // Schema/connection-class errors mean NO record will succeed — fail
      // the whole scan loudly instead of looping through 5,000 identical
      // failures and stamping "completed" at the end.
      if (isFatalPersistenceError(recordErr)) {
        logger.error(
          `❌ [DuplicateRadar] Fatal persistence error on ${moduleName} record ${record.id} — aborting scan:`,
          recordErr,
        );
        await upsertSyncState(moduleName, written, "failed");
        throw recordErr;
      }
      skipped++;
      if (skipped <= 5)
        logger.warn(
          `⚠️ [DuplicateRadar] Skipped ${moduleName} record ${record.id}: ${recordErr}`,
        );
    }
    processedInLoop++;
    if (processedInLoop % 200 === 0) {
      broadcastSSE("module", {
        module: moduleName,
        status: "processing",
        count: written,
      });
      if (onProgress && records.length > 0)
        onProgress(0.5 + 0.5 * (processedInLoop / records.length));
    }
  }
  if (droppedNoCompany > 0)
    logger.warn(
      `⚠️ [DuplicateRadar] ${moduleName}: dropped ${droppedNoCompany} record(s) with no extractable company name (Zoho layout likely missing Company / Account_Name / Last_Name)`,
    );
  if (skipped > 0)
    logger.warn(
      `⚠️ [DuplicateRadar] Skipped ${skipped} ${moduleName} records due to errors`,
    );

  scanState.moduleStatuses[moduleName] = "done";
  if (onProgress) onProgress(1);
  broadcastSSE("module", {
    module: moduleName,
    status: "done",
    count: written,
  });
  // INSTRUMENTATION (2026-06-20) — per-module timing so a slow sync is
  // diagnosable from the logs: how long each module took, how many records
  // it fetched vs wrote. A module that dominates the wall-clock (rate-limited
  // fetch or a huge changed-set) shows up here immediately.
  logger.info(
    `⏱️ [DuplicateRadar] ${moduleName} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — fetched ${records.length}, written ${written}, skipped ${skipped + droppedNoCompany}, reused-cluster ${reusedCluster}/${written} (fast-path skipped the full clusterer), no-rescore ${<REDACTED_TOKEN>}/${written} (scoring-phase skip)`,
  );
  // CHIP HONESTY: report the count actually persisted to the database, not
  // the count fetched from Zoho. Previously this passed records.length even
  // when every upsertRecord threw — sync_status went 'completed' / 5000
  // while duplicate_records stayed empty, which is what hid the silent
  // failure for weeks. If `written < records.length` something dropped
  // rows; if `written === 0 && records.length > 0` the chip will say
  // "0 (completed)" instead of lying about 5,000.
  await upsertSyncState(moduleName, written, "completed");
  return { count: records.length, written, skipped: skipped + droppedNoCompany };
}

/**
 * Run module-fetch tasks with bounded concurrency. Default 1 (sequential) keeps
 * the number of simultaneous Zoho API calls low so a multi-module sync doesn't
 * trip Zoho's rate / concurrency limit — the cause of "Leads/Deals/Accounts:
 * error" while one module squeaked through. A task that throws still rejects
 * (same as Promise.all). Results preserve input order.
 */
async function runModulesWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) break;
      results[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// Detect records deleted/merged inside Zoho CRM since the last successful sync
// and purge them from the duplicate radar. Without this, a manual Zoho merge
// would leave the losing record visible in the radar forever (Modified_Time
// filters never return deleted records).
async function runDeletionDetection(
  clustersUpdated: Set<number>,
  // Per-module last_sync_at captured BEFORE this scan's fetch ran. CRITICAL
  // (Sample User 2026-07-07 "deleted data still shows" bug): the fetch calls
  // upsertSyncState which sets last_sync_at = NOW(), so re-reading it here gave
  // "now" → the Zoho /deleted feed window became [now, now] = empty and NO
  // deletion was ever detected. Ghost records (deleted/merged in Zoho) then
  // lingered in the radar forever — clusters showed records that 404 when
  // opened in Zoho. Using the PRE-fetch baseline asks Zoho for everything
  // deleted SINCE the last completed sync, which is the whole point of the pass.
  baselines: Record<string, string | undefined>,
): Promise<{
  totalRemoved: number;
  perModule: Record<string, number>;
}> {
  const modules: Array<{ name: string }> = [
    { name: "Leads" },
    { name: "Deals" },
    { name: "Contacts" },
    { name: "Accounts" },
  ];
  const perModule: Record<string, number> = {};
  let totalRemoved = 0;

  // Self-healing lookback floor (Sample User 2026-07-13 "deleted deals still show
  // after sync, many times"): a narrow [last_sync, now] window silently MISSES
  // deletions whenever a sync is skipped by the single-flight guard, fails
  // transiently, or the deletion lands just outside the window — the ghost then
  // lingers forever (the modified-since fetch never returns deleted records).
  // Widen `since` to at least N days ago so every sweep re-asks Zoho for
  // everything deleted recently and RECOVERS earlier misses. removeRecordsByZohoIds
  // is idempotent, so re-seeing an already-pruned id is a harmless no-op. The
  // /deleted feed is bulk-paginated (cheap), not per-record. 0 disables the floor.
  const lookbackDays = parseInt(
    process.env.RADAR_DELETION_LOOKBACK_DAYS || "30",
    10,
  );
  const lookbackFloorIso =
    lookbackDays > 0
      ? new Date(Date.now() - lookbackDays * 86400000).toISOString()
      : null;

  for (const m of modules) {
    try {
      const baseline = baselines[m.name] || undefined;
      // Skip on first ever sync — no baseline to diff against, and the
      // initial fetch will populate the radar from scratch anyway.
      if (!baseline) {
        perModule[m.name] = 0;
        continue;
      }
      // Never SHRINK an already-wide window: use the earlier of (baseline, floor).
      let since = baseline;
      if (lookbackFloorIso && new Date(lookbackFloorIso) < new Date(baseline)) {
        since = lookbackFloorIso;
      }
      const deleted = await fetchDeletedZohoRecords(m.name, {
        type: "all",
        modifiedSince: since,
      });
      if (deleted.length === 0) {
        perModule[m.name] = 0;
        continue;
      }
      const ids = deleted.map((d) => d.id).filter(Boolean);
      // Remove by zoho_record_id ALONE (no module filter): Zoho ids are globally
      // unique, and the /deleted feed already scoped these to this module — but
      // the module filter silently MISSED ghost rows whose zoho_module column is
      // NULL (legacy rows) or mismatched, leaving them lingering. (Sample User 2026-07-15)
      const { removedCount, affectedClusterIds } =
        await removeRecordsByZohoIds(ids);
      affectedClusterIds.forEach((id) => clustersUpdated.add(id));
      perModule[m.name] = removedCount;
      totalRemoved += removedCount;
    } catch (e: any) {
      logger.warn(
        `⚠️ [DuplicateRadar] Deletion detection failed for ${m.name} (non-fatal):`,
        e?.message || e,
      );
      perModule[m.name] = 0;
    }
  }
  return { totalRemoved, perModule };
}

async function scanZohoCRMForDuplicates(
  detectionType: "manual" | "scheduled" | "interval-fallback" = "manual",
  // When true, force a FULL rebuild (wipe + re-pull every record) instead of
  // the default incremental (changed-records-only) sync. Wired to a "Rebuild
  // all" control; routine syncs stay incremental and finish in ~1-2 min.
  forceFull = false,
): Promise<{
  success: boolean;
  totalRecordsScanned: number;
  totalClustersFound: number;
  duplicatesDetected: number;
  highConfidence: number;
  mediumConfidence: number;
  moduleBreakdown: any[];
  pipelineInflation: number;
  durationMs: number;
  error?: string;
}> {
  const startTime = Date.now();

  // SINGLE-FLIGHT GUARD (Sample User 2026-06-30): the scheduled crons + the in-process
  // fallback call this function DIRECTLY (not via the /scan endpoint), so they
  // previously bypassed blockOrClearScan and could start a SECOND scan on top of
  // a healthy long-running one — abandoning the in-flight 68k-Contacts pass
  // (its terminal write gets fenced) so it never finished. Centralise the guard
  // here: if a scan is already running AND still making progress (heartbeat fresh),
  // skip this trigger instead of clobbering it. A genuinely stalled run (no
  // progress for STALE_SCAN_MS) is released and we take over. The /scan + /rebuild
  // endpoints still call blockOrClearScan first for their force-reset semantics.
  const blocked = blockOrClearScan(false);
  if (blocked) {
    logger.info(
      `⏭️ [DuplicateRadar] Skipping ${detectionType} scan — a healthy scan is already in progress (running ${blocked.ageMinutes}m, still making progress).`,
    );
    return {
      success: true,
      totalRecordsScanned: 0,
      totalClustersFound: 0,
      duplicatesDetected: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      moduleBreakdown: [],
      pipelineInflation: 0,
      durationMs: 0,
      error: "skipped — a healthy scan is already in progress",
    };
  }

  // Claim this generation; terminal writes below are gated on it still being
  // current, so a stale concurrent run can't overwrite a newer run's state.
  const myGeneration = ++scanGeneration;
  logger.info(
    `🔍 [DuplicateRadar] Starting Zoho CRM duplicate scan (${detectionType}) [gen ${myGeneration}]...`,
  );

  scanState.status = "scanning";
  scanState.startedAt = startTime;
  scanState.lastProgressAt = startTime; // heartbeat starts now
  scanState.progress = "Initializing scan...";
  scanState.result = null;
  scanState.error = null;
  scanState.moduleStatuses = {
    Leads: "pending",
    Deals: "pending",
    Contacts: "pending",
    Accounts: "pending",
  };
  scanState.recordCounts = {};
  scanState.percentage = 0;

  broadcastSSE("scan", { status: "started", timestamp: startTime });

  try {
    // ── Persist "solved" BEFORE we re-cluster ────────────────────────────
    // Every scan (incremental OR full) re-clusters, which reassigns cluster_ids
    // and can drop status='resolved' / merge_actions — so the per-module
    // "solved" scoreboard kept collapsing to 0 each 6-hourly sync. Snapshot the
    // current solved-state into the durable resolution-ledger (keyed by survivor
    // Zoho id) FIRST, so the breakdown's ledger join re-credits "solved" to
    // whatever cluster each survivor lands in after this scan. Idempotent +
    // best-effort (never blocks the scan).
    await backfillResolutionLedger().catch((e) =>
      logger.warn(
        `[DuplicateRadar] pre-scan ledger snapshot skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

    // ── Recover ORPHANED `syncing` rows ──────────────────────────────────
    // The single-flight guard above is IN-PROCESS (scanState), so it cannot see
    // a run that died with its process — a deploy / republish / instance recycle
    // kills the scan mid-module and leaves that module's zoho_sync_state row on
    // `syncing` forever. Observed 2026-08-30: Leads sat "syncing" with a
    // watermark 6h behind every other module. Flip anything abandoned to
    // `failed` so the chips tell the truth and the module is retried cleanly.
    // Safe: upsertSyncState only advances the watermark on a COMPLETED status,
    // so this leaves last_sync_at / total_synced untouched — the next run still
    // resumes from the last GOOD point and cannot skip records.
    try {
      const { failStaleSyncingModules } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const reset = await failStaleSyncingModules();
      if (reset.length) {
        logger.warn(
          `🧹 [DuplicateRadar] Recovered abandoned sync rows (process died mid-run): ${reset.join(", ")}`,
        );
      }
    } catch {
      /* best-effort — never blocks a scan */
    }

    // ── Decide FULL vs INCREMENTAL ───────────────────────────────────────
    // Incremental = fetch only records modified since each module's last
    // successful sync (Zoho If-Modified-Since header) and DON'T wipe existing
    // data — updates land in place (upsertRecord is idempotent by Zoho id) and
    // the deletion-detection pass purges merged/deleted rows.
    //
    // PER-MODULE: incremental kicks in as soon as ANY module has a baseline
    // (not all four). Each module independently does an incremental fetch if IT
    // has a last_sync_at, else a full pull — so if a heavy module (Contacts,
    // 56k) never finished and has no baseline, only IT does the full pull while
    // Leads/Deals/Accounts go incremental. This breaks the "full never
    // completes → no baseline → always full → freezes again" trap. The
    // first-ever sync (no baseline anywhere) or an explicit "Rebuild all"
    // (forceFull / DUPLICATE_SCAN_MODE=full) does a clean full rebuild.
    // Order = fetch order (Sample User 2026-06-23): the preflight client directory +
    // duplicate detection lean on Deals/Accounts, so fetch those FIRST and the
    // giant Leads module LAST — if Leads exhausts the window, the critical
    // modules already synced (paired with the per-module resilience above).
    const SCAN_MODULES = ["Deals", "Contacts", "Accounts", "Leads"] as const;
    const envFull = (process.env.DUPLICATE_SCAN_MODE || "incremental") === "full";
    const baselines: Record<string, string | undefined> = {};
    for (const m of SCAN_MODULES) {
      const st = await getSyncState(m);
      baselines[m] = st?.last_sync_at
        ? new Date(st.last_sync_at).toISOString()
        : undefined;
    }
    const anyBaseline = SCAN_MODULES.some((m) => !!baselines[m]);
    const incremental = !forceFull && !envFull && anyBaseline;

    // Per-module: incremental only for modules that already have a baseline;
    // modules without one fetch in full (and, because we skip the global wipe
    // in incremental mode, their full upsert just refreshes those rows).
    // 10-min safety overlap so records modified mid-sync aren't missed
    // (re-processing a handful is harmless — upsert is idempotent by Zoho id).
    const sinceFor = (m: string): string | undefined => {
      if (!incremental || !baselines[m]) return undefined;
      return new Date(new Date(baselines[m]!).getTime() - 10 * 60 * 1000).toISOString();
    };

    scanState.progress = incremental
      ? "Preparing incremental scan (changed records only)..."
      : "Preparing full rebuild...";
    scanState.percentage = 5;
    logger.info(
      `🔁 [DuplicateRadar] Scan mode: ${incremental ? "INCREMENTAL (changed-only)" : "FULL rebuild"}` +
        (forceFull ? " [forced]" : ""),
    );
    // Full rebuild wipes first; incremental keeps existing data and updates it.
    if (!incremental) {
      await clearAllDuplicateData();
    }

    const moduleBreakdown: any[] = [];
    let totalRecords = 0;
    const clustersUpdated = new Set<number>();

    // B3: Module fetch (sequential by default — see runModulesWithConcurrency)
    scanState.progress = incremental
      ? "Fetching changed records from Zoho CRM..."
      : "Fetching all modules from Zoho CRM...";
    scanState.percentage = 10;
    broadcastSSE("progress", {
      percentage: 10,
      message: incremental ? "Fetching changed records..." : "Fetching all modules...",
    });

    // Shared fetch-band progress (10 → 60%). Each of the 4 parallel modules
    // reports its own 0..1 completion fraction; the bar = 10 + 50 × average,
    // so it climbs smoothly while modules fetch + write instead of freezing at
    // 10% until the whole Promise.all settles. Monotonic (never moves back).
    const FETCH_BAND_START = 10;
    const FETCH_BAND_END = 60;
    const moduleFrac: Record<string, number> = {
      Leads: 0,
      Deals: 0,
      Contacts: 0,
      Accounts: 0,
    };
    let lastBandPct = FETCH_BAND_START;
    const reportFetch = (mod: string, frac: number) => {
      moduleFrac[mod] = Math.max(moduleFrac[mod] ?? 0, Math.min(1, frac));
      const avg =
        (moduleFrac.Leads +
          moduleFrac.Deals +
          moduleFrac.Contacts +
          moduleFrac.Accounts) /
        4;
      const pct = Math.min(
        FETCH_BAND_END,
        FETCH_BAND_START +
          Math.round((FETCH_BAND_END - FETCH_BAND_START) * avg),
      );
      if (pct > lastBandPct) {
        lastBandPct = pct;
        scanState.percentage = pct;
        broadcastSSE("progress", {
          percentage: pct,
          message: scanState.progress,
        });
      }
    };

    // Fetch modules with BOUNDED concurrency (default 1 = sequential). Fetching
    // all 4 modules in parallel × ZOHO_FETCH_CONCURRENCY pages each meant up to
    // ~16 simultaneous Zoho calls, which tripped Zoho's rate/concurrency limit
    // and failed 3 of 4 modules. Sequential keeps it to one module at a time.
    // Tune with DUPLICATE_MODULE_CONCURRENCY (1–4).
    const MODULE_CONCURRENCY = (() => {
      const n = parseInt(process.env.DUPLICATE_MODULE_CONCURRENCY || "", 10);
      return Number.isFinite(n) && n >= 1 && n <= 4 ? n : 1;
    })();
    // ACCOUNTS FIRST — the Preflight recovery (Resolve → link contacts/deals to
    // an existing account) needs the account directory refreshed before the big
    // Deals/Contacts pulls, so the operator isn't blocked for hours waiting on
    // them. Array order MUST match the destructuring below —
    // runModulesWithConcurrency preserves input order.
    const [accountsResult, dealsResult, contactsResult, leadsResult] =
      await runModulesWithConcurrency([
        () => processModule("Accounts", "account", clustersUpdated, (record) => {
          const d = record.data;
          const websiteRaw = d.Website || "";
          const websiteDomain =
            websiteRaw.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] || "";
          return {
            companyName: d.Account_Name || "Unknown",
            email: d.Email || "",
            phone: d.Phone || "",
            recordName: d.Account_Name || "Unknown",
            domain:
              extractDomain(d.Email || "") ||
              (websiteDomain && !websiteDomain.includes(" ")
                ? websiteDomain
                : null),
            ownerName: d.Owner?.name || "Unknown",
            ownerEmail: d.Owner?.email || "",
            status: "Account",
            source: "Account",
            createdTime: d.Created_Time || "",
            modifiedTime: d.Modified_Time || "",
            layoutName: d.Layout?.name || d.$layout?.name || "",
            layoutId: d.Layout?.id || d.$layout?.id || "",
            zohoModule: "Accounts",
            website: websiteRaw,
            crNumber: d.CR_Number || d.Registration_Number || "",
            vatNumber: d.VAT_Number || d.Tax_ID || "",
            country: d.Billing_Country || d.Shipping_Country || "",
            region: d.Billing_State || d.Shipping_State || "",
            industry: d.Industry || "",
            noOfEmployees: parseInt(d.Employees) || undefined,
            accountType: d.Account_Type || "",
          };
        }, sinceFor("Accounts"), (frac) => reportFetch("Accounts", frac)),
        () => processModule("Deals", "deal", clustersUpdated, (record) => {
          const d = record.data;
          // Reflect the CS "Company Domain" field (e.g. <REDACTED_HOST>) into the
          // deal's domain column — it's the customer's real domain, whereas the
          // Contact_Email is often empty/personal. Same extractor the CS
          // Lifecycle uses (env-override + fuzzy field name), so a client deal's
          // domain is recognised platform-wide (radar, clustering, preflight).
          const csDomain = extractCsFieldsFromRawData(d, {}).company_domain;
          return {
            companyName: d.Account_Name?.name || d.Deal_Name || "Unknown",
            email: d.Contact_Email || "",
            phone: d.Contact_Phone || "",
            recordName: d.Deal_Name || "Unknown Deal",
            domain: csDomain || extractDomain(d.Contact_Email || ""),
            ownerName: d.Owner?.name || "Unknown",
            ownerEmail: d.Owner?.email || "",
            status: "",
            stage: d.Stage || "",
            dealValue: parseFloat(d.Amount) || 0,
            source: d.Lead_Source || "",
            createdTime: d.Created_Time || "",
            modifiedTime: d.Modified_Time || "",
            layoutName: d.Layout?.name || d.$layout?.name || "",
            layoutId: d.Layout?.id || d.$layout?.id || "",
            zohoModule: "Deals",
            pipeline: d.Pipeline || "",
            products: d.Product_Details
              ? JSON.stringify(d.Product_Details)
              : "",
            contactName: d.Contact_Name?.name || "",
            accountName: d.Account_Name?.name || "",
          };
        }, sinceFor("Deals"), (frac) => reportFetch("Deals", frac)),
        () => processModule("Contacts", "contact", clustersUpdated, (record) => {
          const d = record.data;
          return {
            companyName:
              d.Account_Name?.name || d.Company || d.Last_Name || "Unknown",
            email: d.Email || "",
            phone: d.Phone || "",
            mobile: d.Mobile || "",
            recordName:
              d.Full_Name ||
              `${d.First_Name || ""} ${d.Last_Name || ""}`.trim(),
            domain: extractDomain(d.Email || ""),
            ownerName: d.Owner?.name || "Unknown",
            ownerEmail: d.Owner?.email || "",
            status: "Contact",
            source: d.Lead_Source || "",
            createdTime: d.Created_Time || "",
            modifiedTime: d.Modified_Time || "",
            layoutName: d.Layout?.name || d.$layout?.name || "",
            layoutId: d.Layout?.id || d.$layout?.id || "",
            zohoModule: "Contacts",
            title: d.Title || "",
            accountName: d.Account_Name?.name || "",
            country: d.Mailing_Country || d.Other_Country || "",
          };
        }, sinceFor("Contacts"), (frac) => reportFetch("Contacts", frac)),
        () => processModule("Leads", "lead", clustersUpdated, (record) => {
          const d = record.data;
          return {
            companyName: d.Company || d.Last_Name || "Unknown",
            email: d.Email || "",
            phone: d.Phone || "",
            mobile: d.Mobile || "",
            recordName:
              d.Full_Name ||
              `${d.First_Name || ""} ${d.Last_Name || ""}`.trim(),
            domain: extractDomain(d.Email || ""),
            ownerName: d.Owner?.name || "Unknown",
            ownerEmail: d.Owner?.email || "",
            status: d.Lead_Status || "",
            source: d.Lead_Source || "",
            createdTime: d.Created_Time || "",
            modifiedTime: d.Modified_Time || "",
            layoutName: d.Layout?.name || d.$layout?.name || "",
            layoutId: d.Layout?.id || d.$layout?.id || "",
            zohoModule: "Leads",
            title: d.Designation || d.Title || "",
            leadType: d.Lead_Type || "",
            country: d.Country || "",
            industry: d.Industry || "",
            website: d.Website || "",
          };
        }, sinceFor("Leads"), (frac) => reportFetch("Leads", frac)),
      ], MODULE_CONCURRENCY);

    // All-modules-failed guard (Sample User 2026-06-23): the per-module resilience
    // above intentionally lets a PARTIAL sync complete (some modules synced) —
    // but if EVERY module failed (Zoho outage / OAuth cooldown / connectivity),
    // don't let the scan report a green "done" with 0 records (which reads as
    // "data is fresh"). Fail loudly so the operator knows it did NOT complete.
    if (SCAN_MODULES.every((m) => scanState.moduleStatuses[m] === "error")) {
      throw new Error(
        "Zoho sync failed for every module (rate-limit / OAuth cooldown or connectivity) — no data was fetched. The scan did not complete; please retry.",
      );
    }

    // Tasks pagination removed per platform-wide Tasks data removal.
    // `totalRecords` was previously the count fetched from Zoho — that
    // counter looked healthy even when every upsertRecord threw. Use
    // `written` (the count actually persisted) so the scan summary, the
    // detection log, and the dashboard agree with what's queryable.
    totalRecords =
      leadsResult.written +
      dealsResult.written +
      contactsResult.written +
      accountsResult.written;
    const totalFetched =
      leadsResult.count +
      dealsResult.count +
      contactsResult.count +
      accountsResult.count;
    const totalSkipped =
      leadsResult.skipped +
      dealsResult.skipped +
      contactsResult.skipped +
      accountsResult.skipped;
    moduleBreakdown.push(
      { module: "Leads",    fetched: leadsResult.count,    written: leadsResult.written,    skipped: leadsResult.skipped },
      { module: "Deals",    fetched: dealsResult.count,    written: dealsResult.written,    skipped: dealsResult.skipped },
      { module: "Contacts", fetched: contactsResult.count, written: contactsResult.written, skipped: contactsResult.skipped },
      { module: "Accounts", fetched: accountsResult.count, written: accountsResult.written, skipped: accountsResult.skipped },
    );

    // Loud signal in the server log when a sync persisted nothing despite
    // fetching records. Operators tailing logs catch this immediately; the
    // chip showing "0 (completed)" instead of "5000 (completed)" is the
    // user-facing tell.
    if (totalFetched > 0 && totalRecords === 0) {
      logger.error(
        `❌ [DuplicateRadar] Scan persisted 0 records despite fetching ${totalFetched} from Zoho — every upsert was skipped or threw. Check the warnings above (${totalSkipped} skipped).`,
      );
    } else if (totalSkipped > 0) {
      logger.warn(
        `⚠️ [DuplicateRadar] Scan wrote ${totalRecords}/${totalFetched} records (${totalSkipped} skipped across all modules)`,
      );
    }

    scanState.percentage = 60;
    broadcastSSE("progress", {
      percentage: 60,
      message: `All modules fetched (${totalFetched} from Zoho, ${totalRecords} persisted)`,
    });

    // Deletion-detection pass: ask Zoho which records were deleted/merged
    // since our last sync and purge them locally. This is what makes a
    // manual Zoho merge propagate into the duplicate radar.
    const scanMode = process.env.DUPLICATE_SCAN_MODE || "incremental";
    scanState.progress = "Checking Zoho for deleted/merged records...";
    broadcastSSE("progress", {
      percentage: 62,
      message: "Checking Zoho for deletions...",
    });
    const deletionResult = await runDeletionDetection(clustersUpdated, baselines);
    if (deletionResult.totalRemoved > 0) {
      logger.info(
        `🗑️ [DuplicateRadar] Deletion-detection removed ${deletionResult.totalRemoved} record(s):`,
        deletionResult.perModule,
      );
      broadcastSSE("progress", {
        percentage: 65,
        message: `Removed ${deletionResult.totalRemoved} deleted/merged Zoho records`,
      });
    }

    // AUTOMATIC deletion-feed sweep after every completed sync (Sample User 2026-07-23:
    // "schedule it after each sync"). runDeletionDetection above prunes on a
    // narrow [last_sync, now] window and does NOT clear the empty-delete ledger;
    // this wider, ledger-clearing pass is the same one the "Verify & prune
    // deleted" button runs, so bulk "uploaded then removed" batches are caught
    // and the "Tagged · pending delete" rows for admin-deleted records resolve
    // — without anyone clicking. Fire-and-forget so it never extends the sync;
    // idempotent, so overlapping with the button run is harmless. Lookback is
    // env-tunable (default 30d for the frequent auto-run vs 90d on the button).
    if (process.env.RADAR_POSTSYNC_DELETION_SWEEP !== "false") {
      const sweepDays = parseInt(
        process.env.RADAR_POSTSYNC_SWEEP_LOOKBACK_DAYS || "30",
        10,
      );
      void import("../../utils/emptyRecordsDatabase")
        .then(({ sweepDeletedByFeed }) =>
          sweepDeletedByFeed({ lookbackDays: sweepDays }),
        )
        .then((r) =>
          logger.info(
            `🧹 [post-sync deletion sweep] pruned ${r.totalPruned}`,
            r.perModule,
          ),
        )
        .catch((e) =>
          logger.warn(
            `[post-sync deletion sweep] failed (non-fatal): ${e?.message || e}`,
          ),
        );
    }

    // Cleanup stale records (legacy, mostly a no-op now) and orphan clusters
    if (scanMode !== "full") {
      scanState.progress = "Cleaning up orphan clusters...";
      await cleanupStaleRecords();
      await cleanupOrphanClusters();
    }

    scanState.percentage = 70;

    scanState.progress = `All modules fetched (${totalRecords} records). Scoring ${clustersUpdated.size} clusters...`;
    logger.info(
      `📊 [DuplicateRadar] Updating stats for ${clustersUpdated.size} clusters...`,
    );
    // Scoring is the 70→95% phase. Previously single-threaded (one
    // updateClusterStats await per cluster) — with 10k+ clusters that's the
    // dominant tail of a full rebuild. Run it in bounded-concurrency batches
    // so the DB pool is used efficiently without being overwhelmed. Tune via
    // DUPLICATE_SCORE_CONCURRENCY (default 8). A single cluster's scoring
    // failure is logged and skipped, not allowed to abort the whole scan.
    const scoreConcEnv = parseInt(
      process.env.DUPLICATE_SCORE_CONCURRENCY || "",
      10,
    );
    const SCORE_CONCURRENCY =
      Number.isFinite(scoreConcEnv) && scoreConcEnv >= 1 && scoreConcEnv <= 32
        ? scoreConcEnv
        : 8;
    const clusterIds = Array.from(clustersUpdated);
    const scoreT0 = Date.now();
    let processed = 0;
    for (let i = 0; i < clusterIds.length; i += SCORE_CONCURRENCY) {
      const batch = clusterIds.slice(i, i + SCORE_CONCURRENCY);
      await Promise.all(
        batch.map((clusterId) =>
          updateClusterStats(clusterId).catch((e) =>
            logger.warn(
              `[DuplicateRadar] cluster ${clusterId} scoring failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
            ),
          ),
        ),
      );
      processed += batch.length;
      if (processed % 200 < SCORE_CONCURRENCY || processed === clusterIds.length) {
        const pct =
          clusterIds.length > 0
            ? 70 + Math.round((processed / clusterIds.length) * 25)
            : 95;
        scanState.progress = `Scoring clusters: ${processed}/${clusterIds.length}...`;
        scanState.percentage = pct;
        broadcastSSE("progress", {
          percentage: pct,
          message: `Scoring: ${processed}/${clusterIds.length}`,
        });
      }
    }
    logger.info(
      `⏱️ [DuplicateRadar] Scored ${clusterIds.length} clusters in ${((Date.now() - scoreT0) / 1000).toFixed(1)}s (concurrency ${SCORE_CONCURRENCY})`,
    );

    // Layer-2 of Mark-Handled persistence (Sample User 2026-06-16). Every scan
    // re-clusters records and the new cluster row defaults to status='active'
    // even when the survivor Zoho ids are in the resolution ledger from a
    // prior Mark Handled click. Walk active clusters now and flip status back
    // to 'resolved' when every present module has a ledger match — this is
    // the durable counterpart to the view-time filter in getCrossModuleOverlaps.
    // Auto-merge contacts that were tagged "pending Zoho admin delete" → resolve
    // them now IF the admin has actually deleted the tagged duplicates (so they
    // stay AI-Applied · pending until then). Must run BEFORE the ledger-restore
    // below, which reads the entries this writes.
    await reconcileAutoMergedContactDeletions().catch((e) =>
      logger.warn(
        `[DuplicateRadar] auto-merge deletion reconcile skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

    // Reconcile empty-delete ledger: flip pending_delete → deleted for any
    // record the admin has actually removed from Zoho since the last sync.
    await (await import("../../utils/emptyRecordsDatabase"))
      .reconcileEmptyDeleteDeletions()
      .catch(() => {});

    // Auto-prune ghosts in VISIBLE clusters (Sample User 2026-07-13 "deleted deals
    // still appear in Cross-Module after sync"). runDeletionDetection above only
    // catches deletions Zoho still lists in its /deleted feed; a record that was
    // HARD-purged (recycle bin emptied) or missed by every window lingers in its
    // active cluster until someone manually clicks "Verify & prune deleted",
    // which rotates across all ~160k records and rarely reaches it. Here we
    // live-verify a bounded batch drawn ONLY from open clusters (the small set
    // actually shown on the tabs), oldest-verified first, and prune whatever
    // 404s — so a ghost a user would open is gone within a sync or two, no manual
    // click. Bounded + env-tunable; RADAR_POST_SYNC_GHOST_VERIFY=0 disables.
    try {
      const <REDACTED_TOKEN> = parseInt(
        process.env.RADAR_POST_SYNC_GHOST_VERIFY || "300",
        10,
      );
      if (<REDACTED_TOKEN> > 0) {
        const { reconcileDeletedRecords } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        const gv = await reconcileDeletedRecords({
          limit: <REDACTED_TOKEN>,
          activeClustersOnly: true,
        });
        if (gv.pruned > 0 || gv.converted > 0) {
          logger.info(
            `🧹 [DuplicateRadar] Post-sync ghost sweep: checked ${gv.checked}, pruned ${gv.pruned} deleted + marked ${gv.converted} converted lead(s) in active clusters.`,
          );
        }
      }
    } catch (e: any) {
      logger.warn(
        `⚠️ [DuplicateRadar] Post-sync ghost sweep skipped (non-fatal): ${e?.message || e}`,
      );
    }

    // Persist per-record cleanup_class (empty/test/junk/orphaned/tagged) from
    // the synced snapshot — snapshot-only, no live Zoho calls — so later reads
    // can hide cleanup records from the other Radar tabs (Sample User 2026-07-01).
    try {
      const { classifyCleanupRecords } = await import(
        "../../utils/emptyRecordsDatabase"
      );
      const cleanupClassified = await classifyCleanupRecords();
      logger.info(
        `[DuplicateRadar] cleanup_class classified for ${cleanupClassified} record(s)`,
      );
    } catch (e) {
      logger.warn(
        `[DuplicateRadar] post-scan cleanup_class classification skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    await restoreLedgerResolvedClusterStatus().catch((e) =>
      logger.warn(
        `[DuplicateRadar] post-scan ledger restore skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

    // Record today's per-tab progress snapshot (open / solved / total) so the
    // Duplicate Radar has a daily burndown per module, not just a live number.
    // Upsert-per-day: this keeps today's row current on every scan.
    await captureDuplicateProgressSnapshot().catch((e) =>
      logger.warn(
        `[DuplicateRadar] post-scan progress snapshot skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

    const summary = await getEnhancedSummary();
    const duration = Date.now() - startTime;

    await createDetectionLog({
      detection_type: detectionType,
      total_records_scanned: totalRecords,
      total_clusters_found: clustersUpdated.size,
      total_duplicates_detected: summary.trueDuplicateClusters,
      high_confidence_count: summary.highConfidence,
      medium_confidence_count: summary.mediumConfidence,
      low_confidence_count: summary.lowConfidence,
      estimated_pipeline_inflation: summary.estimatedPipelineInflation,
      detection_duration_ms: duration,
      triggered_by:
        detectionType === "scheduled"
          ? "Automated Weekly Scan"
          : "Zoho CRM Scan",
      status: "completed",
      completed_at: new Date(),
    });

    logger.info(
      `✅ [DuplicateRadar] Scan complete: ${totalRecords} records, ${summary.trueDuplicateClusters} true duplicate clusters, ${summary.highConfidence} high confidence`,
    );

    const resultData = {
      success: true,
      totalRecordsScanned: totalRecords,
      totalClustersFound: clustersUpdated.size,
      duplicatesDetected: summary.trueDuplicateClusters,
      highConfidence: summary.highConfidence,
      mediumConfidence: summary.mediumConfidence,
      moduleBreakdown,
      pipelineInflation: summary.estimatedPipelineInflation,
      durationMs: duration,
    };

    if (myGeneration === scanGeneration) {
      scanState.status = "completed";
      scanState.completedAt = Date.now();
      scanState.progress = `Complete: ${totalRecords} records scanned, ${summary.trueDuplicateClusters} duplicate clusters found`;
      scanState.result = resultData;
      scanState.percentage = 100;
      broadcastSSE("scan", { status: "completed", result: resultData });
    } else {
      logger.warn(
        `[DuplicateRadar] Scan gen ${myGeneration} finished but a newer scan (gen ${scanGeneration}) owns the state — not overwriting.`,
      );
    }

    return resultData;
  } catch (error: any) {
    logger.error("❌ [DuplicateRadar] Scan error:", error);
    // Surface Zoho rate-limit cooldowns with a user-actionable message
    // instead of leaking the raw OAuth body or "An internal error occurred".
    const rateLimited =
      error?.isZohoRateLimited ||
      /too many requests/i.test(String(error?.message || ""));
    const userMessage = rateLimited
      ? "Zoho is temporarily rate-limited (too many token refresh attempts in a short window). Wait a few minutes, then click Run scan again."
      : error?.message || "An internal error occurred";

    const errorResult = {
      success: false,
      totalRecordsScanned: 0,
      totalClustersFound: 0,
      duplicatesDetected: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      moduleBreakdown: [],
      pipelineInflation: 0,
      durationMs: Date.now() - startTime,
      error: userMessage,
    };

    if (myGeneration === scanGeneration) {
      scanState.status = "failed";
      scanState.completedAt = Date.now();
      scanState.progress = rateLimited
        ? "Scan failed — Zoho rate-limited"
        : "Scan failed";
      scanState.error = userMessage;
      scanState.result = errorResult;
      broadcastSSE("scan", { status: "failed", error: scanState.error });
    }

    return errorResult;
  }
}

export { scanZohoCRMForDuplicates };

initDuplicateRadarTables().catch((err) => {
  logger.error("Failed to initialize duplicate radar tables:", err);
});

export const duplicateRadarRoutes = [
  // ── Autonomous Resolution: status / manual run / grades / rules ─────────────
  {
    // Config + last run summary + current grades, for the status panel.
    path: "/api/duplicates/autonomous/status",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const cfg = await resolveResolutionRunConfig();
          const canManage = (AUTONOMOUS_RESOLUTION_MANAGE_ROLES as readonly string[]).includes(
            (user as any)?.role,
          );
          const grades = await getGradeHistory(undefined, 4 * 8).catch(() => []);
          // Latest grade per module from the history (history is DESC).
          const latestByModule: Record<string, any> = {};
          for (const g of grades) {
            if (!latestByModule[g.module]) latestByModule[g.module] = g;
          }
          return c.json({
            config: cfg,
            can_manage: canManage,
            slack: { configured: isResolutionSlackConfigured() },
            grades_latest: Object.values(latestByModule),
            module_breakdown: await getModuleResolutionBreakdown().catch(() => []),
            learnings: await getResolutionLearnings().catch(() => null),
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // One-tap EXECUTIVE BRIEF — assembles the real aggregate figures into a
    // board-ready, shareable text block (CEO/CCO). Deterministic (no LLM), so
    // it's consistent and never hallucinates a number. Same framing Adam uses.
    path: "/api/duplicates/autonomous/executive-brief",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          // Shared deterministic builder (same one the weekly digest uses);
          // withTrend shows week-over-week vs the last weekly snapshot.
          const { brief, metrics } = await buildExecutiveBriefText({ withTrend: true });
          return c.json({ brief, generated_at: new Date().toISOString(), data: metrics });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Adam's notification schedule (single source of truth) — for the platform
    // "Notification Schedule" card. Reviewed monthly; timings edited via env.
    path: "/api/duplicates/autonomous/notification-schedule",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          return c.json({ schedule: ADAM_NOTIFICATION_SCHEDULE });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Post a (generated) executive brief to the resolution Slack channel.
    path: "/api/duplicates/autonomous/executive-brief/post",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const text = String(body?.text || "").trim().slice(0, 6000);
          if (!text) return c.json({ error: "Nothing to post." }, 400);
          const stamped =
            text + `\n\n_Shared by ${(user as any)?.email || "an operator"} from the Autonomous Resolution screen._`;
          const res = await postResolutionMessage(stamped);
          if (!res.ok) return c.json({ error: res.error || "Slack post failed" }, 502);
          return c.json({ ok: true, channel: res.channel });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // "Send weekly brief now" — manually fire the SAME weekly leadership job
    // (posts to both channels), but WITHOUT recording a trend snapshot so the
    // Sunday-anchored week-over-week math stays intact. Management-tier only,
    // since it broadcasts to leadership channels.
    path: "/api/duplicates/autonomous/weekly-brief/send",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const res = await postWeeklyExecBrief({ recordSnapshot: false });
          if (!res.ok) {
            return c.json({ error: (res.errors || []).join("; ") || "Slack post failed" }, 502);
          }
          return c.json({ ok: true, posted: res.posted, errors: res.errors });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Safe-tier vs escalated breakdown of the autonomous resolver's PENDING
    // proposals. verdict 'auto' = the agent is confident (would auto-apply once
    // in assisted mode); 'escalate' = needs a human. Lets an operator see the
    // scope before flipping shadow → assisted.
    //   GET /api/duplicates/autonomous/proposal-tiers
    path: "/api/duplicates/autonomous/proposal-tiers",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const r = await pool.query(
            `SELECT COALESCE(payload->>'verdict','unknown') AS verdict, COUNT(*)::int AS n
               FROM ai_pending_actions
              WHERE tool_id = 'duplicate-resolution' AND status = 'pending'
              GROUP BY 1`,
          );
          let safeTier = 0,
            escalated = 0,
            other = 0;
          for (const row of r.rows) {
            if (row.verdict === "auto") safeTier = Number(row.n);
            else if (row.verdict === "escalate") escalated = Number(row.n);
            else other += Number(row.n);
          }
          return c.json({
            success: true,
            total: safeTier + escalated + other,
            safeTier,
            escalated,
            other,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Hygiene & business rules catalog (Sample User 2026-06-20): the read-only list
    // of agreed data-hygiene / governance rules Adam enforces, surfaced on the
    // Autonomous Resolution screen so an operator can see what's being checked.
    //   GET /api/duplicates/hygiene-rules
    path: "/api/duplicates/hygiene-rules",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { getHygieneRulesCatalog } = await import("../../utils/hygieneRulesCatalog");
          return c.json({ success: true, ...getHygieneRulesCatalog() });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Flag a hygiene rule for editing (Sample User 2026-06-20): record the operator's
    // requested change to event_logs so it can be reviewed/actioned. The rules
    // live in code (hygieneRulesCatalog.ts); this is the lightweight "I want
    // this edited" capture, not an in-place editor.
    //   POST /api/duplicates/hygiene-rules/flag  { tab, ruleId, note }
    path: "/api/duplicates/hygiene-rules/flag",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const tab = String(body?.tab || "").slice(0, 64);
          const ruleId = String(body?.ruleId || "").slice(0, 64);
          const note = String(body?.note || "").slice(0, 1000).trim();
          if (!ruleId || !note) {
            return c.json({ error: "ruleId and note are required" }, 400);
          }
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await logEvent({
            userId: (user as any)?.userId ?? undefined,
            userEmail: (user as any)?.email ?? undefined,
            userRole: (user as any)?.role ?? undefined,
            actionType: "AI_ACTION",
            entityType: "SYSTEM",
            entityId: `hygiene-rule:${tab}/${ruleId}`,
            entityName: "Hygiene rule edit request",
            description: `Hygiene rule edit requested for ${tab}/${ruleId}: ${note}`,
            aiInvolved: false,
            severity: "INFO",
            module: "duplicate-radar",
          }).catch(() => {});
          return c.json({ success: true });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Rejection-pattern analysis (Sample User 2026-06-20): why deliberately-rejected
    // proposals were rejected, with recommend-only rule/threshold suggestions.
    //   GET /api/duplicates/autonomous/rejection-patterns?days=30
    path: "/api/duplicates/autonomous/rejection-patterns",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const days = parseInt(url.searchParams.get("days") || "30", 10);
          const { analyzeRejectionPatterns } = await import("../../utils/rejectionPatterns");
          const data = await analyzeRejectionPatterns(
            Number.isFinite(days) && days > 0 ? days : 30,
          );
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk exact email+phone contact merge — PREVIEW (Sample User 2026-06-20).
    //   GET /api/duplicates/contacts/exact-match-preview
    path: "/api/duplicates/contacts/exact-match-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewExactContactMatches } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewExactContactMatches();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk exact email+phone contact merge — APPLY (admin-key gated, Sample User 2026-06-20).
    // Keeps the survivor, tags duplicates Duplicate-Delete (migrate-then-tag).
    //   POST /api/duplicates/contacts/exact-match-merge  { limit? }
    path: "/api/duplicates/contacts/exact-match-merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const limit = parseInt(body?.limit, 10);
          const overrides: Record<string, string> = {};
          if (body?.overrides && typeof body.overrides === "object") {
            for (const [k, v] of Object.entries(body.overrides)) {
              if (typeof k === "string" && typeof v === "string" && v.trim()) overrides[k] = v.trim();
            }
          }
          const excludes: Record<string, string[]> = {};
          if (body?.excludes && typeof body.excludes === "object") {
            for (const [k, v] of Object.entries(body.excludes)) {
              if (typeof k === "string" && Array.isArray(v)) {
                const ids = v.map((x: any) => String(x || "").trim()).filter(Boolean);
                if (ids.length) excludes[k] = ids;
              }
            }
          }
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk exact email+phone merge)`;
          const { applyExactContactMatches } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyExactContactMatches({
            limit: Number.isFinite(limit) && limit > 0 ? limit : 300,
            performedBy,
            overrides,
            excludes,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk same-name+phone contact merge — PREVIEW (Sample User 2026-06-22).
    //   GET /api/duplicates/contacts/name-phone-preview
    path: "/api/duplicates/contacts/name-phone-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewNamePhoneContactMatches } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewNamePhoneContactMatches();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk same-name+phone contact merge — APPLY (admin-key gated, Sample User 2026-06-22).
    // Preserves the survivor's email(s) (primary + Secondary_Email), tags
    // duplicates Duplicate-Delete (migrate-then-tag).
    //   POST /api/duplicates/contacts/name-phone-merge  { limit? }
    path: "/api/duplicates/contacts/name-phone-merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const limit = parseInt(body?.limit, 10);
          const overrides: Record<string, string> = {};
          if (body?.overrides && typeof body.overrides === "object") {
            for (const [k, v] of Object.entries(body.overrides)) {
              if (typeof k === "string" && typeof v === "string" && v.trim()) overrides[k] = v.trim();
            }
          }
          const excludes: Record<string, string[]> = {};
          if (body?.excludes && typeof body.excludes === "object") {
            for (const [k, v] of Object.entries(body.excludes)) {
              if (typeof k === "string" && Array.isArray(v)) {
                const ids = v.map((x: any) => String(x || "").trim()).filter(Boolean);
                if (ids.length) excludes[k] = ids;
              }
            }
          }
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk same name+phone merge)`;
          const { applyNamePhoneContactMatches } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyNamePhoneContactMatches({
            limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
            performedBy,
            excludes,
            overrides,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk link colleagues → Account — PREVIEW (Sample User 2026-06-23).
    //   GET /api/duplicates/contacts/link-account-preview
    path: "/api/duplicates/contacts/link-account-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewContactLinkToAccount } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewContactLinkToAccount();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk link colleagues → Account — APPLY (admin-gated, Sample User 2026-06-23).
    // Sets Account_Name on the contacts of each link-only cluster (no tagging).
    //   POST /api/duplicates/contacts/link-account-apply  { limit? }
    path: "/api/duplicates/contacts/link-account-apply",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const limit = parseInt(body?.limit, 10);
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk link contacts → account)`;
          const { applyContactLinkToAccount } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyContactLinkToAccount({
            dryRun: false,
            limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
            performedBy,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Account auto-merge (same domain + same name, within layout) — READ-ONLY
    // PREVIEW (Sample User 2026-06-22). No writes. Corporate↔Corporate and
    // Partner↔Partner only; the apply (cascade) is a separate, confirmed step.
    //   GET /api/duplicates/accounts/domain-name-preview
    path: "/api/duplicates/accounts/domain-name-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewAccountDomainNameMerge } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewAccountDomainNameMerge();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Account auto-merge — APPLY one scope (admin-key gated, Sample User 2026-06-22).
    // Reuses the agentic merge engine: preserves EN/AR names, re-parents the
    // duplicates' contacts/deals onto the survivor, tags the rest. Never deletes.
    //   POST /api/duplicates/accounts/domain-name-merge  { scope, limit? }
    path: "/api/duplicates/accounts/domain-name-merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const scope = body?.scope === "partner" ? "partner" : "corporate";
          const limit = parseInt(body?.limit, 10);
          // Per-group survivor overrides { "domain|name": zohoIdToKeep }.
          const overrides: Record<string, string> = {};
          if (body?.overrides && typeof body.overrides === "object") {
            for (const [k, v] of Object.entries(body.overrides)) {
              if (typeof k === "string" && typeof v === "string" && v.trim()) {
                overrides[k] = v.trim();
              }
            }
          }
          const excludes: Record<string, string[]> = {};
          if (body?.excludes && typeof body.excludes === "object") {
            for (const [k, v] of Object.entries(body.excludes)) {
              if (typeof k === "string" && Array.isArray(v)) {
                const ids = v.map((x: any) => String(x || "").trim()).filter(Boolean);
                if (ids.length) excludes[k] = ids;
              }
            }
          }
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk account ${scope} domain+name merge)`;
          const { applyAccountDomainNameMerge } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyAccountDomainNameMerge({
            scope,
            dryRun: false,
            limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
            performedBy,
            overrides,
            excludes,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // ONE-CLICK "Apply all safe auto-merges" (Sample User 2026-06-25). Runs ONE bounded
    // batch of each PROVEN safe matcher in sequence — accounts (domain+name) first
    // so contacts re-parent onto the merged survivor, then contacts (exact
    // email+phone, then same name+phone). No new merge logic: it just orchestrates
    // the existing, conservative apply functions behind ONE admin check. The
    // frontend loops this until `more` is false. Each pass is small so the request
    // never hits the proxy timeout; nothing is deleted by the platform.
    path: "/api/duplicates/apply-all-safe",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const n = parseInt(body?.limit, 10);
          const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 25) : 15;
          const by = `${(sessionUser as any)?.email || "admin"} (apply-all-safe)`;
          const {
            applyAccountDomainNameMerge,
            applyExactContactMatches,
            applyNamePhoneContactMatches,
          } = await import("../../utils/duplicateRadarDatabase");
          const accounts = await applyAccountDomainNameMerge({
            scope: "corporate",
            dryRun: false,
            limit,
            performedBy: by,
          });
          const exactContacts = await applyExactContactMatches({ limit, performedBy: by });
          const namePhoneContacts = await applyNamePhoneContactMatches({ limit, performedBy: by });
          const didWork =
            (accounts.merged || 0) +
            (exactContacts.mergedGroups || 0) +
            (namePhoneContacts.mergedGroups || 0);
          const remaining =
            (accounts.remaining || 0) +
            (exactContacts.remaining || 0) +
            (namePhoneContacts.remaining || 0);
          // Loop only while this pass made progress — a progress-based guard that
          // can't spin forever even if `remaining` is stuck (e.g. Zoho rate-limit).
          return c.json({
            success: true,
            accounts,
            exactContacts,
            namePhoneContacts,
            remaining,
            more: didWork > 0,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Dismiss an account auto-merge group as "NOT duplicates" (Sample User 2026-06-23).
    // Records the group's accounts as mutually separated (durable) so the group
    // is excluded from this AND future previews/merges — no Zoho write.
    //   POST /api/duplicates/accounts/dismiss-merge-group  { zohoIds: string[] }
    path: "/api/duplicates/accounts/dismiss-merge-group",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const zohoIds: string[] = Array.isArray(body?.zohoIds)
            ? body.zohoIds.map((z: any) => String(z || "").trim()).filter(Boolean)
            : [];
          if (zohoIds.length < 2) {
            return c.json({ error: "Need at least 2 account ids to dismiss." }, 400);
          }
          const performedBy = `${(user as any)?.email || "user"} (dismiss account merge group)`;
          const { recordSeparations } = await import("../../utils/duplicateRadarDatabase");
          // Each account is its own group → recordSeparations separates all pairs.
          const pairs = await recordSeparations(
            zohoIds.map((z) => [z]),
            "dismiss",
            performedBy,
          );
          return c.json({ success: true, separatedPairs: pairs, accounts: zohoIds.length });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Looser DOMAIN-ONLY account auto-merge — PREVIEW (Sample User 2026-06-23).
    // "Same domain, any name" with the shared-domain guard. No writes.
    //   GET /api/duplicates/accounts/domain-only-preview
    path: "/api/duplicates/accounts/domain-only-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewAccountDomainOnlyMerge } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewAccountDomainOnlyMerge();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Looser DOMAIN-ONLY account auto-merge — APPLY one scope (admin-key gated).
    //   POST /api/duplicates/accounts/domain-only-merge  { scope, limit?, overrides? }
    path: "/api/duplicates/accounts/domain-only-merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const scope = body?.scope === "partner" ? "partner" : "corporate";
          const limit = parseInt(body?.limit, 10);
          const overrides: Record<string, string> = {};
          if (body?.overrides && typeof body.overrides === "object") {
            for (const [k, v] of Object.entries(body.overrides)) {
              if (typeof k === "string" && typeof v === "string" && v.trim()) {
                overrides[k] = v.trim();
              }
            }
          }
          const excludes: Record<string, string[]> = {};
          if (body?.excludes && typeof body.excludes === "object") {
            for (const [k, v] of Object.entries(body.excludes)) {
              if (typeof k === "string" && Array.isArray(v)) {
                const ids = v.map((x: any) => String(x || "").trim()).filter(Boolean);
                if (ids.length) excludes[k] = ids;
              }
            }
          }
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk account ${scope} domain-only merge)`;
          const { applyAccountDomainNameMerge } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyAccountDomainNameMerge({
            scope,
            dryRun: false,
            limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
            performedBy,
            overrides,
            excludes,
            groupBy: "domain",
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Acceptance-pattern analysis (Sample User 2026-06-20): learn AUTO-APPROVE rules
    // from resolved data (manual merges + agent applies). Recommend-only.
    //   GET /api/duplicates/autonomous/acceptance-patterns?module=Accounts&days=90
    path: "/api/duplicates/autonomous/acceptance-patterns",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const days = parseInt(url.searchParams.get("days") || "90", 10);
          const moduleRaw = url.searchParams.get("module") || "";
          const module = ["Accounts", "Leads", "Deals", "Contacts"].includes(moduleRaw)
            ? moduleRaw
            : undefined;
          const { analyzeAcceptancePatterns } = await import("../../utils/rejectionPatterns");
          const data = await analyzeAcceptancePatterns({
            module,
            windowDays: Number.isFinite(days) && days > 0 ? days : 90,
          });
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-tab daily PROGRESS burndown (Sample User 2026-06-17): for each module
    // (Leads/Deals/Contacts/Accounts) returns the daily series of open / solved
    // / total (+ durable merged) plus the latest snapshot and the day-over-day
    // delta. "solved" = clusters no longer active; "total" = open + solved (the
    // denominator, which grows as new duplicates are detected). Read-only.
    //   GET /api/duplicates/progress?days=30
    path: "/api/duplicates/progress",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const days = parseInt(url.searchParams.get("days") || "30", 10);
          const data = await getDuplicateProgressSeries(
            Number.isFinite(days) && days > 0 ? days : 30,
          );
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Clear the autonomous resolver's stale SHADOW proposals — bulk-reject every
    // PENDING 'duplicate-resolution' card in one call. Management-tier. These were
    // never applied to Zoho (shadow), so this writes NOTHING to the CRM — it just
    // empties the review backlog so the queue shows only real escalations.
    // Optional onlyVerdict ('auto'|'escalate') clears just one tier.
    //   POST /api/duplicates/autonomous/clear-shadow-proposals
    path: "/api/duplicates/autonomous/clear-shadow-proposals",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const onlyVerdict =
            body?.onlyVerdict === "auto" || body?.onlyVerdict === "escalate"
              ? body.onlyVerdict
              : null;
          // sourceGroup (Sample User 2026-06-20): which pending actions to clear.
          //   'autonomous' (default) → only the resolver's shadow proposals
          //   'adam'                 → only chat-initiated requests
          //   'all'                  → EVERY pending action (full reset)
          const sourceGroup =
            body?.sourceGroup === "all" || body?.sourceGroup === "adam"
              ? body.sourceGroup
              : "autonomous";
          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const params: any[] = [
            (user as any)?.email || "admin",
            (user as any)?.name || "admin",
          ];
          // Build the tool-scope clause for the chosen source group.
          let toolClause = " AND tool_id = 'duplicate-resolution'";
          if (sourceGroup === "adam") toolClause = " AND tool_id <> 'duplicate-resolution'";
          else if (sourceGroup === "all") toolClause = "";
          let verdictClause = "";
          if (onlyVerdict) {
            verdictClause = ` AND payload->>'verdict' = $${params.length + 1}`;
            params.push(onlyVerdict);
          }
          const r = await pool.query(
            `UPDATE ai_pending_actions
                SET status = 'rejected',
                    rejection_reason = 'Cleared in bulk — backlog reset, never applied to Zoho.',
                    reviewed_by_email = $1,
                    reviewed_by_name = $2,
                    reviewed_at = NOW()
              WHERE status = 'pending'${toolClause}${verdictClause}`,
            params,
          );
          return c.json({ success: true, cleared: r.rowCount ?? 0 });
        } catch (e: any) {
          logger.error("Error clearing shadow proposals:", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // "Post operational digest now" — manually fire the SAME twice-daily apply
    // digest (per-tab status board) on demand, so you can see it immediately
    // instead of waiting for the 09:00 / 17:00 KSA run. Posts to the resolution
    // Slack channel. Management-tier only (it broadcasts to the team channel).
    path: "/api/duplicates/autonomous/digest/send",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const sinceHours =
            Number.isFinite(body?.sinceHours) && body.sinceHours > 0
              ? Math.min(168, Math.floor(body.sinceHours))
              : 8;
          await postResolutionDigest({ label: "Manual run", sinceHours });
          return c.json({ ok: true, sinceHours });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Admin-only: change the agent's mode / kill switch from inside the platform
    // (DB override; applies on the next tick, no republish). Audit-logged.
    path: "/api/duplicates/autonomous/mode",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const patch: { enabled?: boolean; mode?: ResolutionMode } = {};
          if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
          if (["shadow", "assisted", "autonomous"].includes(body?.mode)) {
            patch.mode = body.mode as ResolutionMode;
          }
          if (patch.enabled === undefined && patch.mode === undefined) {
            return c.json({ error: "Provide `mode` (shadow|assisted|autonomous) and/or `enabled` (boolean)." }, 400);
          }
          const before = await resolveResolutionRunConfig();
          const updated = await setResolutionSetting(
            patch,
            (user as any)?.email || "admin",
          );
          const after = await resolveResolutionRunConfig();
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              userEmail: (user as any)?.email || undefined,
              userRole: (user as any)?.role || undefined,
              actionType: "AI_ACTION",
              entityType: "SYSTEM",
              entityId: "autonomous-resolution",
              entityName: "Autonomous Resolution mode",
              description:
                `Autonomous Resolution changed: mode ${before.mode}→${after.mode}, ` +
                `writes ${before.enabled ? "ON" : "OFF"}→${after.enabled ? "ON" : "OFF"}.`,
              aiInvolved: true,
              severity: after.enabled && after.mode !== "shadow" ? "WARNING" : "INFO",
              module: "duplicate-radar",
            });
          } catch {
            /* audit is best-effort */
          }
          return c.json({ ok: true, config: after, override: updated });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Send a one-off test ping to the resolution Slack channel.
    path: "/api/duplicates/autonomous/slack-test",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const result = await sendResolutionSlackTest(
            (user as any)?.email || "operator",
          );
          return c.json(result, result.ok ? 200 : 400);
        } catch (e: any) {
          return c.json({ ok: false, error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // One-off cleanup: delete the bot's zero-progress "applied 0" resolution
    // pings from the Slack channel (Sample User 2026-06-20). Management-tier.
    path: "/api/duplicates/autonomous/cleanup-slack-pings",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const result = await cleanupZeroResolutionPings({ limit: 800 });
          return c.json({ success: !result.error, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Manual "Run now" — runs one full tick (respects mode/kill-switch).
    path: "/api/duplicates/autonomous/run-now",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const modeOverride =
            body?.mode === "shadow" || body?.mode === "assisted" || body?.mode === "autonomous"
              ? body.mode
              : undefined;
          const summary = await runAutonomousResolution({ modeOverride });
          return c.json({ ok: true, summary });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Re-do: re-run the resolution for one cluster (Agent Activity log).
    path: "/api/duplicates/autonomous/run-cluster/:id",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const summary = await runResolutionForCluster(id);
          return c.json({ ok: true, summary });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Undo: remove the agent's Duplicate-Delete tags + reopen the cluster.
    path: "/api/duplicates/autonomous/undo/:id",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const result = await undoClusterResolution(
            id,
            (user as any)?.email || "duplicate-radar",
          );
          return c.json(result, result.ok ? 200 : 400);
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Learning-curve history for the chart. Optional ?module=Accounts.
    path: "/api/duplicates/autonomous/grades",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const module = c.req.query("module") || undefined;
          const history = await getGradeHistory(module, 300);
          return c.json({ history });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // List learning rules (Rules view).
    path: "/api/duplicates/autonomous/rules",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const includeDisabled = c.req.query("all") === "1";
          const rules = await listResolutionRules(includeDisabled);
          return c.json({ rules });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Create a learning rule ("Make this a rule" — don't re-ask similar cases).
    path: "/api/duplicates/autonomous/rules",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const module = parseAgenticModule(body);
          const decision = body?.decision as RuleDecision;
          if (!["auto_approve", "never_merge", "always_link"].includes(decision)) {
            return c.json({ error: "decision must be auto_approve | never_merge | always_link" }, 400);
          }
          const id = await recordResolutionRule({
            module,
            caseSignature:
              body?.caseSignature && typeof body.caseSignature === "object"
                ? body.caseSignature
                : {},
            decision,
            scope: body?.clusterId ? "cluster" : "pattern",
            clusterId: body?.clusterId ?? null,
            createdBy: (user as any)?.email || "duplicate-radar",
          });
          if (id == null) return c.json({ error: "Could not create rule" }, 500);
          return c.json({ ok: true, id });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Enable / disable a rule.
    path: "/api/duplicates/autonomous/rules/:id",
    method: "PATCH" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid rule id" }, 400);
          const body = await c.req.json().catch(() => ({}));
          const ok = await setResolutionRuleEnabled(id, body?.enabled !== false);
          return c.json({ ok });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-record attachment counts for a cluster (the 📎 chip in the merge
    // modal + evidence-safety signal). ?module=Accounts|Leads|Deals|Contacts.
    path: "/api/duplicates/clusters/:id/attachments",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const module = parseAgenticModule({ module: c.req.query("module") });
          const recordType = MODULE_RECORD_TYPE[module];
          const records = await getRecordsByClusterId(id);
          const ids = records
            .filter((r) => r.record_type === recordType && r.zoho_record_id)
            .map((r) => r.zoho_record_id as string)
            .slice(0, 25); // bound the Zoho calls
          const counts: Record<string, number> = {};
          await Promise.all(
            ids.map(async (zid) => {
              try {
                const atts = await fetchRecordAttachments(module, zid);
                counts[zid] = Array.isArray(atts) ? atts.length : 0;
              } catch {
                counts[zid] = -1; // unknown (Zoho error) — UI shows a neutral dash
              }
            }),
          );
          return c.json({ module, counts });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-Account child-deal counts. Replaces the 📎 attachments chip in
    // the Accounts merge modal — "which of these two Accounts has the
    // bigger Deals book?" is a stronger survivor signal than attachment
    // counts. Sample User (2026-06-10): "instead of attachments here we
    // can add the no. of deals that inside the account itself".
    //   GET /api/duplicates/clusters/:id/deal-counts
    //   Response: { counts: { <accountZohoId>: N, ... } }
    //   -1 = Zoho error (UI renders a neutral dash, no crash).
    path: "/api/duplicates/clusters/:id/deal-counts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const records = await getRecordsByClusterId(id);
          const accountIds = records
            .filter((r) => r.record_type === "account" && r.zoho_record_id)
            .map((r) => r.zoho_record_id as string)
            .slice(0, 25); // bound the Zoho fan-out per click
          const counts: Record<string, number> = {};
          await Promise.all(
            accountIds.map(async (zid) => {
              try {
                const deals = await fetchZohoRelatedRecords(
                  "Accounts",
                  zid,
                  "Deals",
                  { perPage: 200 },
                );
                counts[zid] = Array.isArray(deals) ? deals.length : 0;
              } catch {
                counts[zid] = -1;
              }
            }),
          );
          return c.json({ counts });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    //   GET /api/duplicates/clusters/:id/account-deals
    //   Lists the Deals linked to each Account in the cluster, so the Account
    //   merge pop-up can show them and let the operator move a Deal from one
    //   Account to another. Response: { accounts:[{zohoId,name}], deals:{<acct>:[{id,name,stage}]} }
    path: "/api/duplicates/clusters/:id/account-deals",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const records = await getRecordsByClusterId(id);
          const accounts = records
            .filter((r) => r.record_type === "account" && r.zoho_record_id)
            .map((r) => ({
              zohoId: r.zoho_record_id as string,
              name: r.record_name || r.company_name || "Account",
            }))
            .slice(0, 25);
          const deals: Record<
            string,
            Array<{ id: string; name: string; stage: string }>
          > = {};
          await Promise.all(
            accounts.map(async (a) => {
              try {
                const ds = await fetchZohoRelatedRecords(
                  "Accounts",
                  a.zohoId,
                  "Deals",
                  { perPage: 200 },
                );
                deals[a.zohoId] = (Array.isArray(ds) ? ds : []).map(
                  (d: any) => ({
                    id: String(d.id),
                    name: d.Deal_Name || d.Name || "Deal",
                    stage: d.Stage || "",
                  }),
                );
              } catch {
                deals[a.zohoId] = [];
              }
            }),
          );
          return c.json({ accounts, deals });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    //   POST /api/duplicates/link-record-to-account
    //   Move a single Deal or Contact under an Account by setting its
    //   Account_Name lookup in Zoho. Reuses the same primitive the merge
    //   executor uses for "link survivor to account". Admin-gated; supports
    //   dry_run. Body: { module:'Deals'|'Contacts', record_zoho_id, account_zoho_id, dry_run? }
    path: "/api/duplicates/link-record-to-account",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: ua } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return ua(c);
          const body = await c.req.json().catch(() => ({}));
          const module = String(body?.module || "");
          const recordId = String(body?.record_zoho_id || "");
          const accountId = String(body?.account_zoho_id || "");
          const dryRun = body?.dry_run === true;
          if (!["Deals", "Contacts"].includes(module)) {
            return c.json({ error: "module must be 'Deals' or 'Contacts'" }, 400);
          }
          if (!recordId || !accountId) {
            return c.json(
              { error: "record_zoho_id and account_zoho_id are required" },
              400,
            );
          }
          if (dryRun) {
            return c.json({
              success: true,
              dry_run: true,
              message: `Would set ${module} ${recordId} Account_Name → ${accountId}`,
            });
          }
          const { updateZohoRecord } = await import("../../utils/zohoCRM");
          await updateZohoRecord(module, recordId, {
            Account_Name: { id: accountId },
          });
          logger.info(
            `🔗 [DuplicateRadar] Linked ${module} ${recordId} → Account ${accountId} by ${sessionUser.email || "admin"}`,
          );
          return c.json({
            success: true,
            module,
            record_zoho_id: recordId,
            account_zoho_id: accountId,
          });
        } catch (error: any) {
          logger.error("Error linking record to account:", error);
          return c.json({ error: error?.message || "Link failed" }, 500);
        }
      };
    },
  },
  {
    // Post-merge verification — re-query Zoho for every record this cluster
    // has tagged Duplicate-Delete (via prior merge_actions). Reports how many
    // the admin has actually deleted vs. still pending. Closes the "did the
    // tag-and-delete handoff actually happen?" visibility gap.
    //   GET /api/duplicates/clusters/:id/verify-tags
    // Response: { total, deleted, alive, errors, byRecord: [{zohoId, module, status}] }
    path: "/api/duplicates/clusters/:id/verify-tags",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const { pool } = await import("../../utils/duplicateRadarDatabase");
          // Union of every merged_record_ids the cluster has accumulated —
          // closing 'resolve' AND partial 'module_resolved' actions both
          // count, so cross-module clusters with multiple module Applies
          // verify end-to-end on a single call.
          const acts = await pool.query(
            `SELECT merged_record_ids FROM duplicate_merge_actions
              WHERE cluster_id = $1
                AND action_type IN ('resolve', 'module_resolved')`,
            [id],
          );
          const dbIdSet = new Set<number>();
          for (const r of acts.rows) {
            const raw = r.merged_record_ids;
            const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (Array.isArray(arr)) {
              for (const v of arr) {
                const n = typeof v === "number" ? v : parseInt(String(v), 10);
                if (Number.isFinite(n)) dbIdSet.add(n);
              }
            }
          }
          if (dbIdSet.size === 0) {
            return c.json({
              total: 0,
              deleted: 0,
              alive: 0,
              errors: 0,
              byRecord: [],
              message: "No tagged duplicates on this cluster yet — run Apply first.",
            });
          }

          // Resolve db ids → (zoho_record_id, zoho_module). Bound to ≤50
          // ids per call so a runaway merge_action history can't pin us in
          // a 5-minute Zoho fan-out.
          const dbIds = Array.from(dbIdSet).slice(0, 50);
          const recs = await pool.query(
            `SELECT id, zoho_record_id, zoho_module, record_type, record_name
               FROM duplicate_records
              WHERE id = ANY($1::int[])`,
            [dbIds],
          );
          const RECORD_TYPE_TO_MODULE: Record<string, string> = {
            lead: "Leads",
            deal: "Deals",
            contact: "Contacts",
            account: "Accounts",
          };
          const byRecord: Array<{
            dbId: number;
            zohoId: string | null;
            module: string | null;
            name: string | null;
            status: "deleted" | "alive" | "no-zoho-id" | "error";
            error?: string;
          }> = [];
          let deleted = 0,
            alive = 0,
            errors = 0;
          await Promise.all(
            recs.rows.map(async (row: any) => {
              const zohoId = row.zoho_record_id || null;
              const moduleName =
                row.zoho_module ||
                RECORD_TYPE_TO_MODULE[row.record_type as string] ||
                null;
              if (!zohoId || !moduleName) {
                byRecord.push({
                  dbId: row.id,
                  zohoId,
                  module: moduleName,
                  name: row.record_name || null,
                  status: "no-zoho-id",
                });
                return;
              }
              try {
                const live = await fetchZohoRecordById(moduleName, zohoId);
                if (live === null) {
                  deleted++;
                  byRecord.push({
                    dbId: row.id,
                    zohoId,
                    module: moduleName,
                    name: row.record_name || null,
                    status: "deleted",
                  });
                } else {
                  alive++;
                  byRecord.push({
                    dbId: row.id,
                    zohoId,
                    module: moduleName,
                    name: row.record_name || null,
                    status: "alive",
                  });
                }
              } catch (e: any) {
                errors++;
                byRecord.push({
                  dbId: row.id,
                  zohoId,
                  module: moduleName,
                  name: row.record_name || null,
                  status: "error",
                  error: e?.message || String(e),
                });
              }
            }),
          );
          // 2026-06-18 — reconcile like /recheck: records confirmed gone from
          // Zoho (404) are marked stale_pending and purged, so the cluster
          // collapses to the survivor(s) instead of listing deleted dupes.
          let purged = 0;
          const deletedDbIds = byRecord
            .filter((x) => x.status === "deleted")
            .map((x) => x.dbId);
          if (deletedDbIds.length > 0) {
            try {
              await markRecordsStalePendingByIds(deletedDbIds);
              purged = await cleanupStaleRecords();
              await cleanupOrphanClusters();
              await updateClusterStats(id).catch(() => {});
            } catch (reErr: any) {
              logger.warn("[DuplicateRadar] verify-tags reconcile skipped:", {
                error: reErr?.message || String(reErr),
              });
            }
          }
          return c.json({
            total: byRecord.length,
            deleted,
            alive,
            errors,
            purged,
            byRecord,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // BULK verify-and-resolve: for every AI-Applied (pending Zoho delete)
    // cluster — optionally a single module — re-query Zoho for the tagged
    // Duplicate-Delete records and mark Resolved ONLY those where the admin has
    // deleted every one. For when the admin clears a big batch at once. Bounded
    // (≤ maxClusters, ≤50 records/cluster) and conservative — a cluster is only
    // resolved when EVERY tagged duplicate is provably gone (no alive, no
    // no-zoho-id, no Zoho error). Reuses the verify-tags logic + resolveCluster.
    //   POST /api/duplicates/verify-resolve-applied
    //   Body: { module?: 'Accounts'|'Leads'|'Deals'|'Contacts', maxClusters?: number }
    //   Response: { checked, resolved, pending, errored, noTags, more, perCluster }
    path: "/api/duplicates/verify-resolve-applied",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const MODCOL: Record<string, string> = {
            Accounts: "total_accounts",
            Leads: "total_leads",
            Deals: "total_deals",
            Contacts: "total_contacts",
          };
          const moduleRaw = String(body?.module || "").trim();
          const moduleCol = MODCOL[moduleRaw] || null;
          const maxClusters = Number.isFinite(body?.maxClusters)
            ? Math.max(1, Math.min(50, Number(body.maxClusters)))
            : 20;

          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const moduleFilter = moduleCol ? ` AND dc.${moduleCol} > 0` : "";

          // scope=dismissed answers "the admin said they deleted these — did
          // they?" for the Dismissed tab, which had no CRM verification at all;
          // only AI-Applied did. It REPORTS and never mutates: a dismissal is a
          // deliberate human judgement, and auto-resolving one would also
          // inflate the resolved counters that Data Cleaning Progress reads.
          const scope =
            String(body?.scope || "ai_applied").trim() === "dismissed"
              ? "dismissed"
              : "ai_applied";

          const clustersQ = await pool.query(
            scope === "dismissed"
              ? // A dismissed cluster is stored as status 'ignored' — that is
                // what the UI tests (duplicates-app.js: c.status === 'ignored')
                // and what summary.ignoredCount counts. 'dismissed' appears in
                // one COUNT elsewhere in this file but matches no rows; querying
                // it returned checked:0 against 151 visibly dismissed clusters.
                // Both are accepted so neither spelling silently finds nothing.
                `SELECT dc.id
                   FROM duplicate_clusters dc
                  WHERE dc.status IN ('ignored','dismissed')${moduleFilter}
                  ORDER BY dc.updated_at DESC NULLS LAST
                  LIMIT $1`
              : // AI-Applied = active cluster carrying a resolve/module_resolved action.
                `SELECT dc.id
                   FROM duplicate_clusters dc
                  WHERE dc.status = 'active'
                    AND EXISTS (
                      SELECT 1 FROM duplicate_merge_actions ma
                       WHERE ma.cluster_id = dc.id
                         AND ma.action_type IN ('resolve','module_resolved')
                    )${moduleFilter}
                  ORDER BY dc.updated_at DESC NULLS LAST
                  LIMIT $1`,
            [maxClusters + 1],
          );
          const allIds = clustersQ.rows.map((r: any) => Number(r.id));
          const more = allIds.length > maxClusters;
          const ids = allIds.slice(0, maxClusters);

          const RTM: Record<string, string> = {
            lead: "Leads",
            deal: "Deals",
            contact: "Contacts",
            account: "Accounts",
          };
          let resolved = 0,
            pending = 0,
            errored = 0,
            noTags = 0;
          const perCluster: any[] = [];

          // Sequential across clusters (so a big batch can't fan out into a
          // thousand concurrent Zoho calls); records WITHIN a cluster checked in
          // parallel, bounded to ≤50.
          for (const cid of ids) {
            const dbIdSet = new Set<number>();
            if (scope === "dismissed") {
              // A dismissed cluster has no tagged subset — the question is
              // whether the WHOLE group is still in Zoho, so check every member.
              const all = await pool.query(
                `SELECT id FROM duplicate_records WHERE cluster_id = $1`,
                [cid],
              );
              for (const r of all.rows) dbIdSet.add(Number(r.id));
            }
            const acts = scope === "dismissed"
              ? { rows: [] as any[] }
              : await pool.query(
              `SELECT merged_record_ids FROM duplicate_merge_actions
                WHERE cluster_id = $1 AND action_type IN ('resolve','module_resolved')`,
              [cid],
            );
            for (const r of acts.rows) {
              const raw = r.merged_record_ids;
              const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
              if (Array.isArray(arr)) {
                for (const v of arr) {
                  const n = typeof v === "number" ? v : parseInt(String(v), 10);
                  if (Number.isFinite(n)) dbIdSet.add(n);
                }
              }
            }
            if (dbIdSet.size === 0 && scope !== "dismissed") {
              // The action fired but recorded no merged_record_ids, so there is
              // nothing to look up and the cluster can NEVER leave "AI-Applied ·
              // pending Zoho admin delete" — it just sits there forever. Five
              // clusters were in exactly this state on 2026-08-19.
              //
              // A resolve action means "keep the primary, delete the rest", so
              // fall back to the cluster's non-primary members: that is what the
              // action asserted even when it failed to write the list down.
              const fallback = await pool.query(
                `SELECT id FROM duplicate_records
                  WHERE cluster_id = $1 AND COALESCE(is_primary, false) = false`,
                [cid],
              );
              for (const r of fallback.rows) dbIdSet.add(Number(r.id));
            }
            if (dbIdSet.size === 0) {
              // Genuinely nothing to check — a single-record cluster, or every
              // member already gone from the mirror.
              noTags++;
              continue;
            }
            const dbIds = Array.from(dbIdSet).slice(0, 50);
            const recs = await pool.query(
              `SELECT id, zoho_record_id, zoho_module, record_type
                 FROM duplicate_records WHERE id = ANY($1::int[])`,
              [dbIds],
            );
            let total = 0,
              deleted = 0,
              alive = 0,
              errs = 0;
            await Promise.all(
              recs.rows.map(async (row: any) => {
                total++;
                const zohoId = row.zoho_record_id || null;
                const mod =
                  row.zoho_module || RTM[row.record_type as string] || null;
                if (!zohoId || !mod) {
                  // Can't confirm deletion → conservatively treat as not-gone.
                  alive++;
                  return;
                }
                try {
                  const live = await fetchZohoRecordById(mod, zohoId);
                  if (live === null) deleted++;
                  else alive++;
                } catch {
                  errs++;
                }
              }),
            );
            if (scope === "dismissed") {
              // Report only. An all-deleted dismissed cluster is moot and will
              // disappear once the mirror no longer holds the records — it is
              // not a resolution anyone performed, so it must not be credited
              // as one.
              const gone = total > 0 && alive === 0 && errs === 0 && deleted === total;
              if (gone) resolved++;
              else if (errs > 0) errored++;
              else pending++;
              perCluster.push({
                id: cid,
                outcome: gone ? "all_deleted_in_zoho" : errs > 0 ? "error" : "still_present",
                deleted,
                alive,
                total,
              });
            } else if (total > 0 && alive === 0 && errs === 0 && deleted === total) {
              await resolveCluster(
                cid,
                "resolve",
                sessionUser.email || "admin",
                undefined,
                `Verified in CRM (bulk): all ${total} Duplicate-Delete record(s) confirmed deleted in Zoho.`,
              );
              resolved++;
              perCluster.push({ id: cid, outcome: "resolved", deleted, total });
            } else if (errs > 0) {
              errored++;
              perCluster.push({ id: cid, outcome: "error", deleted, alive, errors: errs, total });
            } else {
              pending++;
              perCluster.push({ id: cid, outcome: "pending", deleted, alive, total });
            }
          }
          return c.json({
            success: true,
            scope,
            checked: ids.length,
            // In `dismissed` scope nothing is mutated: `resolved` counts
            // clusters whose records are ALL gone from Zoho, not clusters this
            // call resolved.
            resolved,
            pending,
            errored,
            noTags,
            more,
            perCluster,
          });
        } catch (error: any) {
          logger.error("Error in verify-resolve-applied:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // One-shot cleanup: apply the ≥2-attribute Contact rule retroactively
    // to every existing active Contacts cluster. Splits each cluster's
    // sub-components into their own clusters so today's "7 SLB employees"
    // mass clusters drop off the dashboard. DESTRUCTIVE (rewrites cluster_id
    // on duplicate_records rows) → admin only. Defaults to dry-run.
    //   POST /api/duplicates/bulk-split-contacts
    //   Body: { confirm?: boolean, limit?: number }
    //     confirm !== true → dry-run that returns the plan + counts
    //     limit (default 500, max 5000) bounds clusters touched per call
    path: "/api/duplicates/bulk-split-contacts",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const dryRun = body?.confirm !== true;
          const limit = Number.isFinite(body?.limit)
            ? Math.max(1, Math.min(5000, Number(body.limit)))
            : 500;
          const performedBy =
            (sessionUser as any)?.email ||
            (sessionUser as any)?.role ||
            "admin";
          const result = await bulkSplitContactClustersByStrictRule({
            dryRun,
            limit,
            performedBy,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          logger.error("[bulk-split-contacts] failed:", e);
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-cluster re-check: for every record currently in the cluster,
    // re-fetch from Zoho and report its live state — does the record still
    // exist? what's its current Account_Name? what tags? Used right after
    // an Apply to confirm the migrate-tag-cascade chain actually landed in
    // Zoho without needing to wait for the next 6h scan.
    //   GET /api/duplicates/clusters/:id/recheck
    path: "/api/duplicates/clusters/:id/recheck",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const records = await getRecordsByClusterId(id);
          const RECORD_TYPE_TO_MODULE: Record<string, string> = {
            lead: "Leads",
            deal: "Deals",
            contact: "Contacts",
            account: "Accounts",
          };
          // Bound the fan-out — clusters with hundreds of records would
          // otherwise burn our Zoho quota in one click.
          const targets = records
            .filter((r) => r.zoho_record_id)
            .slice(0, 50);
          const truncated = records.length > targets.length;

          const out = await Promise.all(
            targets.map(async (r) => {
              const moduleName =
                r.zoho_module ||
                RECORD_TYPE_TO_MODULE[r.record_type as string];
              const zohoId = r.zoho_record_id as string;
              if (!moduleName) {
                return {
                  dbId: r.id,
                  zohoId,
                  module: null,
                  name: r.record_name || null,
                  recordType: r.record_type,
                  isPrimary: !!r.is_primary,
                  status: "no-module" as const,
                };
              }
              try {
                const live = await fetchZohoRecordById(moduleName, zohoId);
                if (live === null) {
                  return {
                    dbId: r.id,
                    zohoId,
                    module: moduleName,
                    name: r.record_name || null,
                    recordType: r.record_type,
                    isPrimary: !!r.is_primary,
                    status: "deleted" as const,
                  };
                }
                const data = (live.data as Record<string, any>) || {};
                const tagList: string[] = Array.isArray(data.Tag)
                  ? data.Tag.map((t: any) => String(t?.name || t || "")).filter(Boolean)
                  : [];
                const accountName =
                  data.Account_Name?.name || data.account_name || null;
                return {
                  dbId: r.id,
                  zohoId,
                  module: moduleName,
                  name: r.record_name || null,
                  recordType: r.record_type,
                  isPrimary: !!r.is_primary,
                  status: "alive" as const,
                  hasDuplicateDeleteTag: tagList.some((t) =>
                    /duplicate.?delete/i.test(t),
                  ),
                  tags: tagList,
                  currentAccountName: accountName,
                };
              } catch (e: any) {
                return {
                  dbId: r.id,
                  zohoId,
                  module: moduleName,
                  name: r.record_name || null,
                  recordType: r.record_type,
                  isPrimary: !!r.is_primary,
                  status: "error" as const,
                  error: e?.message || String(e),
                };
              }
            }),
          );
          const tally = {
            total: out.length,
            alive: out.filter((x) => x.status === "alive").length,
            deleted: out.filter((x) => x.status === "deleted").length,
            errors: out.filter((x) => x.status === "error").length,
            tagged: out.filter(
              (x: any) => x.status === "alive" && x.hasDuplicateDeleteTag,
            ).length,
          };
          // 2026-06-18 — reconcile: records confirmed GONE from Zoho (404) are
          // marked stale_pending and purged, so a resolved cluster collapses to
          // just the survivor instead of lingering with already-deleted dupes.
          // Only acts on definitively-deleted rows (never on transient errors).
          let purged = 0;
          const deletedDbIds = out
            .filter((x) => x.status === "deleted" && typeof x.dbId === "number")
            .map((x) => x.dbId as number);
          if (deletedDbIds.length > 0) {
            try {
              await markRecordsStalePendingByIds(deletedDbIds);
              purged = await cleanupStaleRecords();
              await cleanupOrphanClusters();
              await updateClusterStats(id).catch(() => {});
            } catch (reErr: any) {
              logger.warn("[DuplicateRadar] recheck reconcile skipped:", {
                error: reErr?.message || String(reErr),
              });
            }
          }
          return c.json({
            ...tally,
            purged,
            truncated,
            totalInCluster: records.length,
            byRecord: out,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Reparent preview — for an Accounts (or Contacts) merge plan, count
    // the child Deals / Contacts the executor will repoint onto the
    // survivor. The number already lands in the execute report; this
    // endpoint surfaces it BEFORE Apply so the merge modal can render
    // "Will reparent: X Deals · Y Contacts" up front.
    //   GET /api/duplicates/clusters/:id/reparent-preview?module=Accounts
    path: "/api/duplicates/clusters/:id/reparent-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const module = parseAgenticModule({ module: c.req.query("module") });
          // Only Accounts (→ Deals + Contacts) and Contacts (→ Deals) have
          // related-list children worth previewing. Leads / Deals have none.
          if (module !== "Accounts" && module !== "Contacts") {
            return c.json({ module, deals: 0, contacts: 0, scope: "n/a" });
          }
          const recordType = MODULE_RECORD_TYPE[module];
          const records = await getRecordsByClusterId(id);
          // Survivor = the most-complete record (auto-pick) unless the
          // operator overrode it. The preview counts cover all NON-survivor
          // records — same set the executor would walk.
          const sameModuleRecords = records.filter(
            (r) => r.record_type === recordType && r.zoho_record_id,
          );
          if (sameModuleRecords.length < 2) {
            return c.json({ module, deals: 0, contacts: 0, scope: "no-dups" });
          }
          // Pick the primary as the assumed survivor (matches planner's
          // default master selection well enough for a preview).
          const survivor =
            sameModuleRecords.find((r) => r.is_primary) ||
            sameModuleRecords[0];
          const dups = sameModuleRecords.filter(
            (r) => r.zoho_record_id !== survivor.zoho_record_id,
          );

          // Same list shape as duplicateMergeExecutor.MODULE_REPARENT.
          const REPARENT_LISTS: Array<{
            list: string;
            bucket: "deals" | "contacts";
          }> =
            module === "Accounts"
              ? [
                  { list: "Deals", bucket: "deals" },
                  { list: "Contacts", bucket: "contacts" },
                ]
              : [{ list: "Deals", bucket: "deals" }];

          const counts = { deals: 0, contacts: 0 };
          for (const dup of dups.slice(0, 25)) {
            // Bound the fan-out: 25 dups × 2 lists = 50 Zoho calls max.
            for (const rp of REPARENT_LISTS) {
              try {
                const children = await fetchZohoRelatedRecords(
                  module,
                  dup.zoho_record_id as string,
                  rp.list,
                  { perPage: 200 },
                );
                counts[rp.bucket] += Array.isArray(children) ? children.length : 0;
              } catch {
                /* best-effort — partial preview is better than no preview */
              }
            }
          }
          return c.json({
            module,
            deals: counts.deals,
            contacts: counts.contacts,
            scope: dups.length > 25 ? "truncated" : "complete",
            duplicatesInspected: Math.min(dups.length, 25),
            duplicatesTotal: dups.length,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Deal-stage DOCUMENT compliance (Sales SOP 7.5.10): lists deals in
    // Proposal/Paid/Agreement Signed + the documents each stage requires.
    // Field/data-entry compliance is owned by the Quality Dashboard audit;
    // this surface is purely the Zoho-Attachments layer. Per-deal document
    // verification is loaded via the doc-compliance endpoint (lazy, bounds
    // Zoho calls).
    path: "/api/duplicates/deal-compliance",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          // Which stages to check — from the Advanced Filters Stage selector
          // (?stages=A,B,C); defaults to the real closing stages. Zoho's list
          // endpoint ignores `criteria`, so we filter in CODE (reliable).
          const stagesParam = (c.req.query("stages") || "").trim();
          const wanted = stagesParam
            ? stagesParam.split(",").map((s: string) => s.trim()).filter(Boolean)
            : [...DEAL_COMPLIANCE_STAGES];
          const wantedLower = new Set(wanted.map((s: string) => s.toLowerCase()));

          // SOURCE: the local mirror by default, live Zoho only on request.
          //
          // This used to always pull 3,000 deals live from Zoho, which cost
          // 10.2s measured on 2026-08-24 — on tab open AND on every stage-filter
          // Apply. The browser was never blocked (0 long tasks, 85ms to render
          // 976 rows); it was simply waiting, which is what read as the tab
          // being "heavy" and stopping.
          //
          // duplicate_records holds the same deals from the last sync, so the
          // list comes from there instead. Two deliberate consequences, agreed
          // with Sample User 2026-08-24:
          //   FRESHNESS  — a deal created or re-staged since the last sync will
          //                not appear until the next one. The "Refresh from
          //                Zoho (live)" button passes ?live=1 and still hits
          //                Zoho, so there is always a way to see this second.
          //   COVERAGE   — the mirror holds ALL deals, not the most-recently-
          //                modified 3,000, so "In scope" can legitimately grow.
          //                That is more complete, not inflated.
          // Attachment verification is UNCHANGED and still live per deal — only
          // the deal LIST moved.
          const useLive = c.req.query("live") === "1";
          let allDeals: any[] = [];
          try {
            allDeals = useLive
              ? await fetchAllZohoRecords("Deals", {
                  sortBy: "Modified_Time",
                  sortOrder: "desc",
                  maxRecords: 3000,
                })
              : await (async () => {
                  const { pool } = await import("../../utils/duplicateRadarDatabase");
                  // Filter by STAGE in SQL, and never select raw_data.
                  //
                  // This used to fetch every deal that had any stage at all —
                  // 27,281 rows, each carrying its full raw_data JSONB — and
                  // then filter down to ~1,282 in JavaScript. It took 7.7s and
                  // shipped 844KB to the browser (measured 2026-08-26), which
                  // is most of why the tab felt like it hung the machine.
                  // Only the handful of raw_data fields actually rendered are
                  // extracted, in SQL.
                  const q = await pool.query(
                    `SELECT zoho_record_id, record_name, stage, owner_name, owner_email,
                            deal_value, source, created_date, layout_name,
                            NULLIF(BTRIM(COALESCE(
                              raw_data->'Account_Name'->>'name',
                              raw_data->>'Account_Name'
                            )), '') AS account_name,
                            NULLIF(BTRIM(raw_data->>'Stage'), '') AS raw_stage
                       FROM duplicate_records
                      WHERE record_type = 'deal'
                        AND LOWER(BTRIM(COALESCE(NULLIF(stage,''), raw_data->>'Stage',''))) = ANY($1::text[])`,
                    [[...wantedLower]],
                  );
                  // Reshape to the same {id, data:{…}} envelope the live path
                  // returns, so every consumer below is untouched.
                  return q.rows.map((r: any) => ({
                    id: r.zoho_record_id,
                    owner: r.owner_name || r.owner_email || "",
                    data: {
                      Deal_Name: r.record_name || r.zoho_record_id,
                      Stage: r.stage || r.raw_stage || "",
                      Amount: r.deal_value != null ? Number(r.deal_value) : null,
                      Lead_Source: r.source || "",
                      Created_Time: r.created_date
                        ? new Date(r.created_date).toISOString()
                        : "",
                      Account_Name: r.account_name || null,
                      Owner: { name: r.owner_name || r.owner_email || "—" },
                      Layout: r.layout_name ? { name: r.layout_name } : undefined,
                    },
                  }));
                })();
          } catch (e: any) {
            return c.json({ error: `Deal fetch failed: ${e?.message || e}` }, 502);
          }

          // Distinct stages present, and how many deals exist in total.
          //
          // Both used to be derived from the full unfiltered fetch. Now that
          // the deal query is narrowed to the selected stages in SQL, they need
          // their own source — otherwise the in-tab stage filter would only
          // ever offer the stages already selected (no way back to the others),
          // and the "Scanned" card would silently start reporting the filtered
          // count while still being labelled as the whole CRM.
          let distinctStages: string[] = Array.from(
            new Set(allDeals.map((r: any) => (r.data?.Stage || "").trim()).filter(Boolean)),
          ).sort();
          let scannedTotal = allDeals.length;
          if (!useLive) {
            try {
              const { pool } = await import("../../utils/duplicateRadarDatabase");
              const meta = await pool.query(
                `SELECT COALESCE(NULLIF(BTRIM(stage), ''), BTRIM(raw_data->>'Stage')) AS stage,
                        COUNT(*)::text AS n
                   FROM duplicate_records
                  WHERE record_type = 'deal'
                    AND COALESCE(NULLIF(BTRIM(stage), ''), raw_data->>'Stage', '') <> ''
                  GROUP BY 1`,
              );
              distinctStages = (meta.rows as any[])
                .map((r) => String(r.stage || "").trim())
                .filter(Boolean)
                .sort();
              scannedTotal = (meta.rows as any[]).reduce(
                (n, r) => n + (Number(r.n) || 0),
                0,
              );
            } catch (err) {
              logger.warn(
                "[DealCompliance] stage metadata unavailable — falling back to the filtered set",
                { error: err instanceof Error ? err.message : String(err) },
              );
            }
          }

          let deals = allDeals.filter((r: any) =>
            wantedLower.has(String(r.data?.Stage || "").trim().toLowerCase()),
          );
          // Segment chip (Sample User 2026-07-15): filter the live Zoho deals to the
          // chosen product by their Layout — Zoho returns Layout as {id,name}.
          // Same classification as buildSegmentPredicate (substring, corporate=ExampleOrg).
          const dcSegment = (c.req.query("segment") || "").trim();
          if (dcSegment && dcSegment !== "all") {
            const { classifyLayoutSegment } = await import(
              "../../utils/duplicateRadarDatabase"
            );
            const want = dcSegment === "corporate" ? "ExampleOrg" : dcSegment;
            deals = deals.filter((r: any) => {
              const d = r.data || {};
              const layout =
                (d.Layout && (d.Layout.name || (typeof d.Layout === "string" ? d.Layout : ""))) ||
                (d.$layout && d.$layout.name) ||
                "";
              return classifyLayoutSegment(String(layout)) === want;
            });
          }
          const rows = deals.map((rec: any) => {
            const d = rec.data || {};
            const stage = d.Stage || "";
            return {
              id: rec.id,
              name: d.Deal_Name || rec.id,
              stage,
              owner: d.Owner?.name || rec.owner || "—",
              amount: d.Amount ?? null,
              accountName:
                (typeof d.Account_Name === "object" ? d.Account_Name?.name : d.Account_Name) || null,
              source: d.Lead_Source || "",
              createdTime: d.Created_Time || "",
              requiredDocs: requiredDocsForStage(stage).map((x) => ({ key: x.key, label: x.label })),
            };
          });
          const byStage: Record<string, { total: number }> = {};
          for (const r of rows) {
            byStage[r.stage] = byStage[r.stage] || { total: 0 };
            byStage[r.stage].total++;
          }
          // Attach the STORED document-compliance result for each deal.
          //
          // Without this the tab had no idea a deal had ever been checked
          // unless that particular browser still held it in localStorage, so
          // every fresh session showed hundreds of deals as "not yet checked"
          // and the only way to populate them was the operator pressing
          // "Check all documents" and waiting while their browser drove
          // hundreds of live Zoho calls (Sample User 2026-08-25: "this page is a
          // disaster, it stopped the whole PC"). The background sweep now
          // keeps this table current; the page just reads it.
          //
          // Best-effort: a compliance-table failure must not cost the operator
          // the deal list itself.
          let checkedCount = 0;
          try {
            const { pool } = await import("../../utils/duplicateRadarDatabase");
            const ids = rows.map((r) => String(r.id)).filter(Boolean);
            if (ids.length) {
              const dc = await pool.query(
                `SELECT zoho_deal_id, compliant, present_docs, missing_docs,
                        attachment_count, checked_at, checked_by
                   FROM deal_doc_compliance
                  WHERE zoho_deal_id = ANY($1::text[])`,
                [ids],
              );
              const byId = new Map<string, any>();
              for (const r of dc.rows as any[]) byId.set(String(r.zoho_deal_id), r);
              checkedCount = byId.size;
              for (const row of rows as any[]) {
                const hit = byId.get(String(row.id));
                if (!hit) continue;
                row.compliance = {
                  compliant: hit.compliant === true,
                  presentDocs: Array.isArray(hit.present_docs) ? hit.present_docs : [],
                  missingDocs: Array.isArray(hit.missing_docs) ? hit.missing_docs : [],
                  attachmentCount: Number(hit.attachment_count) || 0,
                  checkedAt: hit.checked_at ? new Date(hit.checked_at).toISOString() : null,
                  checkedBy: hit.checked_by || null,
                };
              }
            }
          } catch (err) {
            logger.warn(
              "[DealCompliance] stored results unavailable — list still returned",
              { error: err instanceof Error ? err.message : String(err) },
            );
          }
          // `source` and `last_sync_at` let the UI state where these deals came
          // from. A mirror-backed list is only as fresh as the last sync, and a
          // compliance surface must not imply it is showing this second's CRM.
          let lastSyncAt: string | null = null;
          if (!useLive) {
            try {
              const { pool } = await import("../../utils/duplicateRadarDatabase");
              const s = await pool.query(
                `SELECT last_sync_at FROM zoho_sync_state WHERE module = 'Deals'`,
              );
              const v = s.rows[0]?.last_sync_at;
              lastSyncAt = v ? new Date(v).toISOString() : null;
            } catch {
              /* the list is still valid without the timestamp */
            }
          }
          return c.json({
            total: rows.length,
            scanned: scannedTotal,
            wanted,
            distinct_stages: distinctStages,
            by_stage: byStage,
            source: useLive ? "zoho_live" : "mirror",
            last_sync_at: lastSyncAt,
            // How much of the listed set the background sweep has covered, so
            // the tab can say so instead of implying a human must go and check.
            checked: checkedCount,
            unchecked: Math.max(0, rows.length - checkedCount),
            deals: rows,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-deal document (attachment) compliance — fetches the deal's Zoho
    // attachments and keyword-matches the SOP-required documents for its stage.
    path: "/api/duplicates/deals/:id/doc-compliance",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = c.req.param("id");
          const stage = c.req.query("stage") || "";
          if (!id) return c.json({ error: "deal id required" }, 400);
          let atts: any[] = [];
          try {
            atts = await fetchRecordAttachments("Deals", id);
          } catch (e: any) {
            return c.json({ error: `Zoho attachments fetch failed: ${e?.message || e}` }, 502);
          }
          // Company documents (VAT, CR, National Address) live on the Account,
          // so the Account's attachments are consulted for those. Without this
          // a manual re-check would contradict the background sweep on the same
          // deal, which is worse than either answer on its own.
          let acctAtts: any[] | undefined;
          try {
            const { pool } = await import("../../utils/duplicateRadarDatabase");
            const q = await pool.query(
              `SELECT NULLIF(BTRIM(raw_data->'Account_Name'->>'id'), '') AS account_id
                 FROM duplicate_records
                WHERE record_type = 'deal' AND zoho_record_id = $1
                LIMIT 1`,
              [String(id)],
            );
            const accountId = q.rows[0]?.account_id;
            if (accountId) acctAtts = await fetchRecordAttachments("Accounts", String(accountId));
          } catch (acctErr) {
            logger.warn(
              `[DealCompliance] account attachments unavailable for deal ${id} — deal documents still checked`,
              { error: acctErr instanceof Error ? acctErr.message : String(acctErr) },
            );
          }
          const result = evaluateDocCompliance(stage, atts, acctAtts);
          // The file NAMES of what is actually attached.
          //
          // Without these, "missing 5 documents" is unfalsifiable: the operator
          // cannot tell a deal with nothing attached from a deal whose contract
          // is attached under a name the keyword matcher does not recognise —
          // and those two need opposite responses. Verifying the 96-99%
          // missing-document rate found on Agreement Signed / Paid deals
          // (2026-08-26) needed exactly this and it was not there.
          //
          // Names only, capped: this is a diagnostic, not a file browser.
          const attachmentNames = (atts || [])
            .map((a: any) => String(a?.fileName || "").trim())
            .filter(Boolean)
            .slice(0, 25);
          // Persist the latest result (shared across users/devices) so the
          // scan survives reloads and can be re-checked / sent to owners.
          // Best-effort: a DB hiccup must not fail the live compliance answer.
          try {
            await upsertDealDocCompliance({
              zohoDealId: String(id),
              stage,
              compliant: !!result.compliant,
              presentDocs: (result.presentDocs || []).map((p: any) => p.label),
              missingDocs: (result.missingDocs || []).map((m: any) => m.label),
              attachmentCount: result.attachmentCount || 0,
              checkedBy: user.email || user.userId ? String(user.email || user.userId) : null,
            });
          } catch (persistErr: any) {
            logger.warn(
              `[DealCompliance] persist failed for deal ${id} (non-fatal): ${persistErr?.message || persistErr}`,
            );
          }
          // Return checkedBy + checkedAt alongside the live verdict so the
          // dashboard's freshly-scanned row immediately shows "checked just
          // now by <user>" — without waiting for the next page-load overlay
          // from /deal-compliance/results. Cross-team visibility: any other
          // reviewer hitting Refresh will see the same attribution.
          const checkedBy =
            user.email || user.userId ? String(user.email || user.userId) : null;
          return c.json({
            ...result,
            attachmentNames,
            checkedBy,
            checkedAt: new Date().toISOString(),
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // BATCH doc-compliance (Sample User 2026-07-29) — check up to 50 deals' Zoho
    // attachments in ONE request, server-side, with bounded concurrency + the
    // existing 429 backoff. The dashboard's "Check all documents" used to fire
    // 200 separate browser fetches with heavy per-row work, which hung the
    // whole device / crashed the browser. Now the browser sends ~10 light
    // batch calls instead. Body: { deals: [{ id, stage }] }.
    // PREVIEW of the monthly missing-documents email — exactly what the
    // scheduled job would send, rendered but NOT sent. Nothing about the
    // recipients is accepted from the request: the list is resolved
    // server-side and only its COUNT is returned, so this endpoint cannot be
    // used to discover or redirect who gets the report.
    // GET /api/duplicates/missing-docs-report/preview
    path: "/api/duplicates/missing-docs-report/preview",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const { getDealComplianceReportRows } = await import(
          "../../utils/duplicateRadarDatabase"
        );
        const { countNeverChecked } = await import(
          "../../utils/dealDocComplianceSweep"
        );
        const {
          buildMonthlyMissingDocsEmail,
          monthlyMissingDocsRecipients,
          isMonthlyMissingDocsEnabled,
          periodLabel,
        } = await import("../../utils/missingDocsMonthlyReport");
        const rows = await getDealComplianceReportRows("all");
        const neverChecked = await countNeverChecked();
        // Preview the month that just ended, matching what the job would send.
        const nowKsa = new Date(Date.now() + 3 * 3600_000);
        const covered = new Date(
          Date.UTC(nowKsa.getUTCFullYear(), nowKsa.getUTCMonth() - 1, 1),
        );
        const mail = buildMonthlyMissingDocsEmail(rows, {
          periodLabel: periodLabel(covered),
          inScope: rows.length + neverChecked,
          dashboardUrl: process.env.MISSING_DOCS_REPORT_LINK,
        });
        return c.json({
          success: true,
          enabled: isMonthlyMissingDocsEnabled(),
          recipient_count: monthlyMissingDocsRecipients().length,
          period: periodLabel(covered),
          checked: rows.length,
          in_scope: rows.length + neverChecked,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
      } catch (e: any) {
        logger.error("missing-docs-report/preview failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },

  {
    // Document-compliance report for the Head of Sales: missing-document rate,
    // which owner it sits with, and one sheet per stage (Proposal / Agreement
    // Signed / Paid). Reads the STORED checks kept current by the background
    // sweep, so it makes no Zoho calls and is instant.
    // GET /api/duplicates/deal-compliance.xlsx?segment=
    path: "/api/duplicates/deal-compliance.xlsx",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const url = new URL(c.req.url);
        const segment = (url.searchParams.get("segment") || "all") as any;
        const { getDealComplianceReportRows } = await import(
          "../../utils/duplicateRadarDatabase"
        );
        // In-memory workbook, not the streaming path — see the note on
        // /api/duplicates/multi-active-deals.xlsx. Bounded output (hundreds of
        // rows), and staged exports take this deployment down.
        const { buildWorkbook } = await import("../../utils/excelExport");
        const { buildDealComplianceReportSheets, dealComplianceReportFilename } =
          await import("../../utils/dealComplianceReportExport");
        const { countNeverChecked } = await import(
          "../../utils/dealDocComplianceSweep"
        );
        const rows = await getDealComplianceReportRows(segment);
        const neverChecked = await countNeverChecked();
        const sheets = buildDealComplianceReportSheets(rows, {
          segment: String(segment),
          inScope: rows.length + neverChecked,
        });
        try {
          await createExportLog({
            export_type: "deal_doc_compliance" as any,
            filter_criteria: { segment },
            total_records_exported: rows.length,
            file_format: "xlsx",
            exported_by:
              (user as any).email ||
              (user as any).name ||
              `user:${(user as any).userId ?? "unknown"}`,
          });
        } catch (logErr) {
          logger.warn(
            "[DealCompliance] report export log write failed (non-blocking):",
            logErr,
          );
        }
        const buf = await buildWorkbook(
          sheets.map((s) => ({ ...s, rows: s.rows as Record<string, any>[] })),
          { title: `Deal document compliance — ${segment}` },
        );
        return new Response(new Uint8Array(buf), {
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${dealComplianceReportFilename(String(segment))}"`,
            "Content-Length": String(buf.length),
          },
        });
      } catch (e: any) {
        logger.error("deal-compliance.xlsx failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },

  {
    path: "/api/duplicates/deals/doc-compliance-batch",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const items = Array.isArray(body?.deals) ? body.deals : [];
          const deals = items
            .map((d: any) => ({
              id: String(d?.id || "").trim(),
              stage: String(d?.stage || ""),
            }))
            .filter((d: any) => d.id)
            .slice(0, 50); // hard cap per request
          if (!deals.length) return c.json({ success: true, results: [] });
          const checkedBy =
            user.email || user.userId ? String(user.email || user.userId) : null;
          const nowIso = new Date().toISOString();
          const results: any[] = new Array(deals.length);
          // Account ids for the batch, in ONE query — company documents (VAT,
          // CR, National Address) are checked against the Account, and this
          // path must agree with the background sweep on the same deal.
          const acctByDeal = new Map<string, string>();
          try {
            const { pool } = await import("../../utils/duplicateRadarDatabase");
            const q = await pool.query(
              `SELECT zoho_record_id AS id,
                      NULLIF(BTRIM(raw_data->'Account_Name'->>'id'), '') AS account_id
                 FROM duplicate_records
                WHERE record_type = 'deal' AND zoho_record_id = ANY($1::text[])`,
              [deals.map((d: any) => d.id)],
            );
            for (const row of q.rows as any[]) {
              if (row.account_id) acctByDeal.set(String(row.id), String(row.account_id));
            }
          } catch {
            /* deal documents are still checked without it */
          }
          // Cache the PROMISE: the workers below run concurrently and several
          // deals in a batch commonly share one Account.
          const acctCache = new Map<string, Promise<any[]>>();
          const acctAttsFor = (dealId: string): Promise<any[]> | undefined => {
            const accountId = acctByDeal.get(dealId);
            if (!accountId) return undefined;
            const hit = acctCache.get(accountId);
            if (hit) return hit;
            const p = fetchRecordAttachments("Accounts", accountId).catch(() => [] as any[]);
            acctCache.set(accountId, p);
            return p;
          };
          // Bounded concurrency keeps us under Zoho's attachment rate limit
          // while still finishing a batch in a few seconds.
          const CONC = 3;
          let cursor = 0;
          const worker = async () => {
            while (cursor < deals.length) {
              const my = cursor++;
              const d = deals[my];
              try {
                const atts = await fetchRecordAttachments("Deals", d.id);
                const r = evaluateDocCompliance(d.stage, atts, await acctAttsFor(d.id));
                try {
                  await upsertDealDocCompliance({
                    zohoDealId: d.id,
                    stage: d.stage,
                    compliant: !!r.compliant,
                    presentDocs: (r.presentDocs || []).map((p: any) => p.label),
                    missingDocs: (r.missingDocs || []).map((m: any) => m.label),
                    attachmentCount: r.attachmentCount || 0,
                    checkedBy,
                  });
                } catch {
                  /* persist is best-effort */
                }
                results[my] = {
                  id: d.id,
                  stage: d.stage,
                  compliant: !!r.compliant,
                  presentDocs: r.presentDocs || [],
                  missingDocs: r.missingDocs || [],
                  attachmentCount: r.attachmentCount || 0,
                  checkedBy,
                  checkedAt: nowIso,
                };
              } catch (e: any) {
                results[my] = {
                  id: d.id,
                  stage: d.stage,
                  error: e?.message || String(e),
                };
              }
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(CONC, deals.length) }, worker),
          );
          return c.json({ success: true, results });
        } catch (e: any) {
          logger.error("deals/doc-compliance-batch failed", e);
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Persisted doc-compliance results (latest scan per deal) — rehydrates the
    // Deal-Compliance tab on open so prior scans aren't lost. Optional ?ids=a,b
    // to fetch just the visible deals; otherwise returns the most recent 5000.
    path: "/api/duplicates/deal-compliance/results",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const idsParam = (c.req.query("ids") || "").trim();
          const ids = idsParam
            ? idsParam.split(",").map((s: string) => s.trim()).filter(Boolean)
            : undefined;
          const rows = await getDealDocCompliance(ids);
          const results: Record<string, any> = {};
          for (const r of rows) {
            results[r.zoho_deal_id] = {
              compliant: !!r.compliant,
              present: Array.isArray(r.present_docs) ? r.present_docs : [],
              missing: Array.isArray(r.missing_docs) ? r.missing_docs : [],
              attachmentCount: r.attachment_count || 0,
              stage: r.stage || "",
              checkedAt: r.checked_at,
              checkedBy: r.checked_by || null,
            };
          }
          return c.json({ results });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    path: "/duplicates",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "duplicates.html"),
            "/home/runner/workspace/dashboard/duplicates.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              return c.html(readFileSync(p, "utf-8"));
            }
          }
          return c.text("Duplicate Radar Dashboard not found", 404);
        } catch (error) {
          logger.error("Error serving Duplicate Radar dashboard:", error);
          return c.text("Error loading Duplicate Radar dashboard", 500);
        }
      };
    },
  },
  {
    // The in-platform Autonomous Resolution screen (status / grades / learning
    // curve / rules / run-now). Auth is enforced by its API calls.
    path: "/autonomous-resolution",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "autonomous-resolution.html"),
            "/home/runner/workspace/dashboard/autonomous-resolution.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              return c.html(readFileSync(p, "utf-8"));
            }
          }
          return c.text("Autonomous Resolution screen not found", 404);
        } catch (error) {
          logger.error("Error serving Autonomous Resolution screen:", error);
          return c.text("Error loading Autonomous Resolution screen", 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const summary = await getEnhancedSummary();
          const kpis = await getKPIMetrics();
          const lastScan = await getLastScanDate();
          // Total cleanup actions across ALL action tabs (not just merges) — so
          // the Executive Summary reflects everything the team has actioned.
          const { getCleanupActionsSummary } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const cleanupActions = await getCleanupActionsSummary().catch(() => null);
          return c.json({ ...summary, kpis, cleanupActions, lastScanDate: lastScan });
        } catch (error: any) {
          logger.error("Error fetching summary:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Per-tab snapshot — one headline + verdict per Duplicate Radar tab.
    // Fans out across all the tab scanners in parallel and returns ONLY
    // the summary metrics so the Executive Summary "at-a-glance"
    // scorecard loads fast. Each tab is wrapped — one slow / failing
    // dependency cannot brick the whole exec view.
    path: "/api/duplicates/overview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const { getDuplicateRadarOverview } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const overview = await getDuplicateRadarOverview();
          return c.json({ success: true, ...overview });
        } catch (error: any) {
          logger.error("Error fetching Duplicate Radar overview:", error);
          return c.json(
            { success: false, error: "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  // "View All" support for the executive-summary cards (Top Match Signal Sources
  // and Top Clusters by Pipeline Inflation). These endpoints return the full
  // ranked list, not just the top 5 rendered inline on the page.
  {
    path: "/api/duplicates/clusters-by-inflation",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "500");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const includeInactive =
            new URL(c.req.url).searchParams.get("include_inactive") === "true";
          const rows = await getAllClustersByInflation({
            limit,
            offset,
            includeInactive,
          });
          return c.json({ clusters: rows, total: rows.length, limit, offset });
        } catch (error: any) {
          logger.error("Error fetching clusters by inflation:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters-by-signal/:signal",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const signal = c.req.param("signal");
          if (!signal) return c.json({ error: "signal is required" }, 400);
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "500");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const includeInactive =
            url.searchParams.get("include_inactive") === "true";
          const rows = await getClustersBySignal(signal, {
            limit,
            offset,
            includeInactive,
          });
          return c.json({
            signal,
            clusters: rows,
            total: rows.length,
            limit,
            offset,
          });
        } catch (error: any) {
          logger.error("Error fetching clusters by signal:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // C4: Server-side pagination on clusters (30/page)
  {
    path: "/api/duplicates/clusters",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status");
          const confidence_level = url.searchParams.get("confidence_level");
          const limit = parseInt(url.searchParams.get("limit") || "30");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;
          // Hide legitimate parent-child hierarchies (e.g. 1 account + N contacts/deals)
          // by default. Pass ?include_hierarchies=true to see them.
          const include_hierarchies =
            url.searchParams.get("include_hierarchies") === "true";
          const layoutsParam = url.searchParams.get("layouts");
          const layouts = layoutsParam
            ? layoutsParam
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;

          // owner_email filter: powers the per-owner drill modal on
          // the Owners tab. Click an owner row → modal opens →
          // fetches /api/duplicates/clusters?owner_email=<email> →
          // server returns only clusters where at least one record
          // is owned by that email (case-insensitive match).
          const owner_email = url.searchParams.get("owner_email") || undefined;

          const sort = url.searchParams.get("sort") || undefined;
          const dir = url.searchParams.get("dir") || undefined;

          // Segment chip (Marketplace / ExampleOrg / WalaOne) — Sample User 2026-07-13.
          const rawSegment = (url.searchParams.get("segment") || "").trim();
          const segment: DuplicateFilters["segment"] =
            ["marketplace", "corporate", "ExampleOrg", "walaone"].includes(
              rawSegment,
            )
              ? (rawSegment as DuplicateFilters["segment"])
              : undefined;

          const filters = {
            status: status || undefined,
            confidence_level: confidence_level || undefined,
            start_date,
            end_date,
            hide_hierarchies: !include_hierarchies,
            layouts,
            owner_email,
            segment,
          };

          const [clusters, total] = await Promise.all([
            getAllClusters({ ...filters, limit, offset, sort, dir }),
            getClusterCount(filters),
          ]);

          return c.json({
            clusters,
            total,
            limit,
            offset,
            pages: Math.ceil(total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching clusters:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          let cluster = await getClusterById(id);
          if (!cluster) {
            return c.json({ error: "Cluster not found" }, 404);
          }
          // Live-verify on OPEN (Sample User 2026-07-15): the preview was showing
          // records already DELETED in Zoho (e.g. ARGAS) because they sit in the
          // mirror until a sweep reaches them. When the modal passes ?verify=1 we
          // live-check THIS cluster's records against Zoho, prune the ghosts +
          // mark converted leads, recompute the cluster's stats, and re-read — so
          // the preview only ever shows records that still exist in the CRM.
          const doVerify = new URL(c.req.url).searchParams.get("verify") === "1";
          let records = await getRecordsByClusterId(id);
          if (doVerify && records.length > 0) {
            try {
              const { reconcileDeletedRecords } = await import(
                "../../utils/emptyRecordsDatabase"
              );
              const rc = await reconcileDeletedRecords({
                clusterIds: [id],
                limit: 100,
              });
              if (rc.pruned > 0 || rc.converted > 0) {
                try {
                  const { updateClusterStats } = await import(
                    "../../utils/duplicateRadarDatabase"
                  );
                  await updateClusterStats(id);
                } catch {
                  /* best-effort */
                }
                const fresh = await getClusterById(id);
                if (fresh) cluster = fresh; // may be null if pruned to a singleton
                records = await getRecordsByClusterId(id);
              }
            } catch (e: any) {
              logger.warn(
                `[cluster-detail] on-open verify failed (non-fatal): ${e?.message || e}`,
              );
            }
          }
          // Segment scoping of the PREVIEW (Sample User 2026-07-15): when the operator
          // is working a specific segment (ExampleOrg / Marketplace / WalaOne) and
          // opens a cluster, the preview must show ONLY that segment's records —
          // "when I check the segment I separate the data I need to check". `all`
          // shows everything. Same layout semantics as buildSegmentPredicate.
          const rawSeg = (new URL(c.req.url).searchParams.get("segment") || "").trim();
          if (rawSeg && rawSeg !== "all") {
            const { recordMatchesSegment } = await import(
              "../../utils/duplicateRadarDatabase"
            );
            const filtered = records.filter((r: any) =>
              recordMatchesSegment(r, rawSeg),
            );
            // Only apply if it leaves something — a cluster opened from a
            // segment-filtered tab always has ≥1 record in that segment, but
            // guard against an empty preview if the layout data is sparse.
            if (filtered.length > 0) records = filtered;
          }
          const recommendations = generateSmartRecommendations(records);
          const meta = getClusterRecordTypeMeta(records);
          // Surface "mixed signal" — a cluster containing 2+ distinct
          // corporate domains (or distinct phones) is almost always two
          // unrelated companies that happened to share a name fragment.
          // The frontend uses this to render a red banner and a
          // "Split by domain" button.
          const mixed = await getClusterMixedSignal(id);
          return c.json({
            cluster,
            records,
            recommendations,
            primary_type: meta.primary_type,
            is_cross_module: meta.is_cross_module,
            record_types: meta.record_types,
            mixed_signal: mixed,
            segment_applied: rawSeg && rawSeg !== "all" ? rawSeg : null,
          });
        } catch (error: any) {
          logger.error("Error fetching cluster:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Phase 1 — Agentic Duplicate Resolution: PROPOSE a non-destructive merge
    // plan for an Accounts cluster. READ-ONLY: builds the plan in memory and
    // returns it; performs NO writes to Zoho or the radar DB. Gated on the
    // read-level duplicate-radar role (same as the cluster detail view) — the
    // destructive /execute path (separate, admin-gated) will consume the plan.
    // Response: { success, plan } — see MergePlan in duplicateMergePlanner.ts.
    path: "/api/duplicates/clusters/:id/plan",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const cluster = await getClusterById(id);
          if (!cluster) return c.json({ error: "Cluster not found" }, 404);

          const records = await getRecordsByClusterId(id);
          const body = await c.req.json().catch(() => ({}));
          const module = parseAgenticModule(body);
          const recordType = MODULE_RECORD_TYPE[module];
          const moduleCount = records.filter(
            (r) => r.record_type === recordType,
          ).length;
          if (moduleCount < 2) {
            return c.json(
              {
                error: `This cluster has fewer than 2 ${module} records to plan a merge.`,
                module,
                module_record_count: moduleCount,
              },
              400,
            );
          }

          const includeZohoIds = Array.isArray(body?.record_zoho_ids)
            ? body.record_zoho_ids.filter((x: any) => typeof x === "string")
            : null;
          const masterZohoId =
            typeof body?.master_zoho_id === "string"
              ? body.master_zoho_id
              : null;
          const linkAccountZohoId =
            body && "link_account_zoho_id" in body
              ? typeof body.link_account_zoho_id === "string"
                ? body.link_account_zoho_id
                : ""
              : undefined;
          const forceMergeContacts = body?.force_merge === true;

          const generatedBy =
            (user as any)?.email || (user as any)?.role || "duplicate-radar";
          // Records already tagged Duplicate-Delete by a prior Apply on this
          // same cluster — the planner uses these to drop zombie Accounts
          // from LINK SURVIVOR TO ACCOUNT. Best-effort: if the read fails,
          // we just show the full list (no worse than before this feature).
          let taggedAccountDbIds: number[] = [];
          try {
            taggedAccountDbIds = await getTaggedRecordDbIdsByCluster(id);
          } catch (_) {
            /* non-fatal — fall back to unfiltered candidates */
          }
          let plan;
          try {
            plan = buildMergePlan(module, id, records, {
              tagName: "Duplicate-Delete",
              generatedBy,
              generatedAt: new Date().toISOString(),
              includeZohoIds,
              masterZohoId,
              linkAccountZohoId,
              taggedAccountDbIds,
              forceMergeContacts,
            });
          } catch (e: any) {
            return c.json({ error: e?.message || "Could not build plan" }, 400);
          }

          return c.json({ success: true, plan });
        } catch (error: any) {
          logger.error("Error building merge plan:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Phase 1 — Agentic Duplicate Resolution: EXECUTE a merge plan.
    // Migrates winning fields onto the survivor, reparents Deals/Contacts/Notes,
    // tags duplicates `Duplicate-Delete`, stamps audit notes, and resolves the
    // cluster. The platform NEVER deletes. DESTRUCTIVE → requireAdminOrKey.
    //
    // Body: { confirm?: boolean, dry_run?: boolean, master_zoho_id?: string }
    //   - dry-run is the default; a real write requires confirm === true.
    //   - master_zoho_id lets the operator override the survivor.
    // The plan is rebuilt server-side from live records (the client plan is
    // never trusted) and re-validated before execution.
    path: "/api/duplicates/clusters/:id/execute",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const body = await c.req.json().catch(() => ({}));
          const dryRun = body?.confirm !== true || body?.dry_run === true;
          const masterZohoId =
            typeof body?.master_zoho_id === "string"
              ? body.master_zoho_id
              : null;
          const includeZohoIds = Array.isArray(body?.record_zoho_ids)
            ? body.record_zoho_ids.filter((x: any) => typeof x === "string")
            : null;
          const linkAccountZohoId =
            body && "link_account_zoho_id" in body
              ? typeof body.link_account_zoho_id === "string"
                ? body.link_account_zoho_id
                : ""
              : undefined;
          const forceMergeContacts = body?.force_merge === true;

          const cluster = await getClusterById(id);
          if (!cluster) return c.json({ error: "Cluster not found" }, 404);
          if (cluster.status !== "active") {
            return c.json(
              {
                error: `Cluster is already '${cluster.status}'. Only active clusters can be resolved.`,
              },
              409,
            );
          }

          const records = await getRecordsByClusterId(id);
          const module = parseAgenticModule(body);
          const recordType = MODULE_RECORD_TYPE[module];
          const moduleCount = records.filter(
            (r) => r.record_type === recordType,
          ).length;
          if (moduleCount < 2) {
            return c.json(
              {
                error: `This cluster has fewer than 2 ${module} records to resolve.`,
                module,
                module_record_count: moduleCount,
              },
              400,
            );
          }

          let taggedAccountDbIdsExec: number[] = [];
          try {
            taggedAccountDbIdsExec = await getTaggedRecordDbIdsByCluster(id);
          } catch (_) {
            /* non-fatal */
          }
          let plan;
          try {
            plan = buildMergePlan(module, id, records, {
              tagName: "Duplicate-Delete",
              generatedBy:
                (sessionUser as any)?.email ||
                (sessionUser as any)?.role ||
                "duplicate-radar",
              generatedAt: new Date().toISOString(),
              masterZohoId,
              includeZohoIds,
              linkAccountZohoId,
              taggedAccountDbIds: taggedAccountDbIdsExec,
              forceMergeContacts,
            });
          } catch (e: any) {
            return c.json({ error: e?.message || "Could not build plan" }, 400);
          }

          // Multi-module clusters: Agentic resolves ONE module, so it must NOT
          // close the whole cluster — other modules' records still need their
          // own resolution (manual Mark-Resolved or a separate Agentic run).
          // Only a single-module cluster is fully resolved by one Apply.
          const isCrossModule = records.some(
            (r) => r.record_type && r.record_type !== recordType,
          );

          if (dryRun) {
            // Dry-run stays fully synchronous — no writes, no job row, just
            // the preview report (unchanged behavior).
            const report = await executeMergePlan(plan, {
              performedBy:
                (sessionUser as any)?.email ||
                (sessionUser as any)?.role ||
                "admin",
              dryRun: true,
              closeCluster: !isCrossModule,
            });

            // Learning loop — record what the agent proposed vs. what the
            // operator chose + the outcome, so the agent learns the org's
            // real preferences over time. Best-effort, never blocks.
            try {
              const proposedMasterZohoId = masterZohoId
                ? buildMergePlan(module, id, records, {
                    tagName: "Duplicate-Delete",
                    includeZohoIds,
                  }).masterZohoId
                : plan.masterZohoId;
              await recordResolutionEvent({
                clusterId: id,
                eventType: "dry_run",
                proposedMasterZohoId,
                chosenMasterZohoId: plan.masterZohoId,
                fieldsMigrated: report.fieldsMigrated.length,
                duplicatesTagged: report.taggedRecordIds.length,
                reparented:
                  report.reparented.deals +
                  report.reparented.contacts +
                  report.reparented.notes,
                errors: report.errors.length,
                plan,
                report,
                performedBy: (sessionUser as any)?.email || "admin",
              });
            } catch {
              /* learning capture is non-fatal */
            }

            return c.json({ success: true, dryRun, plan, report });
          }

          // Real run (confirm === true) — move execution off the request
          // path: a 200+-record merge used to 504 here. Single-flight via
          // the merge_jobs row (queued/running for this cluster+module wins),
          // launch the in-process worker WITHOUT awaiting, and return the
          // job id immediately. The worker rebuilds the plan from live
          // records, runs executeMergePlan + learning capture, and pings
          // Slack on completion — see src/utils/mergeJobRunner.ts.
          const {
            getActiveOrLatestMergeJob,
            createMergeJob,
            isMergeJobStale,
            finishMergeJob,
          } = await import("../../utils/mergeJobsDatabase");
          const existingJob = await getActiveOrLatestMergeJob(id, module);
          const existingInFlight =
            existingJob &&
            (existingJob.status === "queued" || existingJob.status === "running");
          // A genuinely-running job → single-flight: hand the operator back the
          // same job to keep polling. But a STALE running job (worker died on a
          // restart) must NOT block — supersede it so "re-apply to continue"
          // starts a fresh worker instead of returning a dead job forever.
          if (existingInFlight && !isMergeJobStale(existingJob!, Date.now())) {
            return c.json(
              {
                job_id: existingJob!.id,
                status: existingJob!.status,
                total: existingJob!.total,
                resumed: true,
              },
              202,
            );
          }
          if (existingInFlight) {
            try {
              await finishMergeJob(existingJob!.id, {
                status: "failed",
                errorMessage:
                  "Superseded — previous job stalled (worker restart).",
              });
            } catch {
              /* non-fatal */
            }
          }

          const total = plan.duplicateZohoIds?.length ?? moduleCount - 1;
          const job = await createMergeJob({
            clusterId: id,
            module,
            total,
            masterZohoId: plan.masterZohoId,
            createdBy:
              (sessionUser as any)?.email || (sessionUser as any)?.role || "admin",
            includeZohoIds,
            linkAccountZohoId,
            forceMergeContacts,
          });

          void import("../../utils/mergeJobRunner")
            .then((m) => m.runMergeJob(job.id))
            .catch(() => {});

          return c.json({ job_id: job.id, status: "running", total }, 202);
        } catch (error: any) {
          logger.error("Error executing merge plan:", error);
          return c.json(
            { success: false, error: error?.message || "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    // Agentic Resolution — poll the background merge job started by the real
    // (non-dry-run) `/execute` above. Returns the latest job for this
    // cluster+module (queued/running takes priority over a finished one so a
    // resumed poll always sees in-flight work first), plus a `stale` flag if
    // a "running" job's heartbeat has gone cold (worker crashed mid-merge).
    path: "/api/duplicates/clusters/:id/merge-job",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const module = parseAgenticModule({ module: c.req.query("module") });
          const { getActiveOrLatestMergeJob, isMergeJobStale } = await import(
            "../../utils/mergeJobsDatabase"
          );
          const job = await getActiveOrLatestMergeJob(id, module);
          if (!job) return c.json({ job: null });
          const stale = isMergeJobStale(job, Date.now());
          return c.json({ job: { ...job, stale } });
        } catch (error: any) {
          logger.error("Error fetching merge job status:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Agentic Resolution — learned signals (read-only). Surfaces what the
    // agent has learned from platform data + operator actions: override rate,
    // apply/dry-run volume, recent corrections, plain-English guidance.
    path: "/api/duplicates/resolution-learnings",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const learnings = await getResolutionLearnings();
          return c.json({ success: true, learnings });
        } catch (error: any) {
          logger.error("Error fetching resolution learnings:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Agentic Resolution — chronological activity log (read-only). Powers the
    // "Agent Activity" section in the Logs tab: every preview/dry-run/apply the
    // agent performed, who ran it, what changed, and any errors.
    path: "/api/duplicates/resolution-activity",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "100");
          const activity = await getResolutionActivity(
            Number.isFinite(limit) ? limit : 100,
          );
          return c.json({ success: true, activity });
        } catch (error: any) {
          logger.error("Error fetching resolution activity:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // "Manual Actions" section in the Logs tab: every Mark Resolved / Mark
    // Dismissed / Bulk-split / partial-apply (module_resolved) operators
    // perform. Reads duplicate_merge_actions, joined with the cluster row
    // for display. Filters: ?action_type=resolve,ignore,split,module_resolved
    // and ?performed_by_like=<substring> and ?cluster_id=N.
    path: "/api/duplicates/merge-actions",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "100");
          const clusterIdRaw = url.searchParams.get("cluster_id");
          const clusterId =
            clusterIdRaw && !isNaN(Number(clusterIdRaw))
              ? Number(clusterIdRaw)
              : undefined;
          const actionTypeRaw = url.searchParams.get("action_type");
          const VALID_TYPES = [
            "resolve",
            "ignore",
            "module_resolved",
            "split",
            "merge",
          ] as const;
          const actionTypes = actionTypeRaw
            ? actionTypeRaw
                .split(",")
                .map((s) => s.trim())
                .filter((s): s is (typeof VALID_TYPES)[number] =>
                  VALID_TYPES.includes(s as any),
                )
            : undefined;
          const performedByLike =
            url.searchParams.get("performed_by_like") || undefined;
          const { getMergeHistoryEnriched } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const actions = await getMergeHistoryEnriched({
            clusterId,
            actionTypes,
            performedByLike,
            limit: Number.isFinite(limit) ? limit : 100,
          });
          return c.json({ success: true, actions });
        } catch (error: any) {
          logger.error("Error fetching merge actions:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Agentic Resolution — LLM reviewer. READ-ONLY: builds the deterministic
    // plan + learnings briefing server-side and asks the duplicateResolution
    // Agent for a concise verdict/confidence/risks narrative. No writes; the
    // LLM only reasons over the briefing (it never authors data decisions).
    path: "/api/duplicates/clusters/:id/agent-review",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const cluster = await getClusterById(id);
          if (!cluster) return c.json({ error: "Cluster not found" }, 404);

          const records = await getRecordsByClusterId(id);
          const body = await c.req.json().catch(() => ({}));
          const module = parseAgenticModule(body);
          const recordType = MODULE_RECORD_TYPE[module];
          const moduleCount = records.filter(
            (r) => r.record_type === recordType,
          ).length;
          if (moduleCount < 2) {
            return c.json(
              {
                error: `This cluster has fewer than 2 ${module} records to review.`,
                module,
                module_record_count: moduleCount,
              },
              400,
            );
          }

          const plan = buildMergePlan(module, id, records, {
            tagName: "Duplicate-Delete",
            generatedBy: (user as any)?.email || "duplicate-radar",
            generatedAt: new Date().toISOString(),
          });
          const learnings = await getResolutionLearnings();

          // Deterministic briefing — the LLM narrates over this, never edits it.
          const fieldLines = plan.fieldDecisions
            .map(
              (d) =>
                `- ${d.label}: ${d.action.toUpperCase()} → "${d.chosenValue ?? "—"}" (${d.reason})`,
            )
            .join("\n");
          const briefing =
            `MERGE BRIEFING — cluster ${id}\n` +
            `Survivor: ${plan.masterName} (${plan.masterZohoId ?? "no-zoho-id"}) — ${plan.masterReason}\n` +
            `Duplicates to tag "${plan.tagName}": ${plan.duplicateZohoIds.length} (${plan.duplicateZohoIds.join(", ") || "none"})\n` +
            `Field decisions (${plan.fieldDecisions.length}):\n${fieldLines || "- none"}\n` +
            `Warnings:\n${(plan.warnings.map((w) => "- " + w).join("\n")) || "- none"}\n\n` +
            `ORG LEARNINGS\n` +
            `- Resolutions so far: ${learnings.totalEvents} (applied ${learnings.applied}, dry-run ${learnings.dryRuns})\n` +
            `- Master override rate: ${Math.round(learnings.masterOverrideRate * 100)}%\n` +
            `- Guidance: ${learnings.guidance.join(" ")}\n\n` +
            `Produce your reviewer recommendation now.`;

          let recommendation = "";
          try {
            const { mastra } = await import("../index");
            const agent = (mastra as any)?.getAgent?.(
              "duplicateResolutionAgent",
            );
            if (agent) {
              const out = await agent.generate(briefing, { maxSteps: 1 });
              recommendation =
                (out && (out.text || out.content)) ||
                (typeof out === "string" ? out : "");
            }
          } catch (agentErr: any) {
            logger.warn("agent-review generate failed; returning plan only", {
              error: agentErr?.message || String(agentErr),
            });
          }

          // Capture the review as a 'preview' learning signal (best-effort).
          try {
            await recordResolutionEvent({
              clusterId: id,
              eventType: "preview",
              proposedMasterZohoId: plan.masterZohoId,
              chosenMasterZohoId: plan.masterZohoId,
              plan,
              performedBy: (user as any)?.email || "reviewer",
            });
          } catch {
            /* non-fatal */
          }

          return c.json({
            success: true,
            recommendation:
              recommendation ||
              "AI reviewer unavailable — see the deterministic plan and warnings.",
            plan,
            learnings,
          });
        } catch (error: any) {
          logger.error("Error in agent-review:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/split",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          // Splitting a cluster is a state-mutating, hard-to-undo write.
          // Gate it on the same write-level role used by /resolve, /primary
          // and /bulk-resolve — NOT the read-only duplicate-radar viewer
          // role, which would otherwise let analysts mutate cluster shape.
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const body = await c.req.json().catch(() => ({}));
          const mode: string = body.mode || "manual";

          // Confirm the source cluster exists before doing anything.
          const source = await getClusterById(id);
          if (!source) return c.json({ error: "Cluster not found" }, 404);

          // Build one-or-more split plans.
          // Each plan = { recordIds, seed: { company_name, domain } }.
          const plans: Array<{
            recordIds: number[];
            seed: { company_name: string; domain?: string | null };
          }> = [];

          if (mode === "by_domain") {
            const mixed = await getClusterMixedSignal(id);
            if (mixed.domains.length < 2) {
              return c.json(
                { error: "Cluster does not have multiple domains to split" },
                400,
              );
            }
            // Keep the largest group on the source cluster (matches the
            // user's mental model: "the original cluster shrinks, the
            // outlier becomes its own"). Split every other domain off.
            // The scan-time conflict guard prevents re-merging on the
            // next scan because incoming records carry their own domain.
            const allRecords = await getRecordsByClusterId(id);
            const sortedDomains = [...mixed.domains].sort((a, b) => {
              const la = (mixed.domain_groups[a] || []).length;
              const lb = (mixed.domain_groups[b] || []).length;
              return lb - la;
            });
            for (const dom of sortedDomains.slice(1)) {
              const ids = mixed.domain_groups[dom] || [];
              if (ids.length === 0) continue;
              // Pick the first record's company_name as the seed for the
              // new cluster — the operator can rename later via Zoho.
              const seedRec = allRecords.find(
                (r) => (r.id as number | undefined) === ids[0],
              );
              plans.push({
                recordIds: ids,
                seed: {
                  company_name: seedRec?.company_name || dom,
                  domain: dom,
                },
              });
            }
          } else if (mode === "by_name") {
            // Auto-split by distinct COMPANY NAME — for name-collision clusters
            // (two real companies sharing a word, e.g. "Andalusia Group" vs
            // "Andalusia Hospital"). Group records by normalized company name,
            // keep the largest group on the source cluster, split each other
            // name-group into its own cluster. NOTE: an EN and AR spelling of
            // the SAME company normalize differently, so they may land in
            // separate groups — use the manual tick-split for those.
            const allRecords = await getRecordsByClusterId(id);
            const byName = new Map<string, { ids: number[]; label: string }>();
            for (const r of allRecords) {
              const raw = (r.company_name || r.record_name || "").trim();
              const key = normalizeCompanyName(raw) || `__${r.id}`;
              if (!byName.has(key)) byName.set(key, { ids: [], label: raw || key });
              if (typeof r.id === "number") byName.get(key)!.ids.push(r.id);
            }
            const groups = Array.from(byName.values()).filter((g) => g.ids.length > 0);
            if (groups.length < 2) {
              return c.json(
                { error: "All records share the same company name — nothing to split by name." },
                400,
              );
            }
            // Keep the largest group on the source; split the rest off.
            groups.sort((a, b) => b.ids.length - a.ids.length);
            for (const g of groups.slice(1)) {
              plans.push({
                recordIds: g.ids,
                seed: { company_name: g.label, domain: null },
              });
            }
          } else {
            // Manual mode: caller supplies the record IDs to move out.
            const recordIds: number[] = Array.isArray(body.record_ids)
              ? body.record_ids
                  .map((n: unknown) => Number(n))
                  .filter((n: number) => Number.isFinite(n))
              : [];
            if (recordIds.length === 0) {
              return c.json(
                { error: "record_ids must be a non-empty array" },
                400,
              );
            }
            plans.push({
              recordIds,
              seed: {
                company_name:
                  typeof body.new_company_name === "string" &&
                  body.new_company_name.trim()
                    ? body.new_company_name.trim()
                    : `${source.company_name || "Cluster"} (split)`,
                domain:
                  typeof body.new_domain === "string" && body.new_domain.trim()
                    ? body.new_domain.trim().toLowerCase()
                    : null,
              },
            });
          }

          if (plans.length === 0) {
            return c.json({ error: "Nothing to split" }, 400);
          }

          // Wrap ALL plans in a single DB transaction so a failure on plan
          // N rolls back plans 0..N-1 — operators never see a half-applied
          // split. Stats refresh runs AFTER commit (idempotent, best-effort).
          const { pool: duplicateRadarPool } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const client = await (duplicateRadarPool as any).connect();
          const newClusterIds: number[] = [];
          try {
            await client.query("BEGIN");
            for (const plan of plans) {
              const result = await splitRecordsIntoNewClusterInTx(
                client,
                id,
                plan.recordIds,
                plan.seed,
              );
              newClusterIds.push(result.new_cluster_id);
            }
            await client.query("COMMIT");
          } catch (txErr) {
            try {
              await client.query("ROLLBACK");
            } catch {
              /* ignore rollback failure */
            }
            throw txErr;
          } finally {
            client.release();
          }

          // Post-commit stats refresh (idempotent). A failure here doesn't
          // invalidate the split — the next scan or manual refresh will
          // re-derive the same numbers.
          try {
            await updateClusterStats(id);
            for (const ncid of newClusterIds) {
              await updateClusterStats(ncid);
            }
          } catch (statsErr) {
            logger.warn(
              "Post-split stats refresh failed (non-fatal)",
              statsErr as any,
            );
          }

          // Durable separation (Sample User 2026-06-20): record that the records left
          // on the source cluster and the records in each split-off cluster are
          // NOT duplicates of each other, so the next sync can't re-fuse them by
          // a shared name / phone / domain and silently undo this split.
          try {
            const { pool: dpool, recordSeparations } = await import(
              "../../utils/duplicateRadarDatabase"
            );
            const groups: string[][] = [];
            for (const cid of [id, ...newClusterIds]) {
              const rr = await dpool.query(
                `SELECT zoho_record_id FROM duplicate_records
                  WHERE cluster_id = $1 AND zoho_record_id IS NOT NULL`,
                [cid],
              );
              groups.push(rr.rows.map((r: any) => r.zoho_record_id as string));
            }
            const n = await recordSeparations(
              groups,
              "split",
              (sessionUser as any)?.email || "operator",
            );
            logger.info(
              `[DuplicateRadar] Split cluster ${id}: recorded ${n} separation pair(s) so it won't re-cluster`,
            );
          } catch (sepErr) {
            logger.warn(
              "Post-split separation-ledger write failed (non-fatal)",
              sepErr as any,
            );
          }

          return c.json({
            success: true,
            source_cluster_id: id,
            new_cluster_ids: newClusterIds,
            split_count: newClusterIds.length,
          });
        } catch (error: any) {
          logger.error("Error splitting cluster:", error);
          return c.json(
            { error: error?.message || "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/status",
    method: "PATCH" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const { status } = await c.req.json();

          if (!["active", "resolved", "ignored"].includes(status)) {
            return c.json({ error: "Invalid status" }, 400);
          }

          const cluster = await updateClusterStatus(id, status);
          if (!cluster) {
            return c.json({ error: "Cluster not found" }, 404);
          }

          return c.json({ success: true, cluster });
        } catch (error: any) {
          logger.error("Error updating cluster status:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/by-owner",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const data = await getDuplicatesByOwner();
          return c.json({ owners: data });
        } catch (error: any) {
          logger.error("Error fetching by owner:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/by-source",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const data = await getDuplicatesBySource();
          return c.json({ sources: data });
        } catch (error: any) {
          logger.error("Error fetching by source:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R6 — Cross-module overlaps. Returns the active clusters that
    // span 2+ record types (Lead+Contact, Lead+Account, etc.), each
    // classified by pairing type so the dashboard can KPI / filter
    // them. Default limit 200 (most tenants run well under that for
    // open cross-module clusters); use ?limit=N to override.
    //
    // Query params:
    //   limit=N        cap result list, default 200, clamped [1, 1000]
    //   pairing=key    filter to one pairing
    //                  (lead_contact / lead_account / lead_deal / mixed)
    //                  NOTE: contact_account / contact_deal / deal_account
    //                  moved to the Record Hint tab (2026-07) — clusters
    //                  classified as exactly one of those no longer appear
    //                  in this endpoint's results, so they're no longer
    //                  accepted as a filter value either.
    path: "/api/duplicates/cross-module-overlaps",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limitRaw = url.searchParams.get("limit");
          // Default to "all" (100k ceiling in getCrossModuleOverlaps) — the old
          // 200 default silently hid real cross-module overlaps.
          const limit = limitRaw ? parseInt(limitRaw, 10) : 100000;
          const pairingRaw = url.searchParams.get("pairing");
          // contact_account / contact_deal / deal_account removed from the
          // whitelist — those linking pairings now live on the Record Hint
          // tab, and getCrossModuleOverlaps no longer returns clusters
          // classified as exactly one of them. An unknown/removed value
          // falls through to `null` (no filter), same as any other
          // unrecognized pairing string.
          const allowedPairings = new Set([
            "lead_contact",
            "lead_account",
            "lead_deal",
            "mixed",
          ]);
          const pairing =
            pairingRaw && allowedPairings.has(pairingRaw)
              ? (pairingRaw as
                  | "lead_contact"
                  | "lead_account"
                  | "lead_deal"
                  | "mixed")
              : null;

          const statusRaw = (url.searchParams.get("status") || "active").toLowerCase();
          const status = (["active", "resolved", "ignored", "handled", "all"].includes(statusRaw)
            ? statusRaw
            : "active") as "active" | "resolved" | "ignored" | "handled" | "all";

          // Segment chip (Marketplace / ExampleOrg / WalaOne) — Sample User 2026-07-13.
          const rawSegment = (url.searchParams.get("segment") || "").trim();
          const segment: DuplicateFilters["segment"] =
            ["marketplace", "corporate", "ExampleOrg", "walaone"].includes(
              rawSegment,
            )
              ? (rawSegment as DuplicateFilters["segment"])
              : undefined;

          const { getCrossModuleOverlaps } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await getCrossModuleOverlaps({
            limit: Number.isFinite(limit) ? limit : 200,
            pairing,
            status,
            segment,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error fetching cross-module overlaps:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Follow-up 3 — Bulk-close lead records in selected cross-module
    // clusters. For each cluster_id, the helper PUTs Lead_Status='Lost Lead'
    // on every Lead record's Zoho id, then marks the cluster resolved if
    // every Zoho write succeeded. Body:
    //   { cluster_ids: number[], dry_run?: boolean, max_clusters?: number }
    //
    // Auth: requireAdminOrKey — this is a destructive write to Zoho.
    //
    // Response: per-cluster summary so the operator can see exactly what
    // closed, what was skipped (already-Lost), what failed and why.
    path: "/api/duplicates/cross-module-overlaps/bulk-close-leads",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          let body: any = {};
          try {
            body = (await c.req.json()) ?? {};
          } catch {
            return c.json(
              {
                success: false,
                error:
                  "Body must be JSON: { cluster_ids: number[], dry_run?, max_clusters? }",
              },
              400,
            );
          }

          if (!Array.isArray(body.cluster_ids) || body.cluster_ids.length === 0) {
            return c.json(
              {
                success: false,
                error: "cluster_ids must be a non-empty array of cluster IDs",
              },
              400,
            );
          }

          const ids: number[] = body.cluster_ids
            .map((x: any) => Number(x))
            .filter((n: number) => Number.isFinite(n) && n > 0);
          if (ids.length === 0) {
            return c.json(
              {
                success: false,
                error: "cluster_ids contained no valid positive integers",
              },
              400,
            );
          }

          const { bulkCloseLeadsInClusters } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await bulkCloseLeadsInClusters({
            clusterIds: ids,
            performedBy: sessionUser.email || "admin",
            dryRun: !!body.dry_run,
            maxClusters:
              typeof body.max_clusters === "number"
                ? body.max_clusters
                : undefined,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error in bulk-close-leads:", error);
          return c.json(
            { success: false, error: error?.message || "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/kpis",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const kpis = await getKPIMetrics();
          return c.json(kpis);
        } catch (error: any) {
          logger.error("Error fetching KPIs:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R4 — Creation-rate trend. Returns weekly (or daily) buckets of
    // new duplicate records vs new total records, plus the percentage
    // duplicate-rate per bucket. Stakeholders use the slope as the
    // leading indicator of whether prevention work is paying off.
    // Query params:
    //   weeks=N        window size, default 12, clamped 1-52
    //   granularity=week|day  default 'week'
    path: "/api/duplicates/creation-trend",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const weeksRaw = url.searchParams.get("weeks");
          const granRaw = url.searchParams.get("granularity");
          const weeks = weeksRaw ? parseInt(weeksRaw, 10) : 12;
          const granularity: "week" | "day" =
            granRaw === "day" ? "day" : "week";

          const { getDuplicateCreationTrend } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const trend = await getDuplicateCreationTrend({
            weeks: Number.isFinite(weeks) ? weeks : 12,
            granularity,
          });
          return c.json({ success: true, ...trend });
        } catch (error: any) {
          logger.error("Error fetching creation trend:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // DUPLICATE SPIKE ROOT-CAUSE (Sample User 2026-07-23) — the trend shows WHEN
    // duplicates rise; this shows WHY. New duplicate records in the recent
    // window vs the prior equal window, broken down by source / owner / module,
    // sorted by biggest increase. Read-only.
    //   GET /api/duplicates/spike-breakdown?weeks=3&segment=
    path: "/api/duplicates/spike-breakdown",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const weeksRaw = url.searchParams.get("weeks");
          const weeks = weeksRaw ? parseInt(weeksRaw, 10) : 3;
          const segment = url.searchParams.get("segment") || undefined;
          const { getDuplicateSpikeBreakdown } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await getDuplicateSpikeBreakdown({
            weeks: Number.isFinite(weeks) ? weeks : 3,
            segment: segment as any,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error fetching spike breakdown:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Amount at risk split by OPEN vs CLOSED deal stage (Sample User 2026-07-29).
    //   GET /api/duplicates/inflation-breakdown?segment=
    path: "/api/duplicates/inflation-breakdown",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const segment = c.req.query("segment") || undefined;
          const { getInflationOpenClosedBreakdown } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await getInflationOpenClosedBreakdown(segment as any);
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error fetching inflation breakdown:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // CLIENTHUB ↔ ZOHO reconcile by CRM ID (Sample User 2026-08-03). Upload a
    // ClientHub export (.xlsx with a "CRM ID" column) OR POST JSON
    // { crmIds: [] }; classifies each id against the Zoho mirror so a
    // count gap can be attributed exactly. Read-only.
    path: "/api/duplicates/cs-lifecycle/reconcile-ids",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const contentType = c.req.header("content-type") || "";
          let crmIds: string[] = [];
          const clientHubPhaseById: Record<string, string> = {};
          if (contentType.startsWith("multipart/form-data")) {
            const form = await c.req.parseBody();
            const file = (form as any).file;
            if (!file || typeof file === "string") {
              return c.json({ error: "Send the workbook as a multipart 'file' field." }, 400);
            }
            const buffer = Buffer.from(await (file as any).arrayBuffer());
            if (buffer.length > 10 * 1024 * 1024) {
              return c.json({ error: "Workbook too large — 10 MB cap." }, 413);
            }
            const ExcelJSMod: any = await import("exceljs");
            const ExcelJS = ExcelJSMod.default ?? ExcelJSMod;
            const wb = new ExcelJS.Workbook();
            try {
              await wb.xlsx.load(buffer);
            } catch (pe: any) {
              return c.json({ error: "Could not parse as .xlsx.", detail: pe?.message || String(pe) }, 400);
            }
            const ws = wb.worksheets[0];
            if (!ws) return c.json({ error: "No worksheet." }, 400);
            const headerRow = ws.getRow(1);
            const norm = (s: any) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
            let crmCol = -1;
            let phaseCol = -1;
            (headerRow.values as any[]).forEach((h, idx) => {
              const n = norm(h);
              if (crmCol < 0 && (n === "crmid" || n === "crmrecordid" || n === "zohoid" || n === "recordid")) crmCol = idx;
              // The ClientHub export tags each row with its phase in a Stage /
              // Phase column — use it to reconcile ALL phases, not just Termination.
              if (phaseCol < 0 && (n === "stage" || n === "phase" || n === "csphase" || n === "lifecyclephase")) phaseCol = idx;
            });
            if (crmCol < 0) {
              return c.json({ error: "No 'CRM ID' column found in the workbook header." }, 400);
            }
            ws.eachRow((row: any, rowNum: number) => {
              if (rowNum === 1) return;
              const v = row.getCell(crmCol).value;
              const id = String((v && (v as any).text) || v || "").trim();
              if (!id) return;
              crmIds.push(id);
              if (phaseCol > 0) {
                const pv = row.getCell(phaseCol).value;
                const ph = String((pv && (pv as any).text) || pv || "").trim();
                if (ph) clientHubPhaseById[id] = ph;
              }
            });
          } else {
            const body = await c.req.json().catch(() => ({}));
            crmIds = Array.isArray(body?.crmIds) ? body.crmIds.map((x: any) => String(x)) : [];
            if (body?.clientHubPhaseById && typeof body.clientHubPhaseById === "object") {
              for (const [k, v] of Object.entries(body.clientHubPhaseById)) {
                clientHubPhaseById[String(k)] = String(v);
              }
            }
          }
          crmIds = crmIds.map((s) => s.trim()).filter(Boolean).slice(0, 20000);
          if (!crmIds.length) return c.json({ error: "No CRM IDs found." }, 400);
          const result = await reconcileCrmIds(crmIds, clientHubPhaseById);
          return c.json({ success: true, ...result });
        } catch (e: any) {
          logger.error("cs-lifecycle/reconcile-ids failed", e);
          const detail = e instanceof Error ? e.message : String(e || "unknown error");
          return c.json({ error: detail.slice(0, 400) }, 500);
        }
      };
    },
  },
  {
    // LIVE "lost data" check (Sample User 2026-08-04) — for the CRM IDs the reconcile
    // flagged not_in_mirror, ask Zoho directly whether the record still exists.
    // Splits genuinely-lost (gone from the CRM) from a mere local sync gap.
    // JSON body { crmIds: string[] }. Read-only live GETs.
    path: "/api/duplicates/cs-lifecycle/verify-missing-ids",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const crmIds = Array.isArray(body?.crmIds)
            ? body.crmIds.map((x: any) => String(x))
            : [];
          if (!crmIds.length) return c.json({ error: "No CRM IDs provided." }, 400);
          const result = await verifyCrmIdsInZoho(crmIds, { max: 1000 });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          logger.error("cs-lifecycle/verify-missing-ids failed", e);
          const detail = e instanceof Error ? e.message : String(e || "unknown error");
          return c.json({ error: detail.slice(0, 400) }, 500);
        }
      };
    },
  },
  {
    // Radar client config (Sample User 2026-08-12) — env-driven values the dashboard
    // JS needs but can't read directly. Currently the product-token lists that
    // map a Zoho Account "Products" value to ExampleOrg vs WalaOne, so a new
    // ExampleOrg sub-product (WalaOffer / WalaBravo / …) is added via env, no code
    // change. Tokens are normalized (lowercased, spaces stripped) to match the
    // client's _accountProduct comparison.
    path: "/api/duplicates/config",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const norm = (csv: string, dflt: string) =>
            Array.from(
              new Set(
                (csv || dflt)
                  .split(",")
                  .map((s) => s.trim().toLowerCase().replace(/\s+/g, ""))
                  .filter(Boolean),
              ),
            );
          return c.json({
            success: true,
            ExampleOrgProductTokens: norm(
              process.env.RADAR_ExampleOrg_PRODUCT_TOKENS || "",
              "ExampleOrg,walaoffer,walabravo",
            ),
            walaoneProductTokens: norm(
              process.env.RADAR_WALAONE_PRODUCT_TOKENS || "",
              "walaone",
            ),
          });
        } catch (e: any) {
          logger.error("duplicates/config failed", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // OWNER OFFBOARDING — read: a (resigned) owner's OPEN-pipeline deals grouped
    // by Stage (Sample User 2026-07-30). GET ?owner=<exact owner_name>.
    path: "/api/duplicates/owner-deals",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const owner = c.req.query("owner") || "";
          if (!owner) return c.json({ error: "owner required" }, 400);
          const result = await getOwnerOpenDeals(String(owner));
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("owner-deals read failed:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // OWNER OFFBOARDING — DESTRUCTIVE bulk write to Zoho (Sample User 2026-07-30).
    // Admin-gated. Body: { owner, dealIds[], action: 'close_lost'|'move',
    // targetStage?, lostReason? }. Re-checks each id (still owned + open) before
    // writing; returns per-deal outcomes + skipped.
    path: "/api/duplicates/owner-deals/bulk-update",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const owner = String(body?.owner || "").trim();
        const dealIds = Array.isArray(body?.dealIds)
          ? body.dealIds.map((x: any) => String(x)).filter(Boolean)
          : [];
        const action = body?.action === "move" ? "move" : "close_lost";
        if (!owner) return c.json({ error: "owner required" }, 400);
        if (!dealIds.length) return c.json({ error: "dealIds required" }, 400);
        if (action === "move" && !String(body?.targetStage || "").trim()) {
          return c.json({ error: "targetStage required for move" }, 400);
        }
        logger.info(
          `[OwnerOffboard] ${su?.email || "operator"} bulk ${action} on ${dealIds.length} deal(s) of owner "${owner}"` +
            (action === "move" ? ` -> "${body.targetStage}"` : ` (Closed Lost / ${body?.lostReason || "Old Data"})`),
        );
        const result = await bulkUpdateOwnerDeals({
          owner,
          dealIds,
          action,
          targetStage: body?.targetStage,
          lostReason: body?.lostReason,
        });
        return c.json({ success: true, action, ...result });
      } catch (e: any) {
        logger.error("owner-deals bulk-update failed", e);
        const detail =
          e instanceof Error ? e.message : String(e || "unknown error");
        return c.json({ error: detail.slice(0, 400) }, 500);
      }
    },
  },
  {
    path: "/api/duplicates/logs",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const logs = await getDetectionLogs(limit);
          return c.json({ logs });
        } catch (error: any) {
          logger.error("Error fetching logs:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/search",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const query = url.searchParams.get("query") || "";
          const record_type =
            (url.searchParams.get("type") as "lead" | "deal" | "all") || "all";
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          logger.info(
            `🔍 [DuplicateRadar] Search query: "${query}", type: ${record_type}`,
          );

          const searchParams = {
            company_name: query,
            domain: query,
            email: query.includes("@") ? query : undefined,
            record_type: record_type === "all" ? undefined : record_type,
            limit,
            offset,
          };

          const results = await searchDuplicates(searchParams);

          return c.json({
            success: true,
            query,
            records: results.records,
            clusters: results.clusters,
            total: results.total_records,
          });
        } catch (error: any) {
          logger.error("Error searching duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/scan-zoho",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const blocked = blockOrClearScan(body?.force === true);
          if (blocked) {
            return c.json(
              {
                success: false,
                error: blocked.error,
                ageMinutes: blocked.ageMinutes,
                progress: scanState.progress,
                startedAt: scanState.startedAt,
                hint: "Send { force: true } to abort the in-progress scan and start a fresh one.",
              },
              409,
            );
          }

          // { full: true } forces a complete re-pull instead of the default
          // incremental (If-Modified-Since) fetch, WITHOUT truncating anything.
          //
          // Previously the only way to get a full pull was /rebuild, which
          // wipes duplicate_records and duplicate_clusters first — far too
          // destructive for the common case of repairing a module whose
          // watermark is wrong. Records upsert on zoho_record_id, so a full
          // re-pull is safe to run at any time; it is also the only path that
          // notices records deleted in Zoho, since an incremental fetch by
          // definition never returns them.
          const fullPull = body?.full === true;
          logger.info(
            `🚀 [DuplicateRadar] Zoho CRM scan triggered via API (async)${fullPull ? " [FULL re-pull, no wipe]" : ""}`,
          );

          scanZohoCRMForDuplicates("manual", fullPull).catch((err) => {
            logger.error("[DuplicateRadar] Background scan error:", err);
            scanState.status = "failed";
            scanState.error = err?.message || "Background scan failed";
          });

          return c.json({
            success: true,
            message:
              "Scan started in background. Poll /api/duplicates/scan-status or connect to /api/duplicates/scan-stream for real-time progress.",
            status: "scanning",
          });
        } catch (error: any) {
          logger.error("Error starting Zoho CRM scan:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // One-shot purge of singleton clusters (status='active' AND
    // total_records<=1). Engine residue, not duplicates. Defaults to
    // dryRun=true: returns the audit + 20-row sample + the count of
    // duplicate_records pointing at them. Caller must POST
    // { "dryRun": false } to actually delete. Refuses if candidate
    // count > maxDelete (default 100k). Admin-only.
    path: "/api/duplicates/cleanup-singletons",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const dryRun = body?.dryRun !== false;
          const maxDelete =
            typeof body?.maxDelete === "number" && body.maxDelete > 0
              ? Math.floor(body.maxDelete)
              : 100000;

          const { cleanupSingletonClusters } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await cleanupSingletonClusters({ dryRun, maxDelete });
          logger.info(
            `🧹 [DuplicateRadar] cleanupSingletonClusters (${dryRun ? "DRY-RUN" : "APPLIED"}) by ${sessionUser?.email || "admin-key"}: ${result.candidateCount} candidates, deleted ${result.deletedClusterCount}, cleared ${result.cleanedRecordCount} records, refused=${result.refusedReason ?? "no"}`,
          );
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error in cleanup-singletons:", error);
          return c.json(
            { success: false, error: "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/rebuild",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const rebuildBody = await c.req.json().catch(() => ({}));
          const rebuildBlocked = blockOrClearScan(rebuildBody?.force === true);
          if (rebuildBlocked) {
            return c.json(
              {
                success: false,
                error: rebuildBlocked.error,
                ageMinutes: rebuildBlocked.ageMinutes,
                progress: scanState.progress,
                startedAt: scanState.startedAt,
                hint: "Send { force: true } to abort the in-progress scan and start a fresh one.",
              },
              409,
            );
          }

          logger.info(
            "🧨 [DuplicateRadar] Rebuild Clusters triggered — wiping tables and rescanning",
          );
          await truncateAllDuplicateData();

          // forceFull=true: we just wiped everything, so a full re-pull is
          // mandatory — an incremental (changed-only) fetch here would leave
          // the radar nearly empty.
          scanZohoCRMForDuplicates("manual", true)
            .then(async () => {
              // Re-attach the AI-Applied markers archived before the truncate.
              // Runs only after a SUCCESSFUL rescan — restoring onto a
              // half-built mirror would bind them to the wrong clusters.
              try {
                const { restoreMergeActions } = await import(
                  "../../utils/duplicateRadarDatabase"
                );
                const restored = await restoreMergeActions();
                logger.info(
                  `[DuplicateRadar] Rebuild restored ${restored} merge action(s)`,
                );
              } catch (restoreErr) {
                // Loud: the archive still holds them, but the UI will show the
                // backlog as untouched until someone re-runs the restore.
                logger.error(
                  "[DuplicateRadar] MERGE-ACTION RESTORE FAILED — AI-Applied markers are archived but not re-attached",
                  restoreErr,
                );
              }
            })
            .catch((err) => {
              logger.error(
                "[DuplicateRadar] Background rebuild scan error:",
                err,
              );
              scanState.status = "failed";
              scanState.error = err?.message || "Background scan failed";
            });

          return c.json({
            success: true,
            message:
              "Clusters wiped. A fresh Zoho scan is rebuilding them. Watch /api/duplicates/scan-stream for progress.",
            status: "scanning",
          });
        } catch (error: any) {
          logger.error("Error rebuilding clusters:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/scan-status",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const elapsed = scanState.startedAt
            ? Date.now() - scanState.startedAt
            : 0;
          return c.json({
            status: scanState.status,
            progress: scanState.progress,
            startedAt: scanState.startedAt,
            completedAt: scanState.completedAt,
            elapsedMs: elapsed,
            percentage: scanState.percentage,
            moduleStatuses: scanState.moduleStatuses,
            recordCounts: scanState.recordCounts,
            result:
              scanState.status === "completed" || scanState.status === "failed"
                ? scanState.result
                : null,
            error: scanState.error,
          });
        } catch (error) {
          return c.json(
            { status: "unknown", error: "Failed to get scan status" },
            500,
          );
        }
      };
    },
  },
  // C1: SSE endpoint for real-time scan progress
  {
    path: "/api/duplicates/scan-stream",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const clientId = `sse-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

          let keepAlive: ReturnType<typeof setInterval> | undefined;

          const stream = new ReadableStream({
            start(controller) {
              sseClients.push({ id: clientId, controller });

              const initialMsg = `event: connected\ndata: ${JSON.stringify({
                clientId,
                currentStatus: scanState.status,
                progress: scanState.progress,
                percentage: scanState.percentage,
                moduleStatuses: scanState.moduleStatuses,
                elapsedMs: scanState.startedAt
                  ? Date.now() - scanState.startedAt
                  : 0,
              })}\n\n`;
              controller.enqueue(new TextEncoder().encode(initialMsg));

              keepAlive = setInterval(() => {
                try {
                  controller.enqueue(
                    new TextEncoder().encode(": keepalive\n\n"),
                  );
                } catch {
                  clearInterval(keepAlive);
                  keepAlive = undefined;
                }
              }, 15000);
              // Allow the Node event loop to exit even if this interval is still
              // active (e.g. during in-process tests). The interval is also
              // cleared explicitly in cancel() when the client disconnects.
              keepAlive.unref();
            },
            cancel() {
              clearInterval(keepAlive);
              keepAlive = undefined;
              sseClients = sseClients.filter((c) => c.id !== clientId);
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (error) {
          return c.json({ error: "Failed to create SSE stream" }, 500);
        }
      };
    },
  },
  // A6: RBAC guard on DELETE mock-data
  {
    path: "/api/duplicates/mock-data",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          await clearMockData();
          return c.json({ success: true, message: "Mock data cleared" });
        } catch (error: any) {
          logger.error("Error clearing mock data:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/export/estimate",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const owner = url.searchParams.get("owner") || undefined;
          const startDate = url.searchParams.get("start_date") || undefined;
          const endDate = url.searchParams.get("end_date") || undefined;

          const filterParams: unknown[] = ["active"];
          let whereClause = "WHERE dc.status = $1";
          if (owner) {
            filterParams.push(owner);
            whereClause += ` AND (dr.owner_name = $${filterParams.length} OR dr.owner_email = $${filterParams.length})`;
          }
          if (startDate) {
            filterParams.push(startDate);
            whereClause += ` AND dr.created_date >= $${filterParams.length}`;
          }
          if (endDate) {
            filterParams.push(endDate + "T23:59:59Z");
            whereClause += ` AND dr.created_date <= $${filterParams.length}`;
          }

          // Use the module-level shared pool. Creating a fresh pg.Pool per
          // request was opening TCP connections that never recycled; under
          // concurrent owner-export traffic (operator clicks several rows
          // in a row) the host's connection limit was being hit and the
          // streams stalled, which the client's abort logic surfaced as
          // "Cancelled" in the download history.
          const r = await sharedDuplicateRadarPool.query(
            `SELECT COUNT(*)::int AS total FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id ${whereClause}`,
            filterParams,
          );
          const { estimateFromCount, estimateResponse } =
            await import("../../utils/exportEstimate");
          return estimateResponse(
            estimateFromCount(r.rows[0]?.total, "csv", 240),
          );
        } catch (error: any) {
          logger.error("Error estimating duplicates CSV export:", error);
          return c.json({ error: "Failed to estimate export size" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/export-xlsx/estimate",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;
          const includeRaw = url.searchParams.get("include_raw") === "1";

          const filterParams: unknown[] = [];
          let whereClause = "WHERE dc.status = 'active'";
          if (start_date) {
            filterParams.push(start_date);
            whereClause += ` AND dr.created_date >= $${filterParams.length}`;
          }
          if (end_date) {
            filterParams.push(end_date + "T23:59:59Z");
            whereClause += ` AND dr.created_date <= $${filterParams.length}`;
          }

          const r = await sharedDuplicateRadarPool.query(
            `SELECT COUNT(*)::int AS total FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id ${whereClause}`,
            filterParams,
          );
          // Type-split sheets duplicate the per-record overhead 4x; All Records
          // adds a 5th copy when include_raw=1. Bump the per-row average so the
          // estimate stays conservative against the picker threshold.
          const baseRows = r.rows[0]?.total ?? 0;
          const sheetMultiplier = includeRaw ? 5 : 4;
          const { estimateBytesFromRows, estimateResponse } =
            await import("../../utils/exportEstimate");
          return estimateResponse({
            rows: baseRows,
            bytes: estimateBytesFromRows(
              baseRows * sheetMultiplier,
              "xlsx",
              140,
            ),
            format: "xlsx",
          });
        } catch (error: any) {
          logger.error("Error estimating duplicates XLSX export:", error);
          return c.json({ error: "Failed to estimate export size" }, 500);
        }
      };
    },
  },
  // B5: JOIN-based export (no N+1)
  {
    path: "/api/duplicates/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const exportType = url.searchParams.get("type") || "all";
          const owner = url.searchParams.get("owner") || undefined;
          const startDate = url.searchParams.get("start_date") || undefined;
          const endDate = url.searchParams.get("end_date") || undefined;
          // Optional per-module filter so the per-tab "Export CSV" buttons
          // (replacing the standalone Export Center tab) can scope the
          // download to just the module the user is currently viewing.
          // Allow only the canonical record types — anything else is
          // ignored to keep the WHERE clause shape stable.
          const rawRecordType = url.searchParams.get("record_type") || "";
          const recordType = ["lead", "deal", "contact", "account"].includes(
            rawRecordType,
          )
            ? rawRecordType
            : undefined;

          const { escapeCSVValue } = await import("../../utils/inputSanitizer");
          const { streamCsv, cursorQuery, stageStreamingExportFromHono } =
            await import("../../utils/excelExport");
          const {
            PLAYBOOK_HEADERS,
            emptyPlaybookState,
            startCluster,
            rowPlaybook,
          } = await import("../../utils/duplicateRadarPlaybook");

          // Build WHERE clause matching getExportRecords filter logic
          const filterParams: unknown[] = ["active"];
          let whereClause = "WHERE dc.status = $1";
          if (owner) {
            filterParams.push(owner);
            whereClause += ` AND (dr.owner_name = $${filterParams.length} OR dr.owner_email = $${filterParams.length})`;
          }
          if (startDate) {
            filterParams.push(startDate);
            whereClause += ` AND dr.created_date >= $${filterParams.length}`;
          }
          if (endDate) {
            filterParams.push(endDate + "T23:59:59Z");
            whereClause += ` AND dr.created_date <= $${filterParams.length}`;
          }
          if (recordType) {
            filterParams.push(recordType);
            whereClause += ` AND dr.record_type = $${filterParams.length}`;
            // Match the per-tab UI (getDuplicateRecordsByType): a record only
            // appears under the Lead/Deal/Contact/Account tab when its cluster
            // has more than one record of that same type. Without this guard
            // the CSV pulled extra rows from cross-module clusters (e.g. a
            // lead sharing a cluster with a contact but no other lead) and
            // ended up larger than the table the user was looking at.
            const countCol =
              recordType === "lead"
                ? "total_leads"
                : recordType === "deal"
                  ? "total_deals"
                  : recordType === "contact"
                    ? "total_contacts"
                    : "total_accounts";
            whereClause += ` AND dc.${countCol} > 1`;
          }

          // Use the module-level shared pool. The cursor stream releases
          // its own client when complete or on error, so we don't manage
          // pool lifetime here. Fresh-pool-per-request was causing
          // connection exhaustion under concurrent owner-export traffic.
          const drCsvPool = sharedDuplicateRadarPool;

          // Count query for the export log (fast aggregate, not a full materialisation)
          const countRes = await drCsvPool.query(
            `SELECT COUNT(*)::int AS total FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id ${whereClause}`,
            filterParams,
          );
          const totalCount: number = countRes.rows[0]?.total ?? 0;

          await createExportLog({
            export_type: exportType as any,
            filter_criteria: { owner, startDate, endDate },
            total_records_exported: totalCount,
            file_format: "csv",
            exported_by: "User",
          });

          const csvHeaders = [
            "Record ID",
            "Type",
            "Name",
            "Company",
            "Domain",
            "Owner",
            "Status/Stage",
            "Value",
            "Source",
            "Created Date",
            "Confidence",
            "Recommendation",
            // R1 (quick wins): remediation-playbook columns appended after
            // the raw record data. Stakeholders skim the right side of the
            // sheet for what to do, due dates, and who to contact.
            ...PLAYBOOK_HEADERS,
          ];
          const source = cursorQuery(
            drCsvPool,
            `SELECT dr.cluster_id, dr.zoho_record_id, dr.id, dr.record_type, dr.record_name, dr.company_name, dr.domain,
                    dr.owner_name, dr.owner_email, dr.status, dr.stage, dr.deal_value, dr.source, dr.created_date,
                    dr.confidence_score, dr.ai_recommendation, dr.is_primary,
                    dc.confidence_score AS cluster_confidence_score,
                    dc.total_records AS cluster_total_records
             FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
             ${whereClause}
             ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC`,
            filterParams,
          );
          const rows = (async function* () {
            // Cluster-scoped state: ORDER BY puts is_primary=true first
            // within each cluster, so the first row we see for a cluster
            // carries the primary record's name. Subsequent rows in the
            // same cluster reuse that primary name in the "Merge into …"
            // recommendation.
            const playbookState = emptyPlaybookState();
            for await (const r of source) {
              const rec = r as Record<string, unknown>;
              const cid = Number(rec["cluster_id"] ?? -1);
              if (cid !== playbookState.cluster_id) {
                startCluster(playbookState, rec);
              }
              const pb = rowPlaybook(rec, playbookState);
              yield [
                rec["zoho_record_id"] ?? rec["id"],
                rec["record_type"],
                rec["record_name"],
                rec["company_name"],
                rec["domain"],
                rec["owner_name"],
                rec["status"] ?? rec["stage"],
                rec["deal_value"] ?? "",
                rec["source"],
                rec["created_date"],
                rec["confidence_score"] == null
                  ? ""
                  : `${rec["confidence_score"]}%`,
                rec["ai_recommendation"] ?? "Review manually",
                pb.recommended_action,
                pb.survivorship_rule,
                pb.owner_to_consult,
                pb.why_verdict,
                pb.due_date,
              ].map((v) => escapeCSVValue(String(v ?? "")));
            }
            // No pool.end() — shared pool is reused across requests.
            // cursorQuery() releases the per-stream client in its own
            // finally block.
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv(
              `duplicate_radar_export_${Date.now()}.csv`,
              csvHeaders,
              rows,
            ),
          );
        } catch (error: any) {
          logger.error("Error exporting data:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;
          const includeRaw = url.searchParams.get("include_raw") === "1";

          const { streamXlsx, cursorQuery, stageStreamingExportFromHono } =
            await import("../../utils/excelExport");
          const {
            PLAYBOOK_XLSX_COLUMNS,
            emptyPlaybookState,
            startCluster,
            rowPlaybook,
          } = await import("../../utils/duplicateRadarPlaybook");

          // Build WHERE clause for date filters (no status filter — XLSX exports all active)
          const xlsxFilterParams: unknown[] = [];
          let xlsxWhere = "WHERE dc.status = 'active'";
          if (start_date) {
            xlsxFilterParams.push(start_date);
            xlsxWhere += ` AND dr.created_date >= $${xlsxFilterParams.length}`;
          }
          if (end_date) {
            xlsxFilterParams.push(end_date + "T23:59:59Z");
            xlsxWhere += ` AND dr.created_date <= $${xlsxFilterParams.length}`;
          }

          // Shared module-level pool (see /export rationale).
          const drXlsxPool = sharedDuplicateRadarPool;

          // Aggregate summary counts and enhanced summary — small results
          const [typeCntRes, summary] = await Promise.all([
              drXlsxPool.query(
                `SELECT COALESCE(dr.record_type, 'other') AS rtype, COUNT(*)::int AS cnt
                 FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
                 ${xlsxWhere} GROUP BY dr.record_type`,
                xlsxFilterParams,
              ),
              getEnhancedSummary(),
            ]);

            const countByType: Record<string, number> = {};
            let totalXlsx = 0;
            for (const row of typeCntRes.rows) {
              countByType[row.rtype] = row.cnt;
              totalXlsx += row.cnt;
            }

            // Log export (non-blocking)
            try {
              await createExportLog({
                export_type: "all",
                filter_criteria: {
                  start_date,
                  end_date,
                  include_raw: includeRaw,
                },
                total_records_exported: totalXlsx,
                file_format: "xlsx",
                exported_by: "User",
              });
            } catch (logErr) {
              logger.warn(
                "[DuplicateRadar] export-xlsx log write failed (non-blocking):",
                logErr,
              );
            }

            const recordColumns = [
              { header: "Cluster ID", key: "cluster_id", width: 12 },
              { header: "Zoho ID", key: "zoho_record_id", width: 22 },
              { header: "Name", key: "record_name", width: 30 },
              { header: "Company", key: "company_name", width: 30 },
              { header: "Email", key: "email", width: 28 },
              { header: "Domain", key: "domain", width: 22 },
              { header: "Phone", key: "phone", width: 18 },
              { header: "Owner", key: "owner_name", width: 22 },
              { header: "Status / Stage", key: "status_or_stage", width: 18 },
              { header: "Value", key: "deal_value", width: 14 },
              { header: "Source", key: "source", width: 18 },
              { header: "Confidence", key: "confidence_score", width: 12 },
              { header: "Recommendation", key: "ai_recommendation", width: 40 },
              { header: "Created", key: "created_str", width: 14 },
              // R1 (quick wins): remediation playbook columns appended to
              // every type sheet so stakeholders see action / owner / due
              // alongside the raw record data.
              ...PLAYBOOK_XLSX_COLUMNS,
            ];

            // SQL template for per-type cursor queries — avoids raw_data JSONB blob.
            // Pulls is_primary + owner_email + cluster_confidence_score so
            // the playbook helpers can compute Merge-into-X / due-date /
            // owner-to-consult / survivorship-rule for each row.
            const typeIdx = xlsxFilterParams.length + 1;
            const recSql = `
              SELECT dr.cluster_id, dr.zoho_record_id, dr.record_name, dr.company_name, dr.email,
                     dr.domain, dr.phone, dr.owner_name, dr.owner_email, dr.is_primary,
                     COALESCE(dr.status, dr.stage, '') AS status_or_stage,
                     dr.deal_value, dr.source, dr.confidence_score, dr.ai_recommendation,
                     TO_CHAR(dr.created_date::date, 'YYYY-MM-DD') AS created_str,
                     dc.confidence_score AS cluster_confidence_score,
                     dc.total_records AS cluster_total_records
              FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
              ${xlsxWhere} AND dr.record_type = $${typeIdx}
              ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC`;

            // Async generator that enriches each row with the five playbook
            // fields. Cluster state is per-generator-instance so the four
            // type sheets (lead/deal/contact/account) don't share state.
            const enrichRows = (src: AsyncIterable<unknown>) =>
              (async function* () {
                const state = emptyPlaybookState();
                for await (const r of src) {
                  const rec = r as Record<string, unknown>;
                  const cid = Number(rec["cluster_id"] ?? -1);
                  if (cid !== state.cluster_id) {
                    startCluster(state, rec);
                  }
                  const pb = rowPlaybook(rec, state);
                  yield { ...rec, ...pb } as Record<string, unknown>;
                }
              })();

            const makeTypeRows = (rtype: string) => {
              const src = cursorQuery(drXlsxPool, recSql, [
                ...xlsxFilterParams,
                rtype,
              ]);
              return enrichRows(src);
            };

            const sheets: Array<{
              name: string;
              columns: typeof recordColumns;
              rows:
                | AsyncIterable<Record<string, unknown>>
                | Array<Record<string, unknown>>;
            }> = [
              {
                name: "Summary",
                columns: [
                  { header: "Metric", key: "metric", width: 32 },
                  { header: "Value", key: "value", width: 18 },
                ],
                rows: [
                  {
                    metric: "Total clusters",
                    value: summary?.totalClusters ?? 0,
                  },
                  { metric: "Total duplicate records", value: totalXlsx },
                  { metric: "Singletons", value: summary?.singletonCount ?? 0 },
                  {
                    metric: "Resolution rate",
                    value: summary?.resolutionRate
                      ? `${summary.resolutionRate}%`
                      : "n/a",
                  },
                  {
                    metric: "Low-confidence clusters",
                    value: summary?.lowConfidence ?? 0,
                  },
                  {
                    metric: "Leads with duplicates",
                    value: countByType["lead"] ?? 0,
                  },
                  {
                    metric: "Deals with duplicates",
                    value: countByType["deal"] ?? 0,
                  },
                  {
                    metric: "Contacts with duplicates",
                    value: countByType["contact"] ?? 0,
                  },
                  {
                    metric: "Accounts with duplicates",
                    value: countByType["account"] ?? 0,
                  },
                  { metric: "Date range start", value: start_date || "(all)" },
                  { metric: "Date range end", value: end_date || "(all)" },
                  { metric: "Generated", value: new Date().toISOString() },
                ],
              },
              {
                name: "Leads",
                columns: recordColumns,
                rows: makeTypeRows("lead"),
              },
              {
                name: "Deals",
                columns: recordColumns,
                rows: makeTypeRows("deal"),
              },
              {
                name: "Contacts",
                columns: recordColumns,
                rows: makeTypeRows("contact"),
              },
            ];

            const accountsSrc = cursorQuery(drXlsxPool, recSql, [
              ...xlsxFilterParams,
              "account",
            ]);
            sheets.push({
              name: "Accounts",
              columns: recordColumns,
              rows: enrichRows(accountsSrc),
            });

            if (includeRaw) {
              const allSrc = cursorQuery(
                drXlsxPool,
                `SELECT dr.cluster_id, dr.zoho_record_id, dr.record_name, dr.company_name, dr.email, dr.domain,
                        dr.phone, dr.owner_name, dr.owner_email, dr.is_primary,
                        COALESCE(dr.status, dr.stage, '') AS status_or_stage,
                        dr.deal_value, dr.source, dr.confidence_score, dr.ai_recommendation,
                        TO_CHAR(dr.created_date::date, 'YYYY-MM-DD') AS created_str,
                        dc.confidence_score AS cluster_confidence_score,
                        dc.total_records AS cluster_total_records
                 FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
                 ${xlsxWhere} ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC`,
                xlsxFilterParams,
              );
              sheets.push({
                name: "All Records",
                columns: recordColumns,
                rows: enrichRows(allSrc),
              });
            }

          return await stageStreamingExportFromHono(c, async () =>
            streamXlsx(sheets, `duplicate_radar_${Date.now()}.xlsx`, {
              title: "Duplicate Radar Export",
            }),
          );
        } catch (error: any) {
          logger.error("Error exporting duplicates XLSX:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // B5: JOIN-based lead/deal/contact/account endpoints (no N+1)
  {
    path: "/api/duplicates/leads",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const { limit, offset, result } = await loadRecordTabWithVerify(
            "lead",
            url,
          );
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching lead duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/deals",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const { limit, offset, result } = await loadRecordTabWithVerify(
            "deal",
            url,
          );
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching deal duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // C2: Contacts and Accounts endpoints
  {
    path: "/api/duplicates/contacts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const { limit, offset, result } = await loadRecordTabWithVerify(
            "contact",
            url,
          );
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching contact duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/accounts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const { limit, offset, result } = await loadRecordTabWithVerify(
            "account",
            url,
          );
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching account duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // C7: Smart AI recommendations
  {
    path: "/api/duplicates/ai-recommendations/:clusterId",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const clusterId = parseInt(c.req.param("clusterId"));
          if (isNaN(clusterId))
            return c.json({ error: "Invalid cluster ID" }, 400);

          const cluster = await getClusterById(clusterId);
          if (!cluster) {
            return c.json({ error: "Cluster not found" }, 404);
          }

          const records = await getRecordsByClusterId(clusterId);
          const recommendations = generateSmartRecommendations(records);
          const meta = getClusterRecordTypeMeta(records);

          return c.json({
            cluster_id: clusterId,
            domain: cluster.domain,
            total_records: records.length,
            recommendations,
            primary_type: meta.primary_type,
            is_cross_module: meta.is_cross_module,
            record_types: meta.record_types,
            ai_summary: meta.is_cross_module
              ? `Cross-module cluster (${meta.record_types.join(" + ")}) for ${cluster.domain || cluster.company_name}. Same-module records get MERGE; cross-module get LINK (set Account_Name / Contact_Name in Zoho — never merge across modules).`
              : `Analyzed ${records.length} ${meta.primary_type || "record"}(s) for ${cluster.domain || cluster.company_name}. Smart scoring considers data completeness, deal activity, recency, and record age.`,
          });
        } catch (error: any) {
          logger.error("Error generating AI recommendations:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/test-record",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const data = await c.req.json();
          const {
            record_type,
            email,
            first_name,
            last_name,
            deal_name,
            company,
            amount,
            owner_email,
          } = data;

          if (!email) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const emailDomain = email.split("@")[1]?.toLowerCase();
          if (!emailDomain) {
            return c.json({ error: "Invalid email format" }, 400);
          }

          const publicDomains = [
            "<REDACTED_HOST>",
            "<REDACTED_HOST>",
            "<REDACTED_HOST>",
            "<REDACTED_HOST>",
            "<REDACTED_HOST>",
            "<REDACTED_HOST>",
            "<REDACTED_HOST>",
          ];
          if (publicDomains.includes(emailDomain)) {
            return c.json(
              {
                error:
                  "Public email domains (gmail, yahoo, etc.) are excluded from duplicate detection. Use a company domain.",
              },
              400,
            );
          }

          const cluster = await findOrCreateClusterByDomain(emailDomain);

          const recordName =
            record_type === "lead"
              ? `${first_name || ""} ${last_name || ""}`.trim() ||
                "Unknown Lead"
              : deal_name || "Unknown Deal";

          const ownerName = owner_email
            ? owner_email
                .split("@")[0]
                .replace(/\./g, " ")
                .replace(/^\w/, (c: string) => c.toUpperCase())
            : "Unknown";

          await addRecordToCluster({
            cluster_id: cluster.id!,
            zoho_record_id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            record_type: record_type || "lead",
            record_name: recordName,
            email: email,
            domain: emailDomain,
            phone: undefined,
            company_name: company || undefined,
            owner_name: ownerName,
            owner_email: owner_email || undefined,
            deal_value: record_type === "deal" ? amount || 0 : undefined,
            stage: undefined,
            source: "Sandbox Test",
            created_date: new Date(),
            modified_date: new Date(),
            is_primary: false,
            confidence_score: 95,
            is_mock_data: true,
          });

          await updateClusterStats(cluster.id!);

          return c.json({
            success: true,
            cluster_id: cluster.id,
            domain: emailDomain,
          });
        } catch (error: any) {
          logger.error("Error adding test record:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/search",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const params = await c.req.json();
          logger.info("🔍 [DuplicateSearch] Searching with params:", params);

          const {
            domain,
            phone,
            company_name,
            contract_number,
            email,
            record_name,
            owner_email,
          } = params;

          if (
            !domain &&
            !phone &&
            !company_name &&
            !contract_number &&
            !email &&
            !record_name &&
            !owner_email
          ) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const results = await searchDuplicates({
            domain,
            phone,
            company_name,
            contract_number,
            email,
            record_name,
            owner_email,
          });

          logger.info(
            "✅ [DuplicateSearch] Found",
            results.total_records,
            "records in",
            results.clusters.length,
            "clusters",
          );

          return c.json(results);
        } catch (error: any) {
          logger.error("Error searching duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/resolve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const body = await c.req.json();
          const { action, primary_record_id, notes } = body;

          if (!action || !["resolve", "ignore", "reopen"].includes(action)) {
            return c.json(
              { error: 'action must be "resolve", "ignore" or "reopen"' },
              400,
            );
          }

          // Re-open: put a resolved/ignored cluster back to ACTIVE so it can be
          // merged/applied. For clusters marked resolved before they were
          // actually merged in Zoho (or dismissed by mistake).
          if (action === "reopen") {
            const cluster = await getClusterById(id);
            if (!cluster) return c.json({ error: "Cluster not found" }, 404);
            await updateClusterStatus(id, "active");
            // A full reopen also un-handles the cross-module overlap (bug
            // #4 follow-on): otherwise a fully reopened cluster would stay
            // invisible to the Cross-Module open queue while being visible
            // everywhere else.
            const { pool: drPool } = await import(
              "../../utils/duplicateRadarDatabase"
            );
            await drPool.query(
              `UPDATE duplicate_clusters SET cross_module_handled_at = NULL WHERE id = $1`,
              [id],
            );
            logger.info(
              `🔓 [DuplicateRadar] Cluster #${id} re-opened (was '${cluster.status}') by ${sessionUser.email || "admin"}`,
            );
            return c.json({ success: true, status: "active" });
          }

          const result = await resolveCluster(
            id,
            action,
            sessionUser.email || "admin",
            primary_record_id,
            notes,
          );
          return c.json({ success: true, merge_action: result });
        } catch (error: any) {
          logger.error("Error resolving cluster:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Bug #4 fix — Cross-Module "Handled" must be MODULE-SCOPED: it should
    // only acknowledge the cross-module relationship (e.g. Lead<->Account)
    // and remove the cluster from the Cross-Module open queue, NOT resolve
    // the whole cluster — a cluster can simultaneously hold a legitimate
    // same-module duplicate (e.g. 2 Leads + 1 Account) that must stay
    // visible in Domain Clusters / the per-module tabs. So this endpoint
    // sets cross_module_handled_at and explicitly does NOT touch `status`.
    // Reversible via /cross-module-unhandle below.
    path: "/api/duplicates/clusters/:id/cross-module-handled",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const upd = await pool.query(
            `UPDATE duplicate_clusters
                SET cross_module_handled_at = NOW()
              WHERE id = $1
            RETURNING id`,
            [id],
          );
          if (upd.rowCount === 0) {
            return c.json({ error: "Cluster not found" }, 404);
          }

          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await logEvent({
            userId: (sessionUser as any)?.userId ?? undefined,
            userEmail: (sessionUser as any)?.email ?? undefined,
            userRole: (sessionUser as any)?.role ?? undefined,
            actionType: "CROSS_MODULE_HANDLED",
            entityType: "DUPLICATE_CLUSTER",
            entityId: String(id),
            entityName: `Cluster #${id}`,
            description: `Cross-module overlap marked handled for cluster #${id} (cluster stays active; same-module duplicates remain visible)`,
            aiInvolved: false,
            severity: "INFO",
            module: "duplicate-radar",
          }).catch(() => {});

          logger.info(
            `[DuplicateRadar] Cluster #${id} cross-module overlap marked handled by ${sessionUser.email || "admin"}`,
          );
          return c.json({ success: true });
        } catch (error: any) {
          logger.error("Error marking cross-module overlap handled:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Reverse of cross-module-handled — puts the cluster back into the
    // Cross-Module open queue. Does not touch `status` either.
    path: "/api/duplicates/clusters/:id/cross-module-unhandle",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const upd = await pool.query(
            `UPDATE duplicate_clusters
                SET cross_module_handled_at = NULL
              WHERE id = $1
            RETURNING id`,
            [id],
          );
          if (upd.rowCount === 0) {
            return c.json({ error: "Cluster not found" }, 404);
          }

          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await logEvent({
            userId: (sessionUser as any)?.userId ?? undefined,
            userEmail: (sessionUser as any)?.email ?? undefined,
            userRole: (sessionUser as any)?.role ?? undefined,
            actionType: "CROSS_MODULE_UNHANDLED",
            entityType: "DUPLICATE_CLUSTER",
            entityId: String(id),
            entityName: `Cluster #${id}`,
            description: `Cross-module overlap un-handled for cluster #${id} (back in the open queue)`,
            aiInvolved: false,
            severity: "INFO",
            module: "duplicate-radar",
          }).catch(() => {});

          logger.info(
            `[DuplicateRadar] Cluster #${id} cross-module overlap un-handled by ${sessionUser.email || "admin"}`,
          );
          return c.json({ success: true });
        } catch (error: any) {
          logger.error("Error un-handling cross-module overlap:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R10 — List pre-merge snapshots for a cluster. Returned in
    // descending snapshot_at order; payload is a summary (no full JSONB)
    // so the dashboard can render a quick list without pulling MB of
    // records_snapshot data over the wire. Use /snapshots/:id to fetch
    // the full frozen state.
    path: "/api/duplicates/clusters/:id/snapshots",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const { listClusterSnapshots } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const snapshots = await listClusterSnapshots(id);
          return c.json({ success: true, snapshots });
        } catch (error: any) {
          logger.error("Error listing cluster snapshots:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R10 — Fetch a single snapshot's frozen cluster + records state.
    // Returned as JSONB so the dashboard can render the full record set
    // including raw_data. 404 when the snapshot id doesn't exist or
    // belongs to a cluster the user isn't authorised to see.
    path: "/api/duplicates/snapshots/:snapshotId",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const sid = parseInt(c.req.param("snapshotId"));
          if (isNaN(sid)) {
            return c.json({ error: "Invalid snapshot ID" }, 400);
          }

          const { getClusterSnapshot } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const snapshot = await getClusterSnapshot(sid);
          if (!snapshot) {
            return c.json({ error: "Snapshot not found" }, 404);
          }
          return c.json({ success: true, snapshot });
        } catch (error: any) {
          logger.error("Error fetching cluster snapshot:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R3 (quick-wins): Mark cluster Resolved AND verify the non-primary
    // records were actually deleted in Zoho. The operator's "Mark
    // Resolved" click asserts a manual Zoho merge happened — this
    // endpoint checks that assertion against Zoho's current state so
    // the dashboard can show Verified / Failed badges instead of just
    // trusting the operator's word.
    //
    // Behaviour:
    //   1. Resolve the cluster (existing resolveCluster flow)
    //   2. For each non-primary record, search Zoho by exact id
    //   3. Persist verification_state = 'verified' | 'failed' + notes
    //   4. If verification failed (records still in Zoho), flip cluster
    //      status back to 'active' so it doesn't silently disappear
    //      from operator queues.
    path: "/api/duplicates/clusters/:id/resolve-and-verify",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          let body: {
            action?: string;
            primary_record_id?: number;
            notes?: string;
          } = {};
          try {
            body = await c.req.json();
          } catch {
            body = {};
          }
          const action = body.action ?? "resolve";
          if (!["resolve", "ignore"].includes(action)) {
            return c.json(
              { error: 'action must be "resolve" or "ignore"' },
              400,
            );
          }

          const mergeAction = await resolveCluster(
            id,
            action as "resolve" | "ignore",
            sessionUser.email || "admin",
            body.primary_record_id,
            body.notes,
          );

          const { verifyClusterMergedInZoho, listClusterSnapshots } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const verification = await verifyClusterMergedInZoho(id);

          // Verification failed → flip the cluster back to active so it
          // reappears in operator queues. The verification_state stays
          // 'failed' with the notes attached so they can see why.
          if (!verification.verified) {
            await updateClusterStatus(id, "active");
            logger.info(
              `[DuplicateRadar] Cluster ${id} verification failed; status reverted to active. ${verification.notes}`,
            );
          }

          // Follow-up 2: surface the just-captured pre-resolve snapshot
          // id so the UI can one-click open the viewer on verification
          // failure. resolveCluster (called above) invokes
          // captureClusterSnapshot internally as its first step (R10),
          // so the most-recent snapshot for this cluster IS the one we
          // just captured. Pulling the latest is cheap (indexed query)
          // and avoids a second client round-trip.
          let latestSnapshotId: number | null = null;
          try {
            const snaps = await listClusterSnapshots(id);
            latestSnapshotId = snaps[0]?.id ?? null;
          } catch (snapErr) {
            // Best-effort — a snapshot-lookup failure must NOT mask the
            // verification result the operator is waiting on.
            logger.warn(
              `[DuplicateRadar] Could not fetch latest snapshot for cluster ${id} after resolve-and-verify: ${(snapErr as Error).message}`,
            );
          }

          return c.json({
            success: true,
            merge_action: mergeAction,
            verification,
            cluster_status: verification.verified ? "resolved" : "active",
            latest_snapshot_id: latestSnapshotId,
          });
        } catch (error: any) {
          logger.error("Error in resolve-and-verify:", error);
          return c.json(
            { success: false, error: "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/primary",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const clusterId = parseInt(c.req.param("id"));
          const { record_id } = await c.req.json();
          if (isNaN(clusterId) || !record_id)
            return c.json({ error: "Invalid parameters" }, 400);

          const success = await markPrimaryRecord(clusterId, record_id);
          return c.json({ success });
        } catch (error: any) {
          logger.error("Error marking primary:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/bulk-resolve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { cluster_ids, action } = await c.req.json();
          if (
            !Array.isArray(cluster_ids) ||
            !["resolve", "ignore", "reopen"].includes(action)
          ) {
            return c.json(
              {
                error:
                  "cluster_ids (array) and action (resolve/ignore/reopen) required",
              },
              400,
            );
          }

          const count = await bulkResolve(
            cluster_ids,
            action,
            sessionUser.email || "admin",
          );
          return c.json({ success: true, resolved: count });
        } catch (error: any) {
          logger.error("Error bulk resolving:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/merge-history",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const clusterId = url.searchParams.get("cluster_id");
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const history = await getMergeHistory(
            clusterId ? parseInt(clusterId) : undefined,
            limit,
          );
          return c.json({ history });
        } catch (error: any) {
          logger.error("Error fetching merge history:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/check",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { email, phone, company_name } = await c.req.json();

          if (!email && !phone && !company_name) {
            return c.json(
              { error: "Provide at least one of: email, phone, company_name" },
              400,
            );
          }

          const result = await checkForDuplicates({
            email,
            phone,
            company_name,
          });
          return c.json(result);
        } catch (error: any) {
          logger.error("Error checking duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/owner-accountability",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const data = await getOwnerAccountability();
          return c.json({ owners: data });
        } catch (error: any) {
          logger.error("Error fetching owner accountability:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // R2: per-owner Remediation Packet — 4-sheet xlsx (Cover, Action Items,
  // Raw Records, FAQ). Owner name passes through the querystring rather
  // than the path so existing owner-name characters (spaces, dots,
  // Arabic) don't have to be URL-pre-encoded by the link generator.
  {
    path: "/api/duplicates/owner-packet",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const ownerName = (url.searchParams.get("owner") || "").trim();
          if (!ownerName) {
            return c.json({ error: "owner query param is required" }, 400);
          }
          // Locale for the packet body. Defaults to English; clamp anything
          // unrecognised so a typo can't break the build (XLSX still ships
          // in English rather than 500ing). Frontend passes "ar" when the
          // dashboard is in Arabic mode (ExampleOrgI18n.currentLang()).
          const langParam = (url.searchParams.get("lang") || "en").toLowerCase();
          const lang: "en" | "ar" = langParam === "ar" ? "ar" : "en";

          const [owners, settings] = await Promise.all([
            getOwnerAccountability(),
            getPacketSettings(),
          ]);
          // Match owner by name OR email, case-insensitive — the dashboard
          // link passes the display name, but operators sometimes hit the
          // endpoint directly with the email.
          const needle = ownerName.toLowerCase();
          const owner = owners.find(
            (o) =>
              (o.owner_name ?? "").trim().toLowerCase() === needle ||
              (o.owner_email ?? "").trim().toLowerCase() === needle,
          );
          if (!owner) {
            return c.json(
              { error: "Owner not found", owner: ownerName },
              404,
            );
          }

          // Pull every duplicate-cluster record this owner is on, sorted so
          // the playbook helpers see is_primary first per cluster. Same
          // name-or-email match as above so a single owner with mismatched
          // case in legacy rows still gets a complete packet.
          const recordsRes = await sharedDuplicateRadarPool.query(
            `
              SELECT dr.cluster_id, dr.zoho_record_id, dr.record_name, dr.record_type,
                     dr.company_name, dr.email, dr.domain, dr.phone,
                     dr.owner_name, dr.owner_email, dr.is_primary,
                     COALESCE(dr.status, dr.stage, '') AS status_or_stage,
                     dr.deal_value, dr.source, dr.confidence_score, dr.ai_recommendation,
                     TO_CHAR(dr.created_date::date, 'YYYY-MM-DD') AS created_str,
                     dc.confidence_score AS cluster_confidence_score,
                     dc.total_records      AS cluster_total_records
              FROM duplicate_records dr
              JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
              WHERE dc.status = 'active'
                AND dc.total_records > 1
                AND (
                  LOWER(TRIM(dr.owner_name))  = $1 OR
                  LOWER(TRIM(dr.owner_email)) = $1
                )
              ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC
            `,
            [needle],
          );

          const records = recordsRes.rows as Array<Record<string, unknown>>;
          const seenClusters = new Set<number>();
          const clusterConfidences: number[] = [];
          for (const r of records) {
            const cid = Number(r.cluster_id ?? -1);
            if (cid > 0 && !seenClusters.has(cid)) {
              seenClusters.add(cid);
              const cc = Number(r.cluster_confidence_score ?? 0);
              if (!Number.isNaN(cc)) clusterConfidences.push(cc);
            }
          }

          const { streamXlsx, stageStreamingExportFromHono } = await import(
            "../../utils/excelExport"
          );
          const { buildPacketSheets, packetFilename } = await import(
            "../../utils/duplicateRadarPacket"
          );

          const sheets = buildPacketSheets({
            owner,
            settings,
            records,
            clusterConfidences,
            lang,
          });
          const filename = packetFilename(owner.owner_name);

          // Audit trail — same table the CSV / XLSX exports write to. Lets
          // operators see who pulled a packet and when from the existing
          // export-log dashboard. Non-blocking: a logging failure must not
          // stop the owner from receiving their packet.
          //
          // `exported_by` is the ACTOR (the admin / ops user that ran the
          // download), not the target owner. The target owner is in
          // filter_criteria. This is the audit invariant: "who pulled
          // sensitive data about whom".
          const actor =
            (admin as any).email ||
            (admin as any).name ||
            `user:${(admin as any).userId ?? "unknown"}`;
          try {
            await createExportLog({
              export_type: "owner_packet" as any,
              filter_criteria: {
                owner: owner.owner_name,
                packet: true,
                lang,
              },
              total_records_exported: records.length,
              file_format: "xlsx",
              exported_by: actor,
            });
          } catch (logErr) {
            logger.warn(
              "[DuplicateRadar] owner-packet export log write failed (non-blocking):",
              logErr,
            );
          }

          return await stageStreamingExportFromHono(c, async () =>
            streamXlsx(sheets, filename, {
              title: `Duplicate Radar — Remediation Packet for ${owner.owner_name}`,
            }),
          );
        } catch (error: any) {
          logger.error("Error generating owner packet:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/enhanced-summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const summary = await getEnhancedSummary();
          const lastScan = await getLastScanDate();
          return c.json({ ...summary, lastScanDate: lastScan });
        } catch (error: any) {
          logger.error("Error fetching enhanced summary:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/sync-status",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const states = await getAllSyncStates();
          // Flag a run that has been "syncing" long enough to be abandoned.
          // Without this a process killed by a deploy or a timeout reads as
          // healthy work in progress indefinitely — Accounts showed
          // "0 (syncing)" for hours that way.
          const { isSyncStale } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          return c.json({
            syncStates: (states as any[]).map((s) => ({
              ...s,
              is_stale: isSyncStale(s),
            })),
          });
        } catch (error: any) {
          logger.error("Error fetching sync status:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/filters/options",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const [owners, layouts, domains, pipelines, products, stages] =
            await Promise.all([
              getDistinctOwners(),
              getDistinctLayouts(),
              getDistinctDomains(),
              getDistinctPipelines(),
              getDistinctProducts(),
              getDistinctStages(),
            ]);
          return c.json({
            owners,
            layouts,
            domains,
            pipelines,
            products,
            stages,
            modules: ["Leads", "Deals", "Contacts", "Accounts"],
          });
        } catch (error: any) {
          logger.error("Error fetching filter options:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/filtered-clusters",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const rawLimit = parseInt(url.searchParams.get("limit") || "30");
          const rawOffset = parseInt(url.searchParams.get("offset") || "0");
          const limit = isNaN(rawLimit)
            ? 30
            : Math.min(Math.max(rawLimit, 1), 100);
          const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);

          const rawSegment = (url.searchParams.get("segment") || "").trim();
          const segment: DuplicateFilters["segment"] =
            ["marketplace", "corporate", "ExampleOrg", "walaone"].includes(
              rawSegment,
            )
              ? (rawSegment as DuplicateFilters["segment"])
              : undefined;

          const filters: DuplicateFilters = {
            modules: url.searchParams.get("modules")
              ? url.searchParams.get("modules")!.split(",")
              : undefined,
            owners: url.searchParams.get("owners")
              ? url.searchParams.get("owners")!.split(",")
              : undefined,
            layouts: url.searchParams.get("layouts")
              ? url.searchParams.get("layouts")!.split(",")
              : undefined,
            pipelines: url.searchParams.get("pipelines")
              ? url.searchParams.get("pipelines")!.split(",")
              : undefined,
            stages: url.searchParams.get("stages")
              ? url.searchParams.get("stages")!.split(",")
              : undefined,
            domain: url.searchParams.get("domain") || undefined,
            start_date: url.searchParams.get("start_date") || undefined,
            end_date: url.searchParams.get("end_date") || undefined,
            status: url.searchParams.get("status") || "active",
            confidence_level:
              url.searchParams.get("confidence_level") || undefined,
            segment,
            // The AI-status chip (Untouched / AI-Applied / Resolved / Dismissed)
            // was never read here, so every chip returned the SAME list: all
            // five values gave an identical total of 88,525 and the identical
            // first cluster, always status 'active'. The per-row badges are
            // computed client-side, so the page looked filtered while the
            // underlying query was not — which is why dismissing a cluster
            // appeared to do nothing and the Dismissed tab showed active
            // clusters. The DB layer has implemented this filter all along
            // (buildAiStatusFilter); only the wiring was missing.
            ai_status: AI_STATUS_VALUES.includes(
              (url.searchParams.get("ai_status") || "").trim(),
            )
              ? (url.searchParams.get("ai_status") || "").trim()
              : undefined,
          };

          const { clusters, total } = await getFilteredClusters(
            filters,
            limit,
            offset,
          );
          return c.json({
            clusters,
            total,
            limit,
            offset,
            pages: Math.ceil(total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching filtered clusters:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/filtered-summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const rawSegment = (url.searchParams.get("segment") || "").trim();
          const segment: DuplicateFilters["segment"] =
            ["marketplace", "corporate", "ExampleOrg", "walaone"].includes(
              rawSegment,
            )
              ? (rawSegment as DuplicateFilters["segment"])
              : undefined;

          const filters: DuplicateFilters = {
            modules: url.searchParams.get("modules")
              ? url.searchParams.get("modules")!.split(",")
              : undefined,
            owners: url.searchParams.get("owners")
              ? url.searchParams.get("owners")!.split(",")
              : undefined,
            stages: url.searchParams.get("stages")
              ? url.searchParams.get("stages")!.split(",")
              : undefined,
            domain: url.searchParams.get("domain") || undefined,
            segment,
          };
          const summary = await getFilteredSummary(filters);
          return c.json(summary);
        } catch (error: any) {
          logger.error("Error fetching filtered summary:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/tasks",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const clusterId = parseInt(c.req.param("id"));
          if (isNaN(clusterId))
            return c.json({ error: "Invalid cluster ID" }, 400);

          const records = await getRecordsByClusterId(clusterId);
          const recordIds = records
            .map((r) => r.zoho_record_id)
            .filter(Boolean) as string[];
          const tasks = await getTasksForRecords(recordIds);
          const taskCount = await getTaskCountForCluster(clusterId);

          return c.json({ tasks, total: taskCount });
        } catch (error: any) {
          logger.error("Error fetching cluster tasks:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // C5: Auto-resolve engine
  {
    path: "/api/duplicates/auto-resolve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const result = await autoResolveClusters();
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error auto-resolving:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/recalculate-stats",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const result = await pool.query(`
            UPDATE duplicate_clusters dc SET
              total_leads = sub.lead_count,
              total_deals = sub.deal_count,
              total_contacts = sub.contact_count,
              total_accounts = sub.account_count,
              total_records = sub.total_count,
              estimated_pipeline_value = sub.inflation,
              first_record_date = sub.first_date,
              latest_activity_date = sub.latest_date,
              updated_at = CURRENT_TIMESTAMP
            FROM (
              SELECT
                cluster_id,
                COUNT(*) FILTER (WHERE record_type = 'lead') as lead_count,
                COUNT(*) FILTER (WHERE record_type = 'deal') as deal_count,
                COUNT(*) FILTER (WHERE record_type = 'contact') as contact_count,
                COUNT(*) FILTER (WHERE record_type = 'account') as account_count,
                COUNT(*) as total_count,
                COALESCE(SUM(deal_value) FILTER (WHERE is_primary = false AND record_type = 'deal'), 0) as inflation,
                MIN(created_date) as first_date,
                MAX(COALESCE(modified_date, created_date)) as latest_date
              FROM duplicate_records
              GROUP BY cluster_id
            ) sub
            WHERE dc.id = sub.cluster_id
          `);
          return c.json({
            success: true,
            clustersUpdated: result.rowCount || 0,
          });
        } catch (error: any) {
          logger.error("Error recalculating stats:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // ─── CS-pipeline overlap: list + scan ──────────────────────────────────────
  {
    path: "/api/duplicates/cs-overlap/clusters",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const verdict = url.searchParams.get("verdict"); // block|review|warn|null
          const limit = Math.min(
            Math.max(parseInt(url.searchParams.get("limit") || "500"), 1),
            2000,
          );
          const offset = Math.max(
            parseInt(url.searchParams.get("offset") || "0"),
            0,
          );

          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const conds: string[] = [
            "cs_overlap_verdict IS NOT NULL",
            "status = 'active'",
            // Empty/Junk exclusion (Task 3): a cluster only belongs here while
            // it still holds at least one REAL record (cleanup_class IS NULL).
            // Cleanup records (empty/test/junk/orphaned/tagged) live on the
            // Empty/Junk tab, not CS Pipeline Overlap.
            "EXISTS (SELECT 1 FROM duplicate_records dr2 WHERE dr2.cluster_id = duplicate_clusters.id AND dr2.cleanup_class IS NULL)",
          ];
          const params: any[] = [];
          if (verdict && ["block", "review", "warn"].includes(verdict)) {
            params.push(verdict);
            conds.push(`cs_overlap_verdict = $${params.length}`);
          }
          // Segment chip (Sample User 2026-07-15): restrict to clusters holding ≥1
          // record on the chosen Zoho Layout, same predicate as every other tab.
          const csoSegment = url.searchParams.get("segment") || undefined;
          const { buildSegmentPredicate: _bspCso } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          let csoSumSegSql = "";
          const csoSumSegParams: any[] = [];
          if (csoSegment && csoSegment !== "all") {
            const segMain = _bspCso(csoSegment as any, params.length + 1);
            if (segMain.condition) {
              conds.push(
                `EXISTS (SELECT 1 FROM duplicate_records r WHERE r.cluster_id = duplicate_clusters.id AND ${segMain.condition})`,
              );
              params.push(...segMain.params);
            }
            const segSum = _bspCso(csoSegment as any, 1);
            if (segSum.condition) {
              csoSumSegSql = ` AND EXISTS (SELECT 1 FROM duplicate_records r WHERE r.cluster_id = duplicate_clusters.id AND ${segSum.condition})`;
              csoSumSegParams.push(...segSum.params);
            }
          }
          const where = conds.join(" AND ");

          const sql = `SELECT id, domain, company_name, company_name_arabic,
                              estimated_pipeline_value, total_records,
                              total_leads, total_deals, total_contacts, total_accounts,
                              confidence_score, confidence_level, status,
                              cs_overlap_verdict, arr_exposure,
                              pipeline_lifecycle_state, client_sector,
                              updated_at
                         FROM duplicate_clusters
                        WHERE ${where}
                        ORDER BY
                          CASE cs_overlap_verdict
                            WHEN 'block' THEN 1
                            WHEN 'review' THEN 2
                            WHEN 'warn' THEN 3
                            ELSE 4
                          END,
                          arr_exposure DESC NULLS LAST
                        LIMIT $${params.length + 1}
                       OFFSET $${params.length + 2}`;
          params.push(limit, offset);
          const r = await pool.query(sql, params);

          const sumRow = await pool.query(
            `SELECT cs_overlap_verdict AS verdict,
                    COUNT(*)::int AS count,
                    COALESCE(SUM(arr_exposure),0)::float AS arr
               FROM duplicate_clusters
              WHERE cs_overlap_verdict IS NOT NULL
                AND status = 'active'
                AND EXISTS (
                  SELECT 1 FROM duplicate_records dr2
                   WHERE dr2.cluster_id = duplicate_clusters.id AND dr2.cleanup_class IS NULL
                )${csoSumSegSql}
              GROUP BY cs_overlap_verdict`,
            csoSumSegParams,
          );
          const summary: Record<string, { count: number; arr: number }> = {};
          let totalArr = 0;
          for (const row of sumRow.rows) {
            summary[row.verdict] = { count: row.count, arr: row.arr };
            totalArr += row.arr;
          }

          return c.json({
            clusters: r.rows,
            total: r.rows.length,
            limit,
            offset,
            summary,
            total_arr_exposure: totalArr,
          });
        } catch (error: any) {
          logger.error("Error fetching CS overlap clusters:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/cs-overlap/scan",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const { scanAllClustersForCsOverlap, initDuplicateRadarTables } =
            await import("../../utils/duplicateRadarDatabase");
          await initDuplicateRadarTables();
          const result = await scanAllClustersForCsOverlap();
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running CS overlap scan:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Manually trigger auto-CAPA for current BLOCK clusters above the ARR
    // threshold. Idempotent: existing open CAPAs are skipped.
    path: "/api/duplicates/cs-overlap/auto-capa",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: { threshold_sar?: number; created_by?: string } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }

          const { autoOpenCapasForBlockClusters } = await import(
            "../../utils/csOverlapAutoCapa"
          );
          const result = await autoOpenCapasForBlockClusters({
            thresholdSar:
              typeof body.threshold_sar === "number"
                ? body.threshold_sar
                : undefined,
            createdBy: body.created_by,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running auto-CAPA:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Communication-eligibility check — answers "can SDR/Marketing contact
    // this domain right now?". Combines contract state (signed/paid),
    // CS Phase, Churn Date, and sector-based cool-off into a single
    // verdict (block / review / allow) with per-deal reasoning.
    path: "/api/duplicates/communication-check",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: { domain?: string } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          if (!body.domain || typeof body.domain !== "string") {
            return c.json(
              { error: "Body must include { domain: string }" },
              400,
            );
          }

          const { checkCommunicationEligibility } = await import(
            "../../utils/csCommunicationCheck"
          );
          const result = await checkCommunicationEligibility({
            domain: body.domain,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running communication-check:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Reconcile synthetic cluster domains (`*.cluster` / company-name slugs)
    // with the authoritative Company_Domain that CS adds during Onboarding.
    // Promotes the cluster's `domain` to the real one whenever every Deal in
    // the cluster agrees. Idempotent + safe to re-run. Pass {dry_run:true}
    // to preview without writing.
    path: "/api/duplicates/reconcile-synthetic-domains",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: { dry_run?: boolean; limit?: number } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }

          const { reconcileSyntheticClusterDomains } = await import(
            "../../utils/duplicateRadarDomainReconciler"
          );
          const result = await reconcileSyntheticClusterDomains({
            dryRun: !!body.dry_run,
            limit: typeof body.limit === "number" ? body.limit : undefined,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error reconciling synthetic domains:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // List synthetic-domain clusters whose proposed authoritative domain
    // collides with another active cluster. Each row pairs the synthetic
    // cluster with the authoritative one so an operator can decide which
    // to keep. Optional ?limit= caps how many synthetic clusters are scanned.
    path: "/api/duplicates/domain-reconcile/collisions",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const limitQ = c.req.query("limit");
          const limit = limitQ ? Number.parseInt(limitQ, 10) : undefined;

          const { listDomainReconcileCollisions } = await import(
            "../../utils/duplicateRadarDomainReconciler"
          );
          const result = await listDomainReconcileCollisions({
            limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error listing domain-reconcile collisions:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Resolve a domain-reconcile collision by merging the synthetic cluster
    // INTO the authoritative one. Body: { authoritative_cluster_id, notes? }.
    // Records the action in duplicate_merge_actions as 'domain_collision_merge'.
    // Requires the standard Duplicate Radar write role.
    path: "/api/duplicates/domain-reconcile/collisions/:syntheticId/merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireAdminOrKey(c);
          if (!user) return unauthorizedResponse(c);

          const syntheticId = Number.parseInt(
            c.req.param("syntheticId") ?? "",
            10,
          );
          if (!Number.isFinite(syntheticId) || syntheticId <= 0) {
            return c.json(
              { success: false, error: "Invalid syntheticId path param" },
              400,
            );
          }

          let body: { authoritative_cluster_id?: number; notes?: string } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const authoritativeId = Number(body.authoritative_cluster_id);
          if (!Number.isFinite(authoritativeId) || authoritativeId <= 0) {
            return c.json(
              {
                success: false,
                error: "Body must include numeric authoritative_cluster_id",
              },
              400,
            );
          }

          const { mergeSyntheticIntoAuthoritative } = await import(
            "../../utils/duplicateRadarDomainReconciler"
          );
          const result = await mergeSyntheticIntoAuthoritative({
            syntheticClusterId: syntheticId,
            authoritativeClusterId: authoritativeId,
            performedBy:
              (user as any).email ?? (user as any).id ?? "domain-reconcile",
            notes: body.notes,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error merging collision pair:", error);
          const msg = String(error?.message ?? "");
          // Validation errors (cluster not active / not synthetic / etc.) carry
          // operator-actionable info — surface them rather than a generic 500.
          const isValidation =
            msg.includes("not found") ||
            msg.includes("not active") ||
            msg.includes("real domain") ||
            msg.includes("must differ");
          return c.json(
            { success: false, error: isValidation ? msg : "An internal error occurred" },
            isValidation ? 400 : 500,
          );
        }
      };
    },
  },
  // ===================================================================
  //  Manual CAPA conversion endpoint (2026-05-30 operator request).
  //
  //  Every actionable row across the duplicate radar (CS Lifecycle
  //  violation, Cross-Module overlap, Domain cluster, Account Hint,
  //  Owner Accountability row, etc.) can be escalated to a formal
  //  CAPA via this single endpoint. The frontend opens a shared
  //  modal that pre-fills the body from row context; this handler
  //  writes the CAPA into the canonical capa_records table so the
  //  same record shows up in the QMS CAPA inbox (where Quality works
  //  it) and in any Audit Reports rollup the team builds on top.
  //
  //  Idempotency: if an OPEN CAPA already exists for the same
  //  (source_type, source_id), we return that record instead of
  //  creating a duplicate. Operators can double-click the button
  //  without spawning two CAPAs.
  //
  //  Body:
  //    {
  //      source_type: string,            // 'duplicate_cluster' | 'cs_lifecycle_manual' | ...
  //      source_id: string,              // stable id from the row (cluster id, deal id, ...)
  //      source_reference?: string,      // human label for cross-link (domain, account name)
  //      title: string,                  // CAPA title (operator-editable in the modal)
  //      description?: string,           // CAPA body (likewise editable)
  //      severity?: 'critical' | 'major' | 'minor' | 'observation' (default 'major')
  //      target_days?: number,           // SLA window in days from now (default 7)
  //      assigned_to?: string,           // owner email
  //      metadata?: any                  // free-form (origin tab, row IDs, …)
  //    }
  //
  //  Returns: { success: true, capa_number, capa_id, was_existing: bool }
  // ===================================================================
  {
    path: "/api/duplicates/capa/manual-open",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const sourceType = String(body?.source_type || "").trim();
          const sourceId = String(body?.source_id || "").trim();
          const title = String(body?.title || "").trim();
          if (!sourceType || !sourceId || !title) {
            return c.json(
              {
                error:
                  "source_type, source_id and title are required.",
              },
              400,
            );
          }

          const description = String(body?.description || "").trim() || undefined;
          const sourceReference = String(body?.source_reference || "").trim() || undefined;
          const assignedTo = String(body?.assigned_to || "").trim() || undefined;
          const VALID_SEVERITIES = new Set([
            "critical",
            "major",
            "minor",
            "observation",
          ]);
          const severity = VALID_SEVERITIES.has(String(body?.severity))
            ? (body.severity as "critical" | "major" | "minor" | "observation")
            : "major";
          // Severity → priority mapping mirrors the auto-CAPA pipeline
          // (csLifecycleAutoCapa.priorityForViolation) so the QMS CAPA
          // inbox sorts manual + auto CAPAs the same way.
          const priority: "critical" | "high" | "medium" | "low" =
            severity === "critical"
              ? "critical"
              : severity === "major"
                ? "high"
                : severity === "minor"
                  ? "medium"
                  : "low";

          const targetDaysRaw = Number(body?.target_days);
          const targetDays =
            Number.isFinite(targetDaysRaw) && targetDaysRaw > 0
              ? Math.min(targetDaysRaw, 365)
              : 7;
          const targetDate = new Date(Date.now() + targetDays * 86400 * 1000);

          const { qmsPool, createCapaRecord } = await import(
            "../../utils/qmsDatabase"
          );

          // Idempotency check — return existing open CAPA for the same
          // (source_type, source_id) instead of duplicating. Matches the
          // auto-CAPA runners' existingOpenCapa() rule.
          const existingRes = await qmsPool.query(
            `SELECT id, capa_number
               FROM capa_records
              WHERE source_type = $1
                AND source_id   = $2
                AND status NOT IN ('closed', 'cancelled')
              LIMIT 1`,
            [sourceType, sourceId],
          );
          if (existingRes.rows.length > 0) {
            return c.json({
              success: true,
              capa_number: existingRes.rows[0].capa_number,
              capa_id: existingRes.rows[0].id,
              was_existing: true,
            });
          }

          const userEmail = (user as any).email || undefined;
          const userName = (user as any).name || undefined;
          const createdBy = userEmail || "duplicate-radar:manual";

          const capa = await createCapaRecord({
            title,
            description,
            capa_type: "corrective",
            source_type: sourceType,
            source_id: sourceId,
            source_reference: sourceReference,
            severity,
            status: "open",
            priority,
            assigned_to: assignedTo,
            target_date: targetDate,
            related_criteria: {},
            attachments: [],
            metadata: {
              origin: "duplicate-radar",
              opened_by: userEmail,
              opened_by_name: userName,
              ...(body?.metadata && typeof body.metadata === "object"
                ? body.metadata
                : {}),
            },
            created_by: createdBy,
          });

          // Audit-log every manual CAPA so the Audit Reports surface +
          // the QMS CAPA history both have a trail. Same envelope shape
          // the SDR review submissions and manual call-status overrides
          // use, so timeline reports stay coherent across action types.
          try {
            const { logEvent } = await import(
              "../../utils/eventLogsDatabase"
            );
            await logEvent({
              actionType: "capa_manual_open",
              entityType: "capa_record",
              entityId: String(capa.id ?? ""),
              entityName: capa.capa_number || title,
              module: "duplicates",
              severity:
                severity === "critical"
                  ? "WARNING"
                  : "INFO",
              aiInvolved: false,
              userEmail,
              userName,
              description: `Operator ${userEmail || "(unknown)"} opened CAPA ${
                capa.capa_number
              } from the duplicate radar: ${title}`,
              newValue: {
                capa_id: capa.id,
                capa_number: capa.capa_number,
                source_type: sourceType,
                source_id: sourceId,
                source_reference: sourceReference,
                severity,
                target_days: targetDays,
              },
            });
          } catch (logErr: any) {
            logger.warn(
              `[duplicate-radar/manual-capa] audit log failed: ${
                logErr?.message || logErr
              }`,
            );
          }

          return c.json({
            success: true,
            capa_number: capa.capa_number,
            capa_id: capa.id,
            was_existing: false,
          });
        } catch (error: any) {
          logger.error("Error opening manual CAPA:", error);
          return c.json(
            { error: error?.message || "Failed to open CAPA" },
            500,
          );
        }
      };
    },
  },
  {
    // KPI rollup over auto-created CAPAs (CS-overlap + CS-lifecycle).
    // Returns: totals, per-source-type breakdown, and a 30-day opened trend.
    path: "/api/duplicates/auto-capa/kpis",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const { getAutoCapaKpis } = await import(
            "../../utils/autoCapaKpis"
          );
          const result = await getAutoCapaKpis({});
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error computing auto-CAPA KPIs:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Manually trigger auto-CAPA for current CS Lifecycle violations
    // (default: critical-severity only). Idempotent: existing open CAPAs
    // for the same (record × code) pair are skipped.
    path: "/api/duplicates/cs-lifecycle/auto-capa",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: {
            severities?: ("info" | "warning" | "critical")[];
            codes?: string[];
            created_by?: string;
          } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }

          const { autoOpenCapasForCsLifecycle } = await import(
            "../../utils/csLifecycleAutoCapa"
          );
          const result = await autoOpenCapasForCsLifecycle({
            severities: body.severities,
            codes: body.codes as any,
            createdBy: body.created_by,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running CS lifecycle auto-CAPA:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Deal Stage Aging — list current Sales-SOP stage-aging violations.
    // Query params: severity={info|warning|critical}, stage={Proposal|...}, limit=N
    // Backed by scanDealStageAgingViolations + the Sales SOP spec
    // (src/utils/salesStageSlaSpec.ts). Pairs with the "Deals Lifecycle"
    // tab in the Duplicate Radar.
    path: "/api/duplicates/deal-stage-aging",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const severity = url.searchParams.get("severity") || undefined;
          const stage = url.searchParams.get("stage") || undefined;
          const segment = url.searchParams.get("segment") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "2000", 10);

          const { scanDealStageAgingViolations } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const { SALES_STAGE_SLA_SPEC } = await import(
            "../../utils/salesStageSlaSpec"
          );
          const result = await scanDealStageAgingViolations({
            severity: severity as any,
            stage,
            limit,
            segment: segment as any,
          });
          return c.json({
            success: true,
            spec: SALES_STAGE_SLA_SPEC,
            ...result,
          });
        } catch (error: any) {
          logger.error("Error fetching Deal Stage Aging violations:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // CS lifecycle compliance — list current violations.
    // Query params: severity={info|warning|critical}, code={onboarding_overdue|...}, limit=N
    path: "/api/duplicates/cs-lifecycle/violations",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const severity = url.searchParams.get("severity") || undefined;
          const code = url.searchParams.get("code") || undefined;
          const segment = url.searchParams.get("segment") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "2000", 10);

          const { scanCsLifecycleViolations } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await scanCsLifecycleViolations({
            severity: severity as any,
            code: code as any,
            limit,
            segment: segment as any,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error fetching CS lifecycle violations:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // DEAL STAGE AUDIT (Sample User 2026-07-21) — READ-ONLY. Every distinct Zoho Deal
    // Stage value with counts, a corporate/marketplace split and the pipelines
    // it appears on, plus suspected near-duplicate values (e.g. "Hold" vs
    // "On Hold"). Writes nothing: re-staging records and removing a dead
    // picklist option are manual Zoho steps, in that order.
    //   GET /api/duplicates/deal-stage-audit
    path: "/api/duplicates/deal-stage-audit",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { getDealStageAudit } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await getDealStageAudit();
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error building deal stage audit:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // CS OWNER ROSTER (Sample User 2026-07-20) — the distinct "CS Owner Name" values
    // across Deal records, with per-owner deal/account counts, plus how many CS
    // deals have no owner. Nothing in the platform listed the CS team before
    // this; the name only existed per-deal in Zoho.
    //   GET /api/duplicates/cs-lifecycle/owners?segment=&limit=
    path: "/api/duplicates/cs-lifecycle/owners",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const segment = url.searchParams.get("segment") || undefined;
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
          const { getCsOwners } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await getCsOwners({ segment: segment as any, limit });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error fetching CS owners:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Force-refresh one or more Deals directly from Zoho's single-record API
    // (real-time, not subject to the bulk-read eventual-consistency lag that
    // can cause CS Lifecycle violations to show stale Phase / Company_Domain
    // values long after the CRM record was updated). For each id we pull the
    // live record, run it through the same Deal extractor used by the bulk
    // sync, and upsert it so the next /violations call reflects current CRM
    // state. Reusing the existing cluster (by zoho_record_id) avoids
    // re-clustering side-effects.
    path: "/api/duplicates/cs-lifecycle/refresh-deals",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const zohoIds: string[] = Array.isArray(body?.zohoIds)
            ? body.zohoIds.filter((x: any) => typeof x === "string" && x.trim())
            : [];
          if (zohoIds.length === 0) {
            return c.json({ error: "zohoIds array required" }, 400);
          }
          const MAX = 50;
          if (zohoIds.length > MAX) {
            return c.json({ error: `Refresh at most ${MAX} deals per request` }, 400);
          }

          const { pool } = await import("../../utils/database");

          const refreshed: string[] = [];
          const missing: string[] = [];
          const failed: { id: string; error: string }[] = [];

          for (const zohoId of zohoIds) {
            try {
              const live = await fetchZohoRecordById("Deals", zohoId);
              if (!live) {
                missing.push(zohoId);
                continue;
              }
              const d: any = live.data;
              const existing = await pool.query(
                `SELECT cluster_id FROM duplicate_records WHERE zoho_record_id = $1 LIMIT 1`,
                [zohoId],
              );
              const clusterId = existing.rows[0]?.cluster_id;
              if (!clusterId) {
                missing.push(zohoId);
                continue;
              }
              await upsertRecord({
                cluster_id: clusterId,
                record_type: "deal",
                zoho_record_id: live.id,
                record_name: d.Deal_Name || "Unknown Deal",
                company_name: d.Account_Name?.name || d.Deal_Name || "Unknown",
                email: d.Contact_Email || undefined,
                domain: extractDomain(d.Contact_Email || "") || undefined,
                phone: d.Contact_Phone || undefined,
                owner_name: d.Owner?.name || "Unknown",
                owner_email: d.Owner?.email || "",
                status: "",
                stage: d.Stage || "",
                deal_value: parseFloat(d.Amount) || 0,
                source: d.Lead_Source || "",
                created_date: d.Created_Time ? new Date(d.Created_Time) : new Date(),
                modified_date: d.Modified_Time ? new Date(d.Modified_Time) : new Date(),
                is_primary: false,
                confidence_score: 0,
                is_mock_data: false,
                raw_data: d,
                layout_name: d.Layout?.name || d.$layout?.name || "",
                layout_id: d.Layout?.id || d.$layout?.id || "",
                zoho_module: "Deals",
                pipeline: d.Pipeline || "",
                products: d.Product_Details ? JSON.stringify(d.Product_Details) : "",
                contact_name: d.Contact_Name?.name || "",
                account_name: d.Account_Name?.name || "",
              });
              refreshed.push(zohoId);
            } catch (err: any) {
              logger.warn(
                `⚠️ [CS-Lifecycle Refresh] Failed to refresh Deal ${zohoId}: ${err?.message || err}`,
              );
              failed.push({ id: zohoId, error: String(err?.message || err) });
            }
          }

          logger.info(
            `🔄 [CS-Lifecycle Refresh] User ${user.email} refreshed ${refreshed.length}/${zohoIds.length} deals live from Zoho`,
          );
          return c.json({
            success: true,
            requested: zohoIds.length,
            refreshed_count: refreshed.length,
            missing_count: missing.length,
            failed_count: failed.length,
            refreshed,
            missing,
            failed,
          });
        } catch (error: any) {
          logger.error("Error in cs-lifecycle/refresh-deals:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Generic per-module live refresh from Zoho. Same pattern as
    // /api/duplicates/cs-lifecycle/refresh-deals but works for any of the
    // four duplicate-radar record types (lead / deal / contact / account)
    // so each per-module tab can offer the same "Refresh from Zoho (live)"
    // UX. For each id we fetch the live record from Zoho's single-record
    // API, run the same per-module extractor used by the bulk sync, and
    // upsert it into the existing cluster so the next /api/duplicates/{type}
    // call reflects the up-to-date CRM values.
    path: "/api/duplicates/refresh-records",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const moduleRaw = String(body?.module || "").toLowerCase();
          const MODULE_MAP: Record<
            string,
            {
              zohoModule: "Leads" | "Deals" | "Contacts" | "Accounts";
              recordType: "lead" | "deal" | "contact" | "account";
            }
          > = {
            leads: { zohoModule: "Leads", recordType: "lead" },
            deals: { zohoModule: "Deals", recordType: "deal" },
            contacts: { zohoModule: "Contacts", recordType: "contact" },
            accounts: { zohoModule: "Accounts", recordType: "account" },
          };
          const cfg = MODULE_MAP[moduleRaw];
          if (!cfg) {
            return c.json(
              {
                error:
                  "module must be one of: leads, deals, contacts, accounts",
              },
              400,
            );
          }
          const zohoIds: string[] = Array.isArray(body?.zohoIds)
            ? body.zohoIds.filter(
                (x: any) => typeof x === "string" && x.trim(),
              )
            : [];
          if (zohoIds.length === 0) {
            return c.json({ error: "zohoIds array required" }, 400);
          }
          const MAX = 50;
          if (zohoIds.length > MAX) {
            return c.json(
              { error: `Refresh at most ${MAX} records per request` },
              400,
            );
          }

          // Per-module extractor — mirrors the bulk-scan extractors at the
          // top of this file (processModule callsites). Kept inline so the
          // refresh endpoint and the bulk scan stay obviously in sync.
          const extract = (
            record: any,
          ): {
            companyName: string;
            recordName: string;
            email: string;
            phone: string;
            mobile?: string;
            domain: string | null;
            ownerName: string;
            ownerEmail: string;
            status: string;
            stage?: string;
            dealValue?: number;
            source: string;
            createdTime: string;
            modifiedTime: string;
            layoutName?: string;
            layoutId?: string;
            pipeline?: string;
            products?: string;
            contactName?: string;
            accountName?: string;
            crNumber?: string;
            vatNumber?: string;
            website?: string;
            country?: string;
            region?: string;
            industry?: string;
            noOfEmployees?: number;
            title?: string;
            leadType?: string;
            accountType?: string;
          } => {
            const d = record.data;
            switch (cfg.recordType) {
              case "lead":
                return {
                  companyName: d.Company || d.Last_Name || "Unknown",
                  email: d.Email || "",
                  phone: d.Phone || "",
                  mobile: d.Mobile || "",
                  recordName:
                    d.Full_Name ||
                    `${d.First_Name || ""} ${d.Last_Name || ""}`.trim(),
                  domain: extractDomain(d.Email || ""),
                  ownerName: d.Owner?.name || "Unknown",
                  ownerEmail: d.Owner?.email || "",
                  status: d.Lead_Status || "",
                  source: d.Lead_Source || "",
                  createdTime: d.Created_Time || "",
                  modifiedTime: d.Modified_Time || "",
                  layoutName: d.Layout?.name || d.$layout?.name || "",
                  layoutId: d.Layout?.id || d.$layout?.id || "",
                  title: d.Designation || d.Title || "",
                  leadType: d.Lead_Type || "",
                  country: d.Country || "",
                  industry: d.Industry || "",
                  website: d.Website || "",
                };
              case "deal":
                return {
                  companyName: d.Account_Name?.name || d.Deal_Name || "Unknown",
                  email: d.Contact_Email || "",
                  phone: d.Contact_Phone || "",
                  recordName: d.Deal_Name || "Unknown Deal",
                  domain: extractDomain(d.Contact_Email || ""),
                  ownerName: d.Owner?.name || "Unknown",
                  ownerEmail: d.Owner?.email || "",
                  status: "",
                  stage: d.Stage || "",
                  dealValue: parseFloat(d.Amount) || 0,
                  source: d.Lead_Source || "",
                  createdTime: d.Created_Time || "",
                  modifiedTime: d.Modified_Time || "",
                  layoutName: d.Layout?.name || d.$layout?.name || "",
                  layoutId: d.Layout?.id || d.$layout?.id || "",
                  pipeline: d.Pipeline || "",
                  products: d.Product_Details
                    ? JSON.stringify(d.Product_Details)
                    : "",
                  contactName: d.Contact_Name?.name || "",
                  accountName: d.Account_Name?.name || "",
                };
              case "contact":
                return {
                  companyName:
                    d.Account_Name?.name ||
                    d.Company ||
                    d.Last_Name ||
                    "Unknown",
                  email: d.Email || "",
                  phone: d.Phone || "",
                  mobile: d.Mobile || "",
                  recordName:
                    d.Full_Name ||
                    `${d.First_Name || ""} ${d.Last_Name || ""}`.trim(),
                  domain: extractDomain(d.Email || ""),
                  ownerName: d.Owner?.name || "Unknown",
                  ownerEmail: d.Owner?.email || "",
                  status: "Contact",
                  source: d.Lead_Source || "",
                  createdTime: d.Created_Time || "",
                  modifiedTime: d.Modified_Time || "",
                  layoutName: d.Layout?.name || d.$layout?.name || "",
                  layoutId: d.Layout?.id || d.$layout?.id || "",
                  title: d.Title || "",
                  accountName: d.Account_Name?.name || "",
                  country: d.Mailing_Country || d.Other_Country || "",
                };
              case "account": {
                const websiteRaw = d.Website || "";
                const websiteDomain =
                  websiteRaw.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] ||
                  "";
                return {
                  companyName: d.Account_Name || "Unknown",
                  email: d.Email || "",
                  phone: d.Phone || "",
                  recordName: d.Account_Name || "Unknown",
                  domain:
                    extractDomain(d.Email || "") ||
                    (websiteDomain && !websiteDomain.includes(" ")
                      ? websiteDomain
                      : null),
                  ownerName: d.Owner?.name || "Unknown",
                  ownerEmail: d.Owner?.email || "",
                  status: "Account",
                  source: "Account",
                  createdTime: d.Created_Time || "",
                  modifiedTime: d.Modified_Time || "",
                  layoutName: d.Layout?.name || d.$layout?.name || "",
                  layoutId: d.Layout?.id || d.$layout?.id || "",
                  website: websiteRaw,
                  crNumber: d.CR_Number || d.Registration_Number || "",
                  vatNumber: d.VAT_Number || d.Tax_ID || "",
                  country: d.Billing_Country || d.Shipping_Country || "",
                  region: d.Billing_State || d.Shipping_State || "",
                  industry: d.Industry || "",
                  noOfEmployees: parseInt(d.Employees) || undefined,
                  accountType: d.Account_Type || "",
                };
              }
            }
          };

          const { pool } = await import("../../utils/database");
          const refreshed: string[] = [];
          const missing: string[] = [];
          const failed: { id: string; error: string }[] = [];

          for (const zohoId of zohoIds) {
            try {
              const live = await fetchZohoRecordById(cfg.zohoModule, zohoId);
              if (!live) {
                missing.push(zohoId);
                continue;
              }
              const existing = await pool.query(
                `SELECT cluster_id FROM duplicate_records WHERE zoho_record_id = $1 AND record_type = $2 LIMIT 1`,
                [zohoId, cfg.recordType],
              );
              const clusterId = existing.rows[0]?.cluster_id;
              if (!clusterId) {
                missing.push(zohoId);
                continue;
              }
              const e = extract(live);
              await upsertRecord({
                cluster_id: clusterId,
                record_type: cfg.recordType,
                zoho_record_id: live.id,
                record_name: e.recordName,
                company_name: e.companyName,
                email: e.email || undefined,
                domain: e.domain || undefined,
                phone: e.phone || undefined,
                mobile: e.mobile || undefined,
                owner_name: e.ownerName,
                owner_email: e.ownerEmail,
                status: e.status,
                stage: e.stage,
                deal_value: e.dealValue,
                source: e.source,
                created_date: e.createdTime
                  ? new Date(e.createdTime)
                  : new Date(),
                modified_date: e.modifiedTime
                  ? new Date(e.modifiedTime)
                  : new Date(),
                is_primary: false,
                confidence_score: 0,
                is_mock_data: false,
                raw_data: live.data,
                layout_name: e.layoutName,
                layout_id: e.layoutId,
                zoho_module: cfg.zohoModule,
                pipeline: e.pipeline,
                products: e.products,
                contact_name: e.contactName,
                account_name: e.accountName,
                cr_number: e.crNumber,
                vat_number: e.vatNumber,
                website: e.website,
                country: e.country,
                region: e.region,
                industry: e.industry,
                no_of_employees: e.noOfEmployees,
                title: e.title,
                lead_type: e.leadType,
                account_type: e.accountType,
              });
              refreshed.push(zohoId);
            } catch (err: any) {
              logger.warn(
                `⚠️ [Radar Refresh] Failed to refresh ${cfg.zohoModule} ${zohoId}: ${err?.message || err}`,
              );
              failed.push({ id: zohoId, error: String(err?.message || err) });
            }
          }

          logger.info(
            `🔄 [Radar Refresh] User ${user.email} refreshed ${refreshed.length}/${zohoIds.length} ${cfg.zohoModule} live from Zoho`,
          );
          return c.json({
            success: true,
            module: moduleRaw,
            requested: zohoIds.length,
            refreshed_count: refreshed.length,
            missing_count: missing.length,
            failed_count: failed.length,
            refreshed,
            missing,
            failed,
          });
        } catch (error: any) {
          logger.error("Error in /api/duplicates/refresh-records:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Account inference scan — walks every deal that lacks a real Account
    // and tries to infer one from its linked contact's email domain. See
    // src/utils/accountInference.ts for the walk + scoring.
    path: "/api/duplicates/account-hints/scan",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const { initDuplicateRadarTables } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          await initDuplicateRadarTables();
          const { scanDealsForAccountHints } = await import(
            "../../utils/accountInference"
          );
          const result = await scanDealsForAccountHints();
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running account-hints scan:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // List account inference hints. Query params:
    //   ?status=pending|dismissed|applied (default pending)
    //   ?limit=N (default 500, max 2000)
    path: "/api/duplicates/account-hints",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "500", 10);
          const segment = url.searchParams.get("segment") || undefined;

          const { listAccountInferenceHints } = await import(
            "../../utils/accountInference"
          );
          const result = await listAccountInferenceHints({ status, limit, segment });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error listing account-hints:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // AI-resolve a single Account-Hint: write the suggested Account_Name
    // directly onto the Zoho Deal record and mark the hint applied. Refuses
    // when confidence is below the threshold (default 70%); the operator
    // can still use the manual Applied / Dismiss buttons for low-signal
    // rows. DESTRUCTIVE (writes to Zoho) → requireAdminOrKey.
    //   POST /api/duplicates/account-hints/:id/resolve-with-ai
    //   Body: { minConfidence?: number }
    path: "/api/duplicates/account-hints/:id/resolve-with-ai",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid hint id" }, 400);
          let body: { minConfidence?: number } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const performedBy =
            (sessionUser as any)?.email ||
            (sessionUser as any)?.role ||
            "admin";
          const attribution = `GRQ Assistant (on behalf of ${performedBy})`;
          const { aiResolveAccountHint } = await import(
            "../../utils/accountInference"
          );
          const result = await aiResolveAccountHint(id, attribution, {
            minConfidence: Number.isFinite(body.minConfidence)
              ? Number(body.minConfidence)
              : undefined,
          });
          // Map domain-level "won't apply" cases to 200s (so the UI can
          // render the reason inline) and real failures to 500.
          if (!result.success && result.error) {
            return c.json({ ...result }, 500);
          }
          return c.json({ ...result });
        } catch (error: any) {
          logger.error("Error AI-resolving account-hint:", error);
          return c.json({ error: error?.message || String(error) }, 500);
        }
      };
    },
  },
  {
    // Bulk AI-resolve every pending Account Hint at-or-above the confidence
    // threshold. Same per-row logic as the single-id endpoint above, but
    // looped — useful when the user has hundreds of high-confidence hints
    // pending. DESTRUCTIVE (writes to Zoho) → requireAdminOrKey.
    //   POST /api/duplicates/account-hints/resolve-all-with-ai
    //   Body: { minConfidence?: number, limit?: number }
    path: "/api/duplicates/account-hints/resolve-all-with-ai",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          let body: { minConfidence?: number; limit?: number } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const performedBy =
            (sessionUser as any)?.email ||
            (sessionUser as any)?.role ||
            "admin";
          const attribution = `GRQ Assistant (on behalf of ${performedBy})`;
          const { aiResolveAllAccountHints } = await import(
            "../../utils/accountInference"
          );
          const report = await aiResolveAllAccountHints(attribution, {
            minConfidence: Number.isFinite(body.minConfidence)
              ? Number(body.minConfidence)
              : undefined,
            limit: Number.isFinite(body.limit)
              ? Number(body.limit)
              : undefined,
          });
          return c.json({ success: true, ...report });
        } catch (error: any) {
          logger.error("Error bulk AI-resolving account-hints:", error);
          return c.json({ error: error?.message || String(error) }, 500);
        }
      };
    },
  },
  {
    // Mark a hint as dismissed (sales reviewed and rejected) or applied
    // (sales fixed the Zoho Account_Name and the next sync will reclassify).
    // Body: { status: "dismissed" | "applied" }
    path: "/api/duplicates/account-hints/:id/status",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid hint id" }, 400);
          let body: { status?: string } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          if (body.status !== "dismissed" && body.status !== "applied") {
            return c.json(
              { error: 'status must be "dismissed" or "applied"' },
              400,
            );
          }
          const { setHintStatus } = await import(
            "../../utils/accountInference"
          );
          const ok = await setHintStatus(id, body.status);
          if (!ok) return c.json({ error: "Hint not found" }, 404);
          return c.json({ success: true });
        } catch (error: any) {
          logger.error("Error updating account-hint status:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Record-Link inference scan — walks every Contact missing an Account
    // and every Deal missing a Contact, and infers a link via shared
    // domain/company evidence. See src/utils/recordLinkHints.ts.
    path: "/api/duplicates/record-hints/scan",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const { scanRecordLinkHints } = await import(
            "../../utils/recordLinkHints"
          );
          const r = await scanRecordLinkHints();
          return c.json({ success: true, ...r });
        } catch (error: any) {
          logger.error("Error running record-hints scan:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // List record-link hints. Query params:
    //   ?type=contact_account|deal_contact (default both)
    // Record Hint section 4 — stalled/Unaccounted deals with a suggested
    // disposition (close vs re-engage) per company deal-picture. Read-only.
    //   GET /api/duplicates/record-hints/stale-deals?limit=N
    path: "/api/duplicates/record-hints/stale-deals",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const limit = Number(c.req.query("limit")) || undefined;
        const segment = c.req.query("segment") || undefined;
        // view: 'open' (default) = stalled deals still needing a decision;
        // 'closed' | 'reengaged' | 'resolved' | 'dismissed' | 'handled' = the
        // deals the operator already actioned, so they can review "how many
        // closed / resolved" (Sample User 2026-07-16).
        const view = (c.req.query("view") || "open").trim().toLowerCase();
        const { scanStaleDeals, listHandledStaleDeals } = await import(
          "../../utils/recordLinkHints"
        );
        const { classifyLayoutSegment } = await import(
          "../../utils/duplicateRadarDatabase"
        );
        const wantSeg =
          segment && segment !== "all"
            ? segment === "corporate"
              ? "ExampleOrg"
              : segment
            : null;
        const bySegment = (arr: any[]) =>
          wantSeg
            ? arr.filter(
                (d) => classifyLayoutSegment(String(d.layout || "")) === wantSeg,
              )
            : arr;

        if (view === "open") {
          let deals = bySegment(await scanStaleDeals({ limit }));
          const summary = {
            total: deals.length,
            close: deals.filter((d) => d.disposition === "close").length,
            reengage: deals.filter((d) => d.disposition === "reengage").length,
            review: deals.filter((d) => d.disposition === "review").length,
          };
          // Handled-bucket counts so the Closed/Resolved/… tabs show a number.
          const { counts } = await listHandledStaleDeals({
            disposition: "all",
            limit: 1,
          });
          return c.json({
            success: true,
            view: "open",
            deals,
            summary,
            dispositionCounts: counts,
          });
        }

        // Handled views.
        const disp = ["closed", "reengaged", "resolved", "dismissed"].includes(
          view,
        )
          ? view
          : "all";
        const handled = await listHandledStaleDeals({ disposition: disp, limit });
        const deals = bySegment(handled.deals);
        return c.json({
          success: true,
          view,
          deals,
          summary: { total: deals.length },
          dispositionCounts: handled.counts,
        });
      } catch (e: any) {
        logger.error("record-hints/stale-deals failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // HITL apply for a stalled deal — close (Stage=Closed Lost) or reengage
    // (Stage forward). Admin-gated Zoho write; never deletes.
    //   POST /api/duplicates/record-hints/stale-deals/apply { dealZohoId, action }
    path: "/api/duplicates/record-hints/stale-deals/apply",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const dealZohoId = String(body?.dealZohoId ?? "").trim();
        const action =
          body?.action === "close" ? "close" : body?.action === "reengage" ? "reengage" : null;
        if (!dealZohoId || !action) {
          return c.json({ error: "dealZohoId and action (close|reengage) required" }, 400);
        }
        const { applyStaleDealDisposition } = await import("../../utils/recordLinkHints");
        const r = await applyStaleDealDisposition(dealZohoId, action, su.email || "admin");
        return c.json({ success: r.applied, ...r });
      } catch (e: any) {
        logger.error("record-hints/stale-deals/apply failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    //   POST /api/duplicates/record-hints/stale-deals/dismiss { dealZohoId }
    //   Operator ✗ "wrong / not stale" — hides the deal from §4. No Zoho write.
    path: "/api/duplicates/record-hints/stale-deals/dismiss",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const dealZohoId = String(body?.dealZohoId ?? "").trim();
        if (!dealZohoId) return c.json({ error: "dealZohoId required" }, 400);
        const { dismissStaleDeal } = await import("../../utils/recordLinkHints");
        const r = await dismissStaleDeal(dealZohoId, su.email || "admin");
        return c.json({ success: r.dismissed, ...r });
      } catch (e: any) {
        logger.error("record-hints/stale-deals/dismiss failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    //   POST /api/duplicates/record-hints/stale-deals/resolve { dealZohoId }
    //   Operator ✓ "Resolved — I already handled this deal MANUALLY in Zoho".
    //   Records it as resolved (not dismissed) and drops it off §4. No Zoho write.
    path: "/api/duplicates/record-hints/stale-deals/resolve",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const dealZohoId = String(body?.dealZohoId ?? "").trim();
        if (!dealZohoId) return c.json({ error: "dealZohoId required" }, 400);
        const { resolveStaleDeal } = await import("../../utils/recordLinkHints");
        const r = await resolveStaleDeal(dealZohoId, su.email || "admin");
        return c.json({ success: r.dismissed, ...r });
      } catch (e: any) {
        logger.error("record-hints/stale-deals/resolve failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    //   POST /api/duplicates/record-hints/stale-deals/reopen { dealZohoId }
    //   Un-handle: bring a Closed/Resolved/Dismissed deal back to the Open list.
    path: "/api/duplicates/record-hints/stale-deals/reopen",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const dealZohoId = String(body?.dealZohoId ?? "").trim();
        if (!dealZohoId) return c.json({ error: "dealZohoId required" }, 400);
        const { reopenStaleDeal } = await import("../../utils/recordLinkHints");
        const r = await reopenStaleDeal(dealZohoId);
        return c.json({ success: r.reopened, ...r });
      } catch (e: any) {
        logger.error("record-hints/stale-deals/reopen failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    //   ?status=pending|dismissed|applied (default pending)
    //   ?limit=N (default 500, max 2000)
    path: "/api/duplicates/record-hints",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const type = c.req.query("type") || undefined;
          const status = c.req.query("status") || undefined;
          const limitRaw = c.req.query("limit");
          const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
          const segment = c.req.query("segment") || undefined;

          const { listRecordLinkHints } = await import(
            "../../utils/recordLinkHints"
          );
          const result = await listRecordLinkHints({ type, status, limit, segment });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error listing record-hints:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // AI-resolve a single Record-Link-Hint: write the suggested target
    // directly onto the Zoho source record's link field and mark the hint
    // applied. Refuses when confidence is below the threshold (default
    // 70%). DESTRUCTIVE (writes to Zoho) → requireAdminOrKey.
    //   POST /api/duplicates/record-hints/:id/resolve-with-ai
    //   Body: { minConfidence?: number }
    path: "/api/duplicates/record-hints/:id/resolve-with-ai",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid hint id" }, 400);
          let body: { minConfidence?: number } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const { aiResolveRecordLinkHint } = await import(
            "../../utils/recordLinkHints"
          );
          const out = await aiResolveRecordLinkHint(
            Number(id),
            Number.isFinite(body.minConfidence)
              ? Number(body.minConfidence)
              : 70,
          );
          return c.json({ success: out.applied, ...out });
        } catch (error: any) {
          logger.error("Error AI-resolving record-hint:", error);
          return c.json({ error: error?.message || String(error) }, 500);
        }
      };
    },
  },
  {
    // Bulk AI-resolve every pending Record-Link Hint at-or-above the
    // confidence threshold. Same per-row logic as the single-id endpoint
    // above, but looped. DESTRUCTIVE (writes to Zoho) → requireAdminOrKey.
    //   POST /api/duplicates/record-hints/resolve-all-with-ai
    //   Body: { type?: "contact_account"|"deal_contact", minConfidence?: number, limit?: number }
    path: "/api/duplicates/record-hints/resolve-all-with-ai",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          let body: {
            type?: "contact_account" | "deal_contact";
            minConfidence?: number;
            limit?: number;
          } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const { aiResolveAllRecordLinkHints } = await import(
            "../../utils/recordLinkHints"
          );
          const report = await aiResolveAllRecordLinkHints({
            type: body.type,
            minConfidence: Number.isFinite(body.minConfidence)
              ? Number(body.minConfidence)
              : undefined,
            limit: Number.isFinite(body.limit) ? Number(body.limit) : undefined,
          });
          return c.json({ success: true, ...report });
        } catch (error: any) {
          logger.error("Error bulk AI-resolving record-hints:", error);
          return c.json({ error: error?.message || String(error) }, 500);
        }
      };
    },
  },
  {
    // Mark a record-link hint as dismissed (operator reviewed and rejected)
    // or applied (operator fixed the link manually in Zoho).
    // Body: { status: "dismissed" | "applied" }
    path: "/api/duplicates/record-hints/:id/status",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid hint id" }, 400);
          let body: { status?: string } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          if (body.status !== "dismissed" && body.status !== "applied") {
            return c.json({ error: "invalid status" }, 400);
          }
          const { pool } = await import("../../utils/duplicateRadarDatabase");
          await pool.query(
            `UPDATE record_link_hints
                SET status = $1,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $2`,
            [body.status, id],
          );
          return c.json({ success: true });
        } catch (error: any) {
          logger.error("Error updating record-hint status:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R5 — Single-record Preflight Webhook for inbound integrations.
    //
    // The existing /api/duplicates/preflight endpoint is built for
    // dashboard operators running batches. This one is the machine-to-
    // machine variant: one record in, one verdict + a should_create
    // boolean back. Zoho workflows, web-form backends, and marketing
    // tools call this BEFORE creating a record so genuine duplicates
    // never enter CRM in the first place (Plauti benchmark: real-time
    // prevention cuts duplicate creation 60% within 90 days).
    //
    // Auth: requireAdminOrKey — accepts an `x-admin-key` header so
    // external systems can call it without a session cookie.
    //
    // Body shape (at least one of domain / email / company_name / phone required):
    //   {
    //     "domain": "<REDACTED_HOST>",                     // optional
    //     "email":  "user@example.invalid",                // optional (domain extracted)
    //     "company_name": "ACME Co",                 // optional
    //     "phone": "<REDACTED_PHONE>",                  // optional
    //     "ref":   "web-form-submission-12345"       // optional, echoed back
    //   }
    //
    // Response shape:
    //   {
    //     "success": true,
    //     "verdict": "block" | "review" | "warn" | "duplicate" | "pass",
    //     "should_create": true | false,            // simple yes/no for callers
    //     "ref": "web-form-submission-12345",
    //     "reason": "active_cs_customer",
    //     "suggested_action": "...",
    //     "cluster_id": 42 | null,
    //     "lifecycle_state": "adoption" | null,
    //     "sector": "private" | "government" | null,
    //     "owners": ["Ali Alhumoud"],
    //     "arr_exposure": 50000 | null
    //   }
    //
    // Reuses runPreflight() under the hood so the verdict logic stays
    // identical to the dashboard's Preflight tab — operators and
    // webhook callers always see the same answer for the same input.
    path: "/api/duplicates/preflight/check",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireAdminOrKey(c);
          if (!user) return unauthorizedResponse(c);

          let body: any = {};
          try {
            body = (await c.req.json()) ?? {};
          } catch {
            return c.json(
              {
                success: false,
                error:
                  "Body must be JSON: { domain?, email?, company_name?, phone?, ref? }",
              },
              400,
            );
          }

          // At least one identifying signal must be present — otherwise
          // we'd return PASS for an effectively-empty payload, which
          // would be misleading to the caller.
          const hasIdentity =
            !!(body.domain && String(body.domain).trim()) ||
            !!(body.email && String(body.email).trim()) ||
            !!(body.company_name && String(body.company_name).trim()) ||
            !!(body.phone && String(body.phone).trim());
          if (!hasIdentity) {
            return c.json(
              {
                success: false,
                error:
                  "At least one of domain / email / company_name / phone must be provided",
              },
              400,
            );
          }

          const { runPreflight, shouldCreateForVerdict } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          const result = await runPreflight({
            rows: [
              {
                domain: body.domain ?? null,
                email: body.email ?? null,
                company_name: body.company_name ?? null,
                phone: body.phone ?? null,
                ref: body.ref ?? null,
              },
            ],
            // Webhook callers (Zoho workflows, intake forms) tend to fire
            // right when a record is being created — staleness matters.
            // Default to ON for the single-record webhook so the verdict
            // reflects the latest CS section. Caller can override with
            // refresh_overlap=false to skip the recompute.
            refresh_overlap: body.refresh_overlap !== false,
          });

          const row = result.rows[0];
          if (!row) {
            return c.json(
              {
                success: false,
                error: "Preflight returned no verdict (unexpected)",
              },
              500,
            );
          }

          return c.json({
            success: true,
            verdict: row.verdict,
            should_create: shouldCreateForVerdict(row.verdict),
            ref: row.ref ?? body.ref ?? null,
            reason: row.reason,
            suggested_action: row.suggested_action,
            cluster_id: row.cluster_id,
            lifecycle_state: row.lifecycle_state,
            sector: row.sector,
            owners: row.owners,
            arr_exposure: row.arr_exposure,
            matched_via: row.matched_via,
            module_counts: row.module_counts,
          });
        } catch (error: any) {
          logger.error("Error in preflight webhook:", error);
          return c.json(
            { success: false, error: "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    // Pre-import duplicate check for marketing batches (dashboard-facing).
    // Body: { rows: [{ domain?, email?, company_name?, phone?, ref? }, ...], max_check? }
    // Returns per-row verdict (block | review | warn | duplicate | pass) plus summary.
    // Parse an uploaded Excel (.xlsx) workbook on the operator's behalf
    // and return the rows in the same shape /api/duplicates/preflight
    // expects. Keeps the existing 'paste CSV/JSON' workflow intact —
    // this endpoint is just a convenience so ops can drag the source
    // file from their inbox/Drive instead of converting it by hand.
    //
    //   POST /api/duplicates/preflight/parse-excel
    //     multipart/form-data with one field 'file' (the .xlsx)
    //   Returns: { rows: [{ domain, company_name }], csv: "...", count: N }
    //
    // Header detection is case-insensitive and tolerates 'Domain' /
    // 'Company' / 'Company Name' / 'Email' (domain extracted from
    // email when no domain column is present). Empty rows are dropped.
    // First worksheet only; we don't infer across sheets.
    path: "/api/duplicates/preflight/parse-excel",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          // Accept either multipart upload or raw arrayBuffer body.
          let buffer: Buffer | null = null;
          let fileName = "upload.xlsx";
          const contentType = c.req.header("content-type") || "";
          if (contentType.startsWith("multipart/form-data")) {
            const form = await c.req.parseBody();
            const file = (form as any).file;
            if (!file || typeof file === "string") {
              return c.json(
                { error: "Send the workbook as a multipart 'file' field." },
                400,
              );
            }
            fileName = (file as any).name || fileName;
            const ab = await (file as any).arrayBuffer();
            buffer = Buffer.from(ab);
          } else {
            const ab = await c.req.arrayBuffer();
            buffer = Buffer.from(ab);
          }

          if (!buffer || buffer.length === 0) {
            return c.json({ error: "Empty upload." }, 400);
          }
          if (buffer.length > 10 * 1024 * 1024) {
            return c.json(
              { error: "Workbook too large — 10 MB cap." },
              413,
            );
          }

          // 2026-06-08 ROOT FIX — exceljs is a CommonJS module; dynamic
          // `await import("exceljs")` returns the ESM wrapper
          // `{ default: ... }`, so the constructor is at
          // .default.Workbook, NOT .Workbook directly. The old code hit
          // `new (ExcelJS as any).Workbook()` which was undefined →
          // TypeError: ExcelJS.Workbook is not a constructor (visible to
          // operators uploading a workbook on the preflight check page).
          // Same fix as documentTextExtractor.ts:219 which has been
          // working correctly.
          const ExcelJSMod: any = await import("exceljs");
          const ExcelJS = ExcelJSMod.default ?? ExcelJSMod;
          const wb = new ExcelJS.Workbook();
          try {
            await wb.xlsx.load(buffer);
          } catch (parseErr: any) {
            return c.json(
              {
                error:
                  "Could not parse as .xlsx — make sure the file isn't .xls / .csv / password-protected.",
                detail: parseErr?.message || String(parseErr),
              },
              400,
            );
          }

          const ws = wb.worksheets?.[0];
          if (!ws) {
            return c.json({ error: "Workbook has no worksheets." }, 400);
          }

          // Defensive coercion — exceljs cell values come in many shapes:
          //   - primitive (string / number / boolean / Date)
          //   - { text } for hyperlinks / shared strings
          //   - { richText: [{ text, font }, ...] } for formatted cells
          //   - { result, formula } for formula cells
          //   - { error } for #N/A / #REF! / etc.
          // The historic code called String(v) directly, which produced
          // "[object Object]" for the structured shapes and silently
          // poisoned header detection. cellToString below normalises every
          // shape into the plain-text the operator would see in Excel.
          function cellToString(v: any): string {
            if (v == null) return "";
            if (typeof v === "string") return v;
            if (typeof v === "number" || typeof v === "boolean") return String(v);
            if (v instanceof Date) return v.toISOString();
            if (typeof v === "object") {
              if (typeof v.text === "string") return v.text;
              if (Array.isArray(v.richText)) {
                return v.richText.map((p: any) => p?.text ?? "").join("");
              }
              if (v.result != null) return cellToString(v.result);
              if (v.error != null) return String(v.error);
              if (typeof v.hyperlink === "string") return v.hyperlink;
            }
            return String(v);
          }
          // Cap the iteration at a sane upper bound — exceljs sometimes
          // reports ws.rowCount = 1,048,576 (Excel's max) for files that
          // really only have 50 rows but carry stray formatting in the
          // empty range. Without the cap we'd burn minutes walking
          // millions of empty rows.
          const MAX_ROWS = 50000;
          const lastRow = Math.min(ws.rowCount || 0, MAX_ROWS);

          // Find header row — first non-empty row.
          let headerRowIdx = 1;
          for (let i = 1; i <= lastRow; i++) {
            const r = ws.getRow(i);
            const rv = r.values;
            if (Array.isArray(rv) && rv.some((v: any) => cellToString(v).trim() !== "")) {
              headerRowIdx = i;
              break;
            }
          }
          const headerRow = ws.getRow(headerRowIdx);
          const headers: string[] = [];
          const headerValues = headerRow.values as any[];
          // exceljs row.values is 1-indexed; index 0 is undefined
          for (let i = 1; i < headerValues.length; i++) {
            headers.push(cellToString(headerValues[i]).trim().toLowerCase());
          }

          function findCol(...needles: string[]): number {
            for (const n of needles) {
              const idx = headers.indexOf(n.toLowerCase());
              if (idx >= 0) return idx;
            }
            return -1;
          }
          const domainIdx = findCol("domain", "website", "url");
          const companyIdx = findCol("company_name", "company name", "company", "name", "account name");
          const emailIdx = findCol("email", "email_address", "email address");
          // NEW — capture the rich dedup signals for multi-signal matching
          // (Tier 1 #2 recommendation from the 2026-05-30 review). The
          // preflight engine already accepts these on PreflightInputRow;
          // wiring them in here means the engine can use email + phone
          // for cross-Zoho matching instead of falling back to domain-only.
          const mobileIdx = findCol("mobile_phone", "mobile phone", "mobile", "cell", "cell phone");
          const corporatePhoneIdx = findCol("corporate_phone", "corporate phone", "phone", "work phone", "office phone");
          // Secondary phone fields (Sample User 2026-07-23): Apollo/enrichment rows
          // often carry a foreign MOBILE but a Saudi number in "Second Phone" /
          // "Other Numbers". Preflight must consider ALL of them so a lead
          // reachable on a KSA number isn't wrongly dropped as out-of-scope.
          const secondPhoneIdx = findCol("second_phone", "second phone", "phone 2", "phone2", "alt phone", "alternate phone", "home phone", "home_phone");
          const otherNumbersIdx = findCol("other_numbers_1", "other numbers 1", "other numbers", "other number", "other phone", "additional phone");
          // Contact (person) name — used to REJECT a named contact that has no
          // email AND no phone (can't be contacted, so don't import). Distinct
          // from company_name so company-only screening rows aren't rejected.
          const contactIdx = findCol(
            "contact_name", "contact name", "full_name", "full name", "fullname", "contact",
          );
          const firstNameIdx = findCol("first_name", "first name", "firstname");
          const lastNameIdx = findCol("last_name", "last name", "lastname");
          // Contact job title — carried through to the Zoho Contact/Lead
          // payload's Title field on push. Optional: a workbook without any
          // of these columns simply produces an empty title (no behavior
          // change for existing uploads).
          // Contact job title. First try exact aliases (English + Arabic), then
          // fall back to ANY header that contains a title-ish word — so a
          // non-standard Mawsool header ("Job Title (EN)", "Position / Role",
          // "المسمى الوظيفي", a trailing space, …) still maps instead of
          // silently dropping every title (which sent leads/contacts to Zoho
          // with a blank Title and made "Backfill Titles" find nothing).
          let titleIdx = findCol(
            "title", "job title", "job_title", "jobtitle", "designation", "position",
            "role", "job role", "job position", "job designation", "current title",
            "current position", "job", "المسمى الوظيفي", "المسمى", "الوظيفة", "المنصب",
          );
          if (titleIdx < 0) {
            for (let i = 0; i < headers.length; i++) {
              const h = headers[i];
              if (
                (/(^|[^a-z])(title|designation|position)([^a-z]|$)/.test(h) &&
                  !/lead\s*status|email|company|account|first|last|full\s*name/.test(h)) ||
                h.includes("المسمى") || h.includes("الوظيف") || h.includes("المنصب")
              ) { titleIdx = i; break; }
            }
          }

          if (domainIdx < 0 && emailIdx < 0) {
            return c.json(
              {
                error:
                  "Workbook is missing required column. Need at least one of: 'domain', 'website', 'url', or 'email'.",
                detected_headers: headers,
              },
              400,
            );
          }

          // Read data rows. Each row tracks both the parsed identifier set
          // (for preflight) and the FULL original row indexed by header
          // (so the UI can later export PASS rows back out with all 32+
          // original columns intact — that's the Tier 1 #3 workflow win).
          interface ParsedRow {
            domain: string;
            email: string;
            phone: string;
            company_name: string;
            contact_name: string;
            title: string;
            original_row: Record<string, any>;
            source_row_number: number;
          }
          const rows: ParsedRow[] = [];
          let skippedRows = 0;
          // KSA-preference phone selection + placeholder stripping (Sample User
          // 2026-07-23). Imported once (not per row).
          const { isKsaPhone, stripPlaceholder } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          for (let i = headerRowIdx + 1; i <= lastRow; i++) {
            try {
              const r = ws.getRow(i);
              const rv = r.values as any[];
              if (!rv || !Array.isArray(rv)) continue;
              // Skip empty rows
              const nonEmpty = rv.some((v: any) => cellToString(v).trim() !== "");
              if (!nonEmpty) continue;

              let domain = "";
              if (domainIdx >= 0) {
                domain = cellToString(rv[domainIdx + 1]).trim();
              }
              let email = "";
              if (emailIdx >= 0) {
                email = cellToString(rv[emailIdx + 1]).trim();
              }
              if (!domain && email) {
                const at = email.lastIndexOf("@");
                if (at > 0 && at < email.length - 1) domain = email.slice(at + 1);
              }
              // Strip leading https:// www. and trailing / from domain
              domain = domain
                .replace(/^https?:\/\//i, "")
                .replace(/^www\./i, "")
                .replace(/\/.*$/, "")
                .trim()
                .toLowerCase();

              let companyName = "Example Organization";
              if (companyIdx >= 0) {
                companyName = cellToString(rv[companyIdx + 1]).trim();
              }
              // Read EVERY phone field (strip Excel's leading text-marker
              // apostrophe). Apollo labels the value with its source, e.g.
              // "<REDACTED_PHONE>(work_hq)" — the label is stripped downstream by
              // normalizePhone/isKsaPhone (both digit-only), so it's harmless here.
              const readPhoneCell = (idx: number) =>
                idx >= 0 ? cellToString(rv[idx + 1]).replace(/^'/, "").trim() : "";
              const mobile = readPhoneCell(mobileIdx);
              const corporatePhone = readPhoneCell(corporatePhoneIdx);
              const secondPhone = readPhoneCell(secondPhoneIdx);
              const otherNumbers = readPhoneCell(otherNumbersIdx);
              // Choose the phone Preflight screens on: PREFER a Saudi (+966 / bare
              // local) number found in ANY field so a lead whose mobile is foreign
              // but whose Second/Other number is KSA stays in scope and is
              // contacted on the KSA number (Sample User 2026-07-23). If NO field holds
              // a KSA number, keep the first real number (foreign → the KSA gate
              // then rejects it as out of scope, which is correct). Placeholders
              // ("Not available (N/A)") fold to empty.
              const _pfClean = (s: string) =>
                stripPlaceholder(s).trim();
              const phoneCandidates = [mobile, corporatePhone, secondPhone, otherNumbers]
                .map(_pfClean)
                .filter(Boolean);
              const phone =
                phoneCandidates.find((p) => isKsaPhone(p)) ||
                phoneCandidates[0] ||
                "";

              let contactName = "Sample User";
              if (contactIdx >= 0) {
                contactName = cellToString(rv[contactIdx + 1]).trim();
              }
              if (!contactName && (firstNameIdx >= 0 || lastNameIdx >= 0)) {
                contactName = [
                  firstNameIdx >= 0 ? cellToString(rv[firstNameIdx + 1]).trim() : "",
                  lastNameIdx >= 0 ? cellToString(rv[lastNameIdx + 1]).trim() : "",
                ]
                  .filter(Boolean)
                  .join(" ")
                  .trim();
              }
              const title = titleIdx >= 0 ? cellToString(rv[titleIdx + 1]).trim() : "";

              // Keep a row that has ANY signal — a domain, an email, a phone, OR a
              // contact name. A NAMED contact with no email/phone used to be dropped
              // here (no domain) and vanish; now it flows through so preflight can
              // REJECT it (no way to contact them). Only a totally empty row drops.
              if (!domain && !email && !phone && !contactName) continue;

              // Reconstruct the full original row keyed by header so the
              // export step can write the operator's original columns back
              // out (including First Name, Title, Industry, Annual Revenue,
              // etc. that preflight itself ignores).
              const originalRow: Record<string, any> = {};
              const fullHeaderValues = headerRow.values as any[];
              for (let h = 1; h < fullHeaderValues.length; h++) {
                const headerLabel = cellToString(fullHeaderValues[h]) || `col_${h}`;
                originalRow[headerLabel] = cellToString(rv[h]);
              }

              rows.push({
                domain,
                email,
                phone,
                company_name: companyName,
                contact_name: contactName,
                title,
                original_row: originalRow,
                source_row_number: i,
              });
            } catch (rowErr: any) {
              // Don't let one corrupted row sink the whole upload —
              // log it server-side and keep scanning. The skipped count is
              // returned to the UI so the operator knows.
              skippedRows++;
              logger.warn("[preflight/parse-excel] skipped row", {
                row: i,
                error: rowErr instanceof Error ? rowErr.message : String(rowErr),
              });
            }
          }

          if (rows.length === 0) {
            return c.json(
              {
                error: "No rows with a domain/email found after the header.",
                detected_headers: headers,
                header_row: headerRowIdx,
              },
              400,
            );
          }

          // Within-file dedup detection (Tier 1 #1 recommendation). Same
          // domain appearing twice within an uploaded list is the most
          // common operator mistake when merging multiple lead sources —
          // catching it here saves Zoho cleanup later. Flag by domain
          // first (strongest signal), then by email as a separate axis
          // (catches "two contacts at the same company" which is
          // legitimate vs "same exact email twice" which is not).
          const seenDomain = new Map<string, number[]>();
          const seenEmail = new Map<string, number[]>();
          for (let idx = 0; idx < rows.length; idx++) {
            const r = rows[idx];
            if (r.domain) {
              const existing = seenDomain.get(r.domain) || [];
              existing.push(idx);
              seenDomain.set(r.domain, existing);
            }
            if (r.email) {
              const e = r.email.toLowerCase();
              const existing = seenEmail.get(e) || [];
              existing.push(idx);
              seenEmail.set(e, existing);
            }
          }
          const domainDuplicateGroups = Array.from(seenDomain.entries())
            .filter(([, indices]) => indices.length > 1)
            .map(([domain, indices]) => ({ domain, row_indices: indices, count: indices.length }));
          const emailDuplicateGroups = Array.from(seenEmail.entries())
            .filter(([, indices]) => indices.length > 1)
            .map(([email, indices]) => ({ email, row_indices: indices, count: indices.length }));
          const intraFileDuplicateRowCount =
            domainDuplicateGroups.reduce((acc, g) => acc + (g.count - 1), 0);

          // Build a CSV the operator can see / re-edit in the textarea.
          // Includes the dedup signals the engine can now use. Title MUST be
          // here — the frontend re-parses this CSV on Check, so a column left
          // out of the CSV is dropped even though we parsed it above (that's the
          // bug that pushed leads/contacts with a blank Title).
          const csvLines = ["domain,company_name,contact_name,title,email,phone"];
          for (const r of rows) {
            const quote = (s: string) =>
              s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
            csvLines.push(
              `${r.domain},${quote(r.company_name)},${quote(r.contact_name)},${quote(r.title)},${quote(r.email)},${quote(r.phone)}`,
            );
          }

          return c.json({
            success: true,
            count: rows.length,
            skipped_rows: skippedRows,
            // Strip the original_row from the rows that go to the preflight
            // engine (it doesn't need 32 columns of overhead). Keep
            // original_rows as a SEPARATE field, parallel-indexed, so the
            // UI can store them client-side for the export step later.
            rows: rows.map((r) => ({
              domain: r.domain,
              email: r.email,
              phone: r.phone,
              company_name: r.company_name,
              contact_name: r.contact_name,
              title: r.title,
            })),
            original_rows: rows.map((r) => r.original_row),
            source_row_numbers: rows.map((r) => r.source_row_number),
            csv: csvLines.join("\n"),
            file_name: fileName,
            detected_headers: headers,
            header_row: headerRowIdx,
            // Within-file dedup result. UI surfaces a "Internal duplicates"
            // badge so the operator sees the issue before clicking Check.
            intra_file_duplicates: {
              by_domain_groups: domainDuplicateGroups.length,
              by_domain_rows: intraFileDuplicateRowCount,
              by_email_groups: emailDuplicateGroups.length,
              groups: domainDuplicateGroups.slice(0, 20), // cap preview at 20 groups
            },
          });
        } catch (error: any) {
          // Surface the real reason instead of an opaque 500 — without this
          // the operator sees "internal error" and has no path forward. The
          // most common cases here are: an unsupported cell type (date/
          // hyperlink/formula error that exceljs can't coerce), an
          // unexpectedly-shaped row, a header containing non-string content,
          // or a worksheet with a wildly wrong rowCount (Excel sometimes
          // reports millions of empty rows). All three are fixable once the
          // operator knows what to look for.
          logger.error("Error parsing preflight Excel:", error);
          const errName = error instanceof Error ? error.name : "Error";
          const errMsg  = error instanceof Error ? error.message : String(error);
          const detail  = `${errName}: ${errMsg}`;
          return c.json(
            {
              error:
                "Failed to parse the workbook — " + detail +
                ". If the file opens cleanly in Excel, try re-saving it as " +
                "a fresh .xlsx (File → Save As → Excel Workbook) so any " +
                "legacy formatting metadata is dropped, then upload again.",
              detail,
              error_type: errName,
            },
            500,
          );
        }
      };
    },
  },
  {
    // LOST-DEAL RE-ENGAGEMENT (Sample User 2026-09-01). Upload a sheet of CLOSED-LOST
    // deals and get back exactly two verdicts per row — BLOCK (existing client /
    // inside cool-off / live open deal / protected / DOAM) or PASS (safe to
    // re-approach). Deliberately NOT the Mawsool ladder: these rows are already
    // CRM deals, so the contact-duplicate rule and the KSA-phone gate would
    // reject essentially every row and tell Sales nothing.
    path: "/api/duplicates/preflight/reengage-excel",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let buffer: Buffer | null = null;
          const contentType = c.req.header("content-type") || "";
          if (contentType.startsWith("multipart/form-data")) {
            const form = await c.req.parseBody();
            const file = (form as any).file;
            if (!file || typeof file === "string") {
              return c.json({ error: "Send the workbook as a multipart 'file' field." }, 400);
            }
            buffer = Buffer.from(await (file as any).arrayBuffer());
          } else {
            buffer = Buffer.from(await c.req.arrayBuffer());
          }
          if (!buffer || buffer.length === 0) return c.json({ error: "Empty upload." }, 400);
          if (buffer.length > 15 * 1024 * 1024) {
            return c.json({ error: "Workbook too large — 15 MB cap." }, 413);
          }

          // exceljs is CommonJS — the constructor sits on .default under a
          // dynamic import (same trap as parse-excel above).
          const ExcelJSMod: any = await import("exceljs");
          const ExcelJS = ExcelJSMod.default ?? ExcelJSMod;
          const wb = new ExcelJS.Workbook();
          try {
            await wb.xlsx.load(buffer);
          } catch (pe: any) {
            return c.json({ error: "Could not parse as .xlsx.", detail: pe?.message || String(pe) }, 400);
          }
          const ws = wb.worksheets[0];
          if (!ws) return c.json({ error: "No worksheet in the workbook." }, 400);

          // Header matching is normalised (lowercase, alphanumerics only) so
          // spacing / casing variants all land. The export carries "Company"
          // TWICE, so every header keeps a LIST of column indexes and the first
          // non-empty cell across them wins.
          const norm = (s: any) =>
            String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
          const cols: Record<string, number[]> = {};
          (ws.getRow(1).values as any[]).forEach((h: any, idx: number) => {
            const n = norm(h && (h as any).text ? (h as any).text : h);
            if (!n) return;
            (cols[n] = cols[n] || []).push(idx);
          });
          const pick = (row: any, ...names: string[]): string => {
            for (const nme of names) {
              for (const idx of cols[nme] || []) {
                const v = row.getCell(idx).value;
                if (v == null) continue;
                // A date cell comes back as a real Date — normalise it to ISO
                // here rather than letting String(Date) produce a locale string
                // downstream (that is what broke the lost-date cool-off).
                if (v instanceof Date) {
                  if (!isNaN(v.getTime())) return v.toISOString();
                  continue;
                }
                const s = String((v && (v as any).text) || v || "").trim();
                if (s) return s;
              }
            }
            return "";
          };
          if (!cols["recordid"] && !cols["companydomain"] && !cols["email"]) {
            return c.json(
              {
                error:
                  "Could not find the expected columns. The sheet needs at least a Record Id, Company Domain or Email column (Deal Name, Account Name, Company, Deal Owner, Closing Date and Closed Lost Reason are used when present).",
              },
              400,
            );
          }

          const inputRows: any[] = [];
          ws.eachRow((row: any, rowNum: number) => {
            if (rowNum === 1) return;
            const rec = {
              record_id: pick(row, "recordid", "dealid", "id"),
              deal_name: pick(row, "dealname"),
              company_name: pick(row, "accountname", "company", "companyname"),
              domain: pick(row, "companydomain", "domain", "website"),
              email: pick(row, "email", "businessemail1"),
              owner: pick(row, "dealowner", "owner"),
              closing_date: pick(row, "closingdate", "closedate", "lostdate"),
              lost_reason: pick(row, "closedlostreason", "lostreason", "reasonforloss"),
            };
            // Skip a fully blank row; keep anything with an identity to check.
            if (rec.record_id || rec.domain || rec.email || rec.company_name || rec.deal_name) {
              inputRows.push(rec);
            }
          });
          if (!inputRows.length) return c.json({ error: "No data rows found." }, 400);

          const { runLostDealReengagement } = await import(
            "../../utils/duplicateRadarReengage"
          );
          const result = await runLostDealReengagement({ rows: inputRows });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          logger.error("preflight/reengage-excel failed", e);
          const detail = e instanceof Error ? e.message : String(e || "unknown error");
          return c.json({ error: detail.slice(0, 400) }, 500);
        }
      };
    },
  },
  {
    // Populate the Layout picker on the "Push PASS rows to Zoho" modal.
    // Returns one entry per layout configured on the requested Zoho
    // module (default Leads). Admin-gated because it touches Zoho
    // credentials.
    path: "/api/duplicates/preflight/zoho-layouts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireAdminOrKey(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const module = (url.searchParams.get("module") || "Leads").trim();
          const { fetchZohoLayouts } = await import("../../utils/zohoCRM");
          const layouts = await fetchZohoLayouts(module);
          return c.json({ success: true, module, layouts });
        } catch (error: any) {
          logger.error("Error fetching Zoho layouts:", error);
          return c.json(
            { error: "Failed to fetch Zoho layouts — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    // Populate the Owner picker on the Push-to-Zoho modal.
    path: "/api/duplicates/preflight/zoho-users",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireAdminOrKey(c);
          if (!user) return unauthorizedResponse(c);
          const { fetchZohoUsers } = await import("../../utils/zohoCRM");
          const users = await fetchZohoUsers("ActiveUsers");
          // Return only the operator-relevant fields, sorted by name.
          const trimmed = users
            .map((u) => ({
              id: u.id,
              name: u.full_name,
              email: u.email,
              role: u.role,
            }))
            .sort((a, b) =>
              (a.name || "").localeCompare(b.name || ""),
            );
          return c.json({ success: true, users: trimmed });
        } catch (error: any) {
          logger.error("Error fetching Zoho users:", error);
          return c.json(
            { error: "Failed to fetch Zoho users — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    // Push the PASS rows from a Preflight run into Zoho as new Leads.
    // Admin-gated (HIGH risk write — creates records in production CRM).
    //
    // Body:
    //   {
    //     rows: PreflightResultRow[]  // typically the verdict='pass' subset
    //     layout_id: string            // required — Zoho Layout to land on
    //     owner_mode: 'self' | 'round_robin' | 'custom'
    //     owner_id?: string            // required when owner_mode='custom'
    //     round_robin_user_ids?: string[]  // required when owner_mode='round_robin'
    //     source: string               // stamped on every Lead's Lead_Source
    //     dry_run?: boolean            // default TRUE — caller must pass false to actually write
    //     max_batch?: number           // hard cap, default 5000
    //   }
    //
    // Server-side defense in depth:
    //   - Only rows with verdict='pass' are pushed (block/review/warn/
    //     duplicate are dropped with an explanatory outcome).
    //   - At least one of (domain, email, company_name) must be present
    //     per row, or it's dropped.
    //   - Hard cap at max_batch — refuses a load larger than the cap.
    //   - Source string is stamped onto Lead_Source so an auditor can
    //     find every record this push created.
    //   - Audit row written to event_logs with the count + layout +
    //     source + dry_run flag.
    path: "/api/duplicates/preflight/push-to-zoho",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const allRows: any[] = Array.isArray(body?.rows) ? body.rows : [];
          if (allRows.length === 0) {
            return c.json({ error: "rows array required" }, 400);
          }
          const layoutId = String(body?.layout_id || "").trim();
          if (!layoutId) {
            return c.json({ error: "layout_id is required" }, 400);
          }
          const ownerMode = String(body?.owner_mode || "self").trim();
          const ownerId = body?.owner_id ? String(body.owner_id).trim() : null;
          const roundRobinIds: string[] = Array.isArray(body?.round_robin_user_ids)
            ? body.round_robin_user_ids.map((x: any) => String(x).trim()).filter(Boolean)
            : [];
          if (ownerMode === "custom" && !ownerId) {
            return c.json(
              { error: "owner_id required when owner_mode='custom'" },
              400,
            );
          }
          if (ownerMode === "round_robin" && roundRobinIds.length === 0) {
            return c.json(
              { error: "round_robin_user_ids required when owner_mode='round_robin'" },
              400,
            );
          }
          const source = (
            body?.source || `Preflight Push — ${new Date().toISOString().slice(0, 10)}`
          ).toString().trim();
          const dryRun = body?.dry_run !== false;
          const MAX_BATCH_HARD = 5000;
          const maxBatch =
            typeof body?.max_batch === "number" && body.max_batch > 0
              ? Math.min(MAX_BATCH_HARD, Math.floor(body.max_batch))
              : MAX_BATCH_HARD;

          // Defense in depth: drop any row that didn't get a PASS verdict.
          // Drop rows that lack ANY identifier the operator could push.
          const eligible: any[] = [];
          const dropped: Array<{ row_index: number; reason: string }> = [];
          for (const r of allRows) {
            if (r?.verdict && r.verdict !== "pass") {
              dropped.push({
                row_index: r.row_index ?? -1,
                reason: "not_pass_verdict",
              });
              continue;
            }
            const dom = (r?.input?.domain ?? r?.domain ?? "").toString().trim();
            const email = (r?.email ?? "").toString().trim();
            const company = (r?.input?.company_name ?? r?.company_name ?? "").toString().trim();
            if (!dom && !email && !company) {
              dropped.push({
                row_index: r.row_index ?? -1,
                reason: "no_identifier",
              });
              continue;
            }
            eligible.push(r);
          }

          if (eligible.length > maxBatch) {
            return c.json(
              {
                error: `Eligible rows (${eligible.length}) exceed max_batch (${maxBatch}). Split client-side.`,
                eligible_count: eligible.length,
              },
              400,
            );
          }

          // Build the Zoho Lead payloads.
          const { splitContactName, PREFLIGHT_LEAD_SOURCE, PREFLIGHT_LEAD_TAG } = await import(
            "../../utils/preflightStructuredPush"
          );
          const payloads: Array<Record<string, any>> = eligible.map((r, i) => {
            const dom = (r?.input?.domain ?? r?.domain ?? "").toString().trim() || null;
            const email = (r?.email ?? "").toString().trim() || null;
            const company = (r?.input?.company_name ?? r?.company_name ?? "").toString().trim() || null;
            const phone = (r?.phone ?? "").toString().trim() || null;
            const title = (r?.title ?? r?.input?.title ?? "").toString().trim() || null;
            const contactName = (r?.contact_name ?? r?.input?.contact_name ?? "").toString().trim();
            const _nm = splitContactName(contactName);
            const ownerForRow =
              ownerMode === "self"
                ? sessionUser?.email || null
                : ownerMode === "round_robin"
                  ? roundRobinIds[i % roundRobinIds.length]
                  : ownerId;
            const p: Record<string, any> = {
              Company: company || dom || "(unknown)",
              Last_Name: _nm.last || company || dom || "(unknown)",
              ...(_nm.first ? { First_Name: _nm.first } : {}),
              Lead_Source: PREFLIGHT_LEAD_SOURCE,
              Description: `Imported via QMS Preflight Push — ${new Date().toISOString()}. Operator: ${sessionUser?.email || "unknown"}.`,
              Layout: { id: layoutId },
            };
            if (email) p.Email = email;
            if (phone) p.Phone = phone;
            if (title) p.Title = title;
            if (dom) p.Website = dom.startsWith("http") ? dom : `<REDACTED_URL>`;
            if (ownerForRow && ownerMode !== "self") {
              p.Owner = { id: ownerForRow };
            }
            return p;
          });

          if (dryRun) {
            // No Zoho calls. Return what WOULD happen.
            return c.json({
              success: true,
              dry_run: true,
              eligible_count: eligible.length,
              dropped_count: dropped.length,
              dropped_sample: dropped.slice(0, 10),
              would_create_count: payloads.length,
              sample_payload: payloads[0] || null,
              source,
              layout_id: layoutId,
              owner_mode: ownerMode,
            });
          }

          const { createZohoRecordsBulk, addZohoTags } = await import(
            "../../utils/zohoCRM"
          );
          const outcomes = await createZohoRecordsBulk("Leads", payloads);
          const created = outcomes.filter((o) => o.status === "success").length;
          const failed = outcomes.filter((o) => o.status === "error").length;
          // Tag the created Leads (best-effort — never fails the push).
          try {
            const leadIds = outcomes
              .filter((o) => o.status === "success" && o.id)
              .map((o) => String(o.id));
            if (leadIds.length && PREFLIGHT_LEAD_TAG) {
              await addZohoTags("Leads", leadIds, [PREFLIGHT_LEAD_TAG]);
            }
          } catch (_) {
            /* tagging is non-fatal */
          }

          // Audit log — every push gets one row in event_logs.
          try {
            const { logEvent } = await import(
              "../../utils/eventLogsDatabase"
            );
            await logEvent({
              userId: sessionUser?.userId ?? 0,
              userEmail: sessionUser?.email ?? "system",
              userRole: sessionUser?.role,
              actionType: "PUSH_TO_ZOHO",
              entityType: "Leads",
              entityId: layoutId,
              entityName: source,
              description: `Preflight Push: created ${created} of ${payloads.length} Leads (${failed} failed) into Layout ${layoutId}, source "${source}", owner_mode=${ownerMode}.`,
              aiInvolved: false,
              severity: failed > 0 ? "WARNING" : "INFO",
              module: "duplicate-radar",
            });
          } catch {
            /* non-fatal */
          }

          return c.json({
            success: true,
            dry_run: false,
            eligible_count: eligible.length,
            dropped_count: dropped.length,
            attempted: payloads.length,
            created,
            failed,
            outcomes_sample: outcomes.slice(0, 20),
            source,
            layout_id: layoutId,
            owner_mode: ownerMode,
          });
        } catch (error: any) {
          logger.error("Error in preflight push-to-zoho:", error);
          return c.json(
            { error: "Push to Zoho failed — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    // Structured push to Zoho — four actions (re-engage, multi-contact,
    // new-company Account→Contact→Deal, Leads). Dry-run by default.
    // Action 1: Push a Deal under an existing Account (churned-past-cool-off).
    // Action 2: Create Account + all contacts + one Deal (multi-contact new).
    // Action 3: Create Account + contact + Deal (single-contact new, first N).
    // Action 4: Create Leads for the remaining rows (after action 3's slice).
    // Body: { action:1|2|3|4, rows:SPRow[], count?, offset?, dry_run?,
    //         owner_mode?, owner_id?, round_robin_user_ids?, source? }
    path: "/api/duplicates/preflight/structured-push",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));

          const action = Number(body?.action) as 1 | 2 | 3 | 4;
          if (![1, 2, 3, 4].includes(action)) {
            return c.json({ error: "action must be 1, 2, 3, or 4" }, 400);
          }
          const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
          if (rows.length === 0) {
            return c.json({ error: "rows array required" }, 400);
          }

          const count =
            typeof body?.count === "number" && body.count >= 0
              ? Math.floor(body.count)
              : 0;
          const offset =
            typeof body?.offset === "number" && body.offset >= 0
              ? Math.floor(body.offset)
              : 0;
          // Head-of-sales leads↔deals split: % of new companies pushed as Deals
          // (the rest are parked as Leads). Omitted → 100 (every new company a
          // deal, back-compat). Clamped 0–100.
          const dealPercent =
            typeof body?.deal_percent === "number" && isFinite(body.deal_percent)
              ? Math.min(100, Math.max(0, Math.floor(body.deal_percent)))
              : 100;
          const dryRun = body?.dry_run !== false;
          // Deal-backfill mode (action 1 only): create the MISSING deals for
          // companies already pushed (accounts + contacts exist, only the deal
          // is missing). Lets rows that now read "duplicate" through, gated to
          // those that resolve to an existing account. See buildStructuredPushPlan.
          const dealBackfill = body?.deal_backfill === true && action === 1;

          const ownerMode = String(body?.owner_mode || "self").trim();
          const ownerId = body?.owner_id ? String(body.owner_id).trim() : null;
          const roundRobinIds: string[] = Array.isArray(body?.round_robin_user_ids)
            ? body.round_robin_user_ids.map((x: any) => String(x).trim()).filter(Boolean)
            : [];
          if (ownerMode === "custom" && !ownerId) {
            return c.json(
              { error: "owner_id required when owner_mode='custom'" },
              400,
            );
          }
          if (ownerMode === "round_robin" && roundRobinIds.length === 0) {
            return c.json(
              { error: "round_robin_user_ids required when owner_mode='round_robin'" },
              400,
            );
          }
          const source = (
            body?.source ||
            `Preflight Structured Push — ${new Date().toISOString().slice(0, 10)}`
          ).toString().trim();

          // Map raw body rows to SPRow shape.
          const { buildStructuredPushPlan, PREFLIGHT_DEAL_TARGET, PREFLIGHT_LEAD_TARGET, PREFLIGHT_LEAD_SOURCE, PREFLIGHT_LEAD_TAG, PREFLIGHT_DEAL_TAG, PREFLIGHT_PRODUCT, PREFLIGHT_EMPLOYEES, PREFLIGHT_SALESPERSON_EMAIL, PREFLIGHT_GOV_TYPE, PREFLIGHT_CS_MEMBER_EMAIL, splitContactName, websiteFromDomain } =
            await import("../../utils/preflightStructuredPush");
          const PRODUCTS_FIELD = PREFLIGHT_PRODUCT ? [PREFLIGHT_PRODUCT] : null;

          // Resolve the default Sales Person AND CS Member (both Zoho USER lookup
          // fields) by email once, so Deals carry valid user references. Null if
          // not found → the field is simply omitted (CS_Member is not mandatory;
          // sending the old string "ExampleOrg" was rejected as INVALID_DATA).
          let salesPersonId: string | null = null;
          let csMemberId: string | null = null;
          if (!dryRun && action !== 4) {
            // HARDCODED ids take priority and BYPASS the Users API entirely.
            // CS_Member is a REQUIRED user-lookup on the Deal layout and Zoho's
            // create API accepts ONLY { id }. Resolving an email→id needs the
            // Zoho Users API — but this org's CRM token is missing the users-read
            // scope (the SAME failure that breaks "Check required fields"), so
            // fetchZohoUsers THROWS, CS_Member is left empty, and every deal
            // rejects with MANDATORY_NOT_FOUND CS_Member. Set the env secret
            // PREFLIGHT_CS_MEMBER_ID (a Zoho user id — Setup → Users → open the
            // user → the number in the URL) to fill it without the Users API.
            const envCsId = String(process.env.PREFLIGHT_CS_MEMBER_ID || "").trim();
            const envSpId = String(process.env.PREFLIGHT_SALESPERSON_ID || "").trim();
            if (envCsId) csMemberId = envCsId;
            if (envSpId) salesPersonId = envSpId;
            if (!csMemberId || !salesPersonId) {
              try {
                const { fetchZohoUsers } = await import("../../utils/zohoCRM");
                const users = await fetchZohoUsers("ActiveUsers");
                const findUserId = (email: string): string | null => {
                  const m = users.find(u => String(u.email || "").toLowerCase() === email.toLowerCase());
                  return m?.id ? String(m.id) : null;
                };
                if (!salesPersonId && PREFLIGHT_SALESPERSON_EMAIL) salesPersonId = findUserId(PREFLIGHT_SALESPERSON_EMAIL);
                if (!csMemberId && PREFLIGHT_CS_MEMBER_EMAIL) csMemberId = findUserId(PREFLIGHT_CS_MEMBER_EMAIL);
                // Fall back to the sales person, then to ANY active CRM user, so
                // the mandatory lookup always carries a real user id.
                if (!csMemberId) csMemberId = salesPersonId || (users[0]?.id ? String(users[0].id) : null);
                if (!salesPersonId) salesPersonId = csMemberId;
              } catch {
                // Users API blocked/failing — rely on the env ids above. If none
                // were set, CS_Member stays empty and the deal will reject; the
                // operator must set PREFLIGHT_CS_MEMBER_ID or make CS_Member
                // optional on the Deal layout.
              }
              if (!csMemberId) {
                logger.warn("[preflight push] CS_Member unresolved and PREFLIGHT_CS_MEMBER_ID not set — deals will reject (CS_Member is mandatory + Users API unavailable).");
              }
            }
          }

          const spRows = rows.map((r: any, idx: number) => ({
            row_index: typeof r.row_index === "number" ? r.row_index : idx,
            company: String(r.company ?? r.input?.company_name ?? r.company_name ?? ""),
            domain: String(r.domain ?? r.input?.domain ?? ""),
            email: String(r.email ?? ""),
            phone: String(r.phone ?? ""),
            contact_name: String(r.contact_name ?? r.input?.contact_name ?? ""),
            title: String(r.title ?? r.input?.title ?? ""),
            verdict: String(r.verdict ?? ""),
            cluster_id: r.cluster_id != null ? Number(r.cluster_id) : null,
            matched_account_zoho_id: (r.matched_account_zoho_id ?? r.input?.matched_account_zoho_id) != null
              ? String(r.matched_account_zoho_id ?? r.input?.matched_account_zoho_id)
              : null,
            matched_account_name: (r.matched_account_name ?? r.input?.matched_account_name) != null
              ? String(r.matched_account_name ?? r.input?.matched_account_name)
              : null,
            lifecycle_state: r.lifecycle_state != null ? String(r.lifecycle_state) : null,
          }));

          // Layer 1: resolve existing accounts (email domain → row domain →
          // name) BEFORE planning, so matched contacts route to A1 (link) and
          // are never rejected or duplicated as new accounts.
          const { rows: enrichedRows, possibleClientOf } = await enrichRowsWithExistingAccounts(spRows);
          const plan = buildStructuredPushPlan(action, enrichedRows, { count, offset, dealPercent, dealBackfill });

          // "Possible existing client" warning text for a lead/new-deal row that
          // FUZZY-matches an existing account (but wasn't exact enough to link).
          const POSSIBLE_CLIENT_NOTE = (name: string) =>
            `⚠ POSSIBLE EXISTING CLIENT — resembles existing account "${name}". Verify before contacting / creating a duplicate. `;
          // How many of THIS action's items fuzzy-match an existing account
          // (leads for A4, new-account companies for A2/A3). A1 already links.
          const possibleClientCount =
            action === 4
              ? plan.leads.filter(r => possibleClientOf(r)).length
              : action !== 1
                ? plan.companies.filter(co => possibleClientOf({ company: co.companyName, domain: co.domain, email: co.contacts[0]?.email })).length
                : 0;
          const DEAL = PREFLIGHT_DEAL_TARGET;
          const LEAD = PREFLIGHT_LEAD_TARGET;

          // Helper: resolve owner field for a given row index.
          function ownerForIndex(i: number): string | null {
            if (ownerMode === "self") return sessionUser?.email || null;
            if (ownerMode === "round_robin") return roundRobinIds[i % roundRobinIds.length];
            return ownerId;
          }

          // ----------------------------------------------------------------
          // DRY-RUN — no Zoho calls.
          // ----------------------------------------------------------------
          if (dryRun) {

            // Build sample payloads per action type.
            let samplePayload: Record<string, any> | null = null;
            let wouldAccounts = 0;
            let wouldContacts = 0;
            let wouldDeals = 0;
            let wouldLeads = 0;
            let a1SkippedNoAccount = 0;
            let a1LiveRejected = 0; // A1 matched account is a LIVE client (signed/paid) → REJECTED: no contact, no deal
            // Diagnostic: exact companies (1/2/3) the plan would push, so the
            // operator can eyeball the list before firing the real run.
            const a1ResolvedKeys = new Set<string>();

            if (action === 4) {
              wouldLeads = plan.leads.length;
              const r = plan.leads[0];
              if (r) {
                const web = websiteFromDomain(r.domain);
                const _nm = splitContactName(r.contact_name || r.company || r.domain);
                samplePayload = {
                  Last_Name: _nm.last || r.company || r.domain || "(unknown)",
                  ...(_nm.first ? { First_Name: _nm.first } : {}),
                  Company: r.company || r.domain || "(unknown)",
                  Lead_Source: PREFLIGHT_LEAD_SOURCE,
                  Layout: { id: LEAD.layoutId },
                  Lead_Status: LEAD.status,
                  ...(r.email ? { Email: r.email } : {}),
                  ...(r.phone ? { Phone: r.phone } : {}),
                  ...(r.title ? { Title: r.title } : {}),
                  ...(web ? { Website: web } : {}),
                  ...(PRODUCTS_FIELD ? { Products: PRODUCTS_FIELD } : {}),
                  No_of_Employees: PREFLIGHT_EMPLOYEES,
                };
              }
            } else if (action === 1) {
              // A1 re-engages under an EXISTING Account. Mirror the REAL run so
              // the preview's deal count is honest: resolve each company's
              // account, then run the SAME live-client check the push uses
              // (Step 1b). A LIVE client (existing signed/paid deal, not churned)
              // is REJECTED — no contact, no deal. Everything else (never-
              // converted OR churned-after-renewal) each gets a re-engagement
              // deal + its contacts, exactly like Step 3. The old preview only
              // credited a deal to `termination_old` rows, so it under-reported
              // deals for never-converted accounts (showed 0 when the real push
              // would create them).
              const {
                getAccountZohoIdByCluster: resolveAccForPreview,
                getAccountZohoIdByDomainOrName: resolveAccByDomainName,
              } = await import("../../utils/duplicateRadarDatabase");
              let sampleCo: (typeof plan.companies)[number] | null = null;
              let sampleAccId: string | null = null;
              // Pass 1: resolve the existing account for every A1 company.
              const resolvedA1: Array<{ co: (typeof plan.companies)[number]; accId: string }> = [];
              for (const co of plan.companies) {
                const matchedAcc = co.contacts.map(c => c.matched_account_zoho_id).find(Boolean) || null;
                const accId =
                  matchedAcc ??
                  (co.clusterId != null
                    ? await resolveAccForPreview(co.clusterId)
                    : null) ??
                  (await resolveAccByDomainName(co.domain, co.companyName));
                if (accId) resolvedA1.push({ co, accId });
                else a1SkippedNoAccount += 1;
              }
              // Pass 2: one batched live-client check (read-only) for the whole
              // preview — same call the real run makes in Step 1b.
              let a1LiveSet = new Set<string>();
              if (resolvedA1.length > 0) {
                try {
                  const { getLiveClientAccounts } = await import("../../utils/zohoCRM");
                  a1LiveSet = await getLiveClientAccounts(resolvedA1.map(x => x.accId));
                } catch { a1LiveSet = new Set(); }
              }
              for (const { co, accId } of resolvedA1) {
                if (a1LiveSet.has(accId)) {
                  a1LiveRejected += co.contacts.length; // live client → rejected, not pushed
                } else {
                  wouldDeals += 1;                       // never-converted / churned → new deal
                  wouldContacts += co.contacts.length;
                  a1ResolvedKeys.add(co.companyKey);
                  if (!sampleCo) {
                    sampleCo = co;
                    sampleAccId = accId;
                  }
                }
              }
              wouldAccounts = 0; // A1 never creates an account.
              if (sampleCo) {
                const primary = pickPrimaryContact(sampleCo.contacts);
                const _nm = splitContactName(sampleCo.contacts[0]?.contact_name || sampleCo.companyName);
                samplePayload = {
                  account: null,
                  contact: sampleCo.contacts[0] ? {
                    Last_Name: _nm.last || sampleCo.companyName,
                    ...(_nm.first ? { First_Name: _nm.first } : {}),
                    Lead_Source: PREFLIGHT_LEAD_SOURCE,
                    ...(sampleCo.contacts[0].email ? { Email: sampleCo.contacts[0].email } : {}),
                    ...(sampleCo.contacts[0].phone ? { Phone: sampleCo.contacts[0].phone } : {}),
                    ...(sampleCo.contacts[0].title ? { Title: sampleCo.contacts[0].title } : {}),
                    Account_Name: { id: sampleAccId },
                  } : null,
                  deal: {
                    Deal_Name: sampleCo.companyName,
                    Stage: DEAL.stage,
                    Pipeline: DEAL.pipeline,
                    Lead_Source: PREFLIGHT_LEAD_SOURCE,
                    Layout: { id: DEAL.layoutId },
                    Account_Name: { id: sampleAccId },
                    ...(PRODUCTS_FIELD ? { Products: PRODUCTS_FIELD } : {}),
                    No_of_Employees: PREFLIGHT_EMPLOYEES,
                    Sales_Person: { email: PREFLIGHT_SALESPERSON_EMAIL },
                    ...(PREFLIGHT_CS_MEMBER_EMAIL ? { CS_Member: { email: PREFLIGHT_CS_MEMBER_EMAIL } } : {}),
                    ...(PREFLIGHT_GOV_TYPE ? { Gov_Type: PREFLIGHT_GOV_TYPE } : {}),
                    Contact_Name: { id: "(would-be-created)" },
                    ...(sampleCo.contacts.length > 1
                      ? { Description: buildOtherContactsDescription(sampleCo.contacts, primary) }
                      : {}),
                  },
                };
              }
            } else {
              wouldAccounts = plan.companies.length;
              wouldContacts = plan.contact_count;
              wouldDeals = plan.companies.length;
              const co = plan.companies[0];
              if (co) {
                const web = websiteFromDomain(co.domain);
                const accountId = "(would-be-created)";
                const contactId = "(would-be-created)";
                const primary = pickPrimaryContact(co.contacts);
                const _nm = splitContactName(co.contacts[0]?.contact_name || co.companyName);
                samplePayload = {
                  account: {
                    Account_Name: co.companyName,
                    ...(web ? { Website: web } : {}),
                  },
                  contact: co.contacts[0] ? {
                    Last_Name: _nm.last || co.companyName,
                    ...(_nm.first ? { First_Name: _nm.first } : {}),
                    Lead_Source: PREFLIGHT_LEAD_SOURCE,
                    ...(co.contacts[0].email ? { Email: co.contacts[0].email } : {}),
                    ...(co.contacts[0].phone ? { Phone: co.contacts[0].phone } : {}),
                    ...(co.contacts[0].title ? { Title: co.contacts[0].title } : {}),
                    Account_Name: { id: accountId },
                  } : null,
                  deal: {
                    Deal_Name: co.companyName || co.domain || "(unknown)",
                    Stage: DEAL.stage,
                    Pipeline: DEAL.pipeline,
                    Lead_Source: PREFLIGHT_LEAD_SOURCE,
                    Layout: { id: DEAL.layoutId },
                    Account_Name: { id: accountId },
                    ...(PRODUCTS_FIELD ? { Products: PRODUCTS_FIELD } : {}),
                    No_of_Employees: PREFLIGHT_EMPLOYEES,
                    Sales_Person: { email: PREFLIGHT_SALESPERSON_EMAIL },
                    ...(PREFLIGHT_CS_MEMBER_EMAIL ? { CS_Member: { email: PREFLIGHT_CS_MEMBER_EMAIL } } : {}),
                    ...(PREFLIGHT_GOV_TYPE ? { Gov_Type: PREFLIGHT_GOV_TYPE } : {}),
                    Contact_Name: { id: contactId },
                    ...(co.contacts.length > 1
                      ? { Description: buildOtherContactsDescription(co.contacts, primary) }
                      : {}),
                  },
                };
              }
            }

            // Full, un-truncated list of exactly what this action would push,
            // so the operator can verify the count (e.g. "why 99?") by eye.
            const eligibleCompanies =
              action === 4
                ? []
                : plan.companies.map(co => ({
                    company: co.companyName,
                    domain: co.domain || null,
                    contacts: co.contacts.length,
                    contact_names: co.contacts.map(
                      cc => cc.contact_name || cc.email || cc.phone || "(no name)",
                    ),
                    ...(action === 1
                      ? { account_resolved: a1ResolvedKeys.has(co.companyKey) }
                      : {}),
                  }));
            const eligibleLeads =
              action === 4
                ? plan.leads.map(r => ({
                    name: r.contact_name || null,
                    company: r.company || r.domain || null,
                    email: r.email || null,
                    phone: r.phone || null,
                  }))
                : [];

            return c.json({
              success: true,
              dry_run: true,
              action,
              eligible_count: plan.eligible_count,
              contact_count: plan.contact_count,
              would: {
                accounts: wouldAccounts,
                contacts: wouldContacts,
                deals: wouldDeals,
                leads: wouldLeads,
              },
              sample_payload: samplePayload,
              eligible_companies: eligibleCompanies,
              eligible_leads: eligibleLeads,
              skipped_count: plan.skipped.length + a1SkippedNoAccount,
              no_matched_account_count: a1SkippedNoAccount,
              live_client_rejected_count: a1LiveRejected,
              possible_existing_client_count: possibleClientCount,
              <REDACTED_TOKEN>: plan.skipped.slice(0, 10),
            });
          }

          // ----------------------------------------------------------------
          // REAL RUN — ordered batched creates with id-mapping.
          // ----------------------------------------------------------------
          const { createZohoRecordsBulk, addZohoTags, addDealContactRoles } = await import("../../utils/zohoCRM");
          const { getAccountZohoIdByCluster, getAccountZohoIdByDomainOrName } =
            await import("../../utils/duplicateRadarDatabase");


          // Track counts
          const created = { accounts: 0, contacts: 0, deals: 0, leads: 0 };
          const failed = { accounts: 0, contacts: 0, deals: 0, leads: 0 };
          let existingContactsLinked = 0; // A1: contacts already in Zoho (reused, not duplicated)
          let reusedAccounts = 0; // accounts found live and reused instead of duplicated
          let existingDealsSkipped = 0; // deals that already exist under the account (idempotent retry)
          let dealsSkippedNoContact = 0; // company had no resolvable contact → can't set mandatory Contact_Name
          let dealsSkippedGoneAccount = 0; // account no longer exists in Zoho (merged/deleted) → skip, don't reject
          const dealSkips: Array<{ company: string; reason: string }> = []; // per-company "why no deal" for the UI
          let liveClientsRejected = 0; // A1 existing accounts with a signed/paid deal → REJECTED (live client, not pushed)
          let contactsExistingAsLead = 0; // contact rows that already exist as a Lead → REJECTED (already in CRM)
          let leadsSkippedExisting = 0; // leads already in Zoho (by email/phone) — skipped, not duplicated
          let outcomesSample: any[] = [];
          // Zoho per-record failure reasons (code + message) so the UI can show
          // WHY a create failed (required field, duplicate, invalid layout, …).
          const errorSamples: Array<{ stage: string; code?: string; message?: string; field?: string }> = [];
          const collectErrors = (stage: string, outs: any[]) => {
            for (const o of outs) {
              if (o?.status === "error" && errorSamples.length < 10) {
                // Zoho names the offending field in details.api_name (both
                // MANDATORY_NOT_FOUND and INVALID_DATA) — surface it so we know
                // exactly which field to add/fix.
                const field = o?.details?.api_name || o?.details?.expected_data_type || undefined;
                errorSamples.push({ stage, code: o.code, message: o.message, field });
              }
            }
          };

          if (action === 4) {
            // --- ACTION 4: create Leads only ---
            // Idempotent guard: skip prospects that already exist as a Lead by
            // EMAIL or PHONE (phone covers the phone-only leads Zoho's built-in
            // email-dup check can't catch). Runs BEFORE any create — email/phone
            // lookups THROW on a Zoho error, so a failure aborts with zero
            // written rather than duplicating. Intra-batch dedup too.
            const { findRecordIdsByEmails, findRecordIdsByPhones, normalizePhoneKey, searchZohoRecords } =
              await import("../../utils/zohoCRM");
            const leadEmails = plan.leads.map(r => String(r.email || "").trim()).filter(Boolean);
            const leadPhones = plan.leads.map(r => String(r.phone || "").trim()).filter(Boolean);
            const leadFoundEmail = await findRecordIdsByEmails("Leads", leadEmails);
            const leadFoundPhone = await findRecordIdsByPhones("Leads", leadPhones);

            // ONE LEAD PER COMPANY (Sample User 2026-07-05). Retried pushes duplicated
            // leads that have NO email AND NO phone (e.g. 7× "Ajialuna") because
            // email/phone were the ONLY dedup keys and those leads carry neither.
            // Collapse to a single lead per company: skip a company that already
            // has a Mawsool lead in Zoho, or that we already created earlier in
            // THIS batch. The existing-company check is best-effort (company
            // names with ( ) , can't go in a Zoho criteria, so they fall back to
            // the email/phone + in-batch checks).
            const existingLeadCompanies = new Set<string>();
            {
              const uniq = Array.from(new Set(plan.leads.map(r => String(r.company || "").trim()).filter(Boolean)));
              const safe = uniq.filter(nm => !/[(),]/.test(nm));
              const CHUNK = 8;
              for (let s = 0; s < safe.length; s += CHUNK) {
                const chunk = safe.slice(s, s + CHUNK);
                const criteria = "(" + chunk.map(nm => `(Company:equals:${nm})`).join("or") + `)and(Lead_Source:equals:${PREFLIGHT_LEAD_SOURCE})`;
                try {
                  const rows = await searchZohoRecords("Leads", criteria);
                  for (const row of rows) {
                    const k = normalizeCompanyName(String(row.data?.Company || ""));
                    if (k) existingLeadCompanies.add(k);
                  }
                } catch { /* best-effort — company dedup is a safety net over email/phone */ }
              }
            }

            const seenLeadEmail = new Set<string>();
            const seenLeadPhone = new Set<string>();
            const seenLeadCompany = new Set<string>();
            const freshLeads = plan.leads.filter((r) => {
              const em = String(r.email || "").trim().toLowerCase();
              const pk = normalizePhoneKey(r.phone);
              const ck = normalizeCompanyName(String(r.company || r.domain || ""));
              // Already in Zoho as a Lead → skip (idempotent retry). Match on
              // email, phone, OR company (one-lead-per-company).
              if ((em && leadFoundEmail.has(em)) || (pk && leadFoundPhone.has(pk)) || (ck && existingLeadCompanies.has(ck))) {
                leadsSkippedExisting++;
                return false;
              }
              // Duplicate within THIS batch → skip the second copy.
              if (em && seenLeadEmail.has(em)) { leadsSkippedExisting++; return false; }
              if (!em && pk && seenLeadPhone.has(pk)) { leadsSkippedExisting++; return false; }
              if (ck && seenLeadCompany.has(ck)) { leadsSkippedExisting++; return false; }
              if (em) seenLeadEmail.add(em);
              if (pk) seenLeadPhone.add(pk);
              if (ck) seenLeadCompany.add(ck);
              return true;
            });

            // "Make sure the company is not an existing client" — for leads that
            // carry a real company domain (email or row), live-check Zoho: drop
            // any whose domain belongs to a LIVE client (existing signed/paid,
            // not churned-after-renewal). Those are handled by CS, never
            // cold-contacted as a fresh lead. Bounded to this slice's domains.
            {
              const { findAccountIdsByDomains, getLiveClientAccounts } = await import("../../utils/zohoCRM");
              const { realDomainRoot } = await import("../../utils/preflightStructuredPush");
              const domOf = (r: any) => realDomainRoot(r.email) || realDomainRoot(r.domain);
              const domains = Array.from(new Set(freshLeads.map(domOf).filter(Boolean) as string[]));
              if (domains.length > 0) {
                const acctByDomain = await findAccountIdsByDomains(domains);
                const liveSet = await getLiveClientAccounts(Array.from(new Set(acctByDomain.values())));
                const liveDomains = new Set<string>();
                for (const [dom, accId] of acctByDomain) if (liveSet.has(accId)) liveDomains.add(dom);
                if (liveDomains.size > 0) {
                  const kept = freshLeads.filter((r: any) => {
                    const d = domOf(r);
                    if (d && liveDomains.has(d)) { liveClientsRejected++; return false; }
                    return true;
                  });
                  freshLeads.length = 0;
                  freshLeads.push(...kept);
                }
              }
            }
            const leadPayloads = freshLeads.map((r, i) => {
              const web = websiteFromDomain(r.domain);
              const company = r.company || r.domain || "(unknown)";
              // Sample User 2026-07-06 (REVERSES the 07-05 "name = company" rule): the
              // Lead NAME must be the CONTACT PERSON so SDRs can call the lead by
              // name. Last_Name/First_Name = the person; the company stays in the
              // Company field (Zoho shows "Person – Company" at the top). Only
              // when the row has no person name do we fall back to the company so
              // Last_Name (required) is never blank.
              const _nm = splitContactName(r.contact_name || company);
              const maybeClient = possibleClientOf(r);
              const p: Record<string, any> = {
                Last_Name: _nm.last || company,
                ...(_nm.first ? { First_Name: _nm.first } : {}),
                Company: company,
                Lead_Source: PREFLIGHT_LEAD_SOURCE,
                Layout: { id: LEAD.layoutId },
                Lead_Status: LEAD.status,
                Description: `${maybeClient ? POSSIBLE_CLIENT_NOTE(maybeClient.name) : ""}Imported via QMS Preflight Structured Push — ${new Date().toISOString()}. Operator: ${sessionUser?.email || "unknown"}.`,
              };
              if (r.email) p.Email = r.email;
              if (r.phone) p.Phone = r.phone;
              if (r.title) p.Title = r.title;
              if (web) p.Website = web;
              if (PRODUCTS_FIELD) p.Products = PRODUCTS_FIELD;
              p.No_of_Employees = PREFLIGHT_EMPLOYEES;
              const ownerVal = ownerForIndex(i);
              if (ownerVal && ownerMode !== "self") {
                p.Owner = { id: ownerVal };
              }
              return p;
            });

            const leadOut = leadPayloads.length > 0
              ? await createZohoRecordsBulk("Leads", leadPayloads)
              : [];
            created.leads = leadOut.filter(o => o.status === "success").length;
            failed.leads = leadOut.filter(o => o.status === "error").length;
            collectErrors("lead", leadOut);
            outcomesSample = leadOut.slice(0, 20);
            // Tag created Leads (best-effort).
            try {
              const leadIds = leadOut.filter(o => o.status === "success" && o.id).map(o => String(o.id));
              if (leadIds.length && PREFLIGHT_LEAD_TAG) await addZohoTags("Leads", leadIds, [PREFLIGHT_LEAD_TAG]);
            } catch (_) { /* tagging non-fatal */ }
          } else {
            // --- ACTIONS 1/2/3: Account → Contact → Deal ---

            // Step 0: Contact-path Leads guard. "Ignore anything already in the
            // CRM" — reject any contact row that already exists as a LEAD (by
            // email or phone), even one the preflight snapshot missed because it
            // was created after the last sync. Runs BEFORE account creation so a
            // company whose contacts are ALL already-leads is dropped entirely
            // (no orphan account/deal). Rows are recorded in skipped.
            {
              const { findRecordIdsByEmails, findRecordIdsByPhones, normalizePhoneKey } =
                await import("../../utils/zohoCRM");
              const allRows = plan.companies.flatMap(co => co.contacts);
              const emails = allRows.map(r => String(r.email || "").trim()).filter(Boolean);
              const phones = allRows.map(r => String(r.phone || "").trim()).filter(Boolean);
              if (emails.length > 0 || phones.length > 0) {
                const leadByEmail = await findRecordIdsByEmails("Leads", emails);
                const leadByPhone = await findRecordIdsByPhones("Leads", phones);
                const isExistingLead = (r: any) => {
                  const em = String(r.email || "").trim().toLowerCase();
                  const pk = normalizePhoneKey(r.phone);
                  return (!!em && leadByEmail.has(em)) || (!!pk && leadByPhone.has(pk));
                };
                const keptCompanies: typeof plan.companies = [];
                for (const co of plan.companies) {
                  const kept = co.contacts.filter((r: any) => {
                    if (isExistingLead(r)) {
                      contactsExistingAsLead++;
                      plan.skipped.push({ row_index: r.row_index, reason: "already_exists_as_lead" });
                      return false;
                    }
                    return true;
                  });
                  if (kept.length > 0) {
                    co.contacts = kept;
                    keptCompanies.push(co);
                  }
                }
                plan.companies = keptCompanies;
              }
            }

            // Step 1: Resolve existing account ids LIVE (idempotent) so a retry
            // NEVER creates a duplicate account. Truth order per company:
            //   explicit matched id (enrichment) → live domain → live exact name
            //   → (A1 only) cluster / synced-directory fallback.
            // A1 requires an existing account (skip if none). A2/A3 create ONLY
            // the accounts that genuinely don't exist yet; the rest are reused.
            const accountIdMap = new Map<string, string>();
            const companiesWithAccount: typeof plan.companies = [];
            const companiesSkippedNoAccount: typeof plan.companies = [];

            {
              const { findAccountIdsByDomains, findAccountIdsByNames } =
                await import("../../utils/zohoCRM");
              const { realDomainRoot } = await import("../../utils/preflightStructuredPush");
              const domainKey = (co: any) =>
                String(realDomainRoot(co.domain) || co.domain || "").trim().toLowerCase();
              const nameKey = (co: any) => String(co.companyName || "").trim().toLowerCase();

              // Two batched LIVE lookups for the whole slice (not the stale
              // synced snapshot — that's what let retries duplicate).
              const acctByDomain = await findAccountIdsByDomains(plan.companies.map(domainKey));
              const acctByName = await findAccountIdsByNames(plan.companies.map(co => co.companyName));

              const resolveLive = (co: any): string | null => {
                // LIVE ids FIRST. The enriched `matched_account_zoho_id` comes
                // from the synced account directory (getAccountDirectory) — a
                // SNAPSHOT that goes stale: when an account is merged or renamed
                // in Zoho its old id is deprecated, and writing { Account_Name:
                // { id: <deprecated> } } is rejected as INVALID_DATA (the exact
                // 47-contact failure we hit). A live domain / exact-name lookup
                // always returns the SURVIVING id. The stale local id is only a
                // last-resort fallback for an account a live search can't find
                // (no domain stored + name variance).
                const matchedAcc =
                  co.contacts.map((c: any) => c.matched_account_zoho_id).find(Boolean) || null;
                return acctByDomain.get(domainKey(co)) || acctByName.get(nameKey(co)) || matchedAcc || null;
              };

              if (action === 1) {
                for (const co of plan.companies) {
                  const existingId =
                    resolveLive(co) ??
                    (co.clusterId != null ? await getAccountZohoIdByCluster(co.clusterId) : null) ??
                    (await getAccountZohoIdByDomainOrName(co.domain, co.companyName));
                  if (!existingId) {
                    companiesSkippedNoAccount.push(co);
                  } else {
                    accountIdMap.set(co.companyKey, existingId);
                    companiesWithAccount.push(co);
                    reusedAccounts++;
                  }
                }
              } else {
                // A2/A3: reuse the account where it already exists; create only
                // the ones that don't. Reused-account companies still get their
                // contact + deal (the deal step gates churned only for A1).
                const toCreate: typeof plan.companies = [];
                for (const co of plan.companies) {
                  const existingId = resolveLive(co);
                  if (existingId) {
                    accountIdMap.set(co.companyKey, existingId);
                    companiesWithAccount.push(co);
                    reusedAccounts++;
                  } else {
                    toCreate.push(co);
                  }
                }
                if (toCreate.length > 0) {
                  const accountPayloads = toCreate.map((co) => {
                    const web = websiteFromDomain(co.domain);
                    // NOTE: no Layout — DEAL.layoutId is a DEALS-module layout,
                    // invalid on an Account create. Accounts use the default layout.
                    const p: Record<string, any> = { Account_Name: co.companyName };
                    if (web) p.Website = web;
                    return p;
                  });
                  const accOut = await createZohoRecordsBulk("Accounts", accountPayloads);
                  created.accounts = accOut.filter(o => o.status === "success").length;
                  failed.accounts = accOut.filter(o => o.status === "error").length;
                  collectErrors("account", accOut);
                  for (let i = 0; i < toCreate.length; i++) {
                    const co = toCreate[i];
                    const out = accOut[i];
                    if (out?.status === "success" && out.id) {
                      accountIdMap.set(co.companyKey, out.id);
                      companiesWithAccount.push(co);
                    } else {
                      companiesSkippedNoAccount.push(co);
                    }
                  }
                }
              }
            }

            // Step 1b: REJECT live clients (A1). An existing account is a LIVE
            // client when it has a customer deal (signed/paid or CS renewal/churn
            // data) that is NOT churned — churned only counts when the churn date
            // is the most recent event (churn set AND after the renewal date, or
            // no renewal). Live clients are rejected data (handled by CS, not
            // cold-contacted) → NOT pushed at all (no contact, no deal). A past
            // client (churned after renewal) or never-converted account is NOT
            // live → it flows through to get the re-engagement / new deal.
            // Checked live in Zoho. (A2/A3 open new accounts → nothing to check.)
            if (action === 1 && companiesWithAccount.length > 0) {
              const { getLiveClientAccounts } = await import("../../utils/zohoCRM");
              const liveSet = await getLiveClientAccounts(
                companiesWithAccount.map(co => accountIdMap.get(co.companyKey) || "").filter(Boolean),
              );
              if (liveSet.size > 0) {
                const keep: typeof companiesWithAccount = [];
                for (const co of companiesWithAccount) {
                  const accId = accountIdMap.get(co.companyKey) || "";
                  if (accId && liveSet.has(accId)) {
                    liveClientsRejected += co.contacts.length;
                    plan.skipped.push(
                      ...co.contacts.map(r => ({ row_index: r.row_index, reason: "live_client_active_deal" })),
                    );
                    accountIdMap.delete(co.companyKey);
                  } else {
                    keep.push(co);
                  }
                }
                companiesWithAccount.length = 0;
                companiesWithAccount.push(...keep);
              }
            }

            // Step 2: Create contacts for companies that have an account id.
            // Map companyKey → primary contact id (for deal linkage) — prefers
            // the created id of the first EMAIL-bearing contact row; falls
            // back to the first row's created id when no row has an email.
            const firstContactIdMap = new Map<string, string>();
            // Map companyKey → the row_index chosen as primary, so Step 3 can
            // build the "other contacts" Description from the remaining rows.
            const primaryRowIndexMap = new Map<string, number>();
            // Map companyKey → ALL created contact ids, so Step 3 can associate
            // every contact of a company to its Deal's Contact Roles.
            const contactIdsByCompany = new Map<string, string[]>();

            if (companiesWithAccount.length > 0) {
              // Check each contact's email against Zoho FIRST (ALL of A1/A2/A3)
              // so we never fail on a duplicate-email contact: an existing
              // contact is REUSED (its id links the Deal's Contact_Name) instead
              // of Zoho rejecting a duplicate and leaving the Deal with no
              // contact (MANDATORY_NOT_FOUND Contact_Name).
              const { normalizePhoneKey } = await import("../../utils/zohoCRM");
              const preexistingByRow = new Map<number, string>();
              {
                // Batched existence check by EMAIL and PHONE (OR-chunks). Both
                // THROW on a Zoho error — and this runs BEFORE any create, so a
                // failure aborts with zero records written instead of silently
                // treating everyone as new and duplicating existing contacts.
                // PHONE is the fix for phone-only contacts (no email), which the
                // email check can't see — the exact gap that duplicated the
                // Mawsool contacts on every retry.
                const { findContactIdsByEmails, findRecordIdsByPhones } =
                  await import("../../utils/zohoCRM");
                const emails = companiesWithAccount.flatMap(co =>
                  co.contacts.map(r => String(r.email || "").trim()).filter(Boolean),
                );
                const phones = companiesWithAccount.flatMap(co =>
                  co.contacts.map(r => String(r.phone || "").trim()).filter(Boolean),
                );
                const foundEmail = await findContactIdsByEmails(emails);
                const foundPhone = await findRecordIdsByPhones("Contacts", phones);
                for (const co of companiesWithAccount) {
                  for (const row of co.contacts) {
                    const em = String(row.email || "").trim().toLowerCase();
                    const pk = normalizePhoneKey(row.phone);
                    const id =
                      (em && foundEmail.get(em)) || (pk && foundPhone.get(pk)) || null;
                    if (id) preexistingByRow.set(row.row_index, id);
                  }
                }
              }

              // Build contact payloads (one per contact row, all companies interleaved).
              interface ContactMeta { companyKey: string; rowIndex: number; hasEmail: boolean }
              const contactMeta: ContactMeta[] = [];
              const contactPayloads: Record<string, any>[] = [];
              // Intra-batch dedup: an email/phone is created ONCE per push; later
              // rows sharing it reuse that created id (no duplicate within one push).
              const emailToPayloadIndex = new Map<string, number>();
              const phoneToPayloadIndex = new Map<string, number>();
              const deferredDupes: Array<{ companyKey: string; rowIndex: number; payloadIndex: number }> = [];

              for (const co of companiesWithAccount) {
                const accountId = accountIdMap.get(co.companyKey)!;
                for (const row of co.contacts) {
                  const em = String(row.email || "").trim().toLowerCase();
                  const pk = normalizePhoneKey(row.phone);
                  // Contact already in Zoho (by email or phone) → reuse it, don't
                  // create a duplicate. Register the existing id for deal linkage.
                  const existingId = preexistingByRow.get(row.row_index);
                  if (existingId) {
                    existingContactsLinked++;
                    const _cids = contactIdsByCompany.get(co.companyKey) || [];
                    _cids.push(existingId);
                    contactIdsByCompany.set(co.companyKey, _cids);
                    if (!firstContactIdMap.has(co.companyKey)) {
                      firstContactIdMap.set(co.companyKey, existingId);
                      primaryRowIndexMap.set(co.companyKey, row.row_index);
                    }
                    continue;
                  }
                  // Same email already queued for creation in THIS batch → reuse
                  // its created id afterwards instead of creating a second copy.
                  if (em && emailToPayloadIndex.has(em)) {
                    deferredDupes.push({ companyKey: co.companyKey, rowIndex: row.row_index, payloadIndex: emailToPayloadIndex.get(em)! });
                    continue;
                  }
                  // Phone-only row whose phone is already queued this batch → same.
                  if (!em && pk && phoneToPayloadIndex.has(pk)) {
                    deferredDupes.push({ companyKey: co.companyKey, rowIndex: row.row_index, payloadIndex: phoneToPayloadIndex.get(pk)! });
                    continue;
                  }
                  const _nm = splitContactName(row.contact_name || co.companyName);
                  const p: Record<string, any> = {
                    Last_Name: _nm.last || co.companyName,
                    ...(_nm.first ? { First_Name: _nm.first } : {}),
                    Lead_Source: PREFLIGHT_LEAD_SOURCE,
                    Account_Name: { id: accountId },
                  };
                  if (row.email) p.Email = row.email;
                  if (row.phone) p.Phone = row.phone;
                  if (row.title) p.Title = row.title;
                  const payloadIndex = contactPayloads.length;
                  contactPayloads.push(p);
                  contactMeta.push({ companyKey: co.companyKey, rowIndex: row.row_index, hasEmail: !!em });
                  if (em) emailToPayloadIndex.set(em, payloadIndex);
                  if (pk) phoneToPayloadIndex.set(pk, payloadIndex);
                }
              }

              const conOut = contactPayloads.length > 0
                ? await createZohoRecordsBulk("Contacts", contactPayloads)
                : [];
              created.contacts = conOut.filter(o => o.status === "success").length;
              failed.contacts = conOut.filter(o => o.status === "error").length;
              collectErrors("contact", conOut);

              // Primary contact per company: prefer the first successfully-created
              // row that HAS an email; fall back to the first successfully-created
              // row if no email-bearing contact was created for that company.
              const fallbackContactIdMap = new Map<string, string>();
              const fallbackRowIndexMap = new Map<string, number>();
              for (let i = 0; i < conOut.length; i++) {
                const out = conOut[i];
                if (out?.status === "success" && out.id) {
                  const meta = contactMeta[i];
                  const _cids = contactIdsByCompany.get(meta.companyKey) || [];
                  _cids.push(String(out.id));
                  contactIdsByCompany.set(meta.companyKey, _cids);
                  if (!fallbackContactIdMap.has(meta.companyKey)) {
                    fallbackContactIdMap.set(meta.companyKey, out.id);
                    fallbackRowIndexMap.set(meta.companyKey, meta.rowIndex);
                  }
                  if (meta.hasEmail && !firstContactIdMap.has(meta.companyKey)) {
                    firstContactIdMap.set(meta.companyKey, out.id);
                    primaryRowIndexMap.set(meta.companyKey, meta.rowIndex);
                  }
                }
              }
              // Fill in companies with no email-bearing created contact from the fallback.
              for (const [companyKey, id] of fallbackContactIdMap) {
                if (!firstContactIdMap.has(companyKey)) {
                  firstContactIdMap.set(companyKey, id);
                  primaryRowIndexMap.set(companyKey, fallbackRowIndexMap.get(companyKey)!);
                }
              }
              // Seniority override (Sample User 2026-07-04): the Deal's PRIMARY contact
              // (Contact_Name) must be the MOST SENIOR contact of the company —
              // not merely the first email-bearing one. Now that every contact
              // has an id (reused OR newly created), re-pick the primary by title
              // seniority across BOTH. The other colleagues stay as Contact Roles.
              {
                const createdIdByRow = new Map<number, string>();
                for (let i = 0; i < conOut.length; i++) {
                  const out = conOut[i];
                  if (out?.status === "success" && out.id) {
                    createdIdByRow.set(contactMeta[i].rowIndex, String(out.id));
                  }
                }
                for (const co of companiesWithAccount) {
                  let bestRow: any = null;
                  let bestRank = -1;
                  let bestHasEmail = false;
                  for (const row of co.contacts) {
                    const rid =
                      preexistingByRow.get(row.row_index) || createdIdByRow.get(row.row_index);
                    if (!rid) continue; // no id (create failed) → can't be primary
                    const rank = seniorityRank(row.title);
                    const hasEmail = !!String(row.email || "").trim();
                    if (
                      bestRow === null ||
                      rank > bestRank ||
                      (rank === bestRank && hasEmail && !bestHasEmail)
                    ) {
                      bestRow = row; bestRank = rank; bestHasEmail = hasEmail;
                    }
                  }
                  if (bestRow) {
                    const rid =
                      preexistingByRow.get(bestRow.row_index) ||
                      createdIdByRow.get(bestRow.row_index);
                    if (rid) {
                      firstContactIdMap.set(co.companyKey, rid);
                      primaryRowIndexMap.set(co.companyKey, bestRow.row_index);
                    }
                  }
                }
              }
              // Attach deferred same-email rows to the id created for that email,
              // so a shared-email colleague still lands on their company's Deal
              // (roles + primary) without a duplicate Contact being created.
              for (const d of deferredDupes) {
                const out = conOut[d.payloadIndex];
                if (out?.status === "success" && out.id) {
                  const _cids = contactIdsByCompany.get(d.companyKey) || [];
                  _cids.push(String(out.id));
                  contactIdsByCompany.set(d.companyKey, _cids);
                  if (!firstContactIdMap.has(d.companyKey)) {
                    firstContactIdMap.set(d.companyKey, String(out.id));
                    primaryRowIndexMap.set(d.companyKey, d.rowIndex);
                  }
                }
              }
            }

            // Step 3: Create deals.
            if (companiesWithAccount.length > 0) {
              const dealPayloads: Record<string, any>[] = [];
              const dealCompanyKeys: string[] = [];

              // LAST-RESORT CS_Member / Sales_Person resolution (Sample User 2026-07-05).
              // CS_Member is a mandatory user-lookup, but this org's token can't
              // read the Users API (fetchZohoUsers throws — same failure as
              // "Check required fields"), so csMemberId is still null here and the
              // deal would reject MANDATORY_NOT_FOUND CS_Member. Bypass the Users
              // API entirely: READ one resolved Account (a CRUD read, which works)
              // and reuse its OWNER's user id — a guaranteed-valid CRM user. This
              // makes deals create without any manual id or env var.
              if (!csMemberId || !salesPersonId) {
                try {
                  const { fetchZohoRecordById } = await import("../../utils/zohoCRM");
                  const anyAccId = companiesWithAccount
                    .map(co => accountIdMap.get(co.companyKey))
                    .find(Boolean);
                  if (anyAccId) {
                    const acc = await fetchZohoRecordById("Accounts", String(anyAccId));
                    const ownerId = acc?.data?.Owner?.id ? String(acc.data.Owner.id) : "";
                    if (ownerId) {
                      if (!csMemberId) csMemberId = ownerId;
                      if (!salesPersonId) salesPersonId = ownerId;
                      logger.info(`[preflight push] Resolved CS_Member/Sales_Person from account owner ${ownerId} (Users API unavailable).`);
                    }
                  }
                } catch (e: any) {
                  const _m = String(e?.message || e);
                  // If the owner read was RATE-LIMITED (a concurrent sync exhausted
                  // the shared Zoho quota), propagate it so the whole push returns
                  // a retryable rate-limit error — instead of silently leaving
                  // CS_Member empty, which would surface as MANDATORY_NOT_FOUND and
                  // look like a permanent failure. The UI waits + retries these.
                  if (/too many requests|rate.?limit|cooling down/i.test(_m)) throw e;
                  logger.warn(`[preflight push] Account-owner CS_Member fallback failed: ${_m}`);
                }
              }

              // Deal_Name = the ACTUAL account name (Sample User 2026-07-05: "add the
              // account name in the deal name"). For a reused account the real
              // Zoho name (e.g. "Ctelecoms (Consolidated Telecoms)") often
              // differs from the Excel company label ("Ctelecoms") — the deal
              // must be named after the account it sits under. Look the name up
              // by the resolved account id from the account directory; fall back
              // to the row's company label when the id isn't in the snapshot.
              const { getAccountDirectory } = await import("../../utils/duplicateRadarDatabase");
              const acctDir = await getAccountDirectory();
              const dealNameFor = (co: any): string => {
                const accId = accountIdMap.get(co.companyKey) || "";
                const acctName = accId ? acctDir.byId.get(accId)?.name : "";
                return String(acctName || co.companyName || co.domain || "(unknown)").trim();
              };

              // Idempotent guard: skip a company whose account already has an
              // OPEN deal of the same name (a retry) so we don't stack dupes.
              // (An old CLOSED/lost deal of the same name does NOT block a new one.)
              const { findExistingDealKeys } = await import("../../utils/zohoCRM");
              const existingDealKeys = await findExistingDealKeys(
                companiesWithAccount
                  .map(co => ({
                    accountId: accountIdMap.get(co.companyKey) || "",
                    name: dealNameFor(co),
                  }))
                  .filter(p => p.accountId),
              );

              // Per-deal edge-case guards (Sample User 2026-07-06). fetchZohoRecordById
              // is a CRUD read (works even with the Users API blocked) and does
              // double duty: (a) confirm the account still EXISTS live — a
              // merged/deleted id would reject with INVALID_DATA Account_Name;
              // (b) read the account's OWN current Owner to use as CS_Member, so
              // one slice's deactivated first-account owner can't poison every
              // deal (INVALID_DATA CS_Member). Imported once, reused per company.
              const { fetchZohoRecordById: _fetchAcc } = await import("../../utils/zohoCRM");
              // Per-company skip reasons (dealSkips, declared above) so the
              // operator can see exactly WHY a company (e.g. Ctelecoms) got no
              // deal — instead of a bare "0 created".
              for (const co of companiesWithAccount) {
                const accountId = accountIdMap.get(co.companyKey);
                const firstContactId = firstContactIdMap.get(co.companyKey);
                const _label = co.companyName || co.domain || co.companyKey;
                if (!accountId) { dealSkips.push({ company: _label, reason: "no existing account resolved" }); continue; }
                // Contact_Name is MANDATORY on the Deal layout — a company with no
                // resolvable contact can't get a deal (was MANDATORY_NOT_FOUND
                // Contact_Name). Skip it instead of rejecting.
                if (!firstContactId) { dealsSkippedNoContact++; dealSkips.push({ company: _label, reason: "no contact to link (Contact_Name required)" }); continue; }

                // Verify the account is live + get its owner for CS_Member.
                let dealCsMember = csMemberId;
                {
                  let acc: any = null;
                  try { acc = await _fetchAcc("Accounts", String(accountId)); }
                  catch (e: any) {
                    const _m = String(e?.message || e);
                    if (/too many requests|rate.?limit|cooling down/i.test(_m)) throw e; // retryable
                    // other read error → keep the shared csMemberId, proceed
                  }
                  if (acc === null) { dealsSkippedGoneAccount++; dealSkips.push({ company: _label, reason: "account deleted/merged in Zoho" }); continue; } // account gone → skip
                  const ownerId = acc?.data?.Owner?.id ? String(acc.data.Owner.id) : "";
                  if (ownerId) dealCsMember = ownerId; // this account's current owner
                }

                const dealName = dealNameFor(co);
                // Already an OPEN deal of this name under this account → skip (retry).
                if (existingDealKeys.has(`${accountId}::${dealName.trim().toLowerCase()}`)) {
                  existingDealsSkipped++;
                  dealSkips.push({ company: dealName, reason: "already has an OPEN deal of this name under the account" });
                  continue;
                }
                const p: Record<string, any> = {
                  Deal_Name: dealName,
                  Stage: DEAL.stage,
                  Pipeline: DEAL.pipeline,
                  Lead_Source: PREFLIGHT_LEAD_SOURCE,
                  Layout: { id: DEAL.layoutId },
                  Account_Name: { id: accountId },
                };
                if (PRODUCTS_FIELD) p.Products = PRODUCTS_FIELD;
                p.No_of_Employees = PREFLIGHT_EMPLOYEES;
                if (salesPersonId) p.Sales_Person = { id: salesPersonId };
                // CS_Member = this account's own owner (validated by the read
                // above), falling back to the shared resolved id. Only { id } —
                // never { email } (that returns MANDATORY_NOT_FOUND api_name:"id").
                if (dealCsMember) p.CS_Member = { id: dealCsMember };
                if (PREFLIGHT_GOV_TYPE) p.Gov_Type = PREFLIGHT_GOV_TYPE;
                p.Contact_Name = { id: firstContactId };
                // A2/A3 open a NEW account — warn if it fuzzy-matches an
                // existing one (possible duplicate / existing client).
                const maybeClient = action !== 1
                  ? possibleClientOf({ company: co.companyName, domain: co.domain, email: co.contacts[0]?.email })
                  : null;
                let dealDesc = maybeClient ? POSSIBLE_CLIENT_NOTE(maybeClient.name) : "";
                if (co.contacts.length > 1) {
                  const primaryRowIndex = primaryRowIndexMap.get(co.companyKey);
                  const primaryRow = primaryRowIndex != null
                    ? co.contacts.find(r => r.row_index === primaryRowIndex) || null
                    : pickPrimaryContact(co.contacts);
                  dealDesc += buildOtherContactsDescription(co.contacts, primaryRow);
                }
                if (dealDesc) p.Description = dealDesc;
                dealPayloads.push(p);
                dealCompanyKeys.push(co.companyKey);
              }

              const dealOut = dealPayloads.length > 0
                ? await createZohoRecordsBulk("Deals", dealPayloads)
                : [];
              created.deals = dealOut.filter(o => o.status === "success").length;
              failed.deals = dealOut.filter(o => o.status === "error").length;
              collectErrors("deal", dealOut);
              outcomesSample = dealOut.slice(0, 20);
              // Tag created Deals (best-effort).
              try {
                const dealIds = dealOut.filter(o => o.status === "success" && o.id).map(o => String(o.id));
                if (dealIds.length && PREFLIGHT_DEAL_TAG) await addZohoTags("Deals", dealIds, [PREFLIGHT_DEAL_TAG]);
              } catch (_) { /* tagging non-fatal */ }
              // Associate every created contact of a company to its Deal's
              // Contact Roles (the primary is also the Deal's Contact_Name).
              // Best-effort — never fails the push. Env PREFLIGHT_CONTACT_ROLE
              // sets an optional role name; omitted → role-less association.
              try {
                const contactRole = process.env.PREFLIGHT_CONTACT_ROLE || null;
                for (let i = 0; i < dealOut.length; i++) {
                  const o = dealOut[i];
                  if (o?.status === "success" && o.id) {
                    const cids = contactIdsByCompany.get(dealCompanyKeys[i]) || [];
                    if (cids.length) await addDealContactRoles(String(o.id), cids, contactRole);
                  }
                }
              } catch (_) { /* contact-role association non-fatal */ }
            }

            // Add <REDACTED_TOKEN> to the plan's skipped count.
            plan.skipped.push(
              ...companiesSkippedNoAccount.flatMap(co =>
                co.contacts.map(r => ({ row_index: r.row_index, reason: "no_matched_account" }))
              )
            );
          }

          // Audit log.
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            const totalFailed = failed.accounts + failed.contacts + failed.deals + failed.leads;
            const desc =
              action === 4
                ? `Preflight structured push (action 4): created ${created.leads} Leads${leadsSkippedExisting ? `, skipped ${leadsSkippedExisting} already-existing` : ""}${liveClientsRejected ? `, rejected ${liveClientsRejected} live-client` : ""} (${failed.leads} failed). Source: "${source}".`
                : `Preflight structured push (action ${action}): created ${created.accounts} accounts, ${created.contacts} contacts, ${created.deals} deals${reusedAccounts ? `, reused ${reusedAccounts} existing account(s)` : ""}${existingContactsLinked ? `, linked ${existingContactsLinked} existing contact(s)` : ""}${liveClientsRejected ? `, rejected ${liveClientsRejected} live-client contact(s)` : ""}${contactsExistingAsLead ? `, rejected ${contactsExistingAsLead} already-a-lead` : ""}${existingDealsSkipped ? `, skipped ${existingDealsSkipped} existing deal(s)` : ""} (${totalFailed} failed). Source: "${source}".`;
            await logEvent({
              userId: sessionUser?.userId ?? 0,
              userEmail: sessionUser?.email ?? "system",
              userRole: sessionUser?.role,
              actionType: "PUSH_TO_ZOHO",
              entityType: action === 4 ? "Leads" : "Deals",
              entityId: action === 4 ? LEAD.layoutId : DEAL.layoutId,
              entityName: source,
              description: desc,
              aiInvolved: false,
              severity: (failed.accounts + failed.contacts + failed.deals + failed.leads) > 0 ? "WARNING" : "INFO",
              module: "duplicate-radar",
            });
          } catch {
            /* non-fatal */
          }

          return c.json({
            success: true,
            dry_run: false,
            action,
            created,
            failed,
            existing_contacts_linked: existingContactsLinked,
            reused_accounts: reusedAccounts,
            existing_deals_skipped: existingDealsSkipped,
            deals_skipped_no_contact: dealsSkippedNoContact,
            deals_skipped_gone_account: dealsSkippedGoneAccount,
            deal_skips: dealSkips.slice(0, 25),
            live_clients_rejected: liveClientsRejected,
            contacts_existing_as_lead: contactsExistingAsLead,
            leads_skipped_existing: leadsSkippedExisting,
            possible_existing_client_count: possibleClientCount,
            skipped_count: plan.skipped.length,
            error_sample: errorSamples,
            outcomes_sample: outcomesSample,
          });
        } catch (error: any) {
          logger.error("Error in preflight structured-push:", error);
          return c.json(
            { error: "Structured push to Zoho failed — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    // Title BACKFILL. Sets the Title on already-created Leads/Contacts (which
    // were pushed from an input without a Title column) by matching each source
    // row to the record BY EMAIL and updating Title from the row. This is an
    // UPDATE (not create) — dry-run by default, admin-gated, sliced by
    // count/offset. Body: { rows, module?, dry_run?, count?, offset? }.
    path: "/api/duplicates/preflight/backfill-titles",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const rowsIn: any[] = Array.isArray(body?.rows) ? body.rows : [];
          if (rowsIn.length === 0) return c.json({ error: "rows array required" }, 400);
          const module = body?.module === "Contacts" ? "Contacts" : "Leads";
          const dryRun = body?.dry_run !== false;
          const count = typeof body?.count === "number" && body.count > 0 ? Math.floor(body.count) : 0;
          const offset = typeof body?.offset === "number" && body.offset >= 0 ? Math.floor(body.offset) : 0;

          // Candidates: rows with a way to MATCH an existing record (email,
          // phone, or name). We now backfill EVERY field the Excel carries —
          // Title, Email, Phone, Mobile, Company — not just Title, so the SDR
          // team gets complete records. PHONE is essential — many Mawsool leads
          // are phone-only, so phone is how we reach + match them.
          const candidates = rowsIn
            .map((r: any) => ({
              email: String(r.email ?? r.input?.email ?? "").trim(),
              phone: String(r.phone ?? r.input?.phone ?? "").trim(),
              title: String(r.title ?? r.input?.title ?? "").trim(),
              contact_name: String(r.contact_name ?? r.input?.contact_name ?? "").trim(),
              company: String(r.company ?? r.company_name ?? r.input?.company_name ?? "").trim(),
            }))
            .filter(r => r.email || r.phone || r.contact_name);
          const sliced = count > 0 ? candidates.slice(offset, offset + count) : candidates;

          const { findRecordIdsByEmails, findRecordIdsByPhones, normalizePhoneKey, findRecordIdsByFullNames, fullNameKey, updateZohoRecordsBulk } = await import("../../utils/zohoCRM");
          const { splitContactName } = await import("../../utils/preflightStructuredPush");
          // Match order: EMAIL (batched) → PHONE (batched) → NAME (BATCHED, unique
          // match only). Name matching used to be one Zoho search PER ROW, which
          // timed out large slices; it's now OR-chunked like email/phone.
          const idByEmail = await findRecordIdsByEmails(module, sliced.map(r => r.email).filter(Boolean));
          const idByPhone = await findRecordIdsByPhones(module, sliced.map(r => r.phone).filter(Boolean));

          // Pass 1 — resolve by email/phone; note which rows still need a name
          // match, split their name ONCE, and carry every fillable field.
          type BF = { id: string | null; viaPhone: boolean; first: string; last: string; email: string; phone: string; title: string; company: string; contactName: string };
          const bf: BF[] = sliced.map(r => {
            let id: string | null = r.email ? (idByEmail.get(r.email.toLowerCase()) || null) : null;
            let viaPhone = false;
            if (!id && r.phone) {
              const pk = normalizePhoneKey(r.phone);
              id = pk ? (idByPhone.get(pk) || null) : null;
              if (id) viaPhone = true;
            }
            const nm = (!id && r.contact_name) ? splitContactName(r.contact_name) : { first: "", last: "" };
            return { id, viaPhone, first: nm.first, last: nm.last, email: r.email, phone: r.phone, title: r.title, company: r.company, contactName: r.contact_name };
          });
          // Pass 2 — ONE batched name lookup for everything email/phone missed.
          const idByName = await findRecordIdsByFullNames(
            module,
            bf.filter(x => !x.id && x.last).map(x => ({ first: x.first, last: x.last })),
          );

          const seen = new Set<string>();
          const updates: Array<Record<string, any>> = [];
          let notFound = 0;
          let matchedByPhone = 0;
          let matchedByName = 0;
          for (const x of bf) {
            let id = x.id;
            if (x.viaPhone) matchedByPhone++;
            if (!id && x.last) {
              id = idByName.get(fullNameKey(x.first, x.last)) || null;
              if (id) matchedByName++;
            }
            if (!id) { notFound++; continue; }
            if (seen.has(id)) continue;
            seen.add(id);
            // Backfill EVERY field the Excel carries onto the matched record
            // (Mawsool is the source of truth). Only sets a field the file has a
            // value for — a blank cell never wipes existing data.
            const p: Record<string, any> = { id };
            if (x.title) p.Title = x.title;
            if (x.email) p.Email = x.email;
            if (x.phone) { p.Phone = x.phone; p.Mobile = x.phone; }
            if (module === "Leads") {
              if (x.company) p.Company = x.company;
              // Sample User 2026-07-06 (REVERSES 07-05): the Lead NAME must be the
              // CONTACT PERSON so SDRs can call the lead by name — company stays
              // in the Company field. Restore the person's name from the Excel
              // contact_name onto Last_Name / First_Name. Rows with no person
              // name keep whatever name they had (no blank Last_Name).
              const nm = splitContactName(String(x.contactName || ""));
              if (nm.last) p.Last_Name = nm.last;
              if (nm.first) p.First_Name = nm.first;
            }
            if (Object.keys(p).length > 1) updates.push(p);
          }

          if (dryRun) {
            return c.json({
              success: true, dry_run: true, module,
              candidates: sliced.length,
              would_update: updates.length,
              matched_by_phone: matchedByPhone,
              matched_by_name: matchedByName,
              not_found: notFound,
              sample: updates.slice(0, 10),
            });
          }

          const out = updates.length > 0 ? await updateZohoRecordsBulk(module, updates) : [];
          const updated = out.filter(o => o.status === "success").length;
          const failed = out.filter(o => o.status === "error").length;
          const errorSample = out.filter(o => o.status === "error").slice(0, 5).map(o => ({ code: o.code, message: o.message }));
          return c.json({
            success: true, dry_run: false, module,
            candidates: sliced.length, updated, failed, not_found: notFound,
            matched_by_phone: matchedByPhone,
            matched_by_name: matchedByName,
            error_sample: errorSample,
          });
        } catch (error: any) {
          logger.error("Error in backfill-titles:", error);
          return c.json({ error: "Title backfill failed — " + (error?.message || "unknown") }, 500);
        }
      };
    },
  },
  {
    // READ-ONLY diagnostic — "Find leads that are actually existing clients."
    // The structured push files a contact under Leads (batch ④) only when it
    // can't match an existing Account by email-domain, row-domain, or EXACT
    // company name. A THIN row (no email / no domain) whose company is stored in
    // Zoho under any name variance — Arabic, a suffix, different punctuation, or
    // simply not yet in the synced account directory — slips through as a NEW
    // Lead, i.e. a duplicate of a client we already have (the "Bader Bahati →
    // Riyadh First Health Cluster" case). This scan re-checks every Lead of a
    // given Lead_Source against the account directory with FUZZY core-name
    // matching (what the push's exact match missed) and lists the ones that hit
    // an existing Account, so the operator can decide to link them. NO writes.
    path: "/api/duplicates/preflight/mislabeled-leads-scan",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          // Lead_Source to scan (single word so the Zoho criteria stays valid —
          // criteria search breaks on spaces/parens). Defaults to the Mawsool
          // import this whole tool exists for.
          const source = String(body?.source || "Mawsool").trim() || "Mawsool";
          // Scope to leads WE created (Sample User 2026-07-06): the source has ~38k
          // Mawsool leads but only ~1.6k were pushed by us — the rest belong to
          // SDRs / older imports and must NOT be touched. When created_by is
          // given, keep only leads whose Created_By / Owner name-or-email
          // contains it (case-insensitive). Empty = all (previous behavior).
          const createdBy = String(body?.created_by || "").trim().toLowerCase();

          const { fetchAllZohoRecords } = await import("../../utils/zohoCRM");
          const { getAccountDirectory } = await import("../../utils/duplicateRadarDatabase");
          const { normalizeCoreName } = await import("../../utils/preflightStructuredPush");

          // 1) LIVE-fetch every Lead of this source in one paginated call.
          const leadsAll = await fetchAllZohoRecords("Leads", {
            criteria: `(Lead_Source:equals:${source})`,
            fields: ["Company", "Last_Name", "First_Name", "Full_Name", "Email", "Phone", "Mobile", "Lead_Status", "Created_Time", "Created_By", "Owner"],
          });
          const leads = createdBy
            ? leadsAll.filter(l => {
                const cb = (l.data as any)?.Created_By || {};
                const ow = (l.data as any)?.Owner || {};
                return [cb.name, cb.email, ow.name, ow.email]
                  .some(x => String(x || "").toLowerCase().includes(createdBy));
              })
            : leadsAll;

          // 2) Load the account directory and build the FUZZY core-name index
          //    the push never uses for auto-linking (it links on EXACT only).
          const dir = await getAccountDirectory();
          const byCore = new Map<string, { zohoId: string; name: string }>();
          const coreCount = new Map<string, number>();
          for (const ref of dir.byId.values()) {
            const core = normalizeCoreName(ref.name);
            if (core.length < 6) continue; // skip generic / too-short cores
            coreCount.set(core, (coreCount.get(core) || 0) + 1);
            if (!byCore.has(core)) byCore.set(core, ref);
          }

          // 3) For each lead, try EXACT name (what the push tried) then FUZZY
          //    core name. A hit means this "new" lead is an existing client.
          const rows: any[] = [];
          for (const l of leads) {
            const d = l.data || {};
            const company = String(d.Company || "").trim();
            if (!company) continue;
            const exact = dir.byName.get(company.toLowerCase());
            const core = normalizeCoreName(company);
            const fuzzy = core.length >= 6 ? byCore.get(core) : undefined;
            const match = exact || fuzzy;
            if (!match) continue;
            const name =
              String(d.Full_Name || `${d.First_Name || ""} ${d.Last_Name || ""}`).trim() || "(no name)";
            rows.push({
              lead_id: l.id,
              lead_name: name,
              company,
              email: String(d.Email || "").trim() || null,
              phone: String(d.Phone || d.Mobile || "").trim() || null,
              lead_status: String(d.Lead_Status || "").trim() || null,
              matched_account_id: match.zohoId,
              matched_account_name: match.name,
              matched_via: exact ? "exact_name" : "fuzzy_core_name",
              name_differs: match.name.trim().toLowerCase() !== company.toLowerCase(),
              ambiguous: !exact && !!fuzzy ? (coreCount.get(core) || 1) > 1 : false,
            });
          }
          rows.sort((a, b) => String(a.company).localeCompare(String(b.company)));

          return c.json({
            success: true,
            source,
            total_leads: leads.length,
            matched: rows.length,
            rows,
          });
        } catch (error: any) {
          logger.error("Error in mislabeled-leads-scan:", error);
          return c.json({ error: "Mislabeled-leads scan failed — " + (error?.message || "unknown") }, 500);
        }
      };
    },
  },
  {
    // Dedup Mawsool LEADS created by repeated pushes. Retried pushes duplicated
    // leads with NO email/phone (nothing to dedup on) — e.g. 7 copies of
    // "Ajialuna Educational Company". Groups every Lead of a source by
    // normalized company, KEEPS the most-complete lead per company, and lists /
    // tags the rest Duplicate-Delete for the admin to remove in Zoho (HITL —
    // never hard-deleted).
    //   Report mode (default): fetch + group, return the duplicate ids + counts.
    //     No writes.
    //   Apply mode ({ apply:true, ids:[...] }): tag those ids Duplicate-Delete
    //     (chunked by 100). The UI sends the report's dup ids back in slices, so
    //     the heavy fetch happens once and each apply call is fast.
    path: "/api/duplicates/preflight/dedup-mawsool-leads",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));

          // ── APPLY MODE — tag the provided duplicate ids (no fetch). ──
          if (body?.apply === true && Array.isArray(body?.ids) && body.ids.length) {
            const { addZohoTags } = await import("../../utils/zohoCRM");
            const ids: string[] = body.ids.map((x: any) => String(x)).filter(Boolean);
            const TAG = String(body?.tag || "Duplicate-Delete");
            let tagged = 0;
            const errs: string[] = [];
            for (let i = 0; i < ids.length; i += 100) {
              const chunk = ids.slice(i, i + 100);
              try { await addZohoTags("Leads", chunk, [TAG]); tagged += chunk.length; }
              catch (e: any) { errs.push(e?.message || String(e)); }
            }
            return c.json({ success: true, apply: true, tagged, failed: ids.length - tagged, errors: errs.slice(0, 3) });
          }

          // ── REPORT MODE — fetch all source leads and group by company. ──
          const source = String(body?.source || "Mawsool").trim() || "Mawsool";
          // Scope to leads WE created (Sample User 2026-07-06) — only dedup the ones
          // pushed by us, identified by Created_By / Owner. The ~36k SDR / older
          // Mawsool leads must NOT be tagged Duplicate-Delete. Empty = all.
          const createdBy = String(body?.created_by || "").trim().toLowerCase();
          const { fetchAllZohoRecords } = await import("../../utils/zohoCRM");
          const { normalizeCompanyName } = await import("../../utils/duplicateRadarDatabase");
          const leadsAll = await fetchAllZohoRecords("Leads", {
            criteria: `(Lead_Source:equals:${source})`,
            fields: ["Company", "Last_Name", "First_Name", "Email", "Phone", "Mobile", "Title", "Lead_Status", "Created_Time", "Created_By", "Owner"],
          });
          const leads = createdBy
            ? leadsAll.filter(l => {
                const cb = (l.data as any)?.Created_By || {};
                const ow = (l.data as any)?.Owner || {};
                return [cb.name, cb.email, ow.name, ow.email]
                  .some(x => String(x || "").toLowerCase().includes(createdBy));
              })
            : leadsAll;

          const groups = new Map<string, any[]>();
          for (const l of leads) {
            const key = normalizeCompanyName(String(l.data?.Company || "")) || "";
            if (!key) continue; // no company name → can't group safely; leave it alone
            const arr = groups.get(key) || [];
            arr.push(l);
            groups.set(key, arr);
          }
          // Completeness score — a lead with email/phone/title is richer and is
          // the one worth keeping; tie broken by OLDEST Created_Time so we keep
          // the original (and any status history) and tag the later copies.
          const score = (l: any): number => {
            const d = l.data || {};
            return (String(d.Email || "").trim() ? 8 : 0)
              + (String(d.Phone || d.Mobile || "").trim() ? 4 : 0)
              + (String(d.Title || "").trim() ? 2 : 0);
          };
          const dupIds: string[] = [];
          const sample: any[] = [];
          let dupGroups = 0;
          for (const [, arr] of groups) {
            if (arr.length < 2) continue;
            dupGroups++;
            const sorted = arr.slice().sort((a, b) => {
              const sc = score(b) - score(a);
              if (sc !== 0) return sc;
              return String(a.data?.Created_Time || "").localeCompare(String(b.data?.Created_Time || ""));
            });
            const dups = sorted.slice(1);
            for (const d of dups) if (d.id) dupIds.push(String(d.id));
            if (sample.length < 50) {
              sample.push({
                company: String(sorted[0].data?.Company || ""),
                copies: arr.length,
                keep_id: sorted[0].id,
                dup_count: dups.length,
              });
            }
          }
          sample.sort((a, b) => b.copies - a.copies);

          return c.json({
            success: true,
            source,
            total_leads: leads.length,
            companies: groups.size,
            duplicate_groups: dupGroups,
            duplicates: dupIds.length,
            dup_ids: dupIds,
            sample: sample.slice(0, 50),
          });
        } catch (error: any) {
          logger.error("Error in dedup-mawsool-leads:", error);
          return c.json({ error: "Dedup failed — " + (error?.message || "unknown") }, 500);
        }
      };
    },
  },
  {
    // READ-ONLY diagnostic. Returns the AUTHORITATIVE required fields (and their
    // exact api_names) for the Deals and Leads modules, plus the specific fields
    // the push fills (products / employees / sales person), so we can confirm
    // the api_names match what the push sends — no guessing. No writes.
    path: "/api/duplicates/preflight/zoho-required-fields",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);
          const { fetchZohoFields } = await import("../../utils/zohoCRM");
          const rx = /product|employ|sales|person/i;
          const summarize = (fields: any[]) => ({
            required: fields.filter(f => f.required).map(f => ({ api_name: f.api_name, label: f.label, type: f.data_type })),
            push_targets: fields
              .filter(f => rx.test(f.label) || rx.test(f.api_name))
              .map(f => ({ api_name: f.api_name, label: f.label, type: f.data_type, required: f.required })),
          });
          const [deals, leads] = await Promise.all([fetchZohoFields("Deals"), fetchZohoFields("Leads")]);
          return c.json({ success: true, deals: summarize(deals), leads: summarize(leads) });
        } catch (error: any) {
          logger.error("Error in zoho-required-fields:", error);
          return c.json({ error: "Field metadata fetch failed — " + (error?.message || "unknown") }, 500);
        }
      };
    },
  },
  {
    // READ-ONLY. Layer 1 of the resolution ladder for the WHOLE upload: resolve
    // each contact's existing Zoho Account by EMAIL domain → row domain →
    // company name (the email-domain check is the new signal the import gate
    // never ran). Returns per-row matched_account_zoho_id + matched_via and a
    // summary, so the client can enrich its rows, refresh the action badges,
    // and send the enriched rows to the push. No writes. Body: { rows }.
    path: "/api/duplicates/preflight/resolve-existing-accounts",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
          if (rows.length === 0) return c.json({ error: "rows array required" }, 400);

          const spRows = rows.map((r: any, idx: number) => ({
            row_index: typeof r.row_index === "number" ? r.row_index : idx,
            company: String(r.company ?? r.input?.company_name ?? r.company_name ?? ""),
            domain: String(r.domain ?? r.input?.domain ?? ""),
            email: String(r.email ?? ""),
            matched_account_zoho_id: (r.matched_account_zoho_id ?? r.input?.matched_account_zoho_id) != null
              ? String(r.matched_account_zoho_id ?? r.input?.matched_account_zoho_id)
              : null,
          }));

          const { rows: enriched, via } = await enrichRowsWithExistingAccounts(spRows);

          // Per-row matches (only the matched ones — keeps payload small).
          const matches = enriched
            .filter(r => String(r.matched_account_zoho_id || "").trim())
            .map(r => ({
              row_index: r.row_index,
              matched_account_zoho_id: String(r.matched_account_zoho_id),
              matched_account_name: String(r.matched_account_name || ""),
              matched_via: via.get(r.row_index) || "unknown",
            }));

          const byVia: Record<string, number> = {};
          for (const m of matches) byVia[m.matched_via] = (byVia[m.matched_via] || 0) + 1;

          return c.json({
            success: true,
            total: spRows.length,
            matched: matches.length,
            unmatched: spRows.length - matches.length,
            by_via: byVia,
            matches,
          });
        } catch (error: any) {
          logger.error("Error in resolve-existing-accounts:", error);
          return c.json(
            { error: "Resolve existing accounts failed — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    // Formatted Excel export for the Preflight Check tab. Takes either a
    // PreflightResponse the client already rendered (preferred — no
    // re-run) or `rows` to re-run server-side. Returns an .xlsx with:
    //   - "Summary" cover sheet (totals, % blocked/duplicate, top reasons,
    //     generated-at)
    //   - "Findings" sheet (color-coded severity rows, frozen header,
    //     business-language "Recommended Action" column, owner column,
    //     module counts, reason code)
    // Designed to be the attachment for an executive email — drop straight
    // into a "Hi [Head of Sales], …" body.
    path: "/api/duplicates/preflight/export-xlsx",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));

          // Prefer the client-supplied result (no extra DB load); fall
          // back to re-running over `rows` if the caller wants the server
          // to compute fresh.
          let result: any = null;
          if (body?.result && typeof body.result === "object") {
            result = body.result;
          } else if (Array.isArray(body?.rows)) {
            const { runPreflight } = await import(
              "../../utils/duplicateRadarPreflight"
            );
            result = await runPreflight({
              rows: body.rows,
              max_check:
                typeof body.max_check === "number"
                  ? body.max_check
                  : undefined,
              refresh_overlap: body.refresh_overlap === true,
            });
          } else {
            return c.json(
              { error: "Provide either `result` or `rows`." },
              400,
            );
          }

          // 2026-06-17 — flagged-only export for the Head-of-Sales hand-off
          // (no PASS rows) + optional per-row contact columns merged from the
          // uploaded file (keyed by row_index). Sending a native .xlsx avoids
          // the CSV→Excel conversion that was shifting cells / dropping the
          // header on the client-built file.
          const flaggedOnly = body?.flaggedOnly === true;
          const passOnly = body?.passOnly === true;
          const contacts =
            body?.contacts && typeof body.contacts === "object"
              ? body.contacts
              : null;
          // FULL original columns from the uploaded file (per row_index) + the
          // ordered header list — appended after the analysis columns so the
          // exported sheet carries the operator's COMPLETE record, not just
          // Company/Contact/Email/Phone.
          const originals =
            body?.originals && typeof body.originals === "object"
              ? body.originals
              : null;
          // Columns from the uploaded file we never want in the hand-off export
          // (enrichment-vendor noise the Sales team doesn't need). Sample User
          // 2026-06-25: drop "Keywords" and "Technologies". Filtering the header
          // list here removes them from BOTH the column defs and the per-row
          // values (which are keyed by header name) with no index drift.
          const PREFLIGHT_EXPORT_EXCLUDE_COLS = new Set(["keywords", "technologies"]);
          const originalHeaders: string[] = Array.isArray(body?.original_headers)
            ? body.original_headers
                .map((h: any) => String(h))
                .filter(Boolean)
                .filter((h: string) => !PREFLIGHT_EXPORT_EXCLUDE_COLS.has(h.trim().toLowerCase()))
            : [];
          const rowsToEmit = (Array.isArray(result.rows) ? result.rows : []).filter(
            (r: any) => {
              if (flaggedOnly) return r && r.verdict && r.verdict !== "pass";
              if (passOnly) return r && r.verdict === "pass";
              return true;
            },
          );

          const ExcelJS = (await import("exceljs")).default;
          const wb = new ExcelJS.Workbook();
          wb.creator = "ExampleOrg QMS — Duplicate Radar";
          wb.created = new Date();

          // ── Summary sheet ────────────────────────────────────────────
          const summary = wb.addWorksheet("Summary", {
            properties: { tabColor: { argb: "FF4F46E5" } },
          });
          summary.columns = [
            { header: "Metric", key: "k", width: 50 },
            { header: "Value", key: "v", width: 28 },
          ];
          const headerRow = summary.getRow(1);
          headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
          headerRow.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF4F46E5" },
          };
          summary.getRow(1).alignment = { vertical: "middle" };
          summary.views = [{ state: "frozen", ySplit: 1 }];

          const add = (k: string, v: any) => summary.addRow({ k, v });
          add("Generated at (UTC)", result.generated_at || new Date().toISOString());
          add("Total rows submitted", result.total_rows || 0);
          add("Rows examined", result.examined || 0);
          add("Rows skipped (over cap)", result.skipped || 0);
          add(
            "Share that would have created a duplicate (%)",
            (result.pct_actionable ?? 0) + "%",
          );
          summary.addRow({});
          const sHdr = summary.addRow({
            k: "Verdict breakdown",
            v: "Count",
          });
          sHdr.font = { bold: true };
          add("✗ BLOCK — active CS customer", result.summary?.block || 0);
          add("⚠ REVIEW — within CS cool-off", result.summary?.review || 0);
          add("✓ WARN — past CS cool-off", result.summary?.warn || 0);
          add(
            "≡ DUPLICATE — already in CRM",
            result.summary?.duplicate || 0,
          );
          add(
            "✗ REJECTED — no email & no phone",
            (result.summary as any)?.no_contact || 0,
          );
          add("✓ PASS — safe to import", result.summary?.pass || 0);

          if (Array.isArray(result.top_reasons) && result.top_reasons.length > 0) {
            summary.addRow({});
            const tHdr = summary.addRow({
              k: "Top reasons (business language)",
              v: "Count / %",
            });
            tHdr.font = { bold: true };
            for (const r of result.top_reasons) {
              add(r.label, r.count + " rows (" + r.pct + "%)");
            }
          }

          // Cell border + alternating row tint for the summary sheet.
          summary.eachRow((row: any, idx: number) => {
            if (idx > 1 && idx % 2 === 0) {
              row.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FFF8FAFC" },
              };
            }
            row.eachCell((cell: any) => {
              cell.border = {
                top: { style: "thin", color: { argb: "FFE2E8F0" } },
                left: { style: "thin", color: { argb: "FFE2E8F0" } },
                bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
                right: { style: "thin", color: { argb: "FFE2E8F0" } },
              };
            });
          });

          // ── Findings sheet ───────────────────────────────────────────
          const findings = wb.addWorksheet("Findings");
          // Every column from the operator's uploaded file, appended AFTER the
          // analysis columns (unique keys orig_<n>, original header text kept
          // verbatim) so the export carries the COMPLETE original record.
          const origColumns = originalHeaders.map((h, idx) => ({
            header: h,
            key: `orig_${idx}`,
            width: 22,
          }));
          findings.columns = [
            { header: "#", key: "i", width: 6 },
            { header: "Verdict", key: "verdict", width: 12 },
            { header: "Severity", key: "sev", width: 10 },
            { header: "Comment / Reason", key: "exec", width: 60 },
            { header: "Domain", key: "domain", width: 26 },
            { header: "Company", key: "company", width: 32 },
            ...(contacts
              ? [
                  { header: "Contact Name", key: "contact_name", width: 24 },
                  { header: "Email", key: "contact_email", width: 30 },
                  { header: "Phone", key: "contact_phone", width: 18 },
                ]
              : []),
            { header: "Existing Owner(s)", key: "owners", width: 28 },
            { header: "CS Owner", key: "cs_owner", width: 22 },
            { header: "CRM Modules (L·D·C·A)", key: "modules", width: 22 },
            { header: "CS Phase", key: "phase", width: 16 },
            { header: "Churn Date", key: "churn_date", width: 14 },
            { header: "Days Since Churn", key: "churn_days", width: 14 },
            // Sample User 2026-06-17 — clickable Zoho links per rejected row.
            // Operator clicks straight to the existing Lead / Deal /
            // Account to verify the rejection without going back into
            // the dashboard. Empty cell when the cluster has no
            // matching record of that type.
            { header: "Existing Active Lead",         key: "link_active_lead",  width: 36 },
            { header: "Existing Active Deal",         key: "link_active_deal",  width: 36 },
            { header: "Existing Customer Deal (CS)",  key: "link_client_deal",  width: 36 },
            { header: "Existing Account",             key: "link_account",      width: 36 },
            { header: "Reason (engineer)", key: "reason", width: 32 },
            { header: "Matched via", key: "matched_via", width: 16 },
            ...origColumns,
          ];
          const fHdr = findings.getRow(1);
          fHdr.font = { bold: true, color: { argb: "FFFFFFFF" } };
          fHdr.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1E293B" },
          };
          findings.views = [{ state: "frozen", ySplit: 1 }];

          const severityFill: Record<string, string> = {
            critical: "FFFEE2E2",
            high: "FFFEF3C7",
            medium: "FFFEF9C3",
            low: "FFDBEAFE",
            info: "FFDCFCE7",
          };

          const fmtModules = (mc: any) =>
            mc
              ? `${mc.leads || 0}·${mc.deals || 0}·${mc.contacts || 0}·${mc.accounts || 0}`
              : "—";

          // Sample User 2026-06-17 — hyperlink helper. ExcelJS understands
          // a cell value of { text, hyperlink, tooltip } as a clickable
          // link. Empty cell when there's no matching record.
          const mkLink = (lk: any) =>
            lk && lk.url
              ? { text: lk.label || "Open in Zoho", hyperlink: lk.url, tooltip: lk.url }
              : "";
          // CS Phase column — render the lifecycle_state enum as a human label
          // for the Head of Sales. Termination rows additionally carry the
          // Churn Date in its own column (Sample User 2026-06-22).
          const phaseLabel = (s: any): string => {
            switch (s) {
              case "onboarding": return "Onboarding";
              case "adoption": return "Adoption";
              case "renewal": return "Renewal";
              case "termination_recent": return "Termination (within cool-off)";
              case "termination_old": return "Termination (past cool-off)";
              default: return "";
            }
          };
          for (const r of rowsToEmit) {
            const ct = contacts
              ? contacts[r.row_index] || contacts[String(r.row_index)] || {}
              : {};
            // Pull this row's full original record and map each header to its
            // orig_<n> column key.
            const origRow = originals
              ? originals[r.row_index] || originals[String(r.row_index)] || {}
              : {};
            const origValues: Record<string, any> = {};
            originalHeaders.forEach((h, idx) => {
              const v = (origRow as any)[h];
              origValues[`orig_${idx}`] = v == null ? "" : v;
            });
            const row = findings.addRow({
              ...origValues,
              i: (r.row_index ?? 0) + 1,
              verdict: r.verdict?.toUpperCase() || "PASS",
              sev: r.executive_severity?.toUpperCase() || "INFO",
              exec: r.executive_action || r.suggested_action || "",
              domain: r.input?.domain || "",
              company: r.input?.company_name || "",
              contact_name: ct.name || "",
              contact_email: ct.email || "",
              contact_phone: ct.phone || "",
              owners: Array.isArray(r.owners) ? r.owners.join(", ") : "",
              cs_owner: r.cs_owner || "",
              modules: fmtModules(r.module_counts),
              phase: (r.cs_phase && String(r.cs_phase).trim()) || phaseLabel(r.lifecycle_state),
              churn_date: r.churn_date || "",
              churn_days: r.churn_days != null ? r.churn_days : "",
              link_active_lead:  mkLink(r.crm_links?.active_lead),
              link_active_deal:  mkLink(r.crm_links?.active_deal),
              link_client_deal:  mkLink(r.crm_links?.client_deal),
              link_account:      mkLink(r.crm_links?.account),
              reason: r.reason || "",
              matched_via: r.matched_via || "",
            });
            // Apply Excel hyperlink styling (blue underline) to the
            // four CRM-link cells when populated. Skip cells where
            // the value is plain text ("").
            for (const key of ["link_active_lead","link_active_deal","link_client_deal","link_account"]) {
              const cell = row.getCell(key);
              if (cell.value && typeof cell.value === "object" && "hyperlink" in (cell.value as any)) {
                cell.font = { color: { argb: "FF1D4ED8" }, underline: true };
              }
            }
            // Existing-client highlighting (Sample User 2026-06-23) — colour CS clients
            // the way the operator hand-marked them so the sales lead can't miss
            // them: RED = existing ACTIVE client (do not contact), ORANGE =
            // churned client (recent / cool-off), AMBER = possible client (verify).
            let fill = severityFill[r.executive_severity] || null;
            const reasonStr = String(r.reason || "");
            if (r.verdict === "block") {
              fill = "FFFFC7CE"; // red — existing active client
            } else if (r.verdict === "review" && reasonStr.startsWith("recently_churned")) {
              fill = "FFFFD27F"; // orange — churned within cool-off
            } else if (r.verdict === "review") {
              fill = "FFFFE699"; // amber — possible client, verify
            }
            if (fill) {
              row.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: fill },
              };
            }
            row.alignment = { vertical: "top", wrapText: true };
          }

          findings.eachRow((row: any) => {
            row.eachCell((cell: any) => {
              cell.border = {
                top: { style: "thin", color: { argb: "FFE2E8F0" } },
                left: { style: "thin", color: { argb: "FFE2E8F0" } },
                bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
                right: { style: "thin", color: { argb: "FFE2E8F0" } },
              };
            });
          });

          const buf = await wb.xlsx.writeBuffer();
          const stamp = new Date()
            .toISOString()
            .slice(0, 16)
            .replace("T", "_")
            .replace(":", "");
          c.header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          );
          c.header(
            "Content-Disposition",
            `attachment; filename="preflight-report_${stamp}.xlsx"`,
          );
          return c.body(buf as ArrayBuffer);
        } catch (error: any) {
          logger.error("Error exporting preflight xlsx:", error);
          return c.json(
            { error: "Failed to export — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/preflight",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: any = {};
          try {
            body = (await c.req.json()) ?? {};
          } catch {
            return c.json(
              { error: "Body must be JSON: { rows: [...], max_check?: number }" },
              400,
            );
          }
          if (!Array.isArray(body.rows)) {
            return c.json(
              { error: "rows must be an array of row objects" },
              400,
            );
          }
          if (body.rows.length === 0) {
            return c.json(
              { error: "rows must contain at least one entry" },
              400,
            );
          }

          const { runPreflight } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          const result = await runPreflight({
            rows: body.rows,
            max_check:
              typeof body.max_check === "number" ? body.max_check : undefined,
            // Opt-in: when the operator wants a fresh CS overlap verdict
            // (e.g. they just nudged a Phase in Zoho), pass
            // ?refresh_overlap=true in the body. Default false keeps the
            // batch endpoint fast.
            refresh_overlap: body.refresh_overlap === true,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running preflight:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Per-row "↻ Re-check from CRM" (Sample User 2026-06-25). After the operator
    // corrects a mis-tagged client in Zoho, this re-fetches ONLY that company's
    // deals from Zoho, busts the CS-client directory cache, and re-runs the
    // preflight verdict for the affected rows — so a stale BLOCK flips to PASS
    // in seconds without re-uploading or waiting for the full scan. Reuses the
    // exact resync logic as scripts/resyncCorrectedDeals.ts.
    path: "/api/duplicates/preflight/recheck",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: any = {};
          try {
            body = (await c.req.json()) ?? {};
          } catch {
            return c.json(
              { error: "Body must be JSON: { domains?: [], names?: [], rows: [...] }" },
              400,
            );
          }
          if (!Array.isArray(body.rows) || body.rows.length === 0) {
            return c.json({ error: "rows must contain at least one entry" }, 400);
          }
          const domains: string[] = Array.isArray(body.domains)
            ? body.domains.filter((d: any) => typeof d === "string" && d.trim())
            : [];
          const names: string[] = Array.isArray(body.names)
            ? body.names.filter((n: any) => typeof n === "string" && n.trim())
            : [];
          if (!domains.length && !names.length) {
            return c.json(
              { error: "Provide at least one domain or company name to re-sync" },
              400,
            );
          }

          // 1) Re-fetch this company's deals from Zoho + bust the directory cache.
          const { resyncCompanyDealsFromZoho } = await import(
            "../../utils/duplicateRadarResync"
          );
          const resync = await resyncCompanyDealsFromZoho([{ domains, names }]);

          // 2) Re-run preflight for the affected rows against the fresh data.
          //    refresh_overlap=true so the CS verdict is recomputed, not cached.
          const { runPreflight } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          const result = await runPreflight({
            rows: body.rows,
            refresh_overlap: true,
          });

          return c.json({
            success: true,
            resync: {
              updated: resync.updated,
              missing: resync.missing,
              scanned: resync.scanned,
            },
            rows: result.rows,
            summary: result.summary,
          });
        } catch (error: any) {
          logger.error("Error in preflight recheck:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Sample User 2026-06-17 — Account merge candidates surface. Returns the
    // set of domains that have ≥2 clusters in active/resolved status,
    // grouped so the operator picks a master and merges the rest in.
    // Read-only.
    path: "/api/duplicates/cluster-merge-candidates",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "200", 10);
          const cmSegment = url.searchParams.get("segment") || undefined;
          const { findSameDomainClusterDuplicates } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const r = await findSameDomainClusterDuplicates({
            limit,
            segment: cmSegment as any,
          });
          return c.json({ success: true, ...r });
        } catch (error: any) {
          logger.error("Error fetching cluster merge candidates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Admin-gated structural cluster merge. Reparents every record from
    // sourceClusterIds to targetClusterId, snapshots each source pre-
    // merge so the action is undo-able, writes one duplicate_merge_actions
    // row per source, deletes the now-empty source rows, and recomputes
    // the target's stats. Body:
    //   { target_cluster_id: number, source_cluster_ids: number[], notes?: string }
    path: "/api/duplicates/clusters/merge-into",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: ua } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return ua(c);

          const body = await c.req.json().catch(() => ({}));
          const targetId = Number(body?.target_cluster_id);
          const sourceIds = Array.isArray(body?.source_cluster_ids)
            ? body.source_cluster_ids.map((x: any) => Number(x))
            : [];
          if (!Number.isFinite(targetId) || targetId <= 0) {
            return c.json(
              { error: "target_cluster_id must be a positive integer" },
              400,
            );
          }
          if (sourceIds.length === 0) {
            return c.json(
              { error: "source_cluster_ids must contain at least one id" },
              400,
            );
          }
          const { mergeClustersIntoMaster } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const r = await mergeClustersIntoMaster({
            sourceClusterIds: sourceIds,
            targetClusterId: targetId,
            performedBy: sessionUser.email || "admin",
            notes: typeof body?.notes === "string" ? body.notes : undefined,
          });
          logger.info(
            `🔁 [DuplicateRadar] Cluster merge: target=#${r.target_cluster_id}, sources=[${r.source_cluster_ids.join(",")}], records_moved=${r.records_moved}, deleted=${r.source_clusters_deleted}, by=${sessionUser.email || "admin"}`,
          );
          return c.json({ success: true, ...r });
        } catch (error: any) {
          logger.error("Error merging clusters:", error);
          return c.json(
            { error: error?.message || "Cluster merge failed" },
            500,
          );
        }
      };
    },
  },

  // ── Empty / Orphaned Records cleanup tab (Sample User 2026-06-25) ──────────────
  // Surfaces orphaned/empty/test records → admin tags them "Empty-Delete" (HITL,
  // never auto-deletes; admin deletes in Zoho). Detection off local data; the
  // only live Zoho call is the lazy per-account attachment check.
  {
    path: "/api/duplicates/empty-records/deals",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const { getEmptyDeals } = await import("../../utils/emptyRecordsDatabase");
        return c.json({ success: true, rows: await getEmptyDeals() });
      } catch (e: any) {
        logger.error("empty-records/deals failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    path: "/api/duplicates/empty-records/accounts",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const { getEmptyAccounts } = await import("../../utils/emptyRecordsDatabase");
        return c.json({ success: true, rows: await getEmptyAccounts() });
      } catch (e: any) {
        logger.error("empty-records/accounts failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    path: "/api/duplicates/empty-records/contacts",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const { getEmptyContacts } = await import("../../utils/emptyRecordsDatabase");
        return c.json({ success: true, rows: await getEmptyContacts() });
      } catch (e: any) {
        logger.error("empty-records/contacts failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Lazy per-account attachment count — Delete stays disabled in the UI until
    // this confirms 0 (so we never tag an account holding a signed contract).
    path: "/api/duplicates/empty-records/accounts/:id/attachments",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const id = c.req.param("id");
        if (!id) return c.json({ error: "account id required" }, 400);
        let atts: any[] = [];
        try {
          atts = await fetchRecordAttachments("Accounts", id);
        } catch (e: any) {
          return c.json({ error: `Zoho attachments fetch failed: ${e?.message || e}` }, 502);
        }
        // An account is only truly empty when it ALSO has no live deals/contacts —
        // the local mirror can be stale, so confirm against Zoho here too (Sample User
        // 2026-06-26: real accounts with deals were wrongly shown as deletable).
        let dealsCount = 0;
        let contactsCount = 0;
        try {
          const deals = await fetchZohoRelatedRecords("Accounts", id, "Deals", { perPage: 1 });
          dealsCount = Array.isArray(deals) ? deals.length : 0;
          const contacts = await fetchZohoRelatedRecords("Accounts", id, "Contacts", { perPage: 1 });
          contactsCount = Array.isArray(contacts) ? contacts.length : 0;
        } catch (e: any) {
          // Inconclusive → fail safe: report it as not-empty so it is NOT tagged.
          return c.json({ error: `Zoho related-list fetch failed: ${e?.message || e}` }, 502);
        }
        return c.json({
          count: Array.isArray(atts) ? atts.length : 0,
          deals: dealsCount,
          contacts: contactsCount,
        });
      } catch (e: any) {
        logger.error("empty-records attachment check failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Per-row "Check documents" — read-only live emptiness check for a single
    // Accounts/Deals/Contacts record (same shared gate AI-Apply uses). Returns
    // { empty, reason, ghost, tagged }; makes NO change.
    path: "/api/duplicates/empty-records/:module/:id/check-empty",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const module = String(c.req.param("module") || "");
        const id = c.req.param("id");
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        if (!id) return c.json({ error: "record id required" }, 400);
        const { checkRecordEmptiness, pruneGhostRecords } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        const r = await checkRecordEmptiness(module as "Deals" | "Accounts" | "Contacts", id);
        // GHOST (already deleted in Zoho) → PRUNE our mirror copy here (Sample User
        // 2026-07-19). The UI removed the row locally on `ghost`, but nothing was
        // persisted, so the very next Refresh re-fetched it from the mirror and it
        // "came back". Pruning makes the removal durable. We only delete OUR copy
        // of a record Zoho no longer has — the platform never deletes in Zoho.
        let pruned = false;
        if (r.ghost) {
          try {
            await pruneGhostRecords([String(id)]);
            pruned = true;
          } catch (pe: any) {
            logger.warn(
              `[check-empty] ghost prune failed (non-fatal) for ${module} ${id}: ${pe?.message || pe}`,
            );
          }
        }
        return c.json({ ...r, pruned });
      } catch (e: any) {
        logger.error("empty-records check-empty failed", e);
        return c.json({ error: `check failed: ${e?.message || e}` }, 502);
      }
    },
  },
  {
    // Read-only BATCH emptiness check — verifies a whole page of ids in ONE request
    // (auto-check on fetch, without firing 50 separate calls that trip the rate
    // limit). Makes NO change. Body: { module, zohoIds[] }.
    path: "/api/duplicates/empty-records/check-batch",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        const zohoIds = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean)
          : [];
        if (!zohoIds.length) return c.json({ success: true, results: [] });
        const { getEmptinessBatch } = await import("../../utils/emptyRecordsDatabase");
        const results = await getEmptinessBatch(module as "Deals" | "Accounts" | "Contacts", zohoIds);
        return c.json({ success: true, results });
      } catch (e: any) {
        logger.error("empty-records check-batch failed", e);
        return c.json({ error: `batch check failed: ${e?.message || e}` }, 502);
      }
    },
  },
  {
    // Smart Account Inference suggestion for an orphaned deal (link, not delete).
    path: "/api/duplicates/empty-records/deals/:id/account-suggestion",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const id = c.req.param("id");
        if (!id) return c.json({ error: "deal id required" }, 400);
        const { pool } = await import("../../utils/duplicateRadarDatabase");
        const dr = await pool.query(
          `SELECT zoho_record_id, raw_data FROM duplicate_records
            WHERE record_type='deal' AND zoho_record_id=$1 LIMIT 1`,
          [id],
        );
        if (!dr.rows.length) return c.json({ suggestion: null });
        const { inferAccountForDeal } = await import("../../utils/accountInference");
        const inf = await inferAccountForDeal(dr.rows[0] as any);
        return c.json({
          suggestion: inf
            ? {
                accountId: inf.account.zoho_record_id,
                accountName: inf.account.account_name || inf.account.company_name || "",
                confidence: inf.confidence,
              }
            : null,
        });
      } catch (e: any) {
        logger.error("empty-records account-suggestion failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: append the Empty-Delete tag (batched by 100). Never deletes.
    path: "/api/duplicates/empty-records/tag",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        const zohoIds: string[] = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean)
          : [];
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
        const tag = process.env.EMPTY_DELETE_TAG || "Empty-Delete";
        const { addZohoTags } = await import("../../utils/zohoCRM");
        const { markEmptyDeleteTagged } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        let tagged = 0;
        for (let i = 0; i < zohoIds.length; i += 100) {
          const batch = zohoIds.slice(i, i + 100);
          await addZohoTags(module, batch, [tag]);
          // Record locally so the cleanup list drops them on the NEXT refresh,
          // without waiting for the slow full sync to re-pull the Zoho tag.
          await markEmptyDeleteTagged(module, batch, su?.email || null);
          tagged += batch.length;
        }
        return c.json({ success: true, tagged, tag });
      } catch (e: any) {
        logger.error("empty-records/tag failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated undo: remove the Empty-Delete tag from the given records.
    path: "/api/duplicates/empty-records/untag",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        const zohoIds: string[] = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean)
          : [];
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
        const tag = process.env.EMPTY_DELETE_TAG || "Empty-Delete";
        const { unmarkEmptyDeleteTagged } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        let untagged = 0;
        for (let i = 0; i < zohoIds.length; i += 100) {
          const batch = zohoIds.slice(i, i + 100);
          await removeZohoTags(module, batch, [tag]);
          await unmarkEmptyDeleteTagged(batch);
          untagged += batch.length;
        }
        return c.json({ success: true, untagged });
      } catch (e: any) {
        logger.error("empty-records/untag failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: Dismiss flagged records as "reviewed — keep, NOT empty"
    // (false positives, e.g. a deal that actually has data). They drop off the
    // cleanup list durably and never reappear. No Zoho write.
    path: "/api/duplicates/empty-records/dismiss",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        const undo = body?.undo === true;
        const zohoIds: string[] = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean)
          : [];
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
        const { markEmptyRecordsDismissed, undismissEmptyRecords } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        if (undo) {
          await undismissEmptyRecords(zohoIds);
          return c.json({ success: true, undismissed: zohoIds.length });
        }
        await markEmptyRecordsDismissed(module, zohoIds, su?.email || null);
        return c.json({ success: true, dismissed: zohoIds.length });
      } catch (e: any) {
        logger.error("empty-records/dismiss failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: link an orphaned deal to an account (re-parent in Zoho).
    path: "/api/duplicates/empty-records/link-deal",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const dealId = String(body?.dealId || "");
        const accountId = String(body?.accountId || "");
        if (!dealId || !accountId) return c.json({ error: "dealId and accountId required" }, 400);
        const { updateZohoRecord } = await import("../../utils/zohoCRM");
        await updateZohoRecord("Deals", dealId, { Account_Name: { id: accountId } });
        return c.json({ success: true });
      } catch (e: any) {
        logger.error("empty-records/link-deal failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Read-access: show every ledger row + counts for the "Tagged · pending delete"
    // sub-section.  No Zoho call; purely our own ledger.
    path: "/api/duplicates/empty-records/tagged-status",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const module = c.req.query("module") || undefined;
        const { getTaggedStatus } = await import("../../utils/emptyRecordsDatabase");
        const result = await getTaggedStatus(module);
        return c.json({ success: true, ...result });
      } catch (e: any) {
        logger.error("empty-records/tagged-status failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Manually dismiss ONE tagged record from the pending queue — local ledger
    // disposition (pending_delete → dismissed), no Zoho write.
    //   POST /api/duplicates/empty-records/dismiss-tagged  { zohoId }
    path: "/api/duplicates/empty-records/dismiss-tagged",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const body = await c.req.json().catch(() => ({}));
        // Bulk path: { zohoIds: [...] } dismisses many in ONE query so a whole
        // page can be cleared without one request per row (the 429 source).
        const manyRaw = Array.isArray(body?.zohoIds)
          ? body.zohoIds
          : Array.isArray(body?.zoho_ids)
            ? body.zoho_ids
            : null;
        if (manyRaw) {
          const { dismissTaggedRecords } = await import("../../utils/emptyRecordsDatabase");
          const dismissed = await dismissTaggedRecords(manyRaw.map((x: any) => String(x)));
          return c.json({ success: true, dismissed });
        }
        const zohoId = String(body?.zohoId ?? body?.zoho_id ?? "").trim();
        if (!zohoId) return c.json({ error: "zohoId or zohoIds required" }, 400);
        const { dismissTaggedRecord } = await import("../../utils/emptyRecordsDatabase");
        await dismissTaggedRecord(zohoId);
        return c.json({ success: true, dismissed: 1 });
      } catch (e: any) {
        logger.error("empty-records/dismiss-tagged failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Accounts carrying MORE THAN ONE OPEN deal — the "one active deal per
    // Account" rule. ?multi_owner=1 narrows to the collision case Sales cares
    // about most: the same account worked by two different people.
    // GET /api/duplicates/multi-active-deals?segment=&multi_owner=1&limit=
    path: "/api/duplicates/multi-active-deals",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const url = new URL(c.req.url);
        // Defaults to ExampleOrg, NOT all: the rule compares deals within ONE
        // product layout, so an unscoped call would flag a ExampleOrg deal and a
        // WalaOne deal on the same company as a collision when they are two
        // legitimate sales.
        const segment = (url.searchParams.get("segment") || "ExampleOrg") as any;
        const multiOwnerOnly = url.searchParams.get("multi_owner") === "1";
        const limitRaw = parseInt(url.searchParams.get("limit") || "", 10);
        const { getMultiActiveDealAccounts } = await import(
          "../../utils/duplicateRadarDatabase"
        );
        // ALWAYS fetch unfiltered, then narrow. The headline counts describe the
        // whole problem — "companies with more than one open deal" and "…worked
        // by more than one person" — and must not change when the operator
        // ticks the filter. Computing them from the filtered set made both
        // cards show the same number whenever the box was ticked (found while
        // testing the tab, 2026-08-25).
        const all = await getMultiActiveDealAccounts(segment, {
          multiOwnerOnly: false,
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
        });
        const multiOwner = all.filter((r) => r.distinct_owners > 1);
        const rows = multiOwnerOnly ? multiOwner : all;
        return c.json({
          success: true,
          segment,
          // Both counts, always — different problems with different owners.
          accounts_with_multiple_open_deals: all.length,
          accounts_with_multiple_owners: multiOwner.length,
          // Deals and value describe the LISTED rows, so the cards and the
          // table always add up to each other.
          total_open_deals_in_violation: rows.reduce((a, r) => a + r.open_deals, 0),
          total_open_value: Math.round(rows.reduce((a, r) => a + r.total_open_value, 0)),
          accounts: rows,
        });
      } catch (e: any) {
        logger.error("multi-active-deals failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },

  {
    // The same conflicts as an Excel workbook, for attaching to the flag that
    // goes to the Head of Sales. Two sheets:
    //   "Duplicated deals" — ONE ROW PER DEAL, because the recipient acts on
    //      individual deals: they sort by owner, filter to their own name and
    //      paste rows into a task list. A cell holding three deals cannot be
    //      sorted or filtered, which is what makes a CSV of grouped text
    //      useless in practice.
    //   "Summary"          — one row per company, for the covering read.
    // GET /api/duplicates/multi-active-deals.xlsx?segment=&multi_owner=1
    path: "/api/duplicates/multi-active-deals.xlsx",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const url = new URL(c.req.url);
        const segment = (url.searchParams.get("segment") || "ExampleOrg") as any;
        const multiOwnerOnly = url.searchParams.get("multi_owner") === "1";
        const { getMultiActiveDealAccounts } = await import(
          "../../utils/duplicateRadarDatabase"
        );
        // DELIBERATE DEVIATION from Engineering SOP §25 ("all new export
        // endpoints MUST use streamXlsx/streamCsv"). That rule exists to keep
        // RSS flat for exports of unbounded size. This one is bounded by the
        // number of CONFLICTS — tens of accounts, ~40 deals, a ~9 KB file — so
        // the memory argument does not apply, and the streaming path is what
        // is actually broken here: on this deployment every staged export took
        // the whole instance down (measured repeatedly 2026-08-25; the same
        // code produces a correct workbook on a developer machine). Building
        // the workbook in memory skips the PassThrough, the ReadableStream,
        // the temp-file staging and its cache entirely.
        const { buildWorkbook } = await import("../../utils/excelExport");
        const { buildMultiActiveDealSheets, multiActiveDealsFilename } =
          await import("../../utils/multiActiveDealsExport");
        const everything = await getMultiActiveDealAccounts(segment, {
          multiOwnerOnly: false,
          limit: 2000,
        });
        const rows = multiOwnerOnly
          ? everything.filter((r) => r.distinct_owners > 1)
          : everything;
        const sheets = buildMultiActiveDealSheets(rows, {
          segment: String(segment),
          multiOwnerOnly,
        });
        // Audit trail — same table every other export writes to, so "who
        // pulled the client list and when" stays answerable. Non-blocking.
        try {
          await createExportLog({
            export_type: "multi_active_deals" as any,
            filter_criteria: { segment, multi_owner: multiOwnerOnly },
            total_records_exported: rows.reduce((n, r) => n + r.open_deals, 0),
            file_format: "xlsx",
            exported_by:
              (user as any).email ||
              (user as any).name ||
              `user:${(user as any).userId ?? "unknown"}`,
          });
        } catch (logErr) {
          logger.warn(
            "[DuplicateRadar] multi-active-deals export log write failed (non-blocking):",
            logErr,
          );
        }
        const buf = await buildWorkbook(
          sheets.map((s) => ({ ...s, rows: s.rows as Record<string, any>[] })),
          { title: `Active deal conflicts — ${segment} layout` },
        );
        return new Response(new Uint8Array(buf), {
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${multiActiveDealsFilename(String(segment))}"`,
            "Content-Length": String(buf.length),
          },
        });
      } catch (e: any) {
        logger.error("multi-active-deals.xlsx failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },

  {
    // Admin-gated: general deletion-reconcile — verify a rotating batch of
    // records against live Zoho and PRUNE the ones deleted/merged in the CRM
    // (incremental sync never reports deletions, so they linger + keep their
    // cluster showing). POST /api/duplicates/reconcile-deleted { module?, limit? }
    path: "/api/duplicates/reconcile-deleted",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = body?.module ? String(body.module) : undefined;
        const limit = typeof body?.limit === "number" ? body.limit : undefined;
        const clusterIds = Array.isArray(body?.clusterIds)
          ? body.clusterIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
          : undefined;
        // activeClustersOnly (Sample User 2026-07-15): the global "Verify & prune
        // deleted" button (available on every tab) has no single cluster in
        // view, so it asks for an immediate pass over ALL open/visible clusters
        // — prunes the ghosts users actually see now, while the background
        // full id-set reconcile handles the long tail.
        const activeClustersOnly = body?.activeClustersOnly === true;
        const { reconcileDeletedRecords } = await import("../../utils/emptyRecordsDatabase");
        const r = await reconcileDeletedRecords({
          module,
          limit,
          clusterIds,
          activeClustersOnly,
        });
        return c.json({ success: true, ...r });
      } catch (e: any) {
        logger.error("reconcile-deleted failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: DEFINITIVE deletion reconcile (Sample User 2026-07-15). Diffs the
    // WHOLE mirror against Zoho's live id set and prunes every record no longer
    // in Zoho — catches HARD-deleted / long-ago / null-module ghosts the /deleted
    // feed and the rotating verify miss. Fetches all ids per module, so it runs
    // as a fire-and-forget BACKGROUND job (returns immediately; watch the logs
    // for [id-set-reconcile]). Safety-capped (won't mass-prune on a partial fetch).
    // POST /api/duplicates/reconcile-deleted-full
    path: "/api/duplicates/reconcile-deleted-full",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const { reconcileAllDeletedByIdSet, sweepDeletedByFeed } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        // Fire-and-forget — takes a few minutes; don't hold the request.
        // TWO passes (Sample User 2026-07-23):
        //   1) sweepDeletedByFeed — asks Zoho's /deleted feed DIRECTLY which
        //      records it removed (authoritative, bulk-paginated) and prunes
        //      exactly those. This CATCHES bulk "uploaded then removed" batches
        //      the id-set reconcile can't, because it never needs a complete live
        //      id set and so never hits the 40% safety abort.
        //   2) reconcileAllDeletedByIdSet — the id-set diff, as a backstop for
        //      anything the /deleted feed's lookback missed (aborts safely if it
        //      can't fetch a complete live set).
        void (async () => {
          try {
            const feed = await sweepDeletedByFeed({ lookbackDays: 90 });
            logger.info("[reconcile-deleted-full] feed sweep complete", feed);
          } catch (e) {
            logger.error("[reconcile-deleted-full] feed sweep failed", e);
          }
          try {
            const idset = await reconcileAllDeletedByIdSet();
            logger.info("[reconcile-deleted-full] id-set complete", idset);
          } catch (e) {
            logger.error("[reconcile-deleted-full] id-set failed", e);
          }
        })();
        return c.json({
          success: true,
          started: true,
          message:
            "Deep clean started — first asks Zoho's deleted-records feed exactly what was removed (catches bulk deletions), then reconciles the full id set as a backstop. Runs in the background (a few minutes); the tabs clear as it finishes.",
        });
      } catch (e: any) {
        logger.error("reconcile-deleted-full failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: manually trigger the deletion-reconcile pass (also runs
    // automatically on every post-sync).  Checks pending_delete rows against
    // live Zoho; stamps ledger 'deleted' + prunes mirror when gone.
    path: "/api/duplicates/empty-records/recheck-deletions",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = body?.module ? String(body.module) : undefined;
        const { reconcileEmptyDeleteDeletions } = await import("../../utils/emptyRecordsDatabase");
        const r = await reconcileEmptyDeleteDeletions(module);
        return c.json({ success: true, ...r });
      } catch (e: any) {
        logger.error("empty-records/recheck-deletions failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: AI-Apply batch — verify each empty candidate against Zoho
    // (prune ghosts, skip docs/protected stages), then tag survivors Empty-Delete.
    // Never deletes in Zoho; the admin removes tagged records.
    path: "/api/duplicates/empty-records/ai-apply",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        const limit =
          Number.isFinite(body?.limit) && body.limit > 0
            ? Math.floor(body.limit)
            : undefined;
        const { aiApplyEmptyDelete } = await import("../../utils/emptyRecordsDatabase");
        const AGENT =
          "Adam — GRQ Assistant (on behalf of " + (su?.email || "operator") + ")";
        const r = await aiApplyEmptyDelete(
          module as "Deals" | "Accounts" | "Contacts",
          { limit, by: AGENT },
        );
        return c.json({ success: true, ...r });
      } catch (e: any) {
        logger.error("empty-records/ai-apply failed", e);
        // Admin-gated debug tool: surface the REAL error so the operator can see
        // WHAT failed (Sample User 2026-07-15 — the opaque "internal error" was
        // undiagnosable). Zoho rate-limit/timeout during an active sync is the
        // usual cause; the message makes that visible instead of hiding it.
        const detail =
          e instanceof Error ? e.message : String(e || "unknown error");
        return c.json({ error: detail.slice(0, 400) }, 500);
      }
    },
  },
  {
    // Admin-gated: live-verify the ids the operator currently sees on a page
    // against Zoho (the same gate AI-Apply uses) WITHOUT tagging — confirms which
    // are genuinely empty, auto-Dismisses any that turn out to have deals/contacts,
    // and prunes ghosts. Bounded by the caller to one visible page.
    path: "/api/duplicates/empty-records/verify-page",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        const zohoIds = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean).slice(0, 100)
          : [];
        if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
        const { verifyEmptyCandidates } = await import("../../utils/emptyRecordsDatabase");
        const AGENT =
          "Adam — GRQ Assistant (on behalf of " + (su?.email || "operator") + ")";
        const r = await verifyEmptyCandidates(
          module as "Deals" | "Accounts" | "Contacts",
          zohoIds,
          AGENT,
        );
        return c.json({ success: true, ...r });
      } catch (e: any) {
        logger.error("empty-records/verify-page failed", e);
        const detail =
          e instanceof Error ? e.message : String(e || "unknown error");
        return c.json({ error: detail.slice(0, 400) }, 500);
      }
    },
  },
  {
    // All CORPORATE existing-client domains with NO churn (Sample User 2026-07-23) —
    // a do-not-cold-contact suppression list. Reads the corporate-scoped CS
    // client directory and returns the ACTIVE (no-churn) domains.
    //   ?format=json (default) | csv | txt
    //   ?fresh=1  rebuild the directory from the DB first (slower, authoritative)
    path: "/api/duplicates/preflight/active-client-domains",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const format = String(c.req.query("format") || "json").toLowerCase();
          const fresh = ["1", "true", "yes"].includes(
            String(c.req.query("fresh") || "").toLowerCase(),
          );
          // ?doam=0 → CRM-active only (no DOAM overlay) for a clean ClientHub
          // reconciliation, since ClientHub doesn't track the DOAM channel.
          const includeDoam = !["0", "false", "no"].includes(
            String(c.req.query("doam") || "").toLowerCase(),
          );
          const { listActiveClientDomains } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          const {
            domains,
            rows,
            total,
            ExampleOrg_count,
            doam_count,
            qualifying_deals,
            missing_company_domain,
            dropped_junk,
            built_at_iso,
            criteria,
          } = await listActiveClientDomains({ fresh, includeDoam });
          if (format === "csv" || format === "txt") {
            const stamp = built_at_iso.slice(0, 10);
            const body =
              format === "csv"
                ? "domain,product\n" +
                  rows
                    .map((r) => `"${r.domain.replace(/"/g, '""')}",${r.product}`)
                    .join("\n")
                : domains.join("\n");
            return new Response(body, {
              status: 200,
              headers: {
                "Content-Type":
                  format === "csv"
                    ? "text/csv; charset=utf-8"
                    : "text/plain; charset=utf-8",
                "Content-Disposition": `attachment; filename="active-client-domains_${stamp}.${format}"`,
                "Cache-Control": "no-store",
              },
            });
          }
          return c.json({
            success: true,
            total,
            ExampleOrg_count,
            doam_count,
            qualifying_deals,
            missing_company_domain,
            dropped_junk,
            criteria,
            built_at_iso,
            rows,
            domains,
          });
        } catch (e: any) {
          logger.error("preflight/active-client-domains failed", e);
          const detail =
            e instanceof Error ? e.message : String(e || "unknown error");
          return c.json({ error: detail.slice(0, 400) }, 500);
        }
      };
    },
  },
  {
    // GROUND-TRUTH: for a list of domains, does the CRM have an Agreement
    // Signed / Paid deal? Returns every deal + stage per domain (Sample User
    // 2026-07-26). POST { domains: string[] } | ?format=csv for a flat export.
    path: "/api/duplicates/preflight/domain-deal-stages",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          // Accept an array, or a newline/comma-separated string.
          let domains: string[] = [];
          if (Array.isArray(body?.domains)) {
            domains = body.domains.map((x: any) => String(x));
          } else if (typeof body?.domains === "string") {
            domains = body.domains.split(/[\s,;]+/);
          }
          domains = domains.map((d) => d.trim()).filter(Boolean).slice(0, 2000);
          if (!domains.length) {
            return c.json({ error: "Provide domains: string[] or a delimited string." }, 400);
          }
          const { checkDomainsForClientDeals } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          const { checked_at_iso, results } =
            await checkDomainsForClientDeals(domains);
          const format = String(c.req.query("format") || "json").toLowerCase();
          if (format === "csv") {
            const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
            const rows = [
              "domain,in_crm,has_signed_or_paid,phases,stages,deal_count,deal_detail",
            ];
            for (const r of results) {
              rows.push(
                [
                  esc(r.input),
                  r.in_crm ? "yes" : "no",
                  r.has_signed_or_paid ? "yes" : "no",
                  esc(r.phases.join(" | ")),
                  esc(r.stages.join(" | ")),
                  r.deals.length,
                  esc(
                    r.deals
                      .map(
                        (d) =>
                          `${d.name} [stage=${d.stage}; phase=${d.phase || "-"}; churn=${d.churn_date || "-"}; renewal=${d.renewal_date || "-"}]`,
                      )
                      .join(" | "),
                  ),
                ].join(","),
              );
            }
            return new Response(rows.join("\n"), {
              status: 200,
              headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="domain-deal-stages_${checked_at_iso.slice(0, 10)}.csv"`,
                "Cache-Control": "no-store",
              },
            });
          }
          const summary = {
            total: results.length,
            with_signed_or_paid: results.filter((r) => r.has_signed_or_paid).length,
            in_crm_other_stage: results.filter(
              (r) => r.in_crm && !r.has_signed_or_paid,
            ).length,
            not_in_crm: results.filter((r) => !r.in_crm).length,
          };
          return c.json({ success: true, checked_at_iso, summary, results });
        } catch (e: any) {
          logger.error("preflight/domain-deal-stages failed", e);
          const detail =
            e instanceof Error ? e.message : String(e || "unknown error");
          return c.json({ error: detail.slice(0, 400) }, 500);
        }
      };
    },
  },
  {
    // GET twin of domain-deal-stages so the CSV can be pulled by URL (paste in
    // the browser → download) to hand to CS. ?domains=<REDACTED_HOST>,<REDACTED_HOST> (comma/space
    // separated); defaults to CSV, ?format=json for the full JSON.
    path: "/api/duplicates/preflight/domain-deal-stages",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const domains = String(c.req.query("domains") || "")
            .split(/[\s,;]+/)
            .map((d) => d.trim())
            .filter(Boolean)
            .slice(0, 2000);
          if (!domains.length) {
            return c.json({ error: "Provide ?domains=<REDACTED_HOST>,<REDACTED_HOST>" }, 400);
          }
          const { checkDomainsForClientDeals } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          const { checked_at_iso, results } =
            await checkDomainsForClientDeals(domains);
          const format = String(c.req.query("format") || "csv").toLowerCase();
          if (format === "json") {
            const summary = {
              total: results.length,
              with_signed_or_paid: results.filter((r) => r.has_signed_or_paid).length,
              in_crm_other_stage: results.filter(
                (r) => r.in_crm && !r.has_signed_or_paid,
              ).length,
              not_in_crm: results.filter((r) => !r.in_crm).length,
            };
            return c.json({ success: true, checked_at_iso, summary, results });
          }
          const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
          const rows = [
            "domain,in_crm,has_signed_or_paid,phases,stages,deal_count,deal_detail",
          ];
          for (const r of results) {
            rows.push(
              [
                esc(r.input),
                r.in_crm ? "yes" : "no",
                r.has_signed_or_paid ? "yes" : "no",
                esc(r.phases.join(" | ")),
                esc(r.stages.join(" | ")),
                r.deals.length,
                esc(
                  r.deals
                    .map(
                      (d) =>
                        `${d.name} [stage=${d.stage}; phase=${d.phase || "-"}; churn=${d.churn_date || "-"}; renewal=${d.renewal_date || "-"}]`,
                    )
                    .join(" | "),
                ),
              ].join(","),
            );
          }
          return new Response(rows.join("\n"), {
            status: 200,
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="domain-deal-stages_${checked_at_iso.slice(0, 10)}.csv"`,
              "Cache-Control": "no-store",
            },
          });
        } catch (e: any) {
          logger.error("preflight/domain-deal-stages GET failed", e);
          const detail =
            e instanceof Error ? e.message : String(e || "unknown error");
          return c.json({ error: detail.slice(0, 400) }, 500);
        }
      };
    },
  },
  {
    // Data Cleaning Progress report — single source of truth for the
    // Cleaning Progress tab, its export, and Adam (getDataCleaningProgress,
    // duplicateRadarDatabase.ts). Mirrors the CS-lifecycle read routes above.
    //   GET /api/duplicates/cleaning-progress?segment=
    path: "/api/duplicates/cleaning-progress",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const segment = new URL(c.req.url).searchParams.get("segment") || "all";
          const { getDataCleaningProgress } = await import("../../utils/duplicateRadarDatabase");
          const result = await getDataCleaningProgress(segment as any);
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error building cleaning-progress report:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
];

export default duplicateRadarRoutes;
