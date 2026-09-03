/**
 * Documentation Live Tracker — ingest safety properties.
 *
 * These lock in the two failure modes most likely to bite, both of which are
 * silent rather than loud:
 *
 *   1. A snapshot hash that includes scan timestamps. Idempotency dies, every
 *      watcher tick counts as a change, and a 15-minute cadence generates
 *      hundreds of audit rows an hour.
 *   2. Type drift across the DB boundary. Postgres hands back NUMERIC as a
 *      string and TIMESTAMP as a Date; the payload carries a number and an ISO
 *      string. Compare them naively and EVERY document reports as changed on
 *      EVERY push, forever, and the board never looks stable.
 *
 * Both are pure functions, so no database is required.
 */

import { describe, expect, test } from "vitest";
import {
  computeSnapshotHash,
  factTuple,
} from "../../src/utils/docTrackerIngest";
import {
  canonicalRegisterCode,
  baseCodeOf,
  docFamilyOf,
  isWellFormedCode,
  normaliseLang,
} from "../../src/utils/docTrackerCodes";

const DOCS = [
  {
    code: "WP-POL-001",
    lang: "EN",
    title: "Privacy Policy",
    file: "a.docx",
    folder: "Policies_EN",
    sizeKB: 249.2,
    modifiedAt: "2026-07-28T09:14:00Z",
    contentHash: "sha256:4a7b",
    codeOk: true,
    issues: [],
    refs: ["WP-SOP-001"],
  },
  {
    code: "WP-SOP-001",
    lang: "EN",
    title: "Access SOP",
    file: "b.docx",
    folder: "SOPs",
    sizeKB: 12,
    modifiedAt: "2026-07-28T09:14:00Z",
    contentHash: "sha256:99aa",
    codeOk: true,
    issues: [],
    refs: [],
  },
];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

describe("register-code canonicalisation", () => {
  test("EN keeps the bare code, AR gets the -AR suffix", () => {
    expect(canonicalRegisterCode("WP-POL-001", "EN")).toBe("WP-POL-001");
    expect(canonicalRegisterCode("WP-POL-001", "AR")).toBe("WP-POL-001-AR");
  });

  test("suffixing is idempotent so re-canonicalising a stored code is safe", () => {
    expect(canonicalRegisterCode("WP-POL-001-AR", "AR")).toBe("WP-POL-001-AR");
  });

  test("an unknown or missing language is treated as EN", () => {
    expect(normaliseLang(null)).toBe("EN");
    expect(normaliseLang("fr")).toBe("EN");
    expect(canonicalRegisterCode("WP-SOP-042")).toBe("WP-SOP-042");
  });

  test("a blank code yields null — an uncoded file is a finding, not a guess", () => {
    expect(canonicalRegisterCode("", "AR")).toBeNull();
    expect(canonicalRegisterCode(null)).toBeNull();
  });

  test("base code and family are recoverable", () => {
    expect(baseCodeOf("WP-POL-001-AR")).toBe("WP-POL-001");
    expect(docFamilyOf("WP-FORM-057")).toBe("FORM");
    expect(docFamilyOf("scan-2026.docx")).toBeNull();
    expect(isWellFormedCode("WP-CTL-007")).toBe(true);
    expect(isWellFormedCode("WP-CTL")).toBe(false);
  });
});

describe("snapshot hash — idempotency", () => {
  test("the same library state hashes identically", () => {
    expect(computeSnapshotHash(clone(DOCS) as any)).toBe(
      computeSnapshotHash(clone(DOCS) as any),
    );
  });

  test("payload ORDER does not affect the hash", () => {
    const reordered = [DOCS[1], DOCS[0]];
    expect(computeSnapshotHash(reordered as any)).toBe(
      computeSnapshotHash(DOCS as any),
    );
  });

  test("a changed content hash DOES change the snapshot hash", () => {
    const m = clone(DOCS);
    m[0].contentHash = "sha256:CHANGED";
    expect(computeSnapshotHash(m as any)).not.toBe(
      computeSnapshotHash(DOCS as any),
    );
  });

  test("changed cross-references change the snapshot hash", () => {
    const m = clone(DOCS);
    m[0].refs = ["WP-SOP-999"];
    expect(computeSnapshotHash(m as any)).not.toBe(
      computeSnapshotHash(DOCS as any),
    );
  });
});

describe("factTuple — type normalisation across the DB boundary", () => {
  const fromDb = {
    title: "Privacy Policy",
    file_name: "a.docx",
    folder: "Policies_EN",
    size_kb: "249.20", // Postgres NUMERIC comes back as a string
    modified_at: new Date("2026-07-28T09:14:00Z"), // and TIMESTAMP as a Date
    content_hash: "sha256:4a7b",
    code_ok: true,
    issues: [],
  };
  const fromPayload = {
    title: "Privacy Policy",
    file_name: "a.docx",
    folder: "Policies_EN",
    size_kb: 249.2,
    modified_at: "2026-07-28T09:14:00Z",
    content_hash: "sha256:4a7b",
    code_ok: true,
    issues: [],
  };

  test("a stored row and its unchanged payload compare EQUAL", () => {
    expect(factTuple(fromDb)).toBe(factTuple(fromPayload));
  });

  test("issue ordering is not a change", () => {
    expect(factTuple({ ...fromDb, issues: ["b", "a"] })).toBe(
      factTuple({ ...fromPayload, issues: ["a", "b"] }),
    );
  });

  test("a genuine content change IS detected", () => {
    expect(factTuple(fromDb)).not.toBe(
      factTuple({ ...fromPayload, content_hash: "sha256:NEW" }),
    );
  });
});
