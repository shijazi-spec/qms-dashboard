// Placeholder / non-real account labels (mirror accountInference.ts).
export const PLACEHOLDER_ACCOUNTS = new Set(["", "-", "n/a", "na", "none", "null", "unknown", "test"]);

const linkVal = (obj: any): { id?: string; name?: string } | null =>
  obj && typeof obj === "object" ? obj : null;

/** A Contact needs an Account when it has no Account_Name, or a placeholder one. */
export function contactNeedsAccount(raw: any): boolean {
  const acc = linkVal(raw?.Account_Name);
  if (!acc) return true;
  if (acc.id) return false;                       // a real linked account
  const nm = String(acc.name || "").trim().toLowerCase();
  return !nm || PLACEHOLDER_ACCOUNTS.has(nm);
}

/** A Deal needs a Contact when it has no Contact_Name (no primary contact role). */
export function dealNeedsContact(raw: any): boolean {
  const c = linkVal(raw?.Contact_Name);
  return !(c && c.id);
}

/** Confidence = base 40 + evidence, capped 100. Matches Account Hints. */
export function scoreLinkConfidence(a: { agreeing: number; explicitDomain: boolean; relatedRecords: number }): number {
  let s = 40;
  s += a.agreeing >= 2 ? 25 : a.agreeing === 1 ? 10 : 0;
  s += a.explicitDomain ? 25 : 0;
  s += a.relatedRecords > 0 ? 10 : 0;
  return Math.min(100, s);
}
