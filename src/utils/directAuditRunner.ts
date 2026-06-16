import { createHash } from "crypto";
import {
  fetchAllZohoRecords,
  fetchRecordAttachments,
  analyzeRecordHygiene,
  calculateQualityScores,
  DEFAULT_GOVERNANCE_RULES,
  type ZohoCRMRecord,
  type HygieneIssue,
  type ZohoAttachmentMeta,
} from "./zohoCRM";
import { walaPlusAttachmentAuditRules } from "./governanceRules";
import { saveAuditResult, getGovernanceDocumentByModule } from "./database";

/**
 * Stable sha256 fingerprint of the EFFECTIVE rule set used for a quality
 * audit. Walks each module's rules in alphabetical order, captures only
 * the load-bearing fields (module, fieldName, ruleType, severity,
 * stageCondition, allowedValues), and serialises with sorted keys. The
 * same rule set always produces the same hash, regardless of object-key
 * order or extraneous fields, so two audits can be compared safely.
 *
 * Exported so the diagnostic endpoint can re-hash the current rules and
 * compare against any historical audit row's stored hash.
 */
export function computeAuditRulesHash(
  rulesByModule: Record<string, any[]>,
): string {
  const modules = Object.keys(rulesByModule).sort();
  const canonical: Record<string, any[]> = {};
  for (const m of modules) {
    const rules = Array.isArray(rulesByModule[m]) ? rulesByModule[m] : [];
    canonical[m] = rules
      .map((r: any) => ({
        module: r.module ?? null,
        fieldName: r.fieldName ?? null,
        ruleType: r.ruleType ?? null,
        severity: r.severity ?? null,
        stageCondition: Array.isArray(r.stageCondition)
          ? [...r.stageCondition].sort()
          : null,
        allowedValues: Array.isArray(r.allowedValues)
          ? [...r.allowedValues].sort()
          : null,
        pattern: r.pattern ?? null,
      }))
      .sort((a: any, b: any) => {
        const ak = `${a.module}|${a.fieldName}|${a.ruleType}|${a.severity}`;
        const bk = `${b.module}|${b.fieldName}|${b.ruleType}|${b.severity}`;
        return ak < bk ? -1 : ak > bk ? 1 : 0;
      });
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16); // 64-bit prefix — collision-resistant for this scale
}

const BATCH_SIZE = 500;
const MAX_RECORDS_PER_MODULE = 50000;
// Per-module cap on detailed (per-record) issues. Using a per-module quota
// instead of a single global cap guarantees every audited module — including
// Tasks and Accounts which are processed last — has real per-record entries
// in `all_issues` so the drill-down modal never has to fall back to a
// synthetic "summary_*" row. Total ceiling = MAX_DETAILED_PER_MODULE * 5 modules.
const MAX_DETAILED_PER_MODULE = 200;

function analyzeRecordBatch(
  records: ZohoCRMRecord[],
  governanceRules: any[],
  issueTypeCounts: Record<string, { count: number; severity: string; module: string }>,
  detailedIssues?: Array<{ recordId: string; module: string; owner: string; layouts: string; products: string; createdBy: string; createdTime: string; stage?: string; pipeline?: string; leadStatus?: string; fieldName: string; issueType: string; description: string; severity: string; suggestedFix: string }>,
  detailedCountsByModule?: Map<string, number>,
  recordIdsWithIssues?: Set<string>
): { issueCount: number; critical: number; high: number; medium: number; low: number; recordsWithIssues: number } {
  let issueCount = 0, critical = 0, high = 0, medium = 0, low = 0, recordsWithIssues = 0;
  for (const record of records) {
    const issues = analyzeRecordHygiene(record, governanceRules);
    issueCount += issues.length;
    if (issues.length > 0) {
      recordsWithIssues++;
      if (recordIdsWithIssues) recordIdsWithIssues.add(record.id);
    }
    for (const issue of issues) {
      if (issue.severity === 'critical') critical++;
      else if (issue.severity === 'high') high++;
      else if (issue.severity === 'medium') medium++;
      else low++;
      const key = `${issue.module}-${issue.issueType}`;
      if (!issueTypeCounts[key]) {
        issueTypeCounts[key] = { count: 0, severity: issue.severity, module: issue.module };
      }
      issueTypeCounts[key].count++;

      const moduleDetailedCount = detailedCountsByModule?.get(issue.module) ?? 0;
      if (detailedIssues && moduleDetailedCount < MAX_DETAILED_PER_MODULE) {
        const ownerData = record.data?.Owner;
        const ownerName = record.owner || (ownerData ? (ownerData.name || ownerData.id || '-') : '-');
        const createdByData = record.data?.Created_By;
        const createdByName = createdByData ? (createdByData.name || createdByData.id || '') : '';
        const layoutData = record.data?.Layout;
        // Zoho's REST API does not return a Layout field for Tasks records, so fall back
        // to "Standard" (the default layout name in Zoho) whenever the value is missing.
        // This keeps the dashboard's Issues by Layout view from showing a "(No Layout)" bucket.
        const layoutName = (layoutData ? (layoutData.name || (typeof layoutData === 'string' ? layoutData : '')) : '') || 'Standard';
        const productsRaw = record.data?.Product_Details;
        const productsName = (Array.isArray(productsRaw) && productsRaw.length > 0)
          ? productsRaw.map((p: any) => p.product?.name || '').filter(Boolean).join(', ')
          : (typeof record.data?.Products === 'object' ? record.data?.Products?.name : record.data?.Products) || record.data?.Product_Name || record.data?.Product || '';
        const stageRawF = record.data?.Stage ?? '';
        const stageNameF = typeof stageRawF === 'object' ? (stageRawF?.name || '') : String(stageRawF || '');
        const leadStatusRawF = record.data?.Lead_Status ?? '';
        const leadStatusNameF = typeof leadStatusRawF === 'object' ? (leadStatusRawF?.name || '') : String(leadStatusRawF || '');
        const pipelineRawF = record.data?.Pipeline ?? '';
        const pipelineNameF = typeof pipelineRawF === 'object' ? (pipelineRawF?.name || '') : String(pipelineRawF || '');
        detailedIssues.push({
          recordId: issue.recordId,
          module: issue.module,
          owner: ownerName,
          layouts: layoutName,
          products: productsName,
          createdBy: createdByName,
          createdTime: record.data?.Created_Time || record.createdTime || '',
          stage: stageNameF,
          leadStatus: leadStatusNameF,
          pipeline: pipelineNameF,
          fieldName: issue.fieldName || '',
          issueType: issue.issueType,
          description: issue.description,
          severity: issue.severity,
          suggestedFix: issue.suggestedFix || `Update the ${issue.fieldName || 'field'} in this record`,
        });
        if (detailedCountsByModule) {
          detailedCountsByModule.set(issue.module, moduleDetailedCount + 1);
        }
      }
    }
  }
  return { issueCount, critical, high, medium, low, recordsWithIssues };
}

// ─── Attachment audit helper ────────────────────────────────────────────────
// Returns aggregate counts and pushes per-record issues into the same data
// structures used by the field-rule pass (issueTypeCounts, detailedIssues).
async function runAttachmentAudit(
  records: ZohoCRMRecord[],
  issueTypeCounts: Record<string, { count: number; severity: string; module: string }>,
  detailedIssues: Array<any>,
  detailedCountsByModule: Map<string, number>,
  alreadyFlaggedRecordIds: Set<string>,
  logger?: any,
): Promise<{ issueCount: number; critical: number; high: number; medium: number; low: number; recordsScanned: number; newRecordsWithIssues: number }> {
  const cfg = walaPlusAttachmentAuditRules;
  const stageField = cfg.stageField;

  // Filter to records in audited stages (case-insensitive match against keys).
  const stageKeys = Object.keys(cfg.stages);
  const stageKeysLower = stageKeys.map(s => s.toLowerCase());
  const targets = records.filter(r => {
    const stage = String(r.data?.[stageField] || '').trim();
    return stage && stageKeysLower.includes(stage.toLowerCase());
  });

  if (targets.length === 0) {
    return { issueCount: 0, critical: 0, high: 0, medium: 0, low: 0, recordsScanned: 0, newRecordsWithIssues: 0 };
  }

  logger?.info(`📎 [DirectAudit] Attachment audit: ${targets.length} Deals in stages [${stageKeys.join(', ')}]`);

  const sevToBucket = (s: string) => (s === 'critical' ? 'critical' : s === 'high' ? 'high' : s === 'medium' ? 'medium' : 'low');
  let issueCount = 0, critical = 0, high = 0, medium = 0, low = 0;
  const recordsWithAttachmentIssues = new Set<string>();

  // Bounded parallel fetch.
  let cursor = 0;
  const concurrency = Math.max(1, cfg.fetchConcurrency || 6);
  const failed: string[] = [];

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const rec = targets[idx];
      const rawStage = String(rec.data?.[stageField] || '').trim();
      const stageKey = stageKeys.find(k => k.toLowerCase() === rawStage.toLowerCase());
      if (!stageKey) continue;
      const stageRule = cfg.stages[stageKey];

      let attachments: ZohoAttachmentMeta[] = [];
      try {
        attachments = await fetchRecordAttachments(cfg.module, rec.id);
      } catch (e) {
        failed.push(rec.id);
        continue;
      }

      const recordIssues: HygieneIssue[] = [];

      // Rule 1: presence — no attachments at all.
      if (attachments.length === 0) {
        recordIssues.push({
          recordId: rec.id,
          module: cfg.module,
          issueType: 'missing_required_document',
          fieldName: 'Attachments',
          description: `${stageRule.description} No attachments found on this record.`,
          severity: stageRule.severityIfMissing,
          suggestedFix: `Upload a document whose filename contains one of: ${stageRule.keywords.join(', ')}`,
        });
      } else {
        // Rule 2: type — at least one attachment must match keywords.
        const lowerNames = attachments.map(a => (a.fileName || '').toLowerCase());
        const matchesKeyword = stageRule.keywords.some(kw => {
          const kwLower = kw.toLowerCase();
          return lowerNames.some(n => n.includes(kwLower));
        });
        if (!matchesKeyword) {
          recordIssues.push({
            recordId: rec.id,
            module: cfg.module,
            issueType: 'wrong_document_type',
            fieldName: 'Attachments',
            description: `${stageRule.description} ${attachments.length} file(s) attached but none match the required document type.`,
            severity: stageRule.severityIfWrongType,
            suggestedFix: `Upload a document whose filename contains one of: ${stageRule.keywords.join(', ')}`,
          });
        }
      }

      // Rule 3 (universal): empty / dangerous extensions on any attachment.
      for (const a of attachments) {
        const fnLower = (a.fileName || '').toLowerCase();
        if (a.fileSizeBytes === 0) {
          recordIssues.push({
            recordId: rec.id,
            module: cfg.module,
            issueType: 'empty_attachment_file',
            fieldName: 'Attachments',
            description: `Attachment "${a.fileName}" is 0 bytes (corrupt or empty upload).`,
            severity: 'critical',
            suggestedFix: `Delete the empty file and re-upload the correct document.`,
          });
        }
        if (cfg.dangerousExtensions.some(ext => fnLower.endsWith(ext))) {
          recordIssues.push({
            recordId: rec.id,
            module: cfg.module,
            issueType: 'dangerous_attachment_extension',
            fieldName: 'Attachments',
            description: `Attachment "${a.fileName}" has a disallowed/executable extension.`,
            severity: 'critical',
            suggestedFix: `Remove the file. Only document formats (pdf, docx, xlsx) should be attached.`,
          });
        }
      }

      // Only count this record toward newRecordsWithIssues if it wasn't already
      // flagged by the field-rule pass — prevents double-counting in moduleRecordsWithIssues.
      if (recordIssues.length > 0 && !alreadyFlaggedRecordIds.has(rec.id)) {
        recordsWithAttachmentIssues.add(rec.id);
      }

      for (const issue of recordIssues) {
        issueCount++;
        const bucket = sevToBucket(issue.severity);
        if (bucket === 'critical') critical++;
        else if (bucket === 'high') high++;
        else if (bucket === 'medium') medium++;
        else low++;

        const key = `${issue.module}-${issue.issueType}`;
        if (!issueTypeCounts[key]) {
          issueTypeCounts[key] = { count: 0, severity: issue.severity, module: issue.module };
        }
        issueTypeCounts[key].count++;

        const moduleDetailedCount = detailedCountsByModule.get(issue.module) ?? 0;
        if (detailedIssues && moduleDetailedCount < MAX_DETAILED_PER_MODULE) {
          const ownerData = rec.data?.Owner;
          const ownerName = rec.owner || (ownerData ? (ownerData.name || ownerData.id || '-') : '-');
          const createdByData = rec.data?.Created_By;
          const createdByName = createdByData ? (createdByData.name || createdByData.id || '') : '';
          const layoutData = rec.data?.Layout;
          const layoutName = (layoutData ? (layoutData.name || (typeof layoutData === 'string' ? layoutData : '')) : '') || 'Standard';
          const productsRaw = rec.data?.Product_Details;
          const productsName = (Array.isArray(productsRaw) && productsRaw.length > 0)
            ? productsRaw.map((p: any) => p.product?.name || '').filter(Boolean).join(', ')
            : (typeof rec.data?.Products === 'object' ? rec.data?.Products?.name : rec.data?.Products) || rec.data?.Product_Name || rec.data?.Product || '';
          const stageRaw = rec.data?.Stage ?? '';
          const stageName = typeof stageRaw === 'object' ? (stageRaw?.name || '') : String(stageRaw || '');
          const leadStatusRaw = rec.data?.Lead_Status ?? '';
          const leadStatusName = typeof leadStatusRaw === 'object' ? (leadStatusRaw?.name || '') : String(leadStatusRaw || '');
          const pipelineRaw = rec.data?.Pipeline ?? '';
          const pipelineName = typeof pipelineRaw === 'object' ? (pipelineRaw?.name || '') : String(pipelineRaw || '');
          detailedIssues.push({
            recordId: issue.recordId,
            module: issue.module,
            owner: ownerName,
            layouts: layoutName,
            products: productsName,
            createdBy: createdByName,
            createdTime: rec.data?.Created_Time || rec.createdTime || '',
            stage: stageName,
            leadStatus: leadStatusName,
            pipeline: pipelineName,
            fieldName: issue.fieldName || 'Attachments',
            issueType: issue.issueType,
            description: issue.description,
            severity: issue.severity,
            suggestedFix: issue.suggestedFix || 'Review the attachments on this Deal.',
          });
          detailedCountsByModule.set(issue.module, moduleDetailedCount + 1);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (failed.length > 0) {
    logger?.warn(`⚠️ [DirectAudit] Attachment fetch failed for ${failed.length} Deal(s) — they were skipped.`);
  }

  return {
    issueCount,
    critical,
    high,
    medium,
    low,
    recordsScanned: targets.length,
    newRecordsWithIssues: recordsWithAttachmentIssues.size,
  };
}

// User-selected date filter forwarded from the dashboard's upper-area
// Created/Modified pickers via /api/audit/trigger. Either pair (or both)
// may be set; both being set means a record must match BOTH ranges.
// When unset (cron-driven audits), all records are scanned.
export interface AuditDateFilters {
  created?: { start?: string | null; end?: string | null };
  modified?: { start?: string | null; end?: string | null };
}

function hasAnyAuditFilter(f?: AuditDateFilters): boolean {
  if (!f) return false;
  const c = f.created || {};
  const m = f.modified || {};
  return !!(c.start || c.end || m.start || m.end);
}

// Strictly parse a YYYY-MM-DD string into a KSA-anchored midnight Date.
// Returns null when the input is not a calendar-valid date. Plain regex +
// `new Date()` is not enough because JS silently rolls invalid days
// (e.g. "2026-02-31" → 2026-03-03), which would make the Slack header
// quietly lie. We round-trip the parsed components and compare back to
// the input to reject any normalized values.
function parseKsaDateOnly(input: string, endOfDay: boolean): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const suffix = endOfDay ? "T23:59:59.999+03:00" : "T00:00:00+03:00";
  const d = new Date(`${input}${suffix}`);
  if (isNaN(d.getTime())) return null;
  // Verify components round-trip in KSA (no silent rollover like 02-31).
  const ksaParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return ksaParts === input ? d : null;
}

function pickValidPair(
  pair?: { start?: string | null; end?: string | null },
): { start: Date; end: Date; label: string } | null {
  const s = pair?.start;
  const e = pair?.end;
  if (typeof s !== "string" || typeof e !== "string") return null;
  const start = parseKsaDateOnly(s, false);
  const end = parseKsaDateOnly(e, true);
  if (!start || !end) return null;
  if (start.getTime() > end.getTime()) return null; // reject inverted ranges
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" });
  return { start, end, label: `${fmt(start)} - ${fmt(end)}` };
}

// Build a DigestWindow that mirrors the user-selected Created and/or Modified
// period from the upper-area filter so the Slack "Period Covered" header on
// a manual audit run shows the dd/mm/yyyy KSA range(s) the user actually
// picked. Returns null when no fully-formed pair is set, in which case the
// caller falls back to computeDigestWindow() (cron-style window).
//
// When BOTH Created and Modified are set, audit scoping is the intersection
// of the two ranges (see filterRecordsByAuditDateFilters: hasC && hasM →
// cMatch && mMatch), so the header text shows BOTH labels explicitly to
// stay truthful with what was actually scanned. The window's start/end are
// set to the union span so any downstream URL parameters that read
// window_start/window_end (e.g. the digest's "Download Issues (Excel)"
// link) can still resolve a contiguous range without dropping rows.
//
// Format matches the existing executive digest: dateLabelKsa() uses the
// "en-GB" locale in Asia/Riyadh, which renders YYYY-MM-DD inputs as
// dd/mm/yyyy — exactly the form shown in the screenshots
// ("Period Covered: 01/05/2026 - 07/05/2026 (KSA)").
function buildUserPeriodDigestWindow(
  filters?: AuditDateFilters,
): import("./executiveDigest").DigestWindow | null {
  if (!filters) return null;
  const created = pickValidPair(filters.created);
  const modified = pickValidPair(filters.modified);
  if (!created && !modified) return null;

  let start: Date;
  let end: Date;
  let periodLabel: string;

  if (created && modified) {
    // Union span for the Date objects (covers both ranges so any consumer
    // reading window_start/window_end gets a non-empty contiguous span);
    // explicit dual label in the human-readable header so the recipient
    // sees the real Created ∩ Modified scope of the audit.
    start =
      created.start.getTime() < modified.start.getTime()
        ? created.start
        : modified.start;
    end =
      created.end.getTime() > modified.end.getTime()
        ? created.end
        : modified.end;
    periodLabel = `Created ${created.label} / Modified ${modified.label}`;
  } else {
    const chosen = (created || modified)!;
    start = chosen.start;
    end = chosen.end;
    periodLabel = chosen.label;
  }

  return {
    cadence: "weekly",
    start,
    end,
    periodLabel,
  };
}

// Apply the user-selected created/modified window to the records actually
// scanned by this audit run. Mirrors the semantics of
// isRecordInSeparateDateFilters in src/data/index.ts but operates on
// ZohoCRMRecord (which nests timestamps under .data) so the live Zoho
// pipeline and the cached-leads pipeline stay consistent.
function filterRecordsByAuditDateFilters(
  records: ZohoCRMRecord[],
  filters: AuditDateFilters,
): ZohoCRMRecord[] {
  const cStart = filters.created?.start || null;
  const cEnd = filters.created?.end || null;
  const mStart = filters.modified?.start || null;
  const mEnd = filters.modified?.end || null;
  const hasC = !!(cStart && cEnd);
  const hasM = !!(mStart && mEnd);
  if (!hasC && !hasM) return records;

  const inRange = (iso: string | undefined | null, s: string, e: string) => {
    if (!iso) return false;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return false;
    const start = new Date(s); start.setHours(0, 0, 0, 0);
    const end = new Date(e); end.setHours(23, 59, 59, 999);
    return d >= start && d <= end;
  };

  return records.filter((rec) => {
    const created = rec.data?.Created_Time || rec.createdTime || null;
    const modified = rec.data?.Modified_Time || rec.modifiedTime || null;
    let cMatch = true;
    let mMatch = true;
    if (hasC) cMatch = inRange(created, cStart!, cEnd!);
    if (hasM) mMatch = inRange(modified, mStart!, mEnd!);
    if (hasC && hasM) return cMatch && mMatch;
    return hasC ? cMatch : mMatch;
  });
}

export async function runDirectAudit(
  logger?: any,
  dateFilters?: AuditDateFilters,
) {
  logger?.info("🔍 [DirectAudit] Starting direct quality audit...", {
    dateFiltersApplied: hasAnyAuditFilter(dateFilters),
    filters: dateFilters || null,
  });

  const hasZohoCredentials = !!(process.env.ZOHO_ACCESS_TOKEN || (process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN));

  let qualityScores = {
    peopleScore: 0,
    processScore: 0,
    governanceScore: 0,
    overallScore: 0,
  };
  let totalRecordsAudited = 0;
  let totalIssuesFound = 0;
  let criticalIssues = 0;
  let highIssues = 0;
  let mediumIssues = 0;
  let lowIssues = 0;
  const moduleBreakdown: Array<{ module: string; recordsAudited: number; issuesFound: number }> = [];
  const topIssues: Array<{ module: string; issueType: string; count: number; severity: string }> = [];
  // Function-scoped so the rules_hash computation at save time can see
  // it regardless of which try-block populated it.
  const rulesByModule: Record<string, any[]> = {};
  let allFindingTypes: Array<{ module: string; issueType: string; count: number; severity: string }> = [];
  let auditSuccess = false;
  let skipReason = "";
  const detailedIssues: Array<{ recordId: string; module: string; owner: string; layouts: string; products: string; createdBy: string; createdTime: string; stage?: string; pipeline?: string; leadStatus?: string; fieldName: string; issueType: string; description: string; severity: string; suggestedFix: string }> = [];
  // Per-module tally so each module gets its own quota of detailed (per-record)
  // issues — prevents the first modules in the iteration order from starving
  // later ones (e.g. Tasks, Accounts) of `all_issues` entries.
  const detailedCountsByModule = new Map<string, number>();
  // Per-module unique-records-with-issues counts. Used by the dashboard's
  // compliance-rate calc as the truthful denominator (was previously
  // approximated from the 1000-row detailed sample, which made compliance
  // effectively constant regardless of CRM data changes).
  const recordCountsByModule: Record<string, number> = {};

  if (!hasZohoCredentials) {
    logger?.warn("⚠️ [DirectAudit] Zoho CRM credentials not configured - running with sample metrics");
    skipReason = "CRM integration not configured.";

    qualityScores = {
      peopleScore: 75,
      processScore: 68,
      governanceScore: 72,
      overallScore: 72,
    };
    totalRecordsAudited = 0;
    auditSuccess = true;
  } else {
    try {
      const modules = ["Leads", "Deals", "Contacts", "Accounts"];
      const issueTypeCounts: Record<string, { count: number; severity: string; module: string }> = {};

      for (const moduleName of modules) {
        logger?.info(`📊 [DirectAudit] Auditing ${moduleName} (paginated, up to ${MAX_RECORDS_PER_MODULE} records)...`);
        try {
          // Transient Zoho/network failures (e.g. "fetch failed" mid-pagination)
          // were previously fatal for an entire module — the module silently
          // dropped out of recordCountsByModule and the dashboard rendered "0"
          // for it. Retry up to 2 extra times with a short backoff before
          // giving up so a single flaky request no longer zeroes a module.
          let allRecords: ZohoCRMRecord[] | null = null;
          let lastErr: any = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              allRecords = await fetchAllZohoRecords(moduleName, { maxRecords: MAX_RECORDS_PER_MODULE });
              break;
            } catch (e) {
              lastErr = e;
              const msg = e instanceof Error ? e.message : String(e);
              logger?.warn(`⚠️ [DirectAudit] ${moduleName} fetch attempt ${attempt}/3 failed: ${msg}`);
              if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
            }
          }
          if (!allRecords) throw lastErr || new Error(`Failed to fetch ${moduleName}`);

          // Scope the records actually audited to the user-selected
          // Created/Modified window when one is supplied. This is what
          // makes "Period Covered" in Audit History line up with the
          // upper-area filter the user picked when they clicked
          // "Run AI Audit" — and keeps every downstream count
          // (records audited, issues, scores) consistent with that window.
          if (hasAnyAuditFilter(dateFilters)) {
            const before = allRecords.length;
            allRecords = filterRecordsByAuditDateFilters(allRecords, dateFilters!);
            logger?.info(
              `🔎 [DirectAudit] ${moduleName}: filtered ${before} → ${allRecords.length} records by user-selected period`,
            );
          }

          const recordCount = allRecords.length;
          totalRecordsAudited += recordCount;

          const moduleGovDoc = await getGovernanceDocumentByModule(moduleName);
          let governanceRules = DEFAULT_GOVERNANCE_RULES;

          if (moduleGovDoc?.rules_json) {
            try {
              const docRules = typeof moduleGovDoc.rules_json === 'string'
                ? JSON.parse(moduleGovDoc.rules_json)
                : moduleGovDoc.rules_json;
              if (Array.isArray(docRules)) {
                governanceRules = docRules;
              } else if (docRules.rules && Array.isArray(docRules.rules)) {
                governanceRules = docRules.rules;
              }
            } catch (e) {
              logger?.warn(`⚠️ [DirectAudit] Could not parse governance rules for ${moduleName}, using defaults`);
            }
          }
          rulesByModule[moduleName] = governanceRules as any[];

          let moduleIssueCount = 0;
          let moduleCritical = 0, moduleHigh = 0, moduleMedium = 0, moduleLow = 0;
          let moduleRecordsWithIssues = 0;
          // Tracks record IDs flagged by the field-rule pass so the attachment
          // pass below can avoid double-counting them in moduleRecordsWithIssues.
          const recordIdsWithFieldIssues = new Set<string>();

          for (let i = 0; i < recordCount; i += BATCH_SIZE) {
            const batch = allRecords.slice(i, i + BATCH_SIZE);
            const batchResult = analyzeRecordBatch(batch, governanceRules, issueTypeCounts, detailedIssues, detailedCountsByModule, recordIdsWithFieldIssues);
            moduleIssueCount += batchResult.issueCount;
            moduleCritical += batchResult.critical;
            moduleHigh += batchResult.high;
            moduleMedium += batchResult.medium;
            moduleLow += batchResult.low;
            moduleRecordsWithIssues += batchResult.recordsWithIssues;

            if (i > 0 && i % 5000 === 0) {
              logger?.info(`  📊 [DirectAudit] ${moduleName}: processed ${i}/${recordCount} records...`);
            }
          }

          // ─── Attachment audit (additive — Deals only, specific stages) ───
          // Runs ONLY for Deals in the stages defined in walaPlusAttachmentAuditRules.
          // Fetches the Attachments related list per record (parallel, bounded).
          // Adds new issue types: missing_required_document, wrong_document_type,
          // empty_attachment_file, dangerous_attachment_extension.
          if (moduleName === walaPlusAttachmentAuditRules.module) {
            try {
              const attachmentResult = await runAttachmentAudit(
                allRecords,
                issueTypeCounts,
                detailedIssues,
                detailedCountsByModule,
                recordIdsWithFieldIssues,
                logger,
              );
              moduleIssueCount += attachmentResult.issueCount;
              moduleCritical += attachmentResult.critical;
              moduleHigh += attachmentResult.high;
              moduleMedium += attachmentResult.medium;
              moduleLow += attachmentResult.low;
              // recordsWithIssues already counted by field-rule pass; we add only
              // records that had ZERO field issues but DO have attachment issues.
              moduleRecordsWithIssues += attachmentResult.newRecordsWithIssues;
              logger?.info(`📎 [DirectAudit] Attachment audit: scanned ${attachmentResult.recordsScanned} Deals, ${attachmentResult.issueCount} attachment issues found`);
            } catch (attErr) {
              logger?.warn(`⚠️ [DirectAudit] Attachment audit failed (non-fatal): ${attErr instanceof Error ? attErr.message : String(attErr)}`);
            }
          }

          totalIssuesFound += moduleIssueCount;
          criticalIssues += moduleCritical;
          highIssues += moduleHigh;
          mediumIssues += moduleMedium;
          lowIssues += moduleLow;
          recordCountsByModule[moduleName] = moduleRecordsWithIssues;

          moduleBreakdown.push({
            module: moduleName,
            recordsAudited: recordCount,
            issuesFound: moduleIssueCount,
            recordsWithIssues: moduleRecordsWithIssues,
          } as any);

          logger?.info(`✅ [DirectAudit] Completed ${moduleName}: ${recordCount} records, ${moduleIssueCount} issues found`);
        } catch (error) {
          logger?.warn(`⚠️ [DirectAudit] Could not fetch ${moduleName}: ${error instanceof Error ? error.message : String(error)}`);
          moduleBreakdown.push({ module: moduleName, recordsAudited: 0, issuesFound: 0 });
        }
      }

      qualityScores = calculateQualityScores(
        buildIssueSummary(criticalIssues, highIssues, mediumIssues, lowIssues),
        totalRecordsAudited
      );

      allFindingTypes = Object.entries(issueTypeCounts)
        .map(([key, data]) => ({
          module: data.module,
          issueType: key.split("-").slice(1).join("-"),
          count: data.count,
          severity: data.severity,
        }))
        .sort((a, b) => b.count - a.count);

      topIssues.push(...allFindingTypes.slice(0, 10));

      auditSuccess = true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [DirectAudit] CRM audit failed", { error: errorMessage });
      skipReason = errorMessage;
    }
  }

  try {
    const recommendations = getDefaultRecommendations(qualityScores, totalIssuesFound, criticalIssues, highIssues);
    const auditData = {
      total_records_audited: totalRecordsAudited,
      total_issues_found: totalIssuesFound,
      people_score: qualityScores.peopleScore,
      process_score: qualityScores.processScore,
      governance_score: qualityScores.governanceScore,
      overall_score: qualityScores.overallScore,
      dimension_details: { moduleBreakdown, criticalIssues, highIssues, mediumIssues, lowIssues },
      issues_by_category: topIssues,
      recommendations,
      calendar_events_count: 0,
      raw_audit_data: {
        skipReason,
        insights: skipReason 
          ? `Partial audit completed. ${skipReason}` 
          : `Quality audit completed with ${totalIssuesFound} issues found across ${totalRecordsAudited} records.`,
        all_issues: detailedIssues,
        recordCountsByModule,
      },
    };

    // Fingerprint the rule set used for this audit so the trend logic
    // can detect when the goalposts moved. Computed across every module
    // we actually audited (defaults if the audit fell back to the mock
    // path and never populated rulesByModule).
    const rulesHash = Object.keys(rulesByModule).length > 0
      ? computeAuditRulesHash(rulesByModule)
      : computeAuditRulesHash({
          Leads: DEFAULT_GOVERNANCE_RULES as any[],
          Deals: DEFAULT_GOVERNANCE_RULES as any[],
          Contacts: DEFAULT_GOVERNANCE_RULES as any[],
          Accounts: DEFAULT_GOVERNANCE_RULES as any[],
        });

    const savedResult = await saveAuditResult({
      ...auditData,
      // Persist the user-selected period (from the upper-area Created /
      // Modified pickers) so Audit History can render an accurate
      // "Period Covered" cell instead of falling back to "All Data".
      period_created_start: dateFilters?.created?.start ?? null,
      period_created_end: dateFilters?.created?.end ?? null,
      period_modified_start: dateFilters?.modified?.start ?? null,
      period_modified_end: dateFilters?.modified?.end ?? null,
      rules_hash: rulesHash,
    });
    logger?.info("✅ [DirectAudit] Audit results saved to database successfully");

    // Slack notification — audit completed. Posts to SLACK_CHANNEL_ID using
    // SLACK_BOT_TOKEN. Failures are swallowed so a Slack outage never blocks
    // the audit pipeline. This is in addition to the internal audit_notifications
    // table updated by fireAuditCompletedTrigger below.
    try {
      const slackFlag = String(
        process.env.DIRECT_AUDIT_SLACK_NOTIFY ?? "true",
      ).toLowerCase();
      const directAuditSlackEnabled = !["0", "false", "off", "no"].includes(
        slackFlag,
      );
      const slackToken = process.env.SLACK_BOT_TOKEN || process.env.SLACK_API_TOKEN;
      const slackChannel =
        process.env.DIRECT_AUDIT_SLACK_CHANNEL ||
        process.env.SLACK_CHANNEL_ID ||
        process.env.SLACK_DEFAULT_CHANNEL;

      if (directAuditSlackEnabled && slackToken && slackChannel && totalRecordsAudited === 0) {
        // ROOT-CAUSE GUARD (2026-05-28):
        // If the audit returned ZERO records (Zoho rate-limited, token
        // expired, network failure that survived all 3 retry attempts,
        // or a genuinely empty source) the downstream score math
        // collapses to 100% because (records - issues) / records is
        // 0/0 → fallback 100. The unconditional Slack success message
        // below would then page operators with a misleading
        // "Quality Audit Completed — 100% / Records: 0" — exactly the
        // false-positive that prompted this fix after operators saw a
        // 100% success on Slack while the dashboard showed 143k records
        // with 21.6% compliance.
        //
        // When records=0, send a DIFFERENT "audit yielded no data"
        // warning instead. The success-message branch below is
        // explicitly skipped via the `&& totalRecordsAudited > 0` guard
        // we add on its `if`, so this branch and that one are
        // mutually exclusive and the success message never fires on
        // an empty-source run.
        const {
          enqueueSlackOutboxMessage,
          processOutboxMessageById,
          processDueOutboxMessages,
        } = await import("./notificationOutbox");
        const dashUrl = process.env.PUBLIC_DASHBOARD_URL || "https://qms-dashboard.replit.app/";
        const generatedAtKsa = new Date().toLocaleTimeString("en-US", {
          timeZone: "Asia/Riyadh",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
        const reason = !hasZohoCredentials
          ? "Zoho CRM credentials are not configured"
          : "Zoho returned zero records across all modules (likely rate-limited / 429 or token expired)";
        const warningBlocks: any[] = [
          {
            type: "header",
            text: { type: "plain_text", text: "⚠️ Quality Audit Yielded No Data" },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Records Audited:*\n0` },
              { type: "mrkdwn", text: `*Reason:*\n${reason}` },
              { type: "mrkdwn", text: `*Generated at (KSA):*\n${generatedAtKsa}` },
              { type: "mrkdwn", text: `*Action:*\nVerify the Zoho integration on /integrations and re-run the audit. The numeric score is suppressed because dividing-by-zero falls back to 100% which would be misleading.` },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Open Dashboard" },
                url: dashUrl,
              },
            ],
          },
        ];
        try {
          await processDueOutboxMessages(20);
          const outboxEntry = await enqueueSlackOutboxMessage({
            source: "direct_audit_no_data",
            destination: slackChannel,
            text: `⚠️ WalaPlus Quality Audit — no records audited (${reason})`,
            blocks: warningBlocks,
            dedupeKey: savedResult.id ? `direct-audit:${savedResult.id}:slack-no-data` : undefined,
            metadata: {
              auditId: savedResult.id || null,
              reason,
            },
            maxAttempts: Number.parseInt(process.env.DIRECT_AUDIT_OUTBOX_MAX_ATTEMPTS || "4", 10),
          });
          await processOutboxMessageById(outboxEntry.id);
          logger?.warn("⚠️ [DirectAudit] Audit completed with 0 records — sent 'no data' warning to Slack instead of fake-success message", {
            reason,
          });
        } catch (warnErr) {
          logger?.error("❌ [DirectAudit] Failed to enqueue 'no data' warning:", warnErr);
        }
      } else if (directAuditSlackEnabled && slackToken && slackChannel && totalRecordsAudited > 0) {
        const {
          enqueueSlackOutboxMessage,
          processOutboxMessageById,
          processDueOutboxMessages,
        } = await import("./notificationOutbox");
        const score = qualityScores.overallScore || 0;
        const scoreEmoji = score >= 90 ? "🟢" : score >= 80 ? "🟡" : score >= 70 ? "🟠" : "🔴";
        const sevSummary = `🔴 Critical: ${criticalIssues}\n🟠 High: ${highIssues}\n🟡 Medium: ${mediumIssues}\n🟢 Low: ${lowIssues}`;
        const moduleSummary = moduleBreakdown
          .filter((m: any) => m.recordsAudited > 0)
          .map((m: any) => `• *${m.module}*: ${m.recordsAudited.toLocaleString()} records, ${m.issuesFound.toLocaleString()} issues`)
          .join("\n");
        const findingTypeLines = allFindingTypes.map(
          (f) =>
            `• *${f.module}* / ${f.issueType}: ${f.count.toLocaleString()} _(${f.severity})_`,
        );
        const findingTypeChunks: string[] = [];
        if (findingTypeLines.length > 0) {
          let currentChunk = "";
          for (const line of findingTypeLines) {
            const candidate = currentChunk ? `${currentChunk}\n${line}` : line;
            if (candidate.length > 2800) {
              if (currentChunk) findingTypeChunks.push(currentChunk);
              currentChunk = line;
            } else {
              currentChunk = candidate;
            }
          }
          if (currentChunk) findingTypeChunks.push(currentChunk);
        }
        const dashUrl = process.env.PUBLIC_DASHBOARD_URL || "https://qms-dashboard.replit.app/";
        const generatedAtKsa = new Date().toLocaleTimeString("en-US", {
          timeZone: "Asia/Riyadh",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });

        let executiveSectionText = "";
        try {
          const { generateDigestData } = await import("./executiveDigest");
          // When the user picked a Created/Modified period from the upper-area
          // filter, override the digest window so the Slack "Period Covered"
          // header reflects that exact selection instead of the auto-computed
          // weekly window. Falls back to the cron-style weekly window when no
          // user period is set (scheduled runs / admin-key triggers).
          const userWindow = buildUserPeriodDigestWindow(dateFilters);
          const digestData = await generateDigestData(
            userWindow
              ? { cadence: "weekly", window: userWindow, now: new Date() }
              : { cadence: "weekly", now: new Date() },
          );
          const sectionLines = digestData.business_sections.map(
            (section) =>
              `• *--- ${section.title} ---*\n  - Total ${section.total} (Leads ${section.leads} / Deals ${section.deals})\n  - New ${section.new_in_window}\n  - Progressed ${section.progressed}\n  - Stalled ${section.stalled}\n  - Severity: 🔴 Critical ${section.severity_counts.critical} | 🟠 High ${section.severity_counts.high} | 🟡 Medium ${section.severity_counts.medium} | 🟢 Low ${section.severity_counts.low}`,
          );
          executiveSectionText = `*Period Covered (KSA):*\n${digestData.window_start} -> ${digestData.window_end}\n\n*Executive Segments (Dashboard-aligned):*\n${sectionLines.join("\n")}\n\n*Definitions:*\n*Progressed = records in advancing stages (Qualified, Proposal, Negotiation, Won/Converted/Contract/Onboarding).*\n*Stalled = records in non-progress stages (On hold, Lost, Not Interested, Junk, Unqualified, Inactive).*`;
        } catch (digestErr) {
          logger?.warn("⚠️ [DirectAudit] Could not build executive sections for Slack message", {
            error: digestErr instanceof Error ? digestErr.message : String(digestErr),
          });
        }

        const blocks: any[] = [
          {
            type: "header",
            text: { type: "plain_text", text: `${scoreEmoji} Quality Audit Completed` },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Overall Score:*\n${score.toFixed(1)}%` },
              { type: "mrkdwn", text: `*Records Audited:*\n${totalRecordsAudited.toLocaleString()}` },
              { type: "mrkdwn", text: `*Issues Found:*\n${totalIssuesFound.toLocaleString()}` },
              { type: "mrkdwn", text: `*Severity:*\n${sevSummary}` },
              { type: "mrkdwn", text: `*People:* ${qualityScores.peopleScore.toFixed(1)}%` },
              { type: "mrkdwn", text: `*Process:* ${qualityScores.processScore.toFixed(1)}%` },
              { type: "mrkdwn", text: `*Governance:* ${qualityScores.governanceScore.toFixed(1)}%` },
              { type: "mrkdwn", text: `*Generated at (KSA):*\n${generatedAtKsa}` },
            ],
          },
        ];

        if (executiveSectionText) {
          blocks.push({ type: "divider" });
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: executiveSectionText },
          });
        }

        if (moduleSummary) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `*Module Breakdown:*\n${moduleSummary}` },
          });
        }

        if (findingTypeChunks.length > 0) {
          blocks.push({ type: "divider" });
          findingTypeChunks.forEach((chunk, idx) => {
            blocks.push({
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  idx === 0
                    ? `*--- All Finding Types (${allFindingTypes.length}) ---*\n${chunk}`
                    : `*--- All Finding Types (continued ${idx + 1}) ---*\n${chunk}`,
              },
            });
          });
        }

        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open Dashboard" },
              url: dashUrl,
            },
          ],
        });

        await processDueOutboxMessages(20);
        const outboxEntry = await enqueueSlackOutboxMessage({
          source: "direct_audit_completed",
          destination: slackChannel,
          text: `${scoreEmoji} WalaPlus Quality Audit Completed — Score ${score.toFixed(1)}%`,
          blocks,
          dedupeKey: savedResult.id ? `direct-audit:${savedResult.id}:slack` : undefined,
          metadata: {
            auditId: savedResult.id || null,
            overallScore: score,
          },
          maxAttempts: Number.parseInt(process.env.DIRECT_AUDIT_OUTBOX_MAX_ATTEMPTS || "4", 10),
        });
        const delivered = await processOutboxMessageById(outboxEntry.id);
        if (delivered?.status === "sent") {
          logger?.info("✅ [DirectAudit] Slack notification sent via outbox");
        } else if (delivered?.status === "pending" || delivered?.status === "processing") {
          logger?.warn("⚠️ [DirectAudit] Slack queued for retry via outbox", {
            outboxId: delivered.id,
            lastError: delivered.last_error,
          });
        } else {
          logger?.warn("⚠️ [DirectAudit] Slack notification failed via outbox", {
            outboxId: delivered?.id || outboxEntry.id,
            lastError: delivered?.last_error || null,
          });
        }
      } else if (!directAuditSlackEnabled) {
        logger?.info("ℹ️ [DirectAudit] DIRECT_AUDIT_SLACK_NOTIFY=false — sending digest-format fallback notification");
        try {
          const { sendDigestSlack, computeDigestWindow } = await import("./executiveDigest");
          const now = new Date();
          const cadence = "weekly" as const;
          // Mirror the user-selected period (if any) into the digest window so
          // the Slack "Period Covered" header on this fallback path matches
          // the dates the user picked when clicking "Run AI Audit". Scheduled
          // runs (no dateFilters) keep the standard auto-computed weekly window.
          const window =
            buildUserPeriodDigestWindow(dateFilters) ||
            computeDigestWindow(cadence, now);
          const fallbackResult = await sendDigestSlack({
            cadence,
            now,
            window,
            // Direct-audit fallback should notify immediately for this audit run.
            enforceIdempotency: false,
            channelOverride:
              process.env.DIRECT_AUDIT_SLACK_CHANNEL ||
              process.env.DIGEST_SLACK_CHANNEL_WEEKLY ||
              process.env.DIGEST_SLACK_CHANNEL ||
              process.env.SLACK_CHANNEL_ID ||
              process.env.SLACK_DEFAULT_CHANNEL ||
              undefined,
          });
          logger?.info("✅ [DirectAudit] Digest-format fallback notification attempted", {
            success: fallbackResult.success,
            method: fallbackResult.method,
            error: fallbackResult.error || null,
          });
        } catch (fallbackErr) {
          logger?.warn("⚠️ [DirectAudit] Digest-format fallback notification failed", {
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
        }
      } else {
        logger?.info("ℹ️ [DirectAudit] Slack not configured (SLACK_BOT_TOKEN / SLACK_CHANNEL_ID missing) — skipping Slack notification");
      }
    } catch (slackErr) {
      logger?.warn("⚠️ [DirectAudit] Slack notification failed (audit data was saved)", {
        error: slackErr instanceof Error ? slackErr.message : String(slackErr),
      });
    }

    try {
      const { fireAuditCompletedTrigger, fireNonconformanceDetectedTrigger, fireCAPARequiredTrigger } = await import("./auditTriggerDatabase");
      
      await fireAuditCompletedTrigger(savedResult.id!, {
        totalRecords: totalRecordsAudited,
        totalIssues: totalIssuesFound,
        overallScore: qualityScores.overallScore,
        peopleScore: qualityScores.peopleScore,
        processScore: qualityScores.processScore,
        governanceScore: qualityScores.governanceScore,
        auditDate: savedResult.audit_date || new Date(),
      });
      logger?.info("✅ [DirectAudit] AUDIT_COMPLETED trigger fired");

      if (criticalIssues > 0 || highIssues > 0) {
        await fireNonconformanceDetectedTrigger(savedResult.id!, {
          totalNCs: criticalIssues + highIssues,
          criticalCount: criticalIssues,
          majorCount: highIssues,
          minorCount: mediumIssues,
          ncIds: [],
          auditDate: savedResult.audit_date || new Date(),
          moduleBreakdown,
        });
        logger?.info("✅ [DirectAudit] NONCONFORMANCE_DETECTED trigger fired");
      }

      if (criticalIssues > 0 || qualityScores.overallScore < 70) {
        const topIssue = topIssues[0];
        await fireCAPARequiredTrigger(savedResult.id!, {
          ncId: 0,
          ncTitle: topIssue ? `${topIssue.module}: ${topIssue.issueType}` : 'Quality score below threshold',
          severity: criticalIssues > 0 ? 'critical' : 'high',
          suggestedAction: recommendations[0] || 'Review and address audit findings',
          auditDate: savedResult.audit_date || new Date(),
        });
        logger?.info("✅ [DirectAudit] CAPA_REQUIRED trigger fired");
      }
    } catch (triggerError) {
      logger?.error("❌ [DirectAudit] Failed to fire audit triggers (audit data was saved)", { 
        error: triggerError instanceof Error ? triggerError.message : String(triggerError) 
      });
    }
  } catch (error) {
    logger?.error("❌ [DirectAudit] Failed to save audit results", { error: error instanceof Error ? error.message : String(error) });
  }

  logger?.info("✅ [DirectAudit] Direct audit completed", {
    overallScore: qualityScores.overallScore,
    totalRecords: totalRecordsAudited,
    totalIssues: totalIssuesFound,
  });

  return { success: auditSuccess, qualityScores, totalRecordsAudited, totalIssuesFound };
}

function buildIssueSummary(critical: number, high: number, medium: number, low: number): HygieneIssue[] {
  const issues: HygieneIssue[] = [];
  const sev = (s: 'critical'|'high'|'medium'|'low', n: number) => {
    for (let i = 0; i < n; i++) {
      issues.push({ recordId: '', module: '', issueType: s === 'critical' || s === 'high' ? 'governance_violation' : s === 'medium' ? 'invalid_format' : 'missing_required_field', description: '', severity: s });
    }
  };
  sev('critical', critical);
  sev('high', high);
  sev('medium', medium);
  sev('low', low);
  return issues;
}

function getDefaultRecommendations(scores: any, totalIssues: number, critical: number, high: number): string[] {
  const recommendations: string[] = [];

  if (critical > 0) {
    recommendations.push(`Address ${critical} critical issues immediately - these require urgent attention`);
  }
  if (high > 0) {
    recommendations.push(`Review and resolve ${high} high-priority issues within this week`);
  }
  if (scores.peopleScore < 80) {
    recommendations.push("Improve data entry discipline by providing team training on CRM best practices");
  }
  if (scores.processScore < 80) {
    recommendations.push("Review and reinforce SOP compliance through regular team check-ins");
  }
  if (scores.governanceScore < 80) {
    recommendations.push("Implement stricter governance controls and automated validation rules");
  }
  if (recommendations.length < 3) {
    recommendations.push("Set up automated follow-up reminders for inactive leads and deals");
    recommendations.push("Ensure all meetings are logged in CRM within 24 hours");
    recommendations.push("Implement regular data validation checks for email and phone formats");
  }

  return recommendations.slice(0, 5);
}
