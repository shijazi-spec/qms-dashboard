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
 *  Stage filter. Only the stages that actually exist in this Zoho pipeline. The
 *  operator can widen/narrow this via the Advanced Filters → Stage selector. */
export const DEAL_COMPLIANCE_STAGES = ["Proposal", "Agreement Signed"] as const;

/** Closing/won stages that require the FULL document set (7.5.10). Covers the
 *  common Zoho variants so a selected closing stage still gets doc requirements. */
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
const DOC_CONTRACT: RequiredDoc = {
  key: "contract",
  label: "Quotation / PO / Service Agreement / Contract",
  match: /quotation|quote|\bp\.?o\.?\b|purchase\s*order|service\s*agreement|agreement|contract|اتفاقية|عقد|أمر\s*شراء/i,
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
    return [DOC_PROPOSAL_SENT, DOC_CONTRACT, DOC_VAT, DOC_CR, DOC_NATIONAL_ADDRESS];
  }
  return [];
}

export interface DocComplianceResult {
  stage: string;
  required: number;
  presentDocs: Array<{ key: string; label: string; fileName: string }>;
  missingDocs: Array<{ key: string; label: string }>;
  attachmentCount: number;
  compliant: boolean;
}

/**
 * Match a deal's attachments against the documents its stage requires.
 * A required doc is "present" if ANY attachment file name matches its keywords.
 */
export function evaluateDocCompliance(
  stage: string,
  attachments: ZohoAttachmentLike[],
): DocComplianceResult {
  const required = requiredDocsForStage(stage);
  const names = (attachments || [])
    .map((a) => (a && a.fileName ? String(a.fileName) : ""))
    .filter(Boolean);
  const present: DocComplianceResult["presentDocs"] = [];
  const missing: DocComplianceResult["missingDocs"] = [];
  for (const doc of required) {
    const hit = names.find((n) => doc.match.test(n));
    if (hit) present.push({ key: doc.key, label: doc.label, fileName: hit });
    else missing.push({ key: doc.key, label: doc.label });
  }
  return {
    stage,
    required: required.length,
    presentDocs: present,
    missingDocs: missing,
    attachmentCount: names.length,
    compliant: required.length > 0 && missing.length === 0,
  };
}
