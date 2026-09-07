/**
 * Pins the check-key contract in src/utils/githubEvidenceConnector.ts.
 *
 * The first cut derived the key for an errored check from the function name:
 *
 *     run.name.replace(/^check/, "").toLowerCase()   // "branchprotection"
 *
 * Every other row writes "branch_protection". Because latestObservations()
 * groups by (source, check_key, subject), an error filed under the derived key
 * created a NEW series that no view was looking at, while the dashboard went on
 * serving the last SUCCESSFUL row for the real key. A check could fail
 * indefinitely and the evidence page would keep showing a pass — the exact
 * "manufactures assurance" failure the connector's own header warns about.
 *
 * That derivation is gone. These tests keep it gone, and keep every emitted key
 * traceable to a clause, because an unmapped key is evidence an auditor cannot
 * tie to a control.
 *
 * Run:  npx tsx tests/githubEvidenceConnectorKeys.test.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { CHECK_RUNNERS, CHECK_CLAUSE_MAP } from "../src/utils/githubEvidenceConnector";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("githubEvidenceConnectorKeys");
const SRC = readFileSync(
  join(process.cwd(), "src/utils/githubEvidenceConnector.ts"),
  "utf8",
);

/**
 * The source with comments removed.
 *
 * Structural assertions MUST run against this, not SRC. The comments in that
 * file quote the very patterns these tests ban — `run.name.replace(...)` and
 * `per_page=100` — because explaining a fixed bug is how it stays fixed. A
 * guardrail that greps raw source would fail on the explanation and force
 * someone to delete it, which is the wrong repair. (The same trap already bites
 * check-i18n.cjs, which reads `t('key')` inside comments.)
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("\n=== GitHub evidence connector — check-key contract ===\n");

const emitted = CHECK_RUNNERS.flatMap((r) => r.keys);

await suite.test("every runner declares at least one key", async () => {
  for (const r of CHECK_RUNNERS) {
    suite.expectEqual(r.keys.length > 0, true, `${r.run.name} declares keys`);
  }
});

await suite.test("every emitted key has a clause mapping", async () => {
  for (const key of emitted) {
    suite.expectEqual(
      Object.prototype.hasOwnProperty.call(CHECK_CLAUSE_MAP, key),
      true,
      `${key} is in CHECK_CLAUSE_MAP`,
    );
  }
});

await suite.test("no clause mapping is orphaned", async () => {
  // The reverse direction: a mapped key nothing emits is a claim of coverage
  // the connector does not actually provide.
  for (const key of Object.keys(CHECK_CLAUSE_MAP)) {
    suite.expectEqual(emitted.includes(key), true, `${key} is emitted by a runner`);
  }
});

await suite.test("keys are snake_case, as every stored row expects", async () => {
  for (const key of emitted) {
    suite.expectEqual(
      /^[a-z][a-z0-9_]*$/.test(key),
      true,
      `${key} is snake_case`,
    );
  }
});

await suite.test("the check key is never derived from a function name", async () => {
  // Function names are mangled by bundlers and do not carry the underscores,
  // so deriving a key from one is wrong twice over.
  suite.expectEqual(
    /run\.name/.test(CODE),
    false,
    "no run.name-derived check key in the code",
  );
});

await suite.test("keys are unique across runners", async () => {
  suite.expectEqual(
    new Set(emitted).size,
    emitted.length,
    "no key is emitted by two runners",
  );
});

// ── Pagination honesty ─────────────────────────────────────────────────────
// The list checks previously requested per_page=100 and reported whatever came
// back, so 150 open alerts were reported as 100 while the summary said "in
// total". A wrong number in audit evidence is worse than a missing one.

console.log("\n=== pagination honesty ===\n");

await suite.test("list endpoints go through the paging helper", async () => {
  // A bare githubGet against a list endpoint is the shape of the old bug.
  for (const ep of ["dependabot/alerts", "secret-scanning/alerts", "collaborators"]) {
    suite.expectEqual(
      new RegExp(`githubGet\\(\`[^\`]*${ep.replace("/", "\\/")}`).test(CODE),
      false,
      `${ep} is not read with a single githubGet`,
    );
  }
});

await suite.test("per_page is set in exactly one place", async () => {
  // It belongs in githubList, which pages. Anywhere else it caps silently —
  // which is precisely how the truncation bug was written the first time.
  const occurrences = (CODE.match(/per_page=/g) || []).length;
  suite.expectEqual(occurrences, 1, `per_page= appears once (found ${occurrences})`);
});

await suite.test("truncation is recorded, not hidden", async () => {
  suite.expectEqual(CODE.includes("truncated"), true, "observed carries a truncated flag");
});

suite.finishOrExit();
