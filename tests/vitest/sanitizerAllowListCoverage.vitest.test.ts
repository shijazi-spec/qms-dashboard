/**
 * Every JSON body field a route handler READS must survive the sanitizer.
 *
 * src/mastra/middleware/index.ts runs every JSON body through
 * filterAllowedFields(body, urlPath), which picks an allow-list from the first
 * path segment and DELETES every key not on it before the handler runs. The
 * allow-lists and the handlers are two independent lists of names with nothing
 * keeping them in sync, and when they drift the endpoint answers
 * "<field> is required" for a field the caller definitely sent.
 *
 * That has now happened in six modules. /api/policies could not create a
 * document (policy_number). /api/compliance could not link a document to a
 * clause (document_id, obligation_id) — which is why every clause link in the
 * database was AI-made. /api/vendors could not create an assessment, /api/audits
 * could not create a finding, /api/calls match-phone always rejected, and
 * /api/invitations could never require MFA. Each was found by hand, after the
 * fact. This test finds the next one in CI instead.
 *
 * It does not trust a curated list of fields. It reads the handlers themselves:
 * for each route under a module that has an allow-list, it collects the fields
 * read from the variable assigned `await c.req.json()` (dot access, bracket
 * access, and destructuring), then asks the real filterAllowedFields whether
 * each one survives.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

import { filterAllowedFields } from "../../src/utils/inputSanitizer";

const ROOT = process.cwd();
const ROUTES_DIR = join(ROOT, "src", "mastra", "routes");

/**
 * Fields deliberately kept OFF an allow-list even though a handler reads them.
 * Every entry needs a reason; "it was failing" is not one.
 */
const INTENTIONALLY_STRIPPED: Record<string, string> = {
  // File-binding fields may only be set by POST /api/policies/:id/upload, so a
  // JSON body can never rebind a document to another module's file. The create
  // and update handlers read them only to strip them again — this is the outer
  // of two gates, and both must stay.
  "/api/policies file_path": "file binding — upload endpoint only",
  "/api/policies file_name": "file binding — upload endpoint only",
  "/api/policies file_size": "file binding — upload endpoint only",
  "/api/policies file_mime_type": "file binding — upload endpoint only",
  "/api/policies/:id file_path": "file binding — upload endpoint only",
  "/api/policies/:id file_name": "file binding — upload endpoint only",
  "/api/policies/:id file_size": "file binding — upload endpoint only",
  "/api/policies/:id file_mime_type": "file binding — upload endpoint only",
};

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Strip comments before scanning. This repo has been bitten three times by
 * source-scraping checks that read a field name out of a COMMENT and counted it
 * as code; a route documenting "we used to read body.foo" must not register a
 * read of foo. Newlines are kept so positions still line up.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

interface Read {
  file: string;
  path: string;
  field: string;
}

function collectReads(): Read[] {
  const reads: Read[] = [];
  for (const file of routeFiles(ROUTES_DIR)) {
    const src = stripComments(readFileSync(file, "utf-8"));
    const marks = [...src.matchAll(/path:\s*["'`](\/api\/[^"'`]+)["'`]/g)];
    marks.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = i + 1 < marks.length ? (marks[i + 1].index ?? src.length) : src.length;
      const block = src.slice(start, end);
      const path = m[1];

      const vars = new Set(
        [...block.matchAll(
          /(?:const|let|var)\s+(\w+)\s*(?::\s*[\w<>[\],\s]+)?=\s*await\s+c\.req\.json\s*(?:<[^>]*>)?\s*\(/g,
        )].map((x) => x[1]),
      );

      const fields = new Set<string>();
      for (const d of block.matchAll(
        /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(await\s+c\.req\.json|\w+)\b/g,
      )) {
        // Only a destructure of the BODY counts. `startsWith("await")` looked
        // right and was not: `const { createAudit } = await import("...")`
        // also captures `await`, and that one mistake turned every lazily
        // imported helper into a "body field" — 750 false failures.
        if (!/c\.req\.json/.test(d[2]) && !vars.has(d[2])) continue;
        for (const part of d[1].split(",")) {
          const name = part.trim().split(":")[0].split("=")[0].trim();
          if (name && !name.startsWith("...")) fields.add(name);
        }
      }
      for (const v of vars) {
        for (const x of block.matchAll(new RegExp(`\\b${v}\\s*\\??\\.\\s*([A-Za-z_]\\w*)`, "g")))
          fields.add(x[1]);
        for (const x of block.matchAll(new RegExp(`\\b${v}\\s*\\??\\.?\\s*\\[\\s*["']([A-Za-z_]\\w*)["']`, "g")))
          fields.add(x[1]);
      }
      for (const field of fields) reads.push({ file: relative(ROOT, file), path, field });
    });
  }
  return reads;
}

const READS = collectReads();

/** True when the middleware would delete this field before the handler runs. */
function isStripped(path: string, field: string): boolean {
  const out = filterAllowedFields({ [field]: "x" }, path);
  return !(field in out);
}

describe("the scanner can see what it is checking", () => {
  // Anti-tautology. If the extraction regexes stop matching — a refactor, a
  // new body-reading idiom — the coverage test below would find zero reads and
  // pass. These pin reads we KNOW exist, in three different modules.
  it.each([
    ["/api/compliance/obligations/:id/documents", "document_id"],
    ["/api/policies", "policy_number"],
    ["/api/vendors/assessments", "vendor_id"],
  ])("finds %s reading %s", (path, field) => {
    expect(READS.some((r) => r.path === path && r.field === field)).toBe(true);
  });

  it("scans a meaningful number of reads, not a handful", () => {
    expect(READS.length).toBeGreaterThan(100);
  });

  it("really does detect a stripped field (the check is not always-false)", () => {
    expect(isStripped("/api/policies", "definitely_not_a_real_field")).toBe(true);
    expect(isStripped("/api/policies", "policy_number")).toBe(false);
  });
});

describe("every field a handler reads survives the sanitizer", () => {
  it("strips nothing a handler depends on, except documented exceptions", () => {
    const unexpected = READS
      .filter((r) => isStripped(r.path, r.field))
      .filter((r) => !(`${r.path} ${r.field}` in INTENTIONALLY_STRIPPED))
      .map((r) => `${r.path} → ${r.field}  (${r.file})`);

    expect(
      [...new Set(unexpected)].sort(),
      "Each of these is read by a handler but DELETED by filterAllowedFields " +
        "first, so the endpoint silently ignores it. Add the field to the " +
        "module's ALLOWED_FIELDS in src/utils/inputSanitizer.ts — or, if it must " +
        "stay stripped for security, add it to INTENTIONALLY_STRIPPED here with " +
        "the reason.",
    ).toEqual([]);
  });

  it("keeps every documented exception actually stripped", () => {
    // The exceptions are security decisions. If one stops being stripped —
    // someone "fixes" the test by adding file_path to the policies list — that
    // is a regression of the gate, not a pass.
    for (const key of Object.keys(INTENTIONALLY_STRIPPED)) {
      const [path, field] = key.split(" ");
      expect(isStripped(path, field), `${key} must stay stripped`).toBe(true);
    }
  });
});
