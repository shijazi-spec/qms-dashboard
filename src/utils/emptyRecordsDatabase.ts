import { pool } from "./duplicateRadarDatabase";
import {
  classifyDeal,
  classifyAccount,
  classifyContact,
  testKeywordLikePatterns,
} from "./emptyRecordsDetection";

export interface EmptyRecordRow {
  zohoId: string;
  name: string;
  owner: string | null;
  reason: "orphaned" | "empty" | "test";
  deleteEligible: boolean;
  linkEligible?: boolean;
  extra?: Record<string, any>;
}

const CAP = 500;
const LIKES = testKeywordLikePatterns();
const EMPTY_DELETE_TAG = process.env.EMPTY_DELETE_TAG || "Empty-Delete";

// SQL fragment shared by all three queries: drop any record the operator has
// already tagged Empty-Delete (via the in-platform ledger for immediate effect)
// OR whose freshly-synced Zoho Tag array already carries the tag. Either way a
// tagged record stops reappearing on Refresh.
const NOT_ALREADY_TAGGED = `
  AND %ALIAS%zoho_record_id NOT IN (SELECT zoho_record_id FROM empty_delete_ledger)
  AND NOT COALESCE(%ALIAS%raw_data->'Tag' @> $2::jsonb, false)`;
const TAG_JSONB = JSON.stringify([{ name: EMPTY_DELETE_TAG }]);
const excl = (alias: string) => NOT_ALREADY_TAGGED.replace(/%ALIAS%/g, alias);

/** Mark records as Empty-Delete-tagged locally so the cleanup list drops them
 * immediately (before the slow full sync catches up). Idempotent. */
export async function markEmptyDeleteTagged(
  module: string,
  zohoIds: string[],
  by: string | null,
): Promise<void> {
  const ids = (zohoIds || []).map((s) => String(s)).filter(Boolean);
  if (!ids.length) return;
  await pool.query(
    `INSERT INTO empty_delete_ledger (zoho_record_id, module, tagged_by)
       SELECT UNNEST($1::text[]), $2, $3
       ON CONFLICT (zoho_record_id) DO NOTHING`,
    [ids, module, by],
  );
}

/** Undo the local mark (operator removed the Empty-Delete tag). */
export async function unmarkEmptyDeleteTagged(zohoIds: string[]): Promise<void> {
  const ids = (zohoIds || []).map((s) => String(s)).filter(Boolean);
  if (!ids.length) return;
  await pool.query(
    `DELETE FROM empty_delete_ledger WHERE zoho_record_id = ANY($1::text[])`,
    [ids],
  );
}

// Deals: orphaned (no Account) OR a coarse test-name match. JS classifier refines.
export async function getEmptyDeals(): Promise<EmptyRecordRow[]> {
  const q = await pool.query(
    `SELECT zoho_record_id, record_name, owner_name,
            COALESCE(deal_value, 0) AS amount,
            raw_data->'Account_Name'->>'id' AS account_id,
            raw_data->'Contact_Name'->>'id' AS contact_id
       FROM duplicate_records
      WHERE record_type='deal'
        AND ( COALESCE(NULLIF(raw_data->'Account_Name'->>'id',''), NULL) IS NULL
              OR record_name ILIKE ANY($1::text[]) )
        ${excl("")}
      ORDER BY modified_date DESC NULLS LAST
      LIMIT 4000`,
    [LIKES, TAG_JSONB],
  );
  const out: EmptyRecordRow[] = [];
  for (const r of q.rows) {
    const c = classifyDeal({
      hasAccount: !!(r.account_id && String(r.account_id).trim()),
      hasContact: !!(r.contact_id && String(r.contact_id).trim()),
      amount: Number(r.amount) || 0,
      name: r.record_name || "",
    });
    if (!c.reason) continue;
    out.push({
      zohoId: r.zoho_record_id,
      name: r.record_name || "",
      owner: r.owner_name || null,
      reason: c.reason,
      deleteEligible: c.deleteEligible,
      linkEligible: c.linkEligible,
      extra: { amount: Number(r.amount) || 0, hasContact: !!r.contact_id },
    });
    if (out.length >= CAP) break;
  }
  return out;
}

// Accounts: structurally empty (no deal/contact references it) OR test-name.
export async function getEmptyAccounts(): Promise<EmptyRecordRow[]> {
  const q = await pool.query(
    `WITH linked AS (
        SELECT DISTINCT raw_data->'Account_Name'->>'id' AS aid
          FROM duplicate_records
         WHERE record_type IN ('deal','contact')
           AND raw_data->'Account_Name'->>'id' IS NOT NULL
           AND raw_data->'Account_Name'->>'id' <> ''
     )
     SELECT a.zoho_record_id, a.record_name, a.account_name, a.owner_name,
            (a.zoho_record_id NOT IN (SELECT aid FROM linked)) AS structurally_empty
       FROM duplicate_records a
      WHERE a.record_type='account'
        AND ( a.zoho_record_id NOT IN (SELECT aid FROM linked)
              OR a.record_name ILIKE ANY($1::text[])
              OR a.account_name ILIKE ANY($1::text[]) )
        ${excl("a.")}
      ORDER BY a.modified_date DESC NULLS LAST
      LIMIT 4000`,
    [LIKES, TAG_JSONB],
  );
  const out: EmptyRecordRow[] = [];
  for (const r of q.rows) {
    const name = r.record_name || r.account_name || "";
    const c = classifyAccount({
      hasDeals: !r.structurally_empty, // structurally_empty=false → it HAS a link
      hasContacts: !r.structurally_empty,
      name,
    });
    if (!c.reason) continue;
    out.push({
      zohoId: r.zoho_record_id,
      name,
      owner: r.owner_name || null,
      reason: c.reason,
      // Structurally-empty accounts need the lazy attachment check before delete;
      // test-named accounts are delete-eligible directly.
      deleteEligible: c.reason === "test",
      extra: { structurallyEmpty: c.structurallyEmpty, needsAttachmentCheck: c.reason === "empty" },
    });
    if (out.length >= CAP) break;
  }
  return out;
}

// Contacts: name-only (no email/phone/account/deal) OR test-name.
export async function getEmptyContacts(): Promise<EmptyRecordRow[]> {
  const q = await pool.query(
    `WITH deal_contacts AS (
        SELECT DISTINCT raw_data->'Contact_Name'->>'id' AS cid
          FROM duplicate_records
         WHERE record_type='deal'
           AND raw_data->'Contact_Name'->>'id' IS NOT NULL
           AND raw_data->'Contact_Name'->>'id' <> ''
     )
     SELECT c.zoho_record_id, c.record_name, c.owner_name,
            (c.email IS NOT NULL AND c.email <> '') AS has_email,
            ((c.phone_normalized IS NOT NULL AND c.phone_normalized <> '')
             OR (c.mobile_normalized IS NOT NULL AND c.mobile_normalized <> '')) AS has_phone,
            (c.raw_data->'Account_Name'->>'id' IS NOT NULL AND c.raw_data->'Account_Name'->>'id' <> '') AS has_account,
            (c.zoho_record_id IN (SELECT cid FROM deal_contacts)) AS has_deals
       FROM duplicate_records c
      WHERE c.record_type='contact'
        AND ( ( (c.email IS NULL OR c.email='')
                AND (c.phone_normalized IS NULL OR c.phone_normalized='')
                AND (c.mobile_normalized IS NULL OR c.mobile_normalized='')
                AND (c.raw_data->'Account_Name'->>'id' IS NULL OR c.raw_data->'Account_Name'->>'id'='')
                AND c.zoho_record_id NOT IN (SELECT cid FROM deal_contacts) )
              OR c.record_name ILIKE ANY($1::text[]) )
        ${excl("c.")}
      ORDER BY c.modified_date DESC NULLS LAST
      LIMIT 4000`,
    [LIKES, TAG_JSONB],
  );
  const out: EmptyRecordRow[] = [];
  for (const r of q.rows) {
    const c = classifyContact({
      hasEmail: !!r.has_email,
      hasPhone: !!r.has_phone,
      hasAccount: !!r.has_account,
      hasDeals: !!r.has_deals,
      name: r.record_name || "",
    });
    if (!c.reason) continue;
    out.push({
      zohoId: r.zoho_record_id,
      name: r.record_name || "",
      owner: r.owner_name || null,
      reason: c.reason,
      deleteEligible: c.deleteEligible,
    });
    if (out.length >= CAP) break;
  }
  return out;
}
