/**
 * Evidence for a "missing document" verdict.
 *
 * Ziad told us files were attached to his deals and the platform was not
 * reading them. We could count the misses — 671 of 1,469 files on the WalaPlus
 * signed book, across 355 of 494 deals — but we stored only the names of files
 * we MATCHED, so a miss was a number with nothing behind it. Neither side could
 * settle the argument: he could see files in Zoho, we could see a count.
 *
 * So the evaluator now returns the names of every attachment that satisfied no
 * requirement, and the sweep persists them. A "missing" verdict now carries the
 * evidence that produced it.
 *
 * The rules this pins:
 *
 *   NAMES ONLY. Never content, never the download URL. A filename is enough to
 *   tune a keyword matcher; anything more is exfiltrating customer documents
 *   into a table nobody thinks of as sensitive.
 *
 *   A file that matched something is NOT unmatched, even if other requirements
 *   went unfilled. The question is "did we understand this file", not "how many
 *   boxes did it tick".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { evaluateDocCompliance } from "../../src/utils/dealComplianceCheck";

const att = (fileName: string) => ({ fileName }) as any;

describe("unmatched attachment names", () => {
  it("names the files that satisfied nothing", () => {
    const r = evaluateDocCompliance("Agreement Signed", [
      att("Signed Contract.pdf"),
      att("site-photos.zip"),
      att("meeting notes 12-03.docx"),
    ]);
    expect(r.unmatchedFiles).toContain("site-photos.zip");
    expect(r.unmatchedFiles).toContain("meeting notes 12-03.docx");
  });

  it("does not list a file that matched a requirement", () => {
    const r = evaluateDocCompliance("Proposal", [att("Financial Offer.pdf")]);
    expect(r.presentDocs.length).toBeGreaterThan(0);
    expect(r.unmatchedFiles).not.toContain("Financial Offer.pdf");
  });

  it("counts a matched file once even when other documents are missing", () => {
    // Agreement Signed wants five. One file matches one of them; the other four
    // stay missing. That file is understood, so it is not evidence of a gap.
    const r = evaluateDocCompliance("Agreement Signed", [
      att("Service Agreement.pdf"),
      att("random.txt"),
    ]);
    expect(r.missingDocs.length).toBeGreaterThan(0);
    expect(r.unmatchedFiles).toEqual(["random.txt"]);
  });

  it("does not report a SECOND recognisable file as unreadable", () => {
    // The bug the first live run exposed (2026-09-12). Only one file can be
    // the representative hit for a requirement; the rest were being reported
    // as files we could not classify. Two contracts on one deal is normal —
    // a draft and a signed copy — and neither is a mystery.
    const r = evaluateDocCompliance("Agreement Signed", [
      att("Service Agreement.pdf"),
      att("Service Agreement - countersigned.pdf"),
      att("PO - 2025.pdf"),
      att("holiday photo.jpg"),
    ]);
    expect(r.unmatchedFiles).toEqual(["holiday photo.jpg"]);
  });

  it("returns an empty list rather than undefined when nothing is attached", () => {
    const r = evaluateDocCompliance("Agreement Signed", []);
    expect(r.unmatchedFiles).toEqual([]);
    expect(r.attachmentCount).toBe(0);
  });

  it("still reports names for a stage with no requirements", () => {
    // What a team attaches at an unrequired stage is exactly the evidence
    // needed to judge whether a requirement elsewhere is realistic.
    const r = evaluateDocCompliance("New Deal", [att("company profile.pdf")]);
    expect(r.unmatchedFiles).toEqual(["company profile.pdf"]);
  });

  it("survives attachments with no usable name", () => {
    const r = evaluateDocCompliance("Proposal", [
      { fileName: "" } as any,
      null as any,
      att("x.pdf"),
    ]);
    expect(r.unmatchedFiles).toEqual(["x.pdf"]);
  });
});

describe("only names are stored", () => {
  const SRC = readFileSync(
    join(__dirname, "../../src/utils/dealComplianceCheck.ts"),
    "utf8",
  );
  const DB = readFileSync(
    join(__dirname, "../../src/utils/duplicateRadarDatabase.ts"),
    "utf8",
  );

  it("the evaluator returns strings, not attachment objects", () => {
    const r = evaluateDocCompliance("Proposal", [att("a.pdf")]);
    for (const v of r.unmatchedFiles) expect(typeof v).toBe("string");
  });

  it("no download or preview URL is carried anywhere near it", () => {
    // Zoho's attachment payload includes download_Url / preview_Url. Those
    // must never reach a table that is read by reports and exports.
    const block = /unmatchedFiles[\s\S]{0,400}/.exec(SRC)?.[0] ?? "";
    expect(block).not.toMatch(/download_?Url|preview_?Url|\$file_id/i);
  });

  it("the column is declared in BOTH the CREATE TABLE and an ALTER", () => {
    // check:schema-parity is strict: a column added only by ALTER is drift.
    expect(DB).toContain("unmatched_files JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(DB).toContain(
      "ALTER TABLE deal_doc_compliance ADD COLUMN IF NOT EXISTS unmatched_files",
    );
  });

  it("every writer passes the evidence through", () => {
    // A writer that omits it silently records an empty list, which looks
    // exactly like "we understood every file" — the failure this exists to end.
    const sweep = readFileSync(
      join(__dirname, "../../src/utils/dealDocComplianceSweep.ts"),
      "utf8",
    );
    const routes = readFileSync(
      join(__dirname, "../../src/mastra/routes/duplicateRadarRoutes.ts"),
      "utf8",
    );
    expect(sweep).toContain("unmatchedFiles:");
    const writers = (routes.match(/upsertDealDocCompliance\(\{/g) || []).length;
    const passes = (routes.match(/unmatchedFiles:/g) || []).length;
    expect(passes).toBe(writers);
  });
});
