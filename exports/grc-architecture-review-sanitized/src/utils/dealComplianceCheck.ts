/**
 * Deal-stage document compliance (Sales SOP 7.5.10 / 7.5.11 / 7.6.3).
 *
 * Verifies that deals in the closing stages carry the REQUIRED CRMProvider attachments
 * — the financial offer at Proposal, and the full document set once Paid /
 * Agreement Signed — by keyword-matching attachment file names (EN + AR). Field
 * compliance (Amount, Industry, Bundle_Type, Discount, Onboarding_Method,
 * Contract_No_of_Employees, Trial_Period(_Days), National_Address …) is already
 * covered by analyzeRecordHygiene's stage-conditional rules; this module adds
 * the attachment layer, which the rules engine can't see.
 *
 * The doc-matching is pure (given an attachment list) so it is unit-testable.
 */

export interface CRMProviderAttachmentLike {
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
export const DEAL_COMPLIANCE_STAGES = ["Proposal", "Agreement Signed", "Paid"] as const;

/** Closing/won stages that require the FULL document set (7.5.10). Covers the
 *  common CRMProvider variants so a selected closing stage still gets doc requirements.
 *  "paid" == "agreement signed" here by business rule (backdated deals). */
const FULL_DOC_STAGES = [
  "paid",
  "agreement signed",
  "closed won",
  "agreement sent",
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
// (Sample User 2026-08-09). Any ONE of these attachments satisfies the requirement.
const DOC_QUOTATION_AGREEMENT: RequiredDoc = {
  key: "quotation_agreement",
  label: "Quotation / PO / Service Agreement / Contract",
  // "msa" (Master Service Agreement) and "sow" (Statement of Work) added
  // 2026-09-03: Example Organization filed its contract as "msa for RB Employee
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
 * Documents that belong to the CLIENT COMPANY, not to an individual deal.
 *
 * A VAT certificate, a Commercial Registration and a National Address do not
 * change from one deal to the next, so the business files them once on the
 * Account rather than re-attaching them to every deal. Measured 2026-09-02:
 * of 1,077 deals marked non-compliant, 813 were missing National Address, 805
 * the CR and 795 the VAT certificate — and 513 of those deals DID carry
 * attachments. Example Organization was flagged non-compliant while holding 18 files
 * including the MSA, the SOW, the PO and the invoice.
 *
 * Checking these against the deal alone therefore measured filing convention,
 * not compliance, and produced a 96-100% failure rate that would not have
 * survived its first meeting. They are now satisfied by an attachment on the
 * deal OR on its Account (Sample User 2026-09-03).
 */
export const COMPANY_LEVEL_DOC_KEYS = new Set([
  "vat",
  "commercial_registration",
  "national_address",
]);

export function isCompanyLevelDoc(key: string): boolean {
  return COMPANY_LEVEL_DOC_KEYS.has(key);
}

export interface DocComplianceResult {
  stage: string;
  required: number;
  presentDocs: Array<{
    key: string;
    label: string;
    fileName: string;
    /** Where the file was found. Company documents may live on the Account. */
    source?: "deal" | "account";
  }>;
  missingDocs: Array<{ key: string; label: string }>;
  attachmentCount: number;
  /** Attachments on the linked Account, when they were consulted. */
  accountAttachmentCount?: number;
  compliant: boolean;
}

/**
 * Match a deal's attachments against the documents its stage requires.
 *
 * A required doc is "present" if ANY attachment file name matches its keywords.
 *
 * `accountAttachments` is optional and, when supplied, is consulted ONLY for
 * the company-level documents (VAT, CR, National Address) — see
 * COMPANY_LEVEL_DOC_KEYS. Deal documents stay strictly on the deal: a proposal
 * or a signed contract belongs to the deal it was written for, and accepting a
 * different deal's contract from the shared Account would let one signed file
 * mark an entire company's pipeline compliant.
 *
 * The deal is always searched first, so a company document attached directly to
 * the deal still counts and is still reported as coming from the deal.
 */
export function evaluateDocCompliance(
  stage: string,
  attachments: CRMProviderAttachmentLike[],
  accountAttachments?: CRMProviderAttachmentLike[],
): DocComplianceResult {
  const required = requiredDocsForStage(stage);
  const nameList = (list?: CRMProviderAttachmentLike[]) =>
    (list || [])
      .map((a) => (a && a.fileName ? String(a.fileName) : ""))
      .filter(Boolean);
  const names = nameList(attachments);
  const accountNames = accountAttachments ? nameList(accountAttachments) : null;
  const present: DocComplianceResult["presentDocs"] = [];
  const missing: DocComplianceResult["missingDocs"] = [];
  for (const doc of required) {
    const onDeal = names.find((n) => doc.match.test(n));
    if (onDeal) {
      present.push({ key: doc.key, label: doc.label, fileName: onDeal, source: "deal" });
      continue;
    }
    const onAccount =
      accountNames && isCompanyLevelDoc(doc.key)
        ? accountNames.find((n) => doc.match.test(n))
        : undefined;
    if (onAccount) {
      present.push({ key: doc.key, label: doc.label, fileName: onAccount, source: "account" });
      continue;
    }
    missing.push({ key: doc.key, label: doc.label });
  }
  return {
    stage,
    required: required.length,
    presentDocs: present,
    missingDocs: missing,
    // The headline count stays the DEAL's own attachments — that is what the
    // operator sees on the record. The Account's is reported separately so a
    // pass earned on the Account is never mistaken for files on the deal.
    attachmentCount: names.length,
    ...(accountNames ? { accountAttachmentCount: accountNames.length } : {}),
    compliant: required.length > 0 && missing.length === 0,
  };
}
