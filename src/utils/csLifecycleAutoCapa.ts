/**
 * Auto-create CAPA records for critical CS Lifecycle compliance violations.
 *
 * Companion to csOverlapAutoCapa.ts but triggered by lifecycle rule failures
 * (phase ↔ churn-date desync, etc) rather than cluster ARR. Same idempotency
 * pattern — one open CAPA per (deal record × violation code) — so the nightly
 * scan can re-run any time without duplicating tracked actions.
 *
 * Default scope: severity = 'critical'. Critical lifecycle rules currently are
 * `phase_churn_desync` (a one-working-day SLA breach), `missing_cs_owner` (no
 * one accountable for the motion), and `renewal_overdue` once it passes ~a
 * quarter. `renewal_overdue` is EXCLUDED from auto-CAPA by default (see
 * AUTO_CAPA_LIFECYCLE_EXCLUDE_CODES) because it can match a large backlog and a
 * surprise flood of auto-created CAPAs is hard to undo — it still shows as a
 * critical FLAG and a manual "Open CAPA" is always available. Operators can
 * expand the scope via env (AUTO_CAPA_LIFECYCLE_SEVERITIES=critical,warning).
 *
 * Env knobs:
 *   AUTO_CAPA_LIFECYCLE_ENABLED        (default 'true')
 *   AUTO_CAPA_LIFECYCLE_SEVERITIES     (default 'critical')
 *   AUTO_CAPA_LIFECYCLE_CODES          (default '' — all codes within selected severities)
 *   AUTO_CAPA_LIFECYCLE_EXCLUDE_CODES  (default 'renewal_overdue' — critical flag, no auto-CAPA)
 *   AUTO_CAPA_LIFECYCLE_TARGET_DAYS    (default '3' — critical SLA window)
 *   AUTO_CAPA_DEFAULT_ASSIGNEE         (shared with csOverlapAutoCapa)
 */

import { pool, scanCsLifecycleViolations } from "./duplicateRadarDatabase";
import { createCapaRecord } from "./qmsDatabase";
import { logger } from "./logger";
import type {
  CsViolationCode,
  CsViolationSeverity,
} from "./csLifecycleCompliance";

export interface CsLifecycleAutoCapaResult {
  enabled: boolean;
  severities: CsViolationSeverity[];
  codes_filter: CsViolationCode[] | null;
  candidates: number;
  created: number;
  skipped_existing: number;
  failed: number;
  capa_numbers: string[];
}

const SOURCE_TYPE = "cs_lifecycle_violation";
const SOURCE_ID_PREFIX = "cs_lifecycle";

function violationSourceId(
  recordId: number,
  code: CsViolationCode,
): string {
  return `${SOURCE_ID_PREFIX}:${recordId}:${code}`;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envList<T extends string>(
  name: string,
  fallback: T[],
  validValues: T[] | null = null,
): T[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase() as T)
    .filter(Boolean);
  if (validValues) {
    return parts.filter((p) => (validValues as string[]).includes(p));
  }
  return parts;
}

const VALID_SEVERITIES: CsViolationSeverity[] = ["info", "warning", "critical"];

async function existingOpenCapa(
  recordId: number,
  code: CsViolationCode,
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1
       FROM capa_records
      WHERE source_type = $1
        AND source_id   = $2
        AND status NOT IN ('closed', 'cancelled')
      LIMIT 1`,
    [SOURCE_TYPE, violationSourceId(recordId, code)],
  );
  return r.rows.length > 0;
}

function severityForViolation(
  s: CsViolationSeverity,
): "critical" | "major" | "minor" | "observation" {
  if (s === "critical") return "critical";
  if (s === "warning") return "major";
  return "minor";
}

function priorityForViolation(
  s: CsViolationSeverity,
): "critical" | "high" | "medium" | "low" {
  if (s === "critical") return "critical";
  if (s === "warning") return "high";
  return "medium";
}

const VIOLATION_TITLES: Record<CsViolationCode, string> = {
  phase_churn_desync: "CS SLA breach: Churn Date set without Termination phase",
  onboarding_overdue: "CS SLA breach: Onboarding exceeds 30-day target",
  termination_missing_churn_date: "CS data integrity: Termination phase missing Churn Date",
  termination_missing_churn_reason: "CS data integrity: Termination phase missing Churn Reason",
  phase_transition_stalled: "CS SLA breach: phase transition stalled",
  adoption_premature: "CS process breach: Adoption reached without Onboarding completion",
  missing_company_domain: "CS data integrity: Account missing Company Domain",
  // CS data-quality completeness pack (2026-05-30) — auto-CAPA titles
  // mirror the lifecycle ones so the CAPA inbox stays consistent.
  missing_cs_owner: "CS data integrity: Active deal has no CS Owner",
  missing_customer_since: "CS data integrity: Active deal missing Customer Since",
  missing_renewal_date: "CS data integrity: Active deal missing Renewal Date",
  missing_health_score: "CS data integrity: Active deal missing Health score",
  missing_arr_value: "CS data integrity: Active deal missing ARR value",
  renewal_overdue: "CS SLA breach: Renewal Date passed while phase still active",
};

function buildTitle(
  accountName: string | null,
  domain: string | null,
  code: CsViolationCode,
): string {
  const base = VIOLATION_TITLES[code] || `CS Lifecycle: ${code}`;
  const subject = accountName || domain || "unknown account";
  return `${base} — ${subject}`;
}

function buildDescription(
  accountName: string | null,
  domain: string | null,
  phase: string | null,
  daysSinceModified: number | null,
  message: string,
  suggestedAction: string,
): string {
  const sinceFmt =
    daysSinceModified === null ? "—" : `${daysSinceModified} day(s)`;
  return [
    `Account: ${accountName || "—"}`,
    `Domain: ${domain || "—"}`,
    `Current CS phase: ${phase || "—"}`,
    `Days since last record modification: ${sinceFmt}`,
    "",
    "Violation:",
    `  ${message}`,
    "",
    "Suggested action:",
    `  ${suggestedAction}`,
    "",
    "This CAPA was opened automatically by the CS Lifecycle Compliance",
    "monitor. Once the underlying violation is resolved in CRM (phase moved,",
    "churn date backfilled, etc.) the next nightly scan will not reopen this",
    "CAPA — the original action remains tracked here for audit purposes.",
  ].join("\n");
}

/**
 * Open CAPAs for every CS lifecycle violation whose severity is in the
 * configured set (default: critical only). Idempotent — existing open CAPAs
 * for the same (record × code) pair are skipped.
 */
export async function autoOpenCapasForCsLifecycle(opts: {
  enabled?: boolean;
  severities?: CsViolationSeverity[];
  codes?: CsViolationCode[];
  excludeCodes?: CsViolationCode[];
  createdBy?: string;
}): Promise<CsLifecycleAutoCapaResult> {
  const enabled =
    opts.enabled ?? envBool("AUTO_CAPA_LIFECYCLE_ENABLED", true);
  const severities =
    opts.severities ??
    envList<CsViolationSeverity>(
      "AUTO_CAPA_LIFECYCLE_SEVERITIES",
      ["critical"],
      VALID_SEVERITIES,
    );
  const codes =
    opts.codes ?? envList<CsViolationCode>("AUTO_CAPA_LIFECYCLE_CODES", []);
  const codesFilter = codes.length > 0 ? codes : null;
  // Codes that are CRITICAL (so they show red in the tab + Critical filter +
  // the nightly critical notification) but should NOT auto-spawn a formal CAPA
  // until an operator opts in. renewal_overdue is excluded by default: once
  // renewals can be a quarter overdue this rule can match a large backlog, and
  // a surprise flood of auto-created CAPAs is hard to undo. Enable auto-CAPA for
  // it by setting AUTO_CAPA_LIFECYCLE_EXCLUDE_CODES="" (or omitting it).
  const excludeCodes =
    opts.excludeCodes ??
    envList<CsViolationCode>("AUTO_CAPA_LIFECYCLE_EXCLUDE_CODES", [
      "renewal_overdue",
    ]);
  const excludeSet = new Set<CsViolationCode>(excludeCodes);
  const targetDays = Math.max(
    1,
    envNumber("AUTO_CAPA_LIFECYCLE_TARGET_DAYS", 3),
  );
  const assignee = process.env.AUTO_CAPA_DEFAULT_ASSIGNEE || undefined;
  const createdBy = opts.createdBy || "duplicate-radar:cs-lifecycle-auto";

  const result: CsLifecycleAutoCapaResult = {
    enabled,
    severities,
    codes_filter: codesFilter,
    candidates: 0,
    created: 0,
    skipped_existing: 0,
    failed: 0,
    capa_numbers: [],
  };

  if (!enabled || severities.length === 0) {
    logger.info("[AutoCapaLifecycle] disabled or no severities selected", {
      enabled,
      severities,
    });
    return result;
  }

  const scan = await scanCsLifecycleViolations({ limit: 5000 });

  // Filter to violations matching the configured severity (and optionally code)
  const matchedViolations = scan.violations.filter((v) => {
    if (!severities.includes(v.violation.severity)) return false;
    if (codesFilter && !codesFilter.includes(v.violation.code)) return false;
    if (excludeSet.has(v.violation.code)) return false;
    return true;
  });
  result.candidates = matchedViolations.length;

  for (const row of matchedViolations) {
    try {
      if (await existingOpenCapa(row.record_id, row.violation.code)) {
        result.skipped_existing++;
        continue;
      }
      const target = new Date(Date.now() + targetDays * 86400 * 1000);
      const capa = await createCapaRecord({
        title: buildTitle(
          row.account_name,
          row.domain,
          row.violation.code,
        ),
        description: buildDescription(
          row.account_name,
          row.domain,
          row.current_phase,
          row.days_since_modified,
          row.violation.message,
          row.violation.suggested_action,
        ),
        capa_type: "corrective",
        source_type: SOURCE_TYPE,
        source_id: violationSourceId(row.record_id, row.violation.code),
        source_reference: row.domain || row.account_name || undefined,
        severity: severityForViolation(row.violation.severity),
        status: "open",
        priority: priorityForViolation(row.violation.severity),
        assigned_to: assignee,
        target_date: target,
        metadata: {
          source: "cs_lifecycle_auto",
          duplicate_record_id: row.record_id,
          cluster_id: row.cluster_id,
          zoho_record_id: row.zoho_record_id,
          violation_code: row.violation.code,
          violation_severity: row.violation.severity,
          current_phase: row.current_phase,
          days_since_modified: row.days_since_modified,
        },
        created_by: createdBy,
      } as Omit<
        Parameters<typeof createCapaRecord>[0],
        "id" | "capa_number" | "created_at" | "updated_at"
      >);
      result.created++;
      if (capa.capa_number) result.capa_numbers.push(capa.capa_number);
      logger.info("[AutoCapaLifecycle] created", {
        capa_number: capa.capa_number,
        record_id: row.record_id,
        domain: row.domain,
        code: row.violation.code,
      });
    } catch (err) {
      result.failed++;
      logger.warn("[AutoCapaLifecycle] failed", {
        record_id: row.record_id,
        code: row.violation.code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export const AUTO_CAPA_LIFECYCLE_SOURCE_TYPE = SOURCE_TYPE;
export const AUTO_CAPA_LIFECYCLE_SOURCE_ID_PREFIX = SOURCE_ID_PREFIX;
export { violationSourceId };
