/**
 * Formatting for the CS channel's Slack alerts.
 *
 * Split out of scheduledJobs.ts so it can be tested. Importing scheduledJobs in
 * a test drags in sharedPool and opens a database connection at module load —
 * this file is pure string work with no imports at all, so a test can exercise
 * the arithmetic that decides what a compliance alert claims.
 *
 * That arithmetic is worth guarding: an off-by-one in the overflow line is the
 * kind of thing nobody notices, and "…and 3 more" under a list that is actually
 * hiding 4 is a compliance message that quietly understates a backlog.
 */

/**
 * Turn a violation code into something a person reads:
 * `renewal_overdue` → "Renewal overdue", `missing_cs_owner` → "Missing CS owner".
 *
 * Derived from the code rather than kept as a hand-written map on purpose. A
 * label map drifts silently when a new rule is added — the rule fires, the map
 * has no entry, and the alert shows a blank or "undefined" beside a real count.
 * Deriving it means a new rule reads correctly the day it is written, with no
 * second edit to forget.
 */
export function csRuleLabel(code: string): string {
  const words = String(code || "unknown")
    .replace(/_/g, " ")
    .trim();
  const cased = words.charAt(0).toUpperCase() + words.slice(1);
  // The two abbreviations the derivation cannot know about. Whole-word only, so
  // "cars" and "arrears" are left alone.
  return cased.replace(/\bcs\b/gi, "CS").replace(/\barr\b/gi, "ARR");
}

/**
 * Descending count list — "• Label — 7" — capped, with an honest overflow line.
 *
 * Zero counts are dropped rather than listed: the CS scan reports all 13 rule
 * codes every run, most of them at zero, and a list of zeroes buries the three
 * that matter.
 *
 * The cap exists because Slack truncates long messages, and its truncation says
 * nothing — the tail just disappears. "…and N more" is the same limit, stated.
 */
export function topCounts(
  counts: Record<string, number>,
  max: number,
  label: (key: string) => string = (key) => key,
): string {
  const rows = Object.entries(counts || {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (rows.length === 0) return "";
  const shown = rows
    .slice(0, max)
    .map(([k, n]) => `• ${label(k)} — ${n}`)
    .join("\n");
  const rest = rows.length - max;
  return rest > 0 ? `${shown}\n• …and ${rest} more` : shown;
}
