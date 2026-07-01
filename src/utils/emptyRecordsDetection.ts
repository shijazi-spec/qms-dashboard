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
  // NB: "تجربة" (= "experience / trial") is deliberately NOT here — it is
  // business-legit Arabic ("تجربة العميل" = customer experience / CX, "تجربة
  // المستخدم" = user experience). Flagging it as a token mis-tagged real
  // accounts like "AlasilaCX | تجربة العميل" (Ahmad 2026-06-26). "تجريبي" (=
  // "experimental") stays — it reads as a genuine test marker in a company name.
  "تجريبي", "اختبار", "تست",
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
  const jt = isJunkOrTestName(name);
  if (jt.test || jt.junk) return true;
  return false;
}

// --- walaplus (exact) + junk/gibberish name detection (Sarah 2026-07-01) ---
// `walaplus` = EXACT normalized name only (never a substring — "WalaPlus
// Partners" / "walaplus.com deal" must NOT match). junk = conservative +
// Arabic-safe: J1 whole name is one token repeated (case-insensitive, token
// len>=4); J2 a single Latin token len>=6 that looks machine-generated
// (letters+digits mashup, or mixed-case with a low vowel ratio). Guards:
// never flag a name containing Arabic characters, a genuine >=2-distinct-
// real-word name, a <5-char name, or a pure-numeric name.
// NB: collapses ALL whitespace (not just repeats) so "wala plus" normalizes to
// "walaplus" for the exact-match check below — per spec: "normalize
// lowercase+trim+collapse spaces → equals walaplus" (Sarah 2026-07-01).
function _normName(name: string): string {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, "");
}
function _hasArabic(s: string): boolean {
  return /[؀-ۿ]/.test(s);
}
function _vowelRatio(t: string): number {
  const m = t.match(/[aeiou]/gi);
  return t.length ? (m ? m.length : 0) / t.length : 0;
}
// Count upper<->lower transitions. Real names have few (Acme=1, SES=0,
// even CamelCase brands like McDonald/LinkedIn=3); random machine strings
// (jJQaBOcg=4) have more. Threshold >=4 catches the gibberish while sparing
// genuine CamelCase brands — deliberately conservative to avoid false deletes.
function _caseSwitches(t: string): number {
  let n = 0;
  for (let i = 1; i < t.length; i++) {
    const a = t[i - 1], b = t[i];
    const aL = a >= "a" && a <= "z", aU = a >= "A" && a <= "Z";
    const bL = b >= "a" && b <= "z", bU = b >= "A" && b <= "Z";
    if ((aL && bU) || (aU && bL)) n++;
  }
  return n;
}
function _isMachineToken(t: string): boolean {
  if (t.length < 6) return false;
  const hasLetter = /[a-z]/i.test(t), hasDigit = /\d/.test(t);
  if (hasLetter && hasDigit) return true; // letters+digits mashup
  if (_caseSwitches(t) >= 4) return true; // random internal casing (beyond CamelCase brands)
  if (/^[a-z]+$/i.test(t) && _vowelRatio(t) < 0.2) return true; // consonant soup
  return false;
}
export function isJunkOrTestName(name: string | null | undefined): { junk: boolean; test: boolean } {
  const raw = String(name || "");
  const norm = _normName(raw);
  if (!norm) return { junk: false, test: false };
  const test = norm === "walaplus";
  let junk = false;
  if (!_hasArabic(raw)) {
    const toks = raw.trim().split(/\s+/).filter(Boolean);
    if (toks.length === 2 && toks[0].toLowerCase() === toks[1].toLowerCase() && toks[0].length >= 4) junk = true; // J1
    else if (toks.length === 1 && !/^\d+$/.test(toks[0]) && _isMachineToken(toks[0])) junk = true; // J2
  }
  return { junk, test };
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

// SAFETY PRINCIPLE (Ahmad 2026-06-26): a record that has ANY real data — a deal,
// a contact, an email, or an attachment — is NEVER a cleanup candidate, even if
// its name looks like a test. A "test"-LOOKING name only matters when the record
// is otherwise EMPTY. This reversed the earlier "flag test names regardless of
// links" rule, which mis-tagged real accounts (e.g. "AlasilaCX | تجربة العميل",
// a customer-experience account carrying a SAR-124k deal). Bulk tagging must only
// ever pick records that are genuinely empty.

export function classifyDeal(input: {
  hasAccount: boolean;
  hasContact: boolean;
  amount: number;
  name: string;
  hasAttachments?: boolean;
  stage?: string | null;
}): { reason: "orphaned" | "empty" | "test" | "junk" | null; deleteEligible: boolean; linkEligible: boolean } {
  // Existing-client stages (Agreement Signed / Paid) are never cleanup candidates.
  if (isProtectedDealStage(input.stage)) {
    return { reason: null, deleteEligible: false, linkEligible: false };
  }
  // Empty = no account AND no contact AND no documents. (No amount gate.)
  const empty = !input.hasAccount && !input.hasContact && !input.hasAttachments;
  const orphaned = !input.hasAccount; // has no account → link candidate
  let reason: "orphaned" | "empty" | "test" | "junk" | null = null;
  if (empty) {
    const jt = isJunkOrTestName(input.name);
    reason = jt.junk ? "junk" : (jt.test || isTestOrPlaceholderName(input.name)) ? "test" : "empty";
  } else if (orphaned) reason = "orphaned"; // has data but no account → link, don't delete
  // else: has an account (real linkage) → not flagged, even with a test-looking name.
  return {
    reason,
    deleteEligible: empty, // only genuinely-empty deals may be tagged
    linkEligible: orphaned,
  };
}

export function classifyAccount(input: {
  hasDeals: boolean;
  hasContacts: boolean;
  name: string;
  hasEmail?: boolean;
  hasAttachments?: boolean;
}): { reason: "empty" | "test" | "junk" | null; structurallyEmpty: boolean } {
  const structurallyEmpty =
    !input.hasDeals && !input.hasContacts && !input.hasEmail && !input.hasAttachments;
  // Any real data (deal / contact / email / document) → never a candidate, even
  // if the name looks like a test.
  if (!structurallyEmpty) return { reason: null, structurallyEmpty: false };
  const jt = isJunkOrTestName(input.name);
  return {
    reason: jt.junk ? "junk" : (jt.test || isTestOrPlaceholderName(input.name)) ? "test" : "empty",
    structurallyEmpty: true,
  };
}

export function classifyContact(input: {
  hasEmail: boolean;
  hasPhone: boolean;
  hasAccount: boolean;
  hasDeals: boolean;
  name: string;
}): { reason: "empty" | "test" | "junk" | null; deleteEligible: boolean } {
  const nameOnly = !input.hasEmail && !input.hasPhone && !input.hasAccount && !input.hasDeals;
  // A contact with any email / phone / account / deal is never a candidate, even
  // if the name looks like a test.
  if (!nameOnly) return { reason: null, deleteEligible: false };
  const jt = isJunkOrTestName(input.name);
  return {
    reason: jt.junk ? "junk" : (jt.test || isTestOrPlaceholderName(input.name)) ? "test" : "empty",
    deleteEligible: true,
  };
}
