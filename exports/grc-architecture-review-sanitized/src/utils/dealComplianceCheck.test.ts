/**
 * Unit tests for the pure deal-document matcher.
 * Run: npx tsx src/utils/dealComplianceCheck.test.ts
 */
import { requiredDocsForStage, evaluateDocCompliance } from "./dealComplianceCheck";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

console.log("requiredDocsForStage");
assert(requiredDocsForStage("Proposal").length === 1, "Proposal → 1 doc (financial offer)");
assert(requiredDocsForStage("Agreement Signed").length === 5, "Agreement Signed → 5 docs");
assert(requiredDocsForStage("Paid").length === 5, "Paid → 5 docs");
assert(requiredDocsForStage("Closed Won").length === 5, "Closed Won → 5 docs");
assert(requiredDocsForStage("Qualification").length === 0, "non-target stage → 0 docs");

console.log("evaluateDocCompliance — Proposal");
assert(
  evaluateDocCompliance("Proposal", [{ fileName: "Example Organization Financial Offer v2.pdf" }]).compliant,
  "financial offer present → compliant",
);
assert(
  !evaluateDocCompliance("Proposal", [{ fileName: "random.png" }]).compliant,
  "no offer → not compliant",
);
assert(
  evaluateDocCompliance("Proposal", [{ fileName: "العرض المالي.pdf" }]).compliant,
  "Arabic financial-offer name matches",
);

console.log("evaluateDocCompliance — Agreement Signed (full set)");
const full = evaluateDocCompliance("Agreement Signed", [
  { fileName: "Proposal_final.pdf" },
  { fileName: "Service Agreement signed.pdf" },
  { fileName: "VAT Certificate.pdf" },
  { fileName: "Commercial Registration.pdf" },
  { fileName: "National Address.pdf" },
]);
assert(full.compliant && full.missingDocs.length === 0, "all 5 docs present → compliant");

const partial = evaluateDocCompliance("Agreement Signed", [
  { fileName: "Proposal.pdf" },
  { fileName: "contract.pdf" },
]);
assert(
  !partial.compliant && partial.missingDocs.some((m) => m.key === "vat"),
  "missing VAT/CR/National Address → flagged",
);
assert(partial.presentDocs.length === 2, "present docs counted");
assert(partial.attachmentCount === 2, "attachment count tracked");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
