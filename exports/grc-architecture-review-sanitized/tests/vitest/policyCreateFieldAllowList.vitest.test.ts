/**
 * The /api/policies field allow-list.
 *
 * The sanitizer middleware deletes any body field not on this list BEFORE the
 * handler runs. `policy_number` was missing while POST /api/policies requires
 * it, so every create returned "Missing required fields" — from the Document
 * Control UI as well as the API. 154 seeded policies existed and not one more
 * could be added. Found 2026-08-18 while filing the CS SOP.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { filterAllowedFields } from "../../src/utils/inputSanitizer";

/** Every name="..." the Document Control create form posts. */
function formFieldNames(): string[] {
  const html = readFileSync(
    join(process.cwd(), "dashboard", "policies.html"),
    "utf-8",
  );
  return [...html.matchAll(/name="([a-z_]+)"/g)]
    .map((m) => m[1])
    .filter((n) => n !== "viewport");
}

describe("create-policy body survives the sanitizer", () => {
  it("keeps policy_number — the field the handler requires", () => {
    const out = filterAllowedFields(
      { policy_number: "WP-BU-CS-SOP-003", title: "CS", category: "operational" },
      "/api/policies",
    );
    expect(out.policy_number).toBe("WP-BU-CS-SOP-003");
    expect(out.title).toBe("CS");
    expect(out.category).toBe("operational");
  });

  it("keeps every field the Document Control form actually posts", () => {
    const posted = Object.fromEntries(formFieldNames().map((n) => [n, "x"]));
    const out = filterAllowedFields(posted, "/api/policies");
    const dropped = Object.keys(posted).filter((k) => !(k in out));
    // A field the form sends but the list drops is silently lost on save — the
    // user fills it in, gets a success toast, and the value never lands.
    expect(dropped, `form fields dropped by the sanitizer: ${dropped.join(", ")}`).toEqual([]);
  });

  it("keeps the document-control metadata the CS SOP record needs", () => {
    const body = {
      policy_number: "WP-BU-CS-SOP-003",
      document_number: "WP-BU-CS-SOP-003",
      document_type: "sop",
      title: "Customer Success Management Process",
      category: "operational",
      version: "1.1",
      status: "published",
      owner_name: "Sample User",
      owner_department: "Customer Success",
      approver_name: "Saleh Alhamddi; Sample User; Osama Harfoush",
      effective_date: "2026-08-13",
      review_date: "2026-11-13",
      confidentiality: "confidential",
      change_summary: "Major revision.",
    };
    const out = filterAllowedFields(body, "/api/policies");
    expect(Object.keys(out).sort()).toEqual(Object.keys(body).sort());
  });
});

describe("the lifecycle endpoints get the field names they actually read", () => {
  // Each of these was stripped, so the endpoint returned "Missing required
  // fields" for every request. Derived by grepping body.<field> out of
  // src/mastra/routes/policyRoutes.ts — the handlers are the contract.
  const CASES: Array<[string, Record<string, unknown>]> = [
    ["POST /:id/transition", { new_status: "archived", comments: "x" }],
    ["PUT /:id/set-owners", {
      operational_owner: "a", operational_owner_email: "user@example.invalid",
      compliance_owner: "b", compliance_owner_email: "user@example.invalid",
    }],
    ["POST /:id/acknowledge", { user_email: "user@example.invalid" }],
    ["POST /review-cycles", { policy_id: 1, scheduled_date: "2026-09-01" }],
  ];

  for (const [label, body] of CASES) {
    it(`keeps every field ${label} requires`, () => {
      const out = filterAllowedFields(body, "/api/policies");
      expect(Object.keys(out).sort()).toEqual(Object.keys(body).sort());
    });
  }

  it("archiving a published document is possible at all", () => {
    // A published document cannot be deleted until it is archived, and
    // archiving goes through /transition. With new_status stripped, a
    // published document was permanent.
    const out = filterAllowedFields({ new_status: "archived" }, "/api/policies");
    expect(out.new_status).toBe("archived");
  });
});

describe("the file-binding gate stays shut", () => {
  it("still drops file fields from a JSON body", () => {
    const out = filterAllowedFields(
      {
        title: "x", category: "operational", policy_number: "P-1",
        file_path: "../../etc/passwd", file_name: "evil.pdf",
        file_size: 1, file_mime_type: "application/pdf",
      },
      "/api/policies",
    );
    // Only POST /api/policies/:id/upload may bind a file. Widening the list for
    // create must not have opened a JSON path to rebind a document's file.
    for (const k of ["file_path", "file_name", "file_size", "file_mime_type"]) {
      expect(out, `${k} must not survive`).not.toHaveProperty(k);
    }
    expect(out.policy_number).toBe("P-1");
  });

  it("drops unknown fields entirely", () => {
    const out = filterAllowedFields(
      { title: "x", is_admin: true, id: 999, created_by: "Sample User" },
      "/api/policies",
    );
    expect(out).toEqual({ title: "x" });
  });
});
