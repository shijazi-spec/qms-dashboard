/**
 * Deal-stage document compliance (Sales SOP 7.5.10 / 7.5.11 / 7.6.3).
 *
 * Verifies that deals in the closing stages carry the REQUIRED Zoho attachments
 * — the financial offer at Proposal, and the full document set once Paid /
 * Agreement Signed — by keyword-matching attachment file names (EN + AR). Field
 * compliance (Amount, Industry, Bundle_Type, Discount, Onboarding_Method,
 * Contract_No_of_Employees, Trial_Period(_Days), National_Address …) is already
 * covered by analyzeRecordHygiene's stage-conditional rules; this module adds
 * the attachment layer, which the rules engine can't see.
 *
 * The doc-matching is pure (given an attachment list) so it is unit-testable.
 */

export interface ZohoAttachmentLike {
  fileName?: string | null;
}

export interface RequiredDoc {
  key: string;
  label: string;
  match: RegExp;
}

/** DEFAULT stages the tab checks when the operator hasn't picked any in the
 *  in-tab Stage filter. These are the three the business cares about:
 *  Proposal (financial offer) + Agreement Signed & Paid (full doc set).
 *  NOTE: "Paid" is NOT a separate concern — it is the Agreement-Signed stage
 *  re-labelled for backdated/migrated deals that missed the data earlier, so
 *  it carries the SAME full-document requirement (see FULL_DOC_STAGES). The
 *  operator can widen/narrow this via the in-tab Stage filter. */
export const DEAL_COMPLIANCE_STAGES = [
  "Proposal",
  // Added 2026-09-11 (Sarah): "agreement sent at least shall have the proposal
  // that sent before, so it shall be checked too". 32 WalaPlus deals sit here
  // — the agreement has gone out and is awaiting signature, which is the last
  // cheap moment to get the paperwork straight. It requires ONE document, not
  // the full five: see requiredDocsForStage.
  "Agreement Sent",
  "Agreement Signed",
  "Paid",
] as const;

/** Closing/won stages that require the FULL document set (7.5.10). Covers the
 *  common Zoho variants so a selected closing stage still gets doc requirements.
 *  "paid" == "agreement signed" here by business rule (backdated deals). */
const FULL_DOC_STAGES = [
  "paid",
  "agreement signed",
  "closed won",
  // "agreement sent" REMOVED 2026-09-11. It was here, demanding all five —
  // including a signed contract that cannot exist at a stage defined by the
  // agreement being out for signature. Every one of the 32 deals there would
  // have failed by definition. It was invisible only because the stage was
  // missing from DEAL_COMPLIANCE_STAGES, so nothing was ever checked; adding
  // the stage without this would have shipped the defect rather than the
  // feature. See its own branch in requiredDocsForStage.
  "awaiting po",
  "client activated",
  "transferred to cs",
];

// Financial offer / commercial proposal (العرض المالي).
const DOC_FINANCIAL_OFFER: RequiredDoc = {
  key: "financial_offer",
  label: "Financial offer / proposal (العرض المالي)",
  match: /proposal|offer|quotation|quote|عرض|مالي|عرض\s*مالي/i,
};

// Full set required once the deal is Paid / Agreement Signed (SOP 7.5.10).
const DOC_PROPOSAL_SENT: RequiredDoc = {
  key: "proposal_sent",
  label: "Proposal sent (latest version)",
  match: /proposal|offer|عرض/i,
};
// Quotation / PO / Service Agreement / Contract — ONE combined required doc,
// matching Sales Governance v1.1 SOP 7.5.10, which lists these together as a
// single bullet ("Quotation/PO/Service Agreement/Contract"). Reverted the
// 2026-08-03 two-doc split to reflect the governance document exactly
// (Sarah 2026-08-09). Any ONE of these attachments satisfies the requirement.
const DOC_QUOTATION_AGREEMENT: RequiredDoc = {
  key: "quotation_agreement",
  label: "Quotation / PO / Service Agreement / Contract",
  // "msa" (Master Service Agreement) and "sow" (Statement of Work) added
  // 2026-09-03: Riyad Bank filed its contract as "msa for RB Employee
  // Program.pdf" and "sow for RB Employee Program.pdf" — the actual signed
  // agreement, under the abbreviation the business uses. "inv" likewise:
  // invoices arrive as "INV-26124340.pdf", which "invoice" does not match.
  // Word-bounded so they cannot fire inside a longer word.
  match: /quotation|quote|\bp\.?o\.?\b|purchase\s*order|invoice|\binv[\s._-]?\d|\bmsa\b|\bsow\b|service\s*agreement|agreement|contract|اتفاقية|عقد|اتفاق|فاتورة|عرض\s*سعر|أمر\s*شراء/i,
};
const DOC_VAT: RequiredDoc = {
  key: "vat",
  label: "VAT Certificate",
  match: /\bvat\b|tax\s*cert|الضريب|ضريبة|القيمة\s*المضافة/i,
};
const DOC_CR: RequiredDoc = {
  key: "commercial_registration",
  label: "Commercial Registration (CR)",
  match: /commercial\s*reg|registration\s*cert|\bc\.?r\.?\b|cr[\s_-]*cert|سجل\s*تجاري|السجل\s*التجاري/i,
};
const DOC_NATIONAL_ADDRESS: RequiredDoc = {
  key: "national_address",
  label: "National Address",
  match: /national\s*address|nat[\s_-]*address|عنوان\s*وطني|العنوان\s*الوطني/i,
};

/** Required documents for a given deal stage. */
export function requiredDocsForStage(stage: string): RequiredDoc[] {
  const s = (stage || "").trim().toLowerCase();
  if (s === "proposal") return [DOC_FINANCIAL_OFFER];
  // Agreement Sent — ONE document (Sarah, 2026-09-11): "agreement sent at
  // least shall have the proposal that sent before". The agreement is out for
  // signature, so the proposal that preceded it must exist; the signed
  // contract and the client's statutory papers are not yet due under SOP
  // 7.5.10, which requires the full set at Agreement Signed / Paid.
  //
  // Deliberately the SAME doc as the signed set's first requirement, so a deal
  // moving Sent -> Signed keeps the document it already satisfied instead of
  // appearing to lose it.
  if (s === "agreement sent") return [DOC_PROPOSAL_SENT];
  if (FULL_DOC_STAGES.includes(s)) {
    // 5 required docs per Sales Governance v1.1 SOP 7.5.10.
    return [
      DOC_PROPOSAL_SENT,
      DOC_QUOTATION_AGREEMENT,
      DOC_VAT,
      DOC_CR,
      DOC_NATIONAL_ADDRESS,
    ];
  }
  return [];
}

/**
 * DEAL-ONLY, deliberately.
 *
 * Between 2026-09-03 and 09-06 this module also accepted the three company
 * certificates (VAT, Commercial Registration, National Address) from the
 * linked ACCOUNT, on the theory that documents which do not change per deal
 * would be filed once at Account level. The data said otherwise: every Account
 * sampled returned ZERO attachments while its deals returned files, and Rawabi
 * Holding and مؤسسة الاسكان both had VAT, CR and National Address attached to
 * the DEAL itself.
 *
 * Sarah settled it on 2026-09-06: "Deals is the place that will have the
 * documents, not the accounts." So the Account lookup is gone — it cost an
 * extra Zoho call per account and never once found a document.
 *
 * Do not reintroduce it without evidence that Accounts actually carry files.
 */
/**
 * Registration identifiers recorded on the DEAL itself, not as files.
 *
 * Sarah, 2026-09-11: "since you have the document of the CR or VAT it's ok,
 * since it's added as data real it's ok, that's compliant, but if there is
 * both not here so it's non-compliant, and the dummy data is a part of the
 * non-compliant too."
 *
 * So CR and VAT are each satisfied by EITHER the certificate OR a genuine
 * number. Nothing else in the required set works this way — a proposal or a
 * contract cannot be "recorded as data".
 *
 * These come off the deal (`CR_Number1`, `VAT_Number1`). They are NOT an
 * account lookup; see the note above evaluateDocCompliance.
 */
export interface DealRegistrationFields {
  crNumber?: string | null;
  vatNumber?: string | null;
}

/**
 * Is this a real registration number, or someone getting past a required field?
 *
 * Measured on the WalaPlus signed book, 2026-09-11: of 271 deals carrying CR
 * text only 134 held a real number, and of 271 carrying VAT text only 99. The
 * rest were `00`, `0000000000`, `....`, two Saudi MOBILE numbers (`0507327065`
 * — exactly ten digits, so a naive length check would have passed them), and a
 * few values far too short.
 *
 * Digits are extracted first, so `CR 1010954387` and `3119 2262 7400 003`
 * count while `0000-0000-00` still does not.
 *
 *   CR  — 10 digits, never leading zero (a leading 0 is a phone number).
 *   VAT — 15 digits, never leading zero.
 *   Neither may be the same digit repeated.
 */
export function isRealRegistrationNumber(
  raw: unknown,
  kind: "cr" | "vat",
): boolean {
  if (raw === null || raw === undefined) return false;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return false;
  if (/^(\d)\1+$/.test(digits)) return false; // 000…, 777…
  if (digits.startsWith("0")) return false;
  return digits.length === (kind === "cr" ? 10 : 15);
}

export interface DocComplianceResult {
  stage: string;
  required: number;
  presentDocs: Array<{
    key: string;
    label: string;
    fileName: string;
    /** How the requirement was met — an attached file, or a recorded number. */
    via: "attachment" | "field";
  }>;
  missingDocs: Array<{ key: string; label: string }>;
  attachmentCount: number;
  compliant: boolean;
  /**
   * Names of files attached to the deal that matched NO required document.
   *
   * Added 2026-09-11, because Ziad said files were attached and we were not
   * reading them, and we had no way to check. We stored the names of documents
   * we matched and a count of everything else — so a miss was a number with no
   * evidence attached to it, and the argument could not be settled either way.
   *
   * Measured on the WalaPlus signed book: 671 of 1,469 attached files (46%)
   * matched nothing, across 355 of 494 deals. Those 671 names are the only
   * thing that can say whether the matcher is under-reading or the documents
   * genuinely are not there.
   *
   * NAMES ONLY — never content, never URLs. A filename is enough to tune a
   * keyword matcher and is already visible to anyone who can open the deal.
   */
  unmatchedFiles: string[];
}

/**
 * Match a deal's attachments against the documents its stage requires.
 *
 * A required doc is "present" if ANY attachment file name matches its keywords.
 * Only the DEAL's own attachments count — see the note above DocComplianceResult.
 */
export function evaluateDocCompliance(
  stage: string,
  attachments: ZohoAttachmentLike[],
  /**
   * The DEAL's own recorded CR / VAT numbers. Not an account lookup — the rule
   * that only the deal's own evidence counts is unchanged; this is a second
   * place ON THE DEAL where two of the five requirements can be satisfied.
   */
  fields: DealRegistrationFields = {},
): DocComplianceResult {
  const required = requiredDocsForStage(stage);
  const names = (attachments || [])
    .map((a) => (a && a.fileName ? String(a.fileName) : ""))
    .filter(Boolean);
  const present: DocComplianceResult["presentDocs"] = [];
  const missing: DocComplianceResult["missingDocs"] = [];
  const matched = new Set<string>();
  for (const doc of required) {
    const hit = names.find((n) => doc.match.test(n));
    if (hit) {
      present.push({ key: doc.key, label: doc.label, fileName: hit, via: "attachment" });
      matched.add(hit);
      continue;
    }
    // No file — but CR and VAT also count when the number itself is recorded
    // on the deal and is real. Only these two: a proposal cannot be data.
    const byField =
      (doc.key === "commercial_registration" &&
        isRealRegistrationNumber(fields.crNumber, "cr")) ||
      (doc.key === "vat" && isRealRegistrationNumber(fields.vatNumber, "vat"));
    if (byField) {
      present.push({
        key: doc.key,
        label: doc.label,
        fileName: "[recorded as data]",
        via: "field",
      });
      continue;
    }
    missing.push({ key: doc.key, label: doc.label });
  }
  // Every attachment that satisfied no requirement. A file that matched one
  // document is counted as matched even if another requirement also wanted it —
  // the question here is "did we understand this file at all", not "how many
  // boxes did it tick".
  //
  // Deliberately NOT filtered to required.length > 0: a stage with no
  // requirements still tells us what the team attaches, which is exactly the
  // evidence needed to decide whether a requirement is realistic.
  const unmatched = names.filter((n) => !matched.has(n));
  return {
    stage,
    required: required.length,
    presentDocs: present,
    missingDocs: missing,
    attachmentCount: names.length,
    compliant: required.length > 0 && missing.length === 0,
    unmatchedFiles: unmatched,
  };
}
