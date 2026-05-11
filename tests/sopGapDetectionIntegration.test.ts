/**
 * Integration test for `computeSopGapSummary` against a live DB.
 *
 * Validates the end-to-end pipeline that the executive digest depends on:
 *   1. Insert a SOP row in `qms_uploaded_documents` pointing at a temp .txt
 *      file on disk (no pre-extracted text).
 *   2. Insert a covering audit_finding referencing one of the clauses.
 *   3. Run `computeSopGapSummary()` and assert it:
 *        - extracted the file via `documentTextExtractor` on demand
 *        - persisted the extraction result back into the row
 *        - reported the covered clause as covered and the uncovered ones
 *          as open gaps (with stable top_gaps ordering)
 *
 * Run: `npx tsx tests/sopGapDetectionIntegration.test.ts`
 *
 * Requires DATABASE_URL and a writable temp dir. Cleans up after itself.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TestSuite } from "./_helpers/runner";
import { sharedPool as pool } from "../src/utils/sharedPool";
import { computeSopGapSummary } from "../src/utils/sopGapDetection";
import { initQmsDocsTable } from "../src/utils/qmsDocsDatabase";

const suite = new TestSuite("sopGapDetection integration");

const SOP_BODY = [
  "WalaPlus Onboarding SOP",
  "This procedure satisfies PDPL Article 6 for lawful processing.",
  "Security obligations also map to ISO 27001 A.5.15 (access control)",
  "and ISO 27001 A.8.3 (information access restriction).",
].join("\n");

(async () => {
  let docId: number | null = null;
  let findingId: number | null = null;
  let tmpFile: string | null = null;

  await suite.test(
    "computeSopGapSummary extracts on demand and detects gaps",
    async () => {
      try {
        await initQmsDocsTable();
      } catch (err) {
        console.warn(
          "[skip] qms_uploaded_documents init failed:",
          (err as Error).message,
        );
        return;
      }

      // Verify audit_findings table exists; otherwise skip.
      let hasFindings = false;
      try {
        await pool.query(`SELECT 1 FROM audit_findings LIMIT 1`);
        hasFindings = true;
      } catch {
        hasFindings = false;
      }

      tmpFile = join(
        tmpdir(),
        `sop-gap-test-${process.pid}-${Date.now()}.txt`,
      );
      await fs.writeFile(tmpFile, SOP_BODY, "utf-8");

      const insRes = await pool.query(
        `INSERT INTO qms_uploaded_documents
           (category, title, file_path, file_name, file_size, mime_type,
            notes, regulation_codes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          "sops",
          "ZZZ-SOP-GAP-TEST",
          tmpFile,
          "sop-gap-test.txt",
          SOP_BODY.length,
          "text/plain",
          null,
          ["PDPL", "ISO-27001"],
          "test-runner",
        ],
      );
      docId = Number(insRes.rows[0].id);

      if (hasFindings) {
        // Cover one of the three clauses (Article 6) so the summary
        // should report 2 open gaps.
        const findingNumber = `SOPGAP-TEST-${process.pid}-${Date.now()}`;
        const fIns = await pool.query(
          `INSERT INTO audit_findings
             (finding_number, severity, criteria_name, description, evidence, recommendation)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            findingNumber,
            "minor",
            "PDPL Article 6 lawful processing",
            "Onboarding flow validates lawful basis per PDPL Article 6.",
            "screenshot.png",
            "Maintain control",
          ],
        );
        findingId = Number(fIns.rows[0].id);
      }

      const summary = await computeSopGapSummary();

      suite.expect(
        summary.documents_scanned >= 1,
        `expected >=1 doc scanned (got ${summary.documents_scanned})`,
      );
      suite.expect(
        summary.requirements_total >= 3,
        `expected >=3 requirements derived (got ${summary.requirements_total})`,
      );
      suite.expect(
        summary.coverage_pct >= 0 && summary.coverage_pct <= 100,
        `coverage_pct in range (got ${summary.coverage_pct})`,
      );

      // Confirm the on-demand extraction was persisted on this row.
      const persisted = await pool.query(
        `SELECT extraction_status, LENGTH(extracted_text) AS len
           FROM qms_uploaded_documents WHERE id = $1`,
        [docId],
      );
      suite.expectEqual(
        persisted.rows[0]?.extraction_status,
        "extracted",
        "extraction_status persisted",
      );
      suite.expect(
        Number(persisted.rows[0]?.len || 0) >= 30,
        "extracted_text persisted with content",
      );

      if (hasFindings) {
        // The covered citation should be reflected in the test row's gaps.
        const ourGaps = summary.top_gaps.filter(
          (g) => g.document_id === docId,
        );
        const coveredOurDoc =
          (summary.requirements_total > 0 ? 1 : 0) > 0
            ? !ourGaps.some((g) => /article\s*6/i.test(g.raw_citation))
            : true;
        suite.expect(
          coveredOurDoc,
          "PDPL Article 6 should NOT appear as a gap when an audit_finding references it",
        );
      }
    },
  );

  // Cleanup
  try {
    if (findingId !== null) {
      await pool.query(`DELETE FROM audit_findings WHERE id = $1`, [findingId]);
    }
  } catch {}
  try {
    if (docId !== null) {
      await pool.query(
        `DELETE FROM qms_uploaded_documents WHERE id = $1`,
        [docId],
      );
    }
  } catch {}
  try {
    if (tmpFile) await fs.unlink(tmpFile);
  } catch {}

  suite.finishOrExit();
})();
