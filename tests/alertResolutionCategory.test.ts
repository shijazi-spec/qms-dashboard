/**
 * Unit tests for the shared resolution-category helper at
 * dashboard/js/alert-resolution.js (Task #346).
 *
 * The helper is a vanilla JS module loaded by both ai-ops.html and
 * consultant.html via a <script src> tag, so it doesn't go through the
 * TypeScript pipeline. We exercise it from Node by reading the file and
 * eval'ing it inside a stand-in `window` object — the same shape the
 * dashboards expose.
 *
 * Coverage matrix:
 *   - categorize() returns null for non-resolved statuses
 *   - "auto-resolved: error rate …"        → "recovered"
 *   - "auto-resolved: p95 latency …"       → "recovered"
 *   - "auto-resolved: tool went silent …"  → "went_silent"
 *   - "auto-resolved: prompt regression …" → "prompt_regression_auto"
 *   - missing/empty resolution_note        → "manual"
 *   - operator-supplied note               → "manual"
 *   - whitespace / case insensitivity      → still routes to the right bucket
 *   - unknown "auto-resolved:" variant     → falls back to "recovered"
 *   - getBadgeSpec() returns the matching slug + classes per category
 *   - isRecoveryCategory() flags only recovered + went_silent
 *
 * Run:  npx tsx tests/alertResolutionCategory.test.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("alertResolutionCategory");

console.log("\n=== alertResolutionCategory unit tests ===\n");

// Load the dashboard helper into a stand-in `window` so its IIFE can
// attach `WalaPlusAlertResolution`. We use indirect eval so the script
// runs in the global scope of this test process and the IIFE can find
// our injected `window` reference via globalThis.
const SRC = readFileSync(
  join(process.cwd(), "dashboard/js/alert-resolution.js"),
  "utf-8",
);
const fakeWindow: any = {};
(globalThis as any).window = fakeWindow;
// eslint-disable-next-line no-eval
(0, eval)(SRC);
const R = fakeWindow.WalaPlusAlertResolution;

function alert(
  status: string,
  resolution_note: string | null | undefined,
): any {
  return { id: 1, status, resolution_note };
}

await suite.test("categorize() returns null for non-resolved statuses", async () => {
  suite.expectEqual(R.categorize(alert("open", null)), null, "open");
  suite.expectEqual(
    R.categorize(alert("acknowledged", "auto-resolved: error rate")),
    null,
    "acknowledged ignores note",
  );
  suite.expectEqual(R.categorize(alert("dismissed", null)), null, "dismissed");
  suite.expectEqual(R.categorize(null), null, "null alert");
  suite.expectEqual(R.categorize(undefined), null, "undefined alert");
});

await suite.test("categorize() routes tool-health recovery notes to 'recovered'", async () => {
  suite.expectEqual(
    R.categorize(
      alert(
        "resolved",
        "auto-resolved: error rate back below threshold (1% < 5% over 30m, 100 calls)",
      ),
    ),
    "recovered",
    "error rate prefix",
  );
  suite.expectEqual(
    R.categorize(
      alert(
        "resolved",
        "auto-resolved: p95 latency back below threshold (300ms < 500ms over 30m, 50 calls)",
      ),
    ),
    "recovered",
    "p95 latency prefix",
  );
});

await suite.test("categorize() routes silent-tool sweep notes to 'went_silent'", async () => {
  suite.expectEqual(
    R.categorize(
      alert(
        "resolved",
        "auto-resolved: tool went silent — no calls recorded in the last 60 minutes (cooldown window)",
      ),
    ),
    "went_silent",
    "silent-tool prefix",
  );
});

await suite.test("categorize() routes prompt-regression notes to 'prompt_regression_auto'", async () => {
  suite.expectEqual(
    R.categorize(
      alert(
        "resolved",
        'auto-resolved: prompt regression for "consultant" is no longer present',
      ),
    ),
    "prompt_regression_auto",
    "prompt regression prefix",
  );
});

await suite.test("categorize() returns 'manual' for resolved rows without an auto-resolved prefix", async () => {
  suite.expectEqual(R.categorize(alert("resolved", null)), "manual", "null note");
  suite.expectEqual(R.categorize(alert("resolved", "")), "manual", "empty note");
  suite.expectEqual(
    R.categorize(alert("resolved", "Closed by an operator after triage")),
    "manual",
    "operator note",
  );
});

await suite.test("categorize() is case- and whitespace-insensitive on the prefix check", async () => {
  suite.expectEqual(
    R.categorize(
      alert(
        "resolved",
        "  AUTO-RESOLVED: Tool Went Silent — extra padding   ",
      ),
    ),
    "went_silent",
    "uppercase + padded silent-tool note",
  );
  suite.expectEqual(
    R.categorize(
      alert("resolved", "Auto-Resolved: Error rate back below threshold"),
    ),
    "recovered",
    "mixed-case recovery note",
  );
});

await suite.test("categorize() falls back to 'recovered' for unknown auto-resolved variants", async () => {
  // A future cron variant that adds a new "auto-resolved: …" reason
  // should still get a green pill rather than be misread as manual.
  suite.expectEqual(
    R.categorize(alert("resolved", "auto-resolved: future variant we don't know about")),
    "recovered",
    "unknown auto-resolved variant",
  );
});

await suite.test("isAutoResolved() agrees with categorize() on the auto/manual binary view", async () => {
  suite.expect(R.isAutoResolved(alert("resolved", "auto-resolved: error rate")), "recovery → auto");
  suite.expect(
    R.isAutoResolved(
      alert("resolved", "auto-resolved: tool went silent — 60m"),
    ),
    "silent → auto",
  );
  suite.expect(
    R.isAutoResolved(
      alert("resolved", 'auto-resolved: prompt regression for "x"'),
    ),
    "prompt regression → auto",
  );
  suite.expect(!R.isAutoResolved(alert("resolved", null)), "manual is NOT auto");
  suite.expect(!R.isAutoResolved(alert("open", null)), "open is NOT auto");
});

await suite.test("getBadgeSpec() returns a slug + classes per category", async () => {
  const recovered = R.getBadgeSpec("recovered");
  suite.expect(!!recovered, "recovered spec exists");
  suite.expectEqual(recovered.slug, "recovered", "recovered slug");
  suite.expect(/green/.test(recovered.classes), "recovered uses green palette");

  const silent = R.getBadgeSpec("went_silent");
  suite.expectEqual(silent.slug, "went-silent", "went_silent slug");
  suite.expect(/teal/.test(silent.classes), "went_silent uses teal palette");

  const reg = R.getBadgeSpec("prompt_regression_auto");
  suite.expectEqual(reg.slug, "prompt-regression", "prompt_regression slug");
  suite.expect(/purple/.test(reg.classes), "prompt_regression_auto uses purple palette");

  const manual = R.getBadgeSpec("manual");
  suite.expectEqual(manual.slug, "manual", "manual slug");
  suite.expect(/gray/.test(manual.classes), "manual uses gray palette");

  suite.expectEqual(R.getBadgeSpec("not_a_category"), null, "unknown category → null spec");
  suite.expectEqual(R.getBadgeSpec(null), null, "null category → null spec");
});

await suite.test("isRecoveryCategory() flags only recovered + went_silent", async () => {
  suite.expect(R.isRecoveryCategory("recovered"), "recovered IS recovery");
  suite.expect(R.isRecoveryCategory("went_silent"), "went_silent IS recovery");
  suite.expect(
    !R.isRecoveryCategory("prompt_regression_auto"),
    "prompt regression is NOT a recovery (different surface area)",
  );
  suite.expect(!R.isRecoveryCategory("manual"), "manual is NOT recovery");
  suite.expect(!R.isRecoveryCategory(null), "null is NOT recovery");
});

const summary = suite.summarize();
console.log(
  `\nResult: ${summary.passed}/${summary.total} passed${summary.failed ? `, ${summary.failed} failed` : ""}\n`,
);
process.exit(summary.failed === 0 ? 0 : 1);
