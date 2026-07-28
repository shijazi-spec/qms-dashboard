/**
 * docTrackerCodes — pure helpers mapping what the collector sees on disk to the
 * controlled-document register.
 *
 * THE JOIN
 * The collector reports {code: "WP-POL-001", lang: "EN" | "AR"}. The register
 * (`policies.policy_number`) is globally UNIQUE and has no language column, so
 * EN and AR are separate register codes:
 *
 *   EN  WP-POL-001      →  WP-POL-001
 *   AR  WP-POL-001      →  WP-POL-001-AR
 *
 * That keeps one tracker row ↔ at most one `policies` row, which is what makes
 * the whole coverage chain resolvable:
 *
 *   registerCode → policies.policy_number → policies.id
 *               → qms_uploaded_documents.source_policy_id
 *               → obligation_documents → obligations → regulations
 *
 * DAY-ONE CONSEQUENCE: `controlledDocumentRegistry` seeds 154 bare codes and
 * zero "-AR" variants, so on the first snapshot every Arabic file resolves to a
 * register code that does not exist yet. Those surface as orphans for a human to
 * promote — ingest never creates a `policies` row.
 *
 * Pure and dependency-free so it can be unit-tested without a database.
 */

export type DocLang = "EN" | "AR";

/** Prefixes used by the WP-* controlled document set (see controlledDocumentRegistry). */
export const DOC_FAMILIES = ["POL", "DOC", "SOP", "FORM", "CTL"] as const;
export type DocFamily = (typeof DOC_FAMILIES)[number];

/** Shape of a controlled document code: WP-<FAMILY>-<NNN>. */
const WP_CODE = /^WP-([A-Z]+)-(\d+)$/i;

/** Normalise a language token to EN/AR. Anything unrecognised is treated as EN. */
export function normaliseLang(lang?: string | null): DocLang {
  return String(lang ?? "").trim().toUpperCase() === "AR" ? "AR" : "EN";
}

/**
 * Map (code, lang) to the register code. EN keeps the bare code; AR gets the
 * "-AR" suffix. Idempotent: a code that already ends in "-AR" is not
 * double-suffixed, so re-canonicalising a stored register code is safe.
 *
 * Returns null when the code is blank — the caller treats that as an uncoded
 * file, which is itself a finding rather than something to invent a code for.
 */
export function canonicalRegisterCode(
  code: string | null | undefined,
  lang?: string | null,
): string | null {
  const base = String(code ?? "").trim().toUpperCase();
  if (!base) return null;
  if (normaliseLang(lang) !== "AR") return base;
  return base.endsWith("-AR") ? base : `${base}-AR`;
}

/** Strip the language suffix to recover the shared base code (WP-POL-001). */
export function baseCodeOf(registerCode: string | null | undefined): string | null {
  const c = String(registerCode ?? "").trim().toUpperCase();
  if (!c) return null;
  return c.endsWith("-AR") ? c.slice(0, -3) : c;
}

/**
 * The document family (POL / DOC / SOP / FORM / CTL), used to bucket the
 * tracker board and to pick a policy document_type when an orphan is promoted.
 * Returns null for codes that do not match the WP-<FAMILY>-<NNN> shape.
 */
export function docFamilyOf(code: string | null | undefined): DocFamily | null {
  const m = WP_CODE.exec(String(code ?? "").trim());
  if (!m) return null;
  const fam = m[1].toUpperCase();
  return (DOC_FAMILIES as readonly string[]).includes(fam)
    ? (fam as DocFamily)
    : null;
}

/** True when the code matches the controlled-document shape at all. */
export function isWellFormedCode(code: string | null | undefined): boolean {
  return WP_CODE.test(String(code ?? "").trim());
}

/**
 * Inverse of policyMappingBridge.qmsCategoryForDocType — maps a document family
 * to the `policies.document_type` an orphan promotion should use.
 */
export function policyDocumentTypeFor(family: DocFamily | null): string {
  switch (family) {
    case "POL":
      return "policy";
    case "SOP":
      return "sop";
    case "FORM":
      return "form";
    case "CTL":
      return "control";
    case "DOC":
      return "document";
    default:
      return "document";
  }
}
