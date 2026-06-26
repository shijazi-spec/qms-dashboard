import { isPlaceholderName } from "./duplicateRadarDatabase";

// Moderate test-record detection: a standalone whole-word keyword (EN+AR) OR an
// exact placeholder. Env-extendable via EMPTY_DELETE_TEST_KEYWORDS (comma-sep).
// NB: "demo" and "testing" are deliberately NOT here — they're business-legit
// ("Request Demo | <client>" deals, "<X> Testing Laboratory" firms). A record
// named EXACTLY "demo"/"testing" is still caught via isPlaceholderName. Re-add
// any word through EMPTY_DELETE_TEST_KEYWORDS if your data needs it. (Sarah 2026-06-25)
const BASE_TEST_KEYWORDS = [
  "test", "tester", "dummy", "sample", "trial", "sandbox",
  "asdf", "qwerty", "xxx", "zzz", "deleteme", "donotuse", "placeholder",
  "تجربة", "تجريبي", "اختبار", "تست",
];
export const EMPTY_DELETE_TEST_KEYWORDS: string[] = Array.from(
  new Set([
    ...BASE_TEST_KEYWORDS,
    ...(process.env.EMPTY_DELETE_TEST_KEYWORDS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ]),
);
const _TEST_KW_SET = new Set(EMPTY_DELETE_TEST_KEYWORDS);

// Whole-name junk: the ENTIRE name is a generic placeholder — bulk-import
// artifacts like 97 contacts literally named "name" (Sarah 2026-06-25). Matched
// as the WHOLE name only (NOT a token), so real firms like "First Contact
// Solutions" are never touched. Flagged regardless of account link.
const WHOLE_NAME_JUNK = new Set([
  "name", "names", "contact", "contacts", "اسم", "الاسم", "جهة اتصال",
]);
// Selective LIKE roots for the SQL prefilter (short tokens like "n" would match
// everything, so only the substantial ones go to ILIKE; JS refines to an exact
// whole-name match).
const _WHOLE_NAME_LIKE_ROOTS = ["name", "contact", "اسم"];

// Tokenize on anything that isn't a Latin/Arabic letter or digit.
function _tokens(name: string): string[] {
  return (name || "")
    .toLowerCase()
    .split(/[^a-z0-9؀-ۿ]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function isTestOrPlaceholderName(name: string | null | undefined): boolean {
  if (!name) return false;
  if (isPlaceholderName(name)) return true;
  // Whole-name junk (exact match on the full normalized name only).
  if (WHOLE_NAME_JUNK.has(name.trim().toLowerCase())) return true;
  for (const tok of _tokens(name)) {
    if (_TEST_KW_SET.has(tok)) return true;
  }
  return false;
}

/**
 * Coarse SQL ILIKE patterns to PREFILTER candidate rows; JS refines (so
 * "%test%" can over-match "latest" and "%contact%" can over-match "First
 * Contact Solutions" — both dropped by the whole-word / whole-name checks).
 */
export function testKeywordLikePatterns(): string[] {
  return [
    ...EMPTY_DELETE_TEST_KEYWORDS.map((k) => `%${k}%`),
    ..._WHOLE_NAME_LIKE_ROOTS.map((k) => `%${k}%`),
  ];
}

export const DEAL_PROTECTED_STAGES = new Set(["agreement signed", "paid"]);

export function isProtectedDealStage(stage?: string | null): boolean {
  return DEAL_PROTECTED_STAGES.has(String(stage || "").trim().toLowerCase());
}

export function classifyDeal(input: {
  hasAccount: boolean;
  hasContact: boolean;
  amount: number;
  name: string;
  hasAttachments?: boolean;
  stage?: string | null;
}): { reason: "orphaned" | "empty" | "test" | null; deleteEligible: boolean; linkEligible: boolean } {
  const isTest = isTestOrPlaceholderName(input.name);
  const empty = !input.hasAccount && !input.hasContact && !input.hasAttachments && !isProtectedDealStage(input.stage);
  const orphaned = !input.hasAccount;
  let reason: "orphaned" | "empty" | "test" | null = null;
  if (isTest) reason = "test";
  else if (empty) reason = "empty";
  else if (orphaned) reason = "orphaned";
  return {
    reason,
    deleteEligible: isTest || empty,
    linkEligible: orphaned,
  };
}

export function classifyAccount(input: {
  hasDeals: boolean;
  hasContacts: boolean;
  name: string;
  hasEmail?: boolean;
  hasAttachments?: boolean;
}): { reason: "empty" | "test" | null; structurallyEmpty: boolean } {
  const isTest = isTestOrPlaceholderName(input.name);
  const structurallyEmpty = !input.hasDeals && !input.hasContacts && !input.hasEmail && !input.hasAttachments;
  let reason: "empty" | "test" | null = null;
  if (isTest) reason = "test";
  else if (structurallyEmpty) reason = "empty";
  return { reason, structurallyEmpty };
}

export function classifyContact(input: {
  hasEmail: boolean;
  hasPhone: boolean;
  hasAccount: boolean;
  hasDeals: boolean;
  name: string;
}): { reason: "empty" | "test" | null; deleteEligible: boolean } {
  const isTest = isTestOrPlaceholderName(input.name);
  const nameOnly = !input.hasEmail && !input.hasPhone && !input.hasAccount && !input.hasDeals;
  let reason: "empty" | "test" | null = null;
  if (isTest) reason = "test";
  else if (nameOnly) reason = "empty";
  return { reason, deleteEligible: isTest || nameOnly };
}
