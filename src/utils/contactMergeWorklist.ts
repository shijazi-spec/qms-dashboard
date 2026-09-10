/**
 * CONTACTS TO MERGE — the worklist that makes a native Zoho merge a two-minute
 * job instead of a hunt (Sarah 2026-09-10).
 *
 * THE PROBLEM THIS SOLVES
 * Contact Duplicates could not be worked, because merging had to preserve every
 * call, meeting and task — an earlier clean-up deleted contacts and took the
 * Sales team's activity history with them. So the radar tags duplicates that
 * hold history `Merge-In-Zoho` and refuses to delete them. What it never did
 * was tell anyone WHICH record should survive, or what the merged contact would
 * look like.
 *
 * WHY THE PLATFORM DOES NOT PERFORM THE MERGE
 * Zoho v2 exposes no merge endpoint and no reliable way to move an activity
 * between records. The merge itself must happen in Zoho's own UI, which
 * re-points calls, meetings, tasks, notes and attachments onto the master and
 * keeps secondary emails and phones. This module prepares the decision; a
 * person makes it in Zoho. Nothing here writes to the CRM.
 *
 * WHAT THE MASTER CHOICE ACTUALLY DECIDES
 * Not the history — Zoho carries related records from EVERY merged record onto
 * the master, so no activity is lost whichever side wins. The master decides
 * which FIELD VALUES survive (name, primary email, primary phone); the others
 * are kept as secondary. So a wrong master is a cosmetic mistake, not a
 * destructive one, and the recommendation can be offered without the census
 * being complete. It is still ranked by activity, because the record people
 * actually worked is the one whose name and number are right.
 */

import { pool } from "./duplicateRadarDatabase";

/** A single contact record inside a merge group. */
export interface MergeCandidateContact {
  zoho_contact_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  account: string | null;
  created_date: string | null;
  /** Activity count from the census. NULL means NOT COUNTED YET — never 0. */
  activity_total: number | null;
  activity_verified: boolean;
}

export interface ContactMergeGroup {
  cluster_id: number;
  /** The record that should survive, and why. */
  master: MergeCandidateContact;
  master_reason: string;
  /** Records to be merged INTO the master. */
  duplicates: MergeCandidateContact[];
  /** Which of {email, phone, name} matched — the merge rule needs 2 of 3. */
  matched_on: string[];
  /** What the contact looks like afterwards. Secondary values are kept by Zoho. */
  merged_preview: {
    name: string | null;
    emails: string[];
    phones: string[];
    account: string | null;
    /** Total activities that end up on the master. Null if any side is uncounted. */
    activities: number | null;
  };
  /** True when every member's activity count is known, so the total is real. */
  activity_fully_counted: boolean;
}

const digits = (v: string | null | undefined) => String(v || "").replace(/\D/g, "");
const normEmail = (v: string | null | undefined) => String(v || "").trim().toLowerCase();
const normName = (v: string | null | undefined) =>
  String(v || "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * PURE. Which of {email, phone, full name} two contacts share.
 *
 * The standing rule is TWO of the three (Sarah): one alone is not evidence —
 * two people at one company share a switchboard number, and "Mohammed" is not
 * an identity. Sharing an Account is not evidence either and is deliberately
 * not consulted here.
 *
 * A phone needs 7+ digits before it counts: shorter values in this CRM are
 * junk ("11") and match everything.
 */
export function matchSignals(
  a: Pick<MergeCandidateContact, "email" | "phone" | "name">,
  b: Pick<MergeCandidateContact, "email" | "phone" | "name">,
): string[] {
  const out: string[] = [];
  const ea = normEmail(a.email);
  const eb = normEmail(b.email);
  if (ea && ea === eb) out.push("email");
  const pa = digits(a.phone);
  const pb = digits(b.phone);
  // Compare on the last 9 digits so +966 5x… and 05x… are the same number.
  if (pa.length >= 7 && pb.length >= 7 && pa.slice(-9) === pb.slice(-9)) out.push("phone");
  const na = normName(a.name);
  const nb = normName(b.name);
  if (na && na === nb) out.push("name");
  return out;
}

/**
 * PURE. Choose the survivor and say why.
 *
 * Ranked by: most activities → verified over uncounted → has an email → oldest.
 * "Most activities" is first because the record people actually worked carries
 * the name and number that are correct; an uncounted record is not treated as
 * empty, only as unproven.
 */
export function pickMaster(members: MergeCandidateContact[]): {
  master: MergeCandidateContact;
  reason: string;
} {
  const sorted = [...members].sort((x, y) => {
    const ax = x.activity_total == null ? -1 : x.activity_total;
    const ay = y.activity_total == null ? -1 : y.activity_total;
    if (ax !== ay) return ay - ax;
    if (x.activity_verified !== y.activity_verified) return x.activity_verified ? -1 : 1;
    const ex = normEmail(x.email) ? 1 : 0;
    const ey = normEmail(y.email) ? 1 : 0;
    if (ex !== ey) return ey - ex;
    const cx = x.created_date ? new Date(x.created_date).getTime() : Number.MAX_SAFE_INTEGER;
    const cy = y.created_date ? new Date(y.created_date).getTime() : Number.MAX_SAFE_INTEGER;
    return cx - cy;
  });
  const master = sorted[0];
  const others = sorted.slice(1);
  let reason: string;
  if ((master.activity_total || 0) > 0) {
    const rest = others.reduce((n, m) => n + (m.activity_total || 0), 0);
    reason =
      rest > 0
        ? `Most activity (${master.activity_total} vs ${rest} on the other record${others.length > 1 ? "s" : ""}) — Zoho moves all of them onto this one.`
        : `The only record with activity (${master.activity_total}).`;
  } else if (members.every((m) => m.activity_total == null)) {
    reason = "No record has been counted yet — this is the oldest with an email. Check in Zoho before merging.";
  } else {
    reason = "No record holds activity; this is the oldest with an email.";
  }
  return { master, reason };
}

/** Union of non-empty values, master's first, de-duplicated case-insensitively. */
function unionValues(
  master: string | null,
  others: Array<string | null>,
  norm: (v: string | null) => string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [master, ...others]) {
    const raw = String(v || "").trim();
    if (!raw) continue;
    const k = norm(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(raw);
  }
  return out;
}

/** PURE. Assemble one group from its members, or null if it is not mergeable. */
export function buildMergeGroup(
  clusterId: number,
  members: MergeCandidateContact[],
  separatedPairs: Set<string>,
): ContactMergeGroup | null {
  if (members.length < 2) return null;
  const { master, reason } = pickMaster(members);

  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  // Two of three, per contact record, against the MASTER. A member that does
  // not clear the bar against the survivor is not this person; dropping it
  // beats merging a stranger into the record.
  const signals = new Set<string>();
  const duplicates = members.filter((m) => {
    if (m.zoho_contact_id === master.zoho_contact_id) return false;
    // A pair the operator already pulled apart stays apart.
    if (separatedPairs.has(pairKey(master.zoho_contact_id, m.zoho_contact_id))) return false;
    const s = matchSignals(master, m);
    if (s.length < 2) return false;
    s.forEach((x) => signals.add(x));
    return true;
  });
  if (!duplicates.length) return null;

  const all = [master, ...duplicates];
  const fullyCounted = all.every((m) => m.activity_total != null);
  return {
    cluster_id: clusterId,
    master,
    master_reason: reason,
    duplicates,
    matched_on: Array.from(signals),
    merged_preview: {
      name: master.name,
      emails: unionValues(master.email, duplicates.map((d) => d.email), normEmail),
      phones: unionValues(master.phone, duplicates.map((d) => d.phone), digits),
      account: master.account || duplicates.map((d) => d.account).find(Boolean) || null,
      activities: fullyCounted ? all.reduce((n, m) => n + (m.activity_total || 0), 0) : null,
    },
    activity_fully_counted: fullyCounted,
  };
}

/**
 * The worklist. Read-only.
 *
 * `limit` bounds CONTACT ROWS read, not groups — a cluster can hold several
 * records, so the group count comes out lower and is reported separately.
 */
export async function getContactMergeWorklist(limit = 4000): Promise<{
  groups: ContactMergeGroup[];
  contacts_scanned: number;
  groups_with_full_counts: number;
}> {
  const res = await pool.query(
    `WITH contact_dups AS (
       SELECT c.cluster_id,
              c.zoho_record_id AS id,
              NULLIF(BTRIM(c.record_name), '') AS name,
              NULLIF(BTRIM(c.email), '') AS email,
              NULLIF(BTRIM(c.phone), '') AS phone,
              COALESCE(
                NULLIF(BTRIM(c.raw_data->'Account_Name'->>'name'), ''),
                NULLIF(BTRIM(c.company_name), '')
              ) AS account,
              c.created_date,
              a.total AS activity_total,
              (a.verified_at IS NOT NULL) AS activity_verified
         FROM duplicate_records c
         LEFT JOIN contact_activity_counts a ON a.zoho_contact_id = c.zoho_record_id
        WHERE c.record_type = 'contact'
          AND c.cluster_id IS NOT NULL
          AND c.zoho_record_id IS NOT NULL
          AND BTRIM(c.zoho_record_id) <> ''
     ),
     sized AS (
       SELECT cluster_id FROM contact_dups GROUP BY cluster_id HAVING COUNT(*) > 1
     )
     SELECT d.* FROM contact_dups d JOIN sized s USING (cluster_id)
      ORDER BY d.cluster_id, COALESCE(d.activity_total, -1) DESC, d.created_date ASC NULLS LAST
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 20000))],
  );

  const byCluster = new Map<number, MergeCandidateContact[]>();
  for (const r of res.rows as any[]) {
    const cid = Number(r.cluster_id);
    const list = byCluster.get(cid) || [];
    list.push({
      zoho_contact_id: String(r.id),
      name: r.name,
      email: r.email,
      phone: r.phone,
      account: r.account,
      created_date: r.created_date ? String(r.created_date) : null,
      activity_total: r.activity_total == null ? null : Number(r.activity_total),
      activity_verified: !!r.activity_verified,
    });
    byCluster.set(cid, list);
  }

  // Separated pairs, once, for every id in play.
  const allIds = (res.rows as any[]).map((r) => String(r.id));
  const separatedPairs = new Set<string>();
  if (allIds.length) {
    const sep = await pool.query(
      `SELECT zoho_id_low, zoho_id_high
         FROM duplicate_separation_ledger
        WHERE zoho_id_low = ANY($1::text[]) OR zoho_id_high = ANY($1::text[])`,
      [allIds],
    );
    for (const row of sep.rows as any[]) {
      separatedPairs.add(`${row.zoho_id_low}|${row.zoho_id_high}`);
    }
  }

  const groups: ContactMergeGroup[] = [];
  for (const [cid, members] of byCluster.entries()) {
    const g = buildMergeGroup(cid, members, separatedPairs);
    if (g) groups.push(g);
  }

  // Most activity at stake first — the merges worth doing today.
  groups.sort(
    (a, b) =>
      (b.merged_preview.activities || 0) - (a.merged_preview.activities || 0) ||
      b.duplicates.length - a.duplicates.length,
  );

  return {
    groups,
    contacts_scanned: res.rows.length,
    groups_with_full_counts: groups.filter((g) => g.activity_fully_counted).length,
  };
}
