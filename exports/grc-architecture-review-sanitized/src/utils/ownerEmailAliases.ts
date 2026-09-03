/**
 * Owner-email aliases — "one person, multiple mailboxes" canonicaliser.
 *
 * Some reps end up tagged on several mailboxes across the CRM (their own
 * address + a shared/import mailbox like `pipedrive@` or `info@`). Without
 * this map, the Owner Accountability rollup splits them into 3+ rows and
 * makes one person look like three different owners.
 *
 * This module is the **single source of truth** — both the backend rollups
 * (getOwnerAccountability, getDuplicatesByOwner) and the dashboard's
 * post-fetch merge function pull from here. The previous version of this
 * map lived only in the dashboard HTML, which meant AssistantPersona and any other
 * backend consumer saw a different (un-merged) view than the dashboard.
 *
 * MAINTENANCE — when adding an alias:
 *   - confirm the source mailbox is actually used by ONLY that one rep
 *   - a shared mailbox legitimately tagged with multiple modifiers (e.g.
 *     an auto-mod account everyone uses) must NOT be aliased here; folding
 *     every other rep's records into the alias target is the failure mode
 *   - keys + values must be lower-case + trimmed (the canonicaliser only
 *     normalises the lookup, not the stored values)
 */

/** alias-email → canonical-email. Keys and values lower-case + trimmed. */
export const OWNER_EMAIL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Rayan Saleh — sits on three tagged addresses in this tenant; <REDACTED_EMAIL>
  // appears only with the "Rayan Saleh" name in the data, so it's safe to alias.
  "<REDACTED_EMAIL>": "<REDACTED_EMAIL>",
  "<REDACTED_EMAIL>": "<REDACTED_EMAIL>",
});

/**
 * Return the canonical email for an owner mailbox. Lower-cases + trims the
 * input; returns the alias target when one exists, else the input itself.
 * Empty / null input returns an empty string so the caller can group safely.
 */
export function canonicaliseOwnerEmail(rawEmail: string | null | undefined): string {
  const key = (rawEmail ?? "").trim().toLowerCase();
  if (!key) return "";
  return OWNER_EMAIL_ALIASES[key] ?? key;
}
