/**
 * CONTACT CLEANUP — the workbook that goes to the Zoho admin (Sarah
 * 2026-09-11: "I need a clear report about it to be sent to the Zoho Admin
 * directly").
 *
 * WHY A WORKBOOK AND NOT A LIST
 * The recipient does not need our verdicts, they need instructions they can
 * work through and sign off. Every bucket demands a DIFFERENT action, and
 * mixing them is how activity history gets deleted: a sheet headed "duplicate
 * contacts" invites deleting all of them, when a third of them must be merged
 * instead. So each bucket is its own sheet, every sheet leads with an ACTION
 * column, and the first sheet says in plain words what to do and what never to
 * do.
 *
 * THE ONE RULE THE WHOLE REPORT EXISTS TO ENFORCE
 * Deleting a contact in Zoho deletes its calls, meetings and emails with it. So
 * a record is only ever listed as deletable when the activity census has
 * POSITIVELY verified it holds nothing AND it has no duplicate to merge into.
 * Everything else goes to a merge sheet. Uncounted is unknown, and unknown is
 * never on a delete sheet.
 *
 * COVERAGE IS PRINTED ON THE SUMMARY. The census is partial, so these counts
 * are a floor, not a total. A reader who does not know that will assume the
 * list is the whole problem and close it.
 */

import type { ColumnSpec } from "./excelExport";
import { getContactsWithNoActivity } from "./contactActivitySweep";
import { getContactMergeWorklist } from "./contactMergeWorklist";
import { getOrphanContacts } from "./orphanContacts";
import { getContactActivityCoverage } from "./contactActivitySweep";

const ZOHO = (id: string) =>
  `https://crm.zoho.com/crm/org766568398/tab/Contacts/${id}`;

export interface CleanupSheet {
  name: string;
  columns: ColumnSpec[];
  rows: Record<string, any>[];
  freezeHeader?: boolean;
}

export interface CleanupReport {
  sheets: CleanupSheet[];
  counts: {
    delete_no_duplicate: number;
    merge_empty_with_twin: number;
    merge_both_active: number;
    orphans: number;
    coverage_pct: number;
  };
  filename: string;
}

const col = (header: string, key: string, width = 24): ColumnSpec => ({
  header,
  key,
  width,
});

/**
 * Build it. Read-only — every source query is a read, and the workbook is a
 * set of instructions, not an action.
 */
export async function buildContactCleanupReport(): Promise<CleanupReport> {
  const [noActivity, mergeWork, orphans, coverage] = await Promise.all([
    getContactsWithNoActivity(20000),
    getContactMergeWorklist(8000),
    getOrphanContacts(20000),
    getContactActivityCoverage(),
  ]);

  const orphanIds = new Set(orphans.contacts.map((o) => o.zoho_contact_id));

  // Bucket 1 — proven empty, no duplicate, and NOT already on the orphan
  // sheet. Listing a record twice under two different actions is how an admin
  // ends up doing the wrong one.
  const deletable = noActivity.filter(
    (c) => !c.twin_id && !orphanIds.has(c.zoho_contact_id),
  );
  // Bucket 2 — proven empty, but a duplicate exists. NOT deletable: the empty
  // record routinely holds the only copy of an email or a phone.
  const emptyWithTwin = noActivity.filter((c) => c.twin_id);

  const checked = (coverage.with_activity || 0) + (coverage.verified || 0);
  const coveragePct = coverage.contacts
    ? Math.round((checked / coverage.contacts) * 100)
    : 0;

  const sheets: CleanupSheet[] = [];

  // ── Sheet 1: what to do ───────────────────────────────────────────────────
  sheets.push({
    name: "Start here",
    columns: [col("Item", "item", 34), col("Detail", "detail", 110)],
    rows: [
      { item: "Purpose", detail: "Contact clean-up in Zoho CRM. Each sheet needs a DIFFERENT action — please do not merge the sheets." },
      { item: "", detail: "" },
      { item: "⚠ THE ONE RULE", detail: "Deleting a contact in Zoho deletes its calls, meetings and emails with it. Only the DELETE sheets are safe to delete. Never delete a row from a MERGE sheet." },
      { item: "", detail: "" },
      { item: "Sheet 2 — DELETE (no duplicate)", detail: `${deletable.length} contacts. Verified to hold no calls, meetings, emails, notes or attachments, and no duplicate exists. Safe to delete.` },
      { item: "Sheet 3 — MERGE (empty, has a duplicate)", detail: `${emptyWithTwin.length} contacts. They hold no activity, but a duplicate of the same person exists. MERGE them in Zoho — the empty record often holds the only copy of an email or phone. Do not delete.` },
      { item: "Sheet 4 — MERGE (both hold activity)", detail: `${mergeWork.groups.length} merges. Both records carry history. Merge in Zoho: it moves every call, meeting and task onto the survivor and keeps the second email and phone. Nothing is lost.` },
      { item: "Sheet 5 — DELETE (orphans)", detail: `${orphans.contacts.length} contacts. No Account, no Deal, no activity, no email, no phone. Nothing attached and nothing to merge into. Safe to delete.` },
      { item: "", detail: "" },
      { item: "How to merge in Zoho", detail: "Open the record marked KEEP, then use Zoho's Merge. Zoho re-points related records onto the survivor and keeps secondary emails/phones. The platform cannot do this — Zoho's API has no way to move an activity between records." },
      { item: "", detail: "" },
      { item: "⚠ Coverage", detail: `The activity check has covered ${coveragePct}% of ${coverage.contacts} contacts (${coverage.with_activity} have activity, ${coverage.proven_empty} verified empty). THESE COUNTS ARE A FLOOR, NOT A TOTAL — a contact not yet checked is deliberately absent rather than assumed empty.` },
      { item: "Why a contact may be missing", detail: "It has not been checked yet, or a Deal points at it, or it has a duplicate that has not been verified. Absence from this report is never a reason to delete." },
      { item: "", detail: "" },
      { item: "Generated", detail: new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC" },
    ],
    freezeHeader: true,
  });

  // ── Sheet 2: delete, no duplicate ─────────────────────────────────────────
  sheets.push({
    name: "2. DELETE no duplicate",
    columns: [
      col("Action", "action", 14),
      col("Contact", "name", 30),
      col("Account", "account", 30),
      col("Owner", "owner", 22),
      col("Created", "created", 12),
      col("Verified empty at", "verified", 20),
      col("Zoho ID", "id", 22),
      col("Open in Zoho", "url", 60),
    ],
    rows: deletable.map((c) => ({
      action: "DELETE",
      name: c.name || "(no name)",
      account: c.account || "",
      owner: c.owner || "",
      created: c.created_date ? String(c.created_date).slice(0, 10) : "",
      verified: c.verified_at ? String(c.verified_at).slice(0, 19).replace("T", " ") : "",
      id: c.zoho_contact_id,
      url: ZOHO(c.zoho_contact_id),
    })),
    freezeHeader: true,
  });

  // ── Sheet 3: empty, but a duplicate exists ────────────────────────────────
  sheets.push({
    name: "3. MERGE empty has dup",
    columns: [
      col("Action", "action", 22),
      col("Contact (empty)", "name", 30),
      col("Its email", "email", 28),
      col("Its phone", "phone", 18),
      col("MERGE INTO", "twin", 30),
      col("Survivor email", "twin_email", 28),
      col("Survivor activities", "twin_acts", 18),
      col("Zoho ID (empty)", "id", 22),
      col("Zoho ID (survivor)", "twin_id", 22),
      col("Open the empty one", "url", 60),
      col("Open the survivor", "twin_url", 60),
    ],
    rows: emptyWithTwin.map((c) => ({
      action: "MERGE — do not delete",
      name: c.name || "(no name)",
      email: c.email || "",
      phone: c.phone || "",
      twin: c.twin_name || "",
      twin_email: c.twin_email || "",
      // Never print 0 for an uncounted record — that distinction is the point.
      twin_acts: c.twin_activity == null ? "not counted" : c.twin_activity,
      id: c.zoho_contact_id,
      twin_id: c.twin_id || "",
      url: ZOHO(c.zoho_contact_id),
      twin_url: c.twin_id ? ZOHO(c.twin_id) : "",
    })),
    freezeHeader: true,
  });

  // ── Sheet 4: both sides hold activity ─────────────────────────────────────
  // One row per RECORD, master first, so the admin can sort by merge group and
  // see at a glance which record survives.
  const bothRows: Record<string, any>[] = [];
  mergeWork.groups.forEach((g, i) => {
    const ref = `M${String(i + 1).padStart(3, "0")}`;
    bothRows.push({
      merge: ref,
      action: "KEEP — merge the others into this",
      name: g.master.name || "(no name)",
      email: g.master.email || "",
      phone: g.master.phone || "",
      acts: g.master.activity_total == null ? "not counted" : g.master.activity_total,
      matched: g.matched_on.join(" + "),
      why: g.master_reason,
      after: [
        g.merged_preview.name || "",
        g.merged_preview.emails.join(" ; "),
        g.merged_preview.phones.join(" ; "),
        g.merged_preview.activities == null
          ? "activity total unknown"
          : `${g.merged_preview.activities} activities kept`,
      ].filter(Boolean).join(" | "),
      id: g.master.zoho_contact_id,
      url: ZOHO(g.master.zoho_contact_id),
    });
    for (const d of g.duplicates) {
      bothRows.push({
        merge: ref,
        action: "MERGE INTO THE KEEP ROW",
        name: d.name || "(no name)",
        email: d.email || "",
        phone: d.phone || "",
        acts: d.activity_total == null ? "not counted" : d.activity_total,
        matched: "",
        why: "",
        after: "",
        id: d.zoho_contact_id,
        url: ZOHO(d.zoho_contact_id),
      });
    }
  });
  sheets.push({
    name: "4. MERGE both active",
    columns: [
      col("Merge #", "merge", 10),
      col("Action", "action", 30),
      col("Contact", "name", 30),
      col("Email", "email", 28),
      col("Phone", "phone", 18),
      col("Activities", "acts", 12),
      col("Matched on", "matched", 20),
      col("Why this survivor", "why", 60),
      col("Result after merge", "after", 70),
      col("Zoho ID", "id", 22),
      col("Open in Zoho", "url", 60),
    ],
    rows: bothRows,
    freezeHeader: true,
  });

  // ── Sheet 5: orphans ──────────────────────────────────────────────────────
  sheets.push({
    name: "5. DELETE orphans",
    columns: [
      col("Action", "action", 14),
      col("Contact", "name", 30),
      col("Owner", "owner", 22),
      col("Created", "created", 12),
      col("Why it qualifies", "why", 70),
      col("Zoho ID", "id", 22),
      col("Open in Zoho", "url", 60),
    ],
    rows: orphans.contacts.map((o) => ({
      action: "DELETE",
      name: o.name || "(no name)",
      owner: o.owner || "",
      created: o.created_date ? String(o.created_date).slice(0, 10) : "",
      why: o.reasons.join(" · "),
      id: o.zoho_contact_id,
      url: ZOHO(o.zoho_contact_id),
    })),
    freezeHeader: true,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    sheets,
    counts: {
      delete_no_duplicate: deletable.length,
      merge_empty_with_twin: emptyWithTwin.length,
      merge_both_active: mergeWork.groups.length,
      orphans: orphans.contacts.length,
      coverage_pct: coveragePct,
    },
    filename: `contact-cleanup-${stamp}.xlsx`,
  };
}
