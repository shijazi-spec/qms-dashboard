/**
 * Keep every in-scope deal's document compliance checked, without anyone
 * having to sit on the page while it happens.
 *
 * The problem this replaces (Sarah 2026-08-25: "this page is a disaster, it
 * stopped the whole PC when it works"): Deal Compliance only knew a deal's
 * document status if a human opened the tab and pressed "Check all documents",
 * which then walked the loaded rows calling Zoho's attachments API. It capped
 * at 200 of 976 in-scope deals, so it could never finish — the tab permanently
 * showed hundreds "not yet checked" — and it pinned the browser for minutes
 * while doing it.
 *
 * The fix is to stop treating this as a foreground action. Attachments are
 * checked in the BACKGROUND, a slice at a time, off the existing 45-minute
 * housekeeping loop. The page then reads stored results and renders instantly.
 *
 * A ROLLING sweep, not a nightly burst. 976 deals in one go is ~976 Zoho
 * attachment calls in a few minutes — enough to hit rate limits, and this
 * deployment has already shown it will fall over under that kind of load. A
 * slice per tick (default 60, concurrency 3) covers roughly 1,900 checks a
 * day: every in-scope deal gets seen daily, with the work spread thin enough
 * that nobody notices it running.
 *
 * Deals are picked OLDEST-FIRST, never-checked before stale, so a deal that
 * has never been looked at is never starved by one that was checked an hour
 * ago.
 */
import { logger } from "./logger";
import { createRedactedPool } from "./redactedPool";
import { DEAL_COMPLIANCE_STAGES } from "./dealComplianceCheck";
import {
  buildSegmentPredicate,
  LIVE_DEAL_STAGE_SQL,
  VERDICT_CURRENT_SQL,
  type DuplicateFilters,
} from "./duplicateRadarDatabase";

// Own pool, matching the convention in the rest of src/utils. Carries the
// redaction wrapper (and, since 2026-08-25, the pool 'error' listener that
// stops an idle-client error killing the process).
const pool = createRedactedPool({ connectionString: process.env.DATABASE_URL });

/** How many deals to check per housekeeping tick. */
function sweepBatchSize(): number {
  const raw = parseInt(process.env.DEAL_DOC_SWEEP_BATCH || "", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : 60;
}

/** A deal checked more recently than this is left alone. */
function sweepMaxAgeHours(): number {
  const raw = parseInt(process.env.DEAL_DOC_SWEEP_MAX_AGE_HOURS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

/** Concurrent Zoho attachment calls. Matches the interactive batch endpoint. */
const SWEEP_CONCURRENCY = 3;

export interface DealDocSweepResult {
  scanned: number;
  compliant: number;
  missing: number;
  errors: number;
  /** In-scope deals still awaiting their first-ever check, after this pass. */
  remaining: number;
}

/**
 * Deals due for a check: in scope by stage, and either never checked or
 * checked longer ago than the max age.
 *
 * Exported for the route that reports sweep progress on the tab.
 */
export function dueDealsSql(): string {
  const stages = DEAL_COMPLIANCE_STAGES.map((s) => `'${s.toLowerCase()}'`).join(", ");
  return `
    SELECT r.zoho_record_id AS id,
           COALESCE(NULLIF(BTRIM(r.stage), ''), r.raw_data->>'Stage', '') AS stage,
           -- CR and VAT are satisfied by a genuine recorded number as well as
           -- by the certificate (Sarah, 2026-09-11), so the check needs them.
           -- Already in the mirror; no extra Zoho call.
           r.raw_data->>'CR_Number1'  AS cr_number,
           r.raw_data->>'VAT_Number1' AS vat_number
      FROM duplicate_records r
      LEFT JOIN deal_doc_compliance d ON d.zoho_deal_id = r.zoho_record_id
     WHERE r.record_type = 'deal'
       AND ${LIVE_DEAL_STAGE_SQL} IN (${stages})
       AND (d.checked_at IS NULL
            OR NOT ${VERDICT_CURRENT_SQL}
            OR d.checked_at < NOW() - ($1 || ' hours')::interval)
     -- Three tiers. Never-checked first: a deal nobody has ever looked at must
     -- not be starved by one checked an hour ago. Then verdicts computed for a
     -- stage the deal has since left: those are not merely old, they are
     -- wrong, and the report hides them until they are redone, so every hour
     -- they wait is an hour the deal is missing from the figures. Then age.
     ORDER BY CASE WHEN d.zoho_deal_id IS NULL THEN 0
                   WHEN NOT ${VERDICT_CURRENT_SQL} THEN 1
                   ELSE 2 END,
              d.checked_at ASC NULLS FIRST, r.zoho_record_id ASC
     LIMIT $2`;
}

/**
 * Check one slice of due deals and persist the results.
 *
 * Best-effort throughout: a deal whose attachments cannot be fetched is
 * counted as an error and skipped, never retried in a tight loop, and never
 * allowed to abort the pass. A background job that can take the process down
 * is worse than no background job.
 */
export async function runDealDocComplianceSweep(
  limit = sweepBatchSize(),
): Promise<DealDocSweepResult> {
  const { upsertDealDocCompliance } = await import("./duplicateRadarDatabase");
  const { fetchRecordAttachments } = await import("./zohoCRM");
  const { evaluateDocCompliance } = await import("./dealComplianceCheck");

  const maxAge = sweepMaxAgeHours();
  const due = await pool.query(dueDealsSql(), [String(maxAge), limit]);
  const deals = (due.rows as any[]).map((r) => ({
    id: String(r.id),
    stage: String(r.stage || ""),
    crNumber: r.cr_number ?? null,
    vatNumber: r.vat_number ?? null,
  }));

  const out: DealDocSweepResult = {
    scanned: 0,
    compliant: 0,
    missing: 0,
    errors: 0,
    remaining: 0,
  };
  if (!deals.length) {
    out.remaining = await countNeverChecked();
    return out;
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < deals.length) {
      const d = deals[cursor++];
      try {
        const atts = await fetchRecordAttachments("Deals", d.id);
        const r = evaluateDocCompliance(d.stage, atts, {
          crNumber: d.crNumber,
          vatNumber: d.vatNumber,
        });
        await upsertDealDocCompliance({
          zohoDealId: d.id,
          stage: d.stage,
          compliant: !!r.compliant,
          presentDocs: (r.presentDocs || []).map((p: any) => p.label),
          missingDocs: (r.missingDocs || []).map((m: any) => m.label),
          attachmentCount: r.attachmentCount || 0,
          unmatchedFiles: r.unmatchedFiles || [],
          checkedBy: "system:sweep",
        });
        out.scanned++;
        if (r.compliant) out.compliant++;
        else out.missing++;
      } catch (err) {
        out.errors++;
        logger.warn("[DealDocSweep] deal check failed", {
          deal: d.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SWEEP_CONCURRENCY, deals.length) }, worker),
  );

  out.remaining = await countNeverChecked();
  return out;
}

/**
 * In-scope deals with no compliance row at all — the "not yet checked" tile.
 *
 * `stages` defaults to every DEAL_COMPLIANCE_STAGES stage (Proposal /
 * Agreement Signed / Paid), matching every existing caller (the sweep's own
 * "remaining" tally, and the in-app Deal Compliance tab/export, which keep
 * Paid visible). A caller that reports on a NARROWER stage set — e.g. the
 * Sales monthly-email's REPORT_STAGES, which excludes Paid because that's
 * Customer Success's — must pass that same narrower list, or this count
 * silently pads the denominator with never-checked Paid deals the caller
 * never mentions.
 */
export async function countNeverChecked(
  stages: readonly string[] = DEAL_COMPLIANCE_STAGES,
  /**
   * Segment to count within. MUST match the segment the caller drew its rows
   * from: this number is the denominator of a coverage statement, and a
   * denominator from a wider population than the numerator makes the coverage
   * look worse than it is — or, worse, makes an all-segment count sit under a
   * WalaPlus-only headline.
   */
  segment?: DuplicateFilters["segment"],
): Promise<number> {
  try {
    const stageList = stages.map((s) => `'${s.toLowerCase()}'`).join(", ");
    const seg = buildSegmentPredicate(segment, 1);
    const segmentCond = seg.condition ? ` AND ${seg.condition}` : "";
    const res = await pool.query(
      `SELECT COUNT(*)::text AS n
         FROM duplicate_records r
         LEFT JOIN deal_doc_compliance d ON d.zoho_deal_id = r.zoho_record_id
        WHERE r.record_type = 'deal'
          AND LOWER(BTRIM(COALESCE(NULLIF(BTRIM(r.stage), ''), r.raw_data->>'Stage', ''))) IN (${stageList})
          -- Never checked, OR checked for a stage the deal has since left
          -- (2026-09-13). getDealComplianceReportRows hides those stale
          -- verdicts, so they must be counted here instead, or the coverage
          -- line would claim more of the book was checked than was.
          AND (d.zoho_deal_id IS NULL OR NOT ${VERDICT_CURRENT_SQL})${segmentCond}`,
      seg.params,
    );
    return Number(res.rows[0]?.n) || 0;
  } catch {
    return 0;
  }
}
