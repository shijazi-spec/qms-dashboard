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

function maxBulkPages(): number {
  const raw = parseInt(process.env.CONTACT_ACTIVITY_BULK_MAX_PAGES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 400; // 400 x 200 = 80k activities
}

export interface ContactActivitySweepResult {
  bulkModules: Record<string, number>;
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

export async function runContactActivitySweep(): Promise<ContactActivitySweepResult> {
  const result: ContactActivitySweepResult = {
    bulkModules: {},
    contactsWithActivity: 0,
    verifiedThisRun: 0,
    provenEmpty: 0,
    truncated: false,
    errors: [],
  };

  const perContact = await runBulkPass(result);
  const bulkFailed = result.errors.length > 0;

  // Reset the bulk columns before writing, so a contact whose activities were
  // deleted in Zoho falls back to 0 instead of keeping a stale count.
  if (!bulkFailed) {
    await pool.query(
      `UPDATE contact_activity_counts
          SET bulk_calls = 0, bulk_tasks = 0, bulk_events = 0,
              total = emails + attachments + notes`,
    );
  }

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
      (result.truncated ? " (BULK TRUNCATED — raise CONTACT_ACTIVITY_BULK_MAX_PAGES)" : "") +
      (result.errors.length ? ` — ${result.errors.length} error(s)` : ""),
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
