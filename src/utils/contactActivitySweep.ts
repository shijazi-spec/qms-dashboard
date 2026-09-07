/**
 * CONTACT ACTIVITY CENSUS (Sarah 2026-09-06).
 *
 * Why this exists
 * ---------------
 * Deleting a contact in Zoho deletes its activities with it. A previous
 * clean-up removed contacts that still carried calls and meetings, and the
 * Sales team lost activity history they are measured on. So the platform must
 * never propose a contact for deletion until it can PROVE the record holds
 * nothing — and "we did not find anything" is not the same as "there is
 * nothing there".
 *
 * Shape of the problem
 * --------------------
 * The obvious implementation — ask Zoho for each contact's related lists — is
 * six API calls per contact. On this corpus that is tens of thousands of calls
 * and does not finish.
 *
 * So the query is INVERTED. Calls, Tasks and Events are ordinary Zoho modules
 * that can be paged in bulk, and each row names the contact it belongs to via
 * `Who_Id`. One pass over those three modules is O(activities) and yields every
 * contact that HAS activity. Everything else is a candidate for "no activity".
 *
 * Emails, Attachments and Notes have no bulk equivalent in v2, so they are
 * checked per record — but only for the candidates the bulk pass found nothing
 * for, which is a much smaller set, and only once each.
 *
 * The gate
 * --------
 * `verified_at IS NULL` means NOT PROVEN EMPTY. It never means empty. A contact
 * is only offered for deletion when the bulk pass found nothing AND the
 * per-record pass completed AND the total is 0. Every failure path leaves
 * verified_at NULL, so an error can only ever make the safe list shorter.
 */
import { createRedactedPool } from "./redactedPool";
import { fetchZohoRecords, fetchZohoRelatedRecords } from "./zohoCRM";
import { logger } from "./logger";

const pool = createRedactedPool({ connectionString: process.env.DATABASE_URL });

/** Modules that can be paged in bulk and carry a Who_Id pointing at a contact. */
const BULK_ACTIVITY_MODULES = [
  { module: "Calls", column: "bulk_calls" },
  { module: "Tasks", column: "bulk_tasks" },
  { module: "Events", column: "bulk_events" },
] as const;

/** Related lists with no bulk equivalent — checked per candidate contact. */
const PER_RECORD_LISTS = [
  { list: "Emails", column: "emails" },
  { list: "Attachments", column: "attachments" },
  { list: "Notes", column: "notes" },
] as const;

function verifyBatchSize(): number {
  const raw = parseInt(process.env.CONTACT_ACTIVITY_VERIFY_BATCH || "", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : 150;
}

/**
 * Safety valve only — the pass stops on its own when a page returns fewer than
 * 200 rows. Raised from 400 (80k activities) because hitting the cap is not a
 * harmless truncation: a capped pass has not read every activity, so it is not
 * allowed to clear stale counts, and the census can never self-heal. On a book
 * with 70k contacts, 80k activities is a plausible corpus size, which made the
 * old default the difference between a census that converges and one that does
 * not.
 */
function maxBulkPages(): number {
  const raw = parseInt(process.env.CONTACT_ACTIVITY_BULK_MAX_PAGES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000; // 1M activities
}

export interface ContactActivitySweepResult {
  bulkModules: Record<string, number>;
  /** Contacts whose bulk counts were cleared because a COMPLETE pass did not
   *  see them. Only ever set after an error-free, untruncated pass. */
  staleCleared?: number;
  contactsWithActivity: number;
  verifiedThisRun: number;
  provenEmpty: number;
  truncated: boolean;
  errors: string[];
}

/** "5146753000000911655" out of whatever shape Zoho returned for Who_Id. */
function whoId(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && typeof v.id === "string") return v.id.trim() || null;
  return null;
}

/**
 * PASS 1 — page Calls/Tasks/Events and count activities per contact.
 *
 * Counts are written as absolute values for the contacts seen, so a contact
 * whose last call was deleted in Zoho drops back to 0 on the next full pass
 * rather than keeping a stale count that would hide it from the safe list
 * forever.
 */
async function runBulkPass(
  result: ContactActivitySweepResult,
): Promise<Map<string, Record<string, number>>> {
  const perContact = new Map<string, Record<string, number>>();
  for (const { module, column } of BULK_ACTIVITY_MODULES) {
    let page = 1;
    let seen = 0;
    for (; page <= maxBulkPages(); page++) {
      let rows: any[] = [];
      try {
        rows = await fetchZohoRecords(module, {
          page,
          perPage: 200,
          fields: ["id", "Who_Id"],
        });
      } catch (e: any) {
        // A module that errors mid-pass leaves every contact it would have
        // named uncounted. Recording the error is what stops the verify pass
        // below from treating those contacts as empty.
        result.errors.push(`${module} page ${page}: ${e?.message || e}`);
        break;
      }
      if (!rows.length) break;
      for (const r of rows) {
        // fetchZohoRecords wraps the record: the Zoho fields are under `.data`
        // (ZohoCRMRecordSchema), NOT on the object itself.
        const id = whoId((r as any)?.data?.Who_Id);
        if (!id) continue; // activity against an Account/Deal, not a contact
        const rec = perContact.get(id) || {};
        rec[column] = (rec[column] || 0) + 1;
        perContact.set(id, rec);
      }
      seen += rows.length;
      if (rows.length < 200) break; // last page
    }
    result.bulkModules[module] = seen;
    if (page > maxBulkPages()) result.truncated = true;
  }
  return perContact;
}

/**
 * PASS 2 — per-record Emails/Attachments/Notes for contacts the bulk pass found
 * nothing for. Only these can ever become "proven empty", and each is checked
 * once; `verified_at` keeps them out of later runs.
 */
async function runVerifyPass(
  result: ContactActivitySweepResult,
  bulkFailed: boolean,
): Promise<void> {
  if (bulkFailed) {
    // A bulk module errored, so "no bulk activity" is not trustworthy for
    // ANY contact this run. Verifying now would stamp verified_at on records
    // whose calls simply were not read.
    result.errors.push(
      "verify pass skipped — a bulk module failed, so zero-activity could not be trusted this run",
    );
    return;
  }
  const due = await pool.query(
    `SELECT c.zoho_record_id AS id
       FROM duplicate_records c
       LEFT JOIN contact_activity_counts a ON a.zoho_contact_id = c.zoho_record_id
      WHERE c.record_type = 'contact'
        AND COALESCE(a.bulk_calls, 0) + COALESCE(a.bulk_tasks, 0) + COALESCE(a.bulk_events, 0) = 0
        AND a.verified_at IS NULL
      ORDER BY c.zoho_record_id
      LIMIT $1`,
    [verifyBatchSize()],
  );
  for (const row of due.rows as Array<{ id: string }>) {
    const counts: Record<string, number> = {};
    let failed = false;
    for (const { list, column } of PER_RECORD_LISTS) {
      try {
        const recs = await fetchZohoRelatedRecords("Contacts", row.id, list, {
          perPage: 200,
        });
        counts[column] = recs.length;
      } catch {
        // Unreadable list — cannot claim empty. Leave verified_at NULL so this
        // contact is retried and never reaches the safe-to-delete list on the
        // strength of a failed read.
        failed = true;
        break;
      }
    }
    if (failed) continue;
    const extra =
      (counts.emails || 0) + (counts.attachments || 0) + (counts.notes || 0);
    await pool.query(
      `INSERT INTO contact_activity_counts
         (zoho_contact_id, emails, attachments, notes, total, verified_at, checked_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (zoho_contact_id) DO UPDATE SET
         emails = EXCLUDED.emails,
         attachments = EXCLUDED.attachments,
         notes = EXCLUDED.notes,
         total = contact_activity_counts.bulk_calls
               + contact_activity_counts.bulk_tasks
               + contact_activity_counts.bulk_events
               + EXCLUDED.emails + EXCLUDED.attachments + EXCLUDED.notes,
         verified_at = NOW(),
         checked_at = NOW()`,
      [row.id, counts.emails || 0, counts.attachments || 0, counts.notes || 0, extra],
    );
    result.verifiedThisRun++;
  }
}

/**
 * Background-run state for the manual trigger.
 *
 * The sweep pages three whole activity modules and cannot finish inside an
 * HTTP request: the first live run on 70,534 contacts died at ~191s with a 504
 * while the work carried on server-side, so the caller learned nothing and the
 * UI reported failure for a sweep that was actually progressing. The route now
 * starts it and returns immediately; progress is read from the coverage query.
 */
let _sweepRunning = false;
let _sweepStartedAt: number | null = null;
let _sweepLast: { finishedAt: string; result: ContactActivitySweepResult } | null = null;

export function getContactActivitySweepStatus(): {
  running: boolean;
  startedAt: string | null;
  elapsedSec: number | null;
  last: { finishedAt: string; result: ContactActivitySweepResult } | null;
} {
  return {
    running: _sweepRunning,
    startedAt: _sweepStartedAt ? new Date(_sweepStartedAt).toISOString() : null,
    elapsedSec: _sweepStartedAt ? Math.round((Date.now() - _sweepStartedAt) / 1000) : null,
    last: _sweepLast,
  };
}

/**
 * Start the sweep in the background if one is not already running. Returns
 * whether THIS call started it, so a double-click cannot launch two passes over
 * the Zoho activity modules at once.
 */
export function startContactActivitySweep(): { started: boolean; alreadyRunning: boolean } {
  if (_sweepRunning) return { started: false, alreadyRunning: true };
  _sweepRunning = true;
  _sweepStartedAt = Date.now();
  void runContactActivitySweep()
    .then((result) => {
      _sweepLast = { finishedAt: new Date().toISOString(), result };
    })
    .catch((e) => {
      logger.error("[contact-activity] background sweep failed:", e?.message || e);
    })
    .finally(() => {
      _sweepRunning = false;
    });
  return { started: true, alreadyRunning: false };
}

export async function runContactActivitySweep(): Promise<ContactActivitySweepResult> {
  const result: ContactActivitySweepResult = {
    bulkModules: {},
    contactsWithActivity: 0,
    verifiedThisRun: 0,
    provenEmpty: 0,
    truncated: false,
    errors: [],
  };

  // Stamped BEFORE the pass so "not seen this run" is decidable afterwards.
  const runStartedAt = Date.now();
  const perContact = await runBulkPass(result);
  const bulkFailed = result.errors.length > 0;

  // NOTE — the reset that used to live HERE was a correctness bug, and it fired
  // in production. It zeroed every contact's bulk counts BEFORE re-writing them,
  // so an interrupted run (a Republish restart is enough) left contacts that
  // really do have calls sitting at zero. Verified in that state, a contact with
  // 30 calls would have been published to the "safe to delete" list. Observed
  // live: with_activity fell from 16,744 to 6,545 across a restart.
  //
  // Zeroing now happens AFTER the pass, only for contacts the pass did not see,
  // and only when the pass was COMPLETE — see below. A stale-high count merely
  // keeps a contact off the safe list, which is the harmless direction.
  for (const [contactId, cols] of perContact) {
    const calls = cols.bulk_calls || 0;
    const tasks = cols.bulk_tasks || 0;
    const events = cols.bulk_events || 0;
    await pool.query(
      `INSERT INTO contact_activity_counts
         (zoho_contact_id, bulk_calls, bulk_tasks, bulk_events, total, bulk_at, checked_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (zoho_contact_id) DO UPDATE SET
         bulk_calls = EXCLUDED.bulk_calls,
         bulk_tasks = EXCLUDED.bulk_tasks,
         bulk_events = EXCLUDED.bulk_events,
         total = EXCLUDED.bulk_calls + EXCLUDED.bulk_tasks + EXCLUDED.bulk_events
               + contact_activity_counts.emails
               + contact_activity_counts.attachments
               + contact_activity_counts.notes,
         bulk_at = NOW(),
         checked_at = NOW()`,
      [contactId, calls, tasks, events, calls + tasks + events],
    );
  }
  result.contactsWithActivity = perContact.size;

  // Zero the contacts this pass did NOT see — but ONLY after a pass that was
  // both error-free and complete. A truncated pass has not read every activity,
  // so "not seen" would not mean "has none", and zeroing on that basis is
  // exactly how a contact with calls reaches the safe-to-delete list.
  //
  // Anything zeroed here also loses verified_at: its total just changed, so the
  // earlier verification no longer describes it and must be redone.
  if (!bulkFailed && !result.truncated) {
    const cleared = await pool.query(
      `UPDATE contact_activity_counts
          SET bulk_calls = 0, bulk_tasks = 0, bulk_events = 0,
              total = emails + attachments + notes,
              verified_at = NULL
        WHERE (bulk_at IS NULL OR bulk_at < $1)
          AND (bulk_calls > 0 OR bulk_tasks > 0 OR bulk_events > 0)`,
      [new Date(runStartedAt).toISOString()],
    );
    result.staleCleared = cleared.rowCount || 0;
  }

  await runVerifyPass(result, bulkFailed);

  const empty = await pool.query(
    `SELECT COUNT(*)::int AS n FROM contact_activity_counts
      WHERE total = 0 AND verified_at IS NOT NULL`,
  );
  result.provenEmpty = empty.rows[0]?.n || 0;

  logger.info(
    `[contact-activity] bulk ${JSON.stringify(result.bulkModules)}, ` +
      `${result.contactsWithActivity} contact(s) with activity, ` +
      `verified ${result.verifiedThisRun} this run, ${result.provenEmpty} proven empty` +
      (result.staleCleared ? `, cleared ${result.staleCleared} stale` : "") +
      (result.truncated
        ? " (BULK TRUNCATED — raise CONTACT_ACTIVITY_BULK_MAX_PAGES; stale counts NOT cleared, so the safe list stays conservative)"
        : "") +
      (result.errors.length ? ` — ${result.errors.length} error(s)` : ""),
  );
  return result;
}

/** Every related list that counts as history, for the self-contained check. */
const ALL_CONTACT_LISTS = [
  { list: "Tasks", column: "bulk_tasks" },
  { list: "Calls", column: "bulk_calls" },
  { list: "Events", column: "bulk_events" },
  { list: "Emails", column: "emails" },
  { list: "Attachments", column: "attachments" },
  { list: "Notes", column: "notes" },
] as const;

function onDemandCap(): number {
  const raw = parseInt(process.env.CONTACT_ACTIVITY_ONDEMAND_MAX || "", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 60;
}
function onDemandConcurrency(): number {
  const raw = parseInt(process.env.CONTACT_ACTIVITY_ONDEMAND_CONCURRENCY || "", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 8) : 4;
}

export interface OnDemandVerifyResult {
  requested: number;
  checked: number;
  provenEmpty: string[];
  hasActivity: Array<{ id: string; total: number }>;
  failed: Array<{ id: string; reason: string }>;
  capped: boolean;
}

/**
 * Verify a SPECIFIC set of contacts right now, for the batch the operator is
 * about to act on (Sarah 2026-09-06).
 *
 * Why this exists alongside the sweep: the background sweep verifies ~150
 * contacts a run against ~53,000 candidates, so waiting for it to reach a
 * particular row takes months. This checks the rows on screen in seconds.
 *
 * SELF-CONTAINED by design — it reads all six related lists per contact rather
 * than trusting the bulk pass to have reached them. The bulk pass is an
 * optimisation for coverage; correctness here must not depend on whether it
 * happened to have run. That costs 6 calls per contact instead of 3, which is
 * affordable precisely because the batch is small and bounded.
 *
 * A contact whose lists cannot all be read is reported as FAILED, never as
 * empty — same rule as everywhere else in this module.
 */
export async function verifyContactsNow(
  zohoIds: string[],
): Promise<OnDemandVerifyResult> {
  const cap = onDemandCap();
  const ids = Array.from(new Set(zohoIds.filter(Boolean))).slice(0, cap);
  const result: OnDemandVerifyResult = {
    requested: zohoIds.length,
    checked: 0,
    provenEmpty: [],
    hasActivity: [],
    failed: [],
    capped: zohoIds.length > ids.length,
  };

  const queue = [...ids];
  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      const counts: Record<string, number> = {};
      let failedList: string | null = null;
      for (const { list, column } of ALL_CONTACT_LISTS) {
        try {
          const recs = await fetchZohoRelatedRecords("Contacts", id, list, {
            perPage: 200,
          });
          counts[column] = recs.length;
        } catch (e: any) {
          failedList = list;
          break;
        }
      }
      if (failedList) {
        result.failed.push({ id, reason: `could not read ${failedList}` });
        continue;
      }
      const total = Object.values(counts).reduce((n, v) => n + v, 0);
      await pool.query(
        `INSERT INTO contact_activity_counts
           (zoho_contact_id, bulk_calls, bulk_tasks, bulk_events, emails, attachments, notes,
            total, bulk_at, verified_at, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NOW())
         ON CONFLICT (zoho_contact_id) DO UPDATE SET
           bulk_calls = EXCLUDED.bulk_calls,
           bulk_tasks = EXCLUDED.bulk_tasks,
           bulk_events = EXCLUDED.bulk_events,
           emails = EXCLUDED.emails,
           attachments = EXCLUDED.attachments,
           notes = EXCLUDED.notes,
           total = EXCLUDED.total,
           bulk_at = NOW(),
           verified_at = NOW(),
           checked_at = NOW()`,
        [
          id,
          counts.bulk_calls || 0,
          counts.bulk_tasks || 0,
          counts.bulk_events || 0,
          counts.emails || 0,
          counts.attachments || 0,
          counts.notes || 0,
          total,
        ],
      );
      result.checked++;
      if (total === 0) result.provenEmpty.push(id);
      else result.hasActivity.push({ id, total });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(onDemandConcurrency(), ids.length || 1) }, worker),
  );
  logger.info(
    `[contact-activity] on-demand verified ${result.checked}/${result.requested}: ` +
      `${result.provenEmpty.length} empty, ${result.hasActivity.length} with activity, ` +
      `${result.failed.length} unreadable`,
  );
  return result;
}

export interface NoActivityContact {
  zoho_contact_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  owner: string | null;
  account: string | null;
  created_date: string | null;
  verified_at: string | null;
}

/**
 * Contacts PROVEN to hold no activity of any kind — the only ones that are safe
 * to delete. Requires verified_at, so a contact the sweep has not finished with
 * is absent rather than assumed empty.
 */
export async function getContactsWithNoActivity(
  limit = 5000,
): Promise<NoActivityContact[]> {
  const res = await pool.query(
    `SELECT r.zoho_record_id AS zoho_contact_id,
            NULLIF(BTRIM(r.record_name), '') AS name,
            NULLIF(BTRIM(r.email), '') AS email,
            NULLIF(BTRIM(r.phone), '') AS phone,
            COALESCE(NULLIF(BTRIM(r.owner_name), ''), NULLIF(BTRIM(r.owner_email), '')) AS owner,
            COALESCE(
              NULLIF(BTRIM(r.raw_data->'Account_Name'->>'name'), ''),
              NULLIF(BTRIM(r.company_name), '')
            ) AS account,
            r.created_date,
            a.verified_at
       FROM contact_activity_counts a
       JOIN duplicate_records r ON r.zoho_record_id = a.zoho_contact_id
      WHERE r.record_type = 'contact'
        AND a.total = 0
        AND a.verified_at IS NOT NULL
      ORDER BY r.created_date ASC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return res.rows as NoActivityContact[];
}

/** Coverage, so the UI can say how much of the corpus has actually been checked. */
export async function getContactActivityCoverage(): Promise<{
  contacts: number;
  counted: number;
  verified: number;
  with_activity: number;
  proven_empty: number;
}> {
  const res = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM duplicate_records WHERE record_type = 'contact') AS contacts,
       (SELECT COUNT(*)::int FROM contact_activity_counts) AS counted,
       (SELECT COUNT(*)::int FROM contact_activity_counts WHERE verified_at IS NOT NULL) AS verified,
       (SELECT COUNT(*)::int FROM contact_activity_counts WHERE total > 0) AS with_activity,
       (SELECT COUNT(*)::int FROM contact_activity_counts WHERE total = 0 AND verified_at IS NOT NULL) AS proven_empty`,
  );
  return res.rows[0];
}

/**
 * Is this contact PROVEN to hold nothing? Used to gate Empty-Delete.
 * Returns false when unknown — the caller must not delete on "we don't know".
 */
export async function isContactProvenEmpty(zohoId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM contact_activity_counts
      WHERE zoho_contact_id = $1 AND total = 0 AND verified_at IS NOT NULL
      LIMIT 1`,
    [zohoId],
  );
  return res.rows.length > 0;
}
