/**
 * ORPHAN CONTACTS — records attached to nothing, holding nothing (Sarah
 * 2026-09-10: "there are many contacts still orphan in the system without any
 * data inside or even linked by any accounts or deals, that shall be raised to
 * be removed too").
 *
 * HOW THIS DIFFERS FROM "CONTACTS WITH NO ACTIVITY"
 * That list answers "has anyone ever called this person". This one answers
 * "does this record represent anything at all". A contact can be activity-free
 * and still matter — it belongs to an Account, it carries the only phone number
 * for a company, a Deal points at it. An orphan is the case where every one of
 * those is false: no Account, no Deal, no activity, no email, no phone. There
 * is nothing to preserve and nothing to merge into, so it is genuinely
 * deletable rather than merely quiet.
 *
 * THE SAFETY RULE LIVES IN TYPESCRIPT, NOT SQL
 * `isSafeToRemove` is a pure function with tests. The query gathers FACTS and
 * this decides — because the rule that matters (activity must be PROVEN zero,
 * never assumed from a missing row) is the one that was got wrong before, when
 * contacts were deleted and the Sales team lost their history. A rule that
 * important should be readable and testable, not spread across a WHERE clause.
 *
 * Nothing here writes. It produces a list for the Zoho admin.
 */

import { pool } from "./duplicateRadarDatabase";

/** Everything the decision needs, gathered per contact. */
export interface OrphanFacts {
  zoho_contact_id: string;
  name: string | null;
  /** Linked Account id from Zoho, or null. */
  account_id: string | null;
  /** How many Deals point at this contact. */
  deal_count: number;
  email: string | null;
  phone: string | null;
  /** Activity count. NULL means NOT COUNTED YET — never treat as zero. */
  activity_total: number | null;
  /** True only when the census positively verified this record. */
  activity_verified: boolean;
  created_date: string | null;
  owner: string | null;
}

export interface OrphanContact extends OrphanFacts {
  /** Why it qualifies, in the order a reviewer would check. */
  reasons: string[];
}

const has = (v: string | null | undefined) => !!String(v || "").trim();

/**
 * PURE. Is this record attached to nothing and holding nothing?
 *
 * Every clause must be TRUE:
 *   - no Account link
 *   - no Deal points at it
 *   - no email and no phone — nothing to reach the person by, and nothing a
 *     merge could contribute to another record
 *   - activity PROVEN zero: counted AND verified. An uncounted contact is
 *     unknown, not empty, and unknown is never deletable. This is the clause
 *     the whole activity census exists to make honest.
 */
export function isSafeToRemove(f: OrphanFacts): boolean {
  if (f.account_id) return false;
  if (f.deal_count > 0) return false;
  if (has(f.email) || has(f.phone)) return false;
  // Absence of evidence is not evidence of absence.
  if (f.activity_total == null || !f.activity_verified) return false;
  return f.activity_total === 0;
}

/**
 * PURE. Why a record did or did not qualify — the same facts either way, so a
 * reviewer can see what was checked rather than trusting a verdict.
 */
export function orphanReasons(f: OrphanFacts): string[] {
  const out: string[] = [];
  out.push(f.account_id ? "linked to an Account" : "no Account");
  out.push(f.deal_count > 0 ? `${f.deal_count} Deal(s) point at it` : "no Deal");
  out.push(has(f.email) || has(f.phone) ? "has an email or phone" : "no email, no phone");
  if (f.activity_total == null) out.push("activity NOT COUNTED yet");
  else if (!f.activity_verified) out.push("activity counted but not verified");
  else if (f.activity_total > 0) out.push(`${f.activity_total} activity(ies)`);
  else out.push("verified: no activity");
  return out;
}

export interface OrphanContactsResult {
  contacts: OrphanContact[];
  /** Candidates examined — records with no account, email or phone. */
  examined: number;
  /**
   * Candidates that look empty but are NOT yet provable, because the census has
   * not verified them. Reported so a short list reads as "not proven yet"
   * rather than "there are only this many".
   */
  awaiting_verification: number;
  /** Excluded because a Deal points at them. */
  held_by_deal: number;
}

/**
 * The list. Read-only.
 *
 * Deal linkage is resolved with ONE pass over deal records collecting the
 * contact ids they reference, rather than a per-contact lookup — the same
 * inversion the activity census uses, and the reason this stays cheap.
 */
export async function getOrphanContacts(limit = 5000): Promise<OrphanContactsResult> {
  const cap = Math.max(1, Math.min(limit, 20000));

  // Candidates: no Account, no email, no phone. Cheap columns only — the
  // expensive questions (deals, activity) are answered for this narrowed set.
  const res = await pool.query(
    `SELECT c.zoho_record_id AS zoho_contact_id,
            NULLIF(BTRIM(c.record_name), '') AS name,
            NULLIF(BTRIM(c.raw_data->'Account_Name'->>'id'), '') AS account_id,
            NULLIF(BTRIM(c.email), '') AS email,
            NULLIF(BTRIM(c.phone), '') AS phone,
            COALESCE(NULLIF(BTRIM(c.owner_name), ''), NULLIF(BTRIM(c.owner_email), '')) AS owner,
            c.created_date,
            a.total AS activity_total,
            (a.verified_at IS NOT NULL) AS activity_verified
       FROM duplicate_records c
       LEFT JOIN contact_activity_counts a ON a.zoho_contact_id = c.zoho_record_id
      WHERE c.record_type = 'contact'
        AND c.zoho_record_id IS NOT NULL
        AND BTRIM(c.zoho_record_id) <> ''
        AND NULLIF(BTRIM(c.raw_data->'Account_Name'->>'id'), '') IS NULL
        AND NULLIF(BTRIM(c.email), '') IS NULL
        AND NULLIF(BTRIM(c.phone), '') IS NULL
        -- Already tagged for the admin; showing it again invites a second tag.
        AND NOT EXISTS (
          SELECT 1 FROM empty_delete_ledger l
           WHERE l.zoho_record_id = c.zoho_record_id
             AND l.status <> 'deleted'
        )
      ORDER BY c.created_date ASC NULLS LAST
      LIMIT $1`,
    [cap],
  );

  const rows = res.rows as any[];
  if (!rows.length) {
    return { contacts: [], examined: 0, awaiting_verification: 0, held_by_deal: 0 };
  }

  // One pass over Deals for the contact ids they reference.
  const ids = rows.map((r) => String(r.zoho_contact_id));
  const dealCounts = new Map<string, number>();
  const deals = await pool.query(
    `SELECT NULLIF(BTRIM(raw_data->'Contact_Name'->>'id'), '') AS contact_id,
            COUNT(*)::int AS n
       FROM duplicate_records
      WHERE record_type = 'deal'
        AND NULLIF(BTRIM(raw_data->'Contact_Name'->>'id'), '') = ANY($1::text[])
      GROUP BY 1`,
    [ids],
  );
  for (const d of deals.rows as any[]) {
    if (d.contact_id) dealCounts.set(String(d.contact_id), Number(d.n) || 0);
  }

  const contacts: OrphanContact[] = [];
  let awaiting = 0;
  let heldByDeal = 0;
  for (const r of rows) {
    const facts: OrphanFacts = {
      zoho_contact_id: String(r.zoho_contact_id),
      name: r.name,
      account_id: r.account_id,
      deal_count: dealCounts.get(String(r.zoho_contact_id)) || 0,
      email: r.email,
      phone: r.phone,
      activity_total: r.activity_total == null ? null : Number(r.activity_total),
      activity_verified: !!r.activity_verified,
      created_date: r.created_date ? String(r.created_date) : null,
      owner: r.owner,
    };
    if (facts.deal_count > 0) {
      heldByDeal++;
      continue;
    }
    if (facts.activity_total == null || !facts.activity_verified) {
      awaiting++;
      continue;
    }
    if (!isSafeToRemove(facts)) continue;
    contacts.push({ ...facts, reasons: orphanReasons(facts) });
  }

  return {
    contacts,
    examined: rows.length,
    awaiting_verification: awaiting,
    held_by_deal: heldByDeal,
  };
}
