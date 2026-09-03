/**
 * Keep every in-scope deal's document compliance checked, without anyone
 * having to sit on the page while it happens.
 *
 * The problem this replaces (Sample User 2026-08-25: "this page is a disaster, it
 * stopped the whole PC when it works"): Deal Compliance only knew a deal's
 * document status if a human opened the tab and pressed "Check all documents",
 * which then walked the loaded rows calling CRMProvider's attachments API. It capped
 * at 200 of 976 in-scope deals, so it could never finish — the tab permanently
 * showed hundreds "not yet checked" — and it pinned the browser for minutes
 * while doing it.
 *
 * The fix is to stop treating this as a foreground action. Attachments are
 * checked in the BACKGROUND, a slice at a time, off the existing 45-minute
 * housekeeping loop. The page then reads stored results and renders instantly.
 *
 * A ROLLING sweep, not a nightly burst. 976 deals in one go is ~976 CRMProvider
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

/** Concurrent CRMProvider attachment calls. Matches the interactive batch endpoint. */
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
    SELECT r.CRMProvider_record_id AS id,
           COALESCE(NULLIF(BTRIM(r.stage), ''), r.raw_data->>'Stage', '') AS stage,
           NULLIF(BTRIM(r.raw_data->'Account_Name'->>'id'), '') AS account_id
      FROM duplicate_records r
      LEFT JOIN deal_doc_compliance d ON d.CRMProvider_deal_id = r.CRMProvider_record_id
     WHERE r.record_type = 'deal'
       AND LOWER(BTRIM(COALESCE(NULLIF(BTRIM(r.stage), ''), r.raw_data->>'Stage', ''))) IN (${stages})
       AND (d.checked_at IS NULL OR d.checked_at < NOW() - ($1 || ' hours')::interval)
     -- Never-checked first: a deal nobody has ever looked at must not be
     -- starved by one that was checked an hour ago.
     ORDER BY d.checked_at ASC NULLS FIRST, r.CRMProvider_record_id ASC
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
  const { fetchRecordAttachments } = await import("./CRMProviderCRM");
  const { evaluateDocCompliance } = await import("./dealComplianceCheck");

  const maxAge = sweepMaxAgeHours();
  const due = await pool.query(dueDealsSql(), [String(maxAge), limit]);
  const deals = (due.rows as any[]).map((r) => ({
    id: String(r.id),
    stage: String(r.stage || ""),
    accountId: r.account_id ? String(r.account_id) : null,
  }));

  // Company documents (VAT, CR, National Address) live on the ACCOUNT, so the
  // Account's attachments are needed too — but one Account carries many deals,
  // and fetching per deal would multiply the CRMProvider calls for no new information.
  // Cached for the pass, with nulls cached as well so a company with no
  // attachments is not re-requested for every one of its deals.
  // The PROMISE is cached, not the result: the workers run concurrently, and
  // caching only on completion would let several of them fetch the same
  // Account at once — precisely the case this cache exists to avoid.
  const accountCache = new Map<string, Promise<any[]>>();
  const accountAttachments = (accountId: string | null): Promise<any[]> | undefined => {
    if (!accountId) return undefined;
    const hit = accountCache.get(accountId);
    if (hit) return hit;
    const p = fetchRecordAttachments("Accounts", accountId).catch((err: unknown) => {
      // A missing or unreadable Account must not fail the deal's own check —
      // its deal documents are still worth recording.
      logger.warn("[DealDocSweep] account attachments unavailable", {
        account: accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as any[];
    });
    accountCache.set(accountId, p);
    return p;
  };

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
        const acctAtts = await accountAttachments(d.accountId);
        const r = evaluateDocCompliance(d.stage, atts, acctAtts);
        await upsertDealDocCompliance({
          CRMProviderDealId: d.id,
          stage: d.stage,
          compliant: !!r.compliant,
          presentDocs: (r.presentDocs || []).map((p: any) => p.label),
          missingDocs: (r.missingDocs || []).map((m: any) => m.label),
          attachmentCount: r.attachmentCount || 0,
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

/** In-scope deals with no compliance row at all — the "not yet checked" tile. */
export async function countNeverChecked(): Promise<number> {
  try {
    const stages = DEAL_COMPLIANCE_STAGES.map((s) => `'${s.toLowerCase()}'`).join(", ");
    const res = await pool.query(
      `SELECT COUNT(*)::text AS n
         FROM duplicate_records r
         LEFT JOIN deal_doc_compliance d ON d.CRMProvider_deal_id = r.CRMProvider_record_id
        WHERE r.record_type = 'deal'
          AND LOWER(BTRIM(COALESCE(NULLIF(BTRIM(r.stage), ''), r.raw_data->>'Stage', ''))) IN (${stages})
          AND d.CRMProvider_deal_id IS NULL`,
    );
    return Number(res.rows[0]?.n) || 0;
  } catch {
    return 0;
  }
}
