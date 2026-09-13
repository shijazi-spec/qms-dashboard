/**
 * GUARD for the bulk "link contacts → Account" cascade.
 *
 * WHY THIS EXISTS
 * The bulk link sets Account_Name on every contact of a cluster that holds
 * contacts and exactly one Account. It used to write that value blind. A live
 * preview on 2026-09-13 (2,065 clusters / 2,272 contacts) showed what that
 * actually means today: in a 40-contact sample, 38 already pointed at the very
 * account the job would set, none were unlinked, and 2 pointed at a DIFFERENT
 * company — which the job would have silently overwritten. Scaled up, that is
 * ~100 contacts moved under the wrong customer for no gain at all.
 *
 * So a contact is only written when it has NO account. A contact that already
 * points somewhere else is never touched: it is reported instead, because a
 * cluster that says one company while the record says another is exactly the
 * kind of mismatch a human should look at.
 *
 * Pure functions — no database, no Zoho. The caller passes the contact's
 * Account_Name value straight out of raw_data.
 */

export type ContactLinkVerdict =
  /** No account on the record — the one case the bulk link may write. */
  | "link"
  /** Already points at the target account — writing would change nothing. */
  | "already_linked"
  /** Points at a DIFFERENT account — never overwrite; report for review. */
  | "mismatch";

export interface ContactAccountLink {
  /** Zoho id of the account the contact currently points at, if the lookup carries one. */
  id: string | null;
  /** Display name of that account, if present. */
  name: string | null;
}

export interface LinkTarget {
  zohoId: string;
  name: string;
}

/** Lower-case, collapse whitespace — for comparing account names without ids. */
function normName(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Read a Zoho Account_Name lookup value. Zoho returns `{ id, name }`, but the
 * mirror also holds older rows where it is a bare string, or absent entirely.
 */
export function readContactAccountLink(accountNameValue: unknown): ContactAccountLink {
  if (accountNameValue == null) return { id: null, name: null };
  if (typeof accountNameValue === "string") {
    const name = accountNameValue.trim();
    return { id: null, name: name || null };
  }
  if (typeof accountNameValue === "object") {
    const o = accountNameValue as Record<string, unknown>;
    const rawId = o.id ?? o.Id ?? null;
    const rawName = o.name ?? o.Name ?? null;
    const id = rawId == null ? null : String(rawId).trim() || null;
    const name = rawName == null ? null : String(rawName).trim() || null;
    return { id, name };
  }
  return { id: null, name: null };
}

/**
 * Decide what the bulk link may do with one contact.
 *
 * The id wins whenever the record carries one. Only when it does not — older
 * mirror rows that stored the lookup as a plain name — does the name decide,
 * so a name-only row that already reads as the target company is left alone
 * rather than rewritten.
 */
export function classifyContactAccountLink(
  accountNameValue: unknown,
  target: LinkTarget,
): ContactLinkVerdict {
  const current = readContactAccountLink(accountNameValue);
  if (!current.id && !current.name) return "link";
  const targetId = String(target?.zohoId ?? "").trim();
  if (current.id) {
    return targetId && current.id === targetId ? "already_linked" : "mismatch";
  }
  const targetName = normName(target?.name);
  return targetName && normName(current.name) === targetName ? "already_linked" : "mismatch";
}
