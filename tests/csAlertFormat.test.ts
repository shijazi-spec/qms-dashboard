/**
 * Unit tests for src/utils/csAlertFormat.ts
 *
 * These format a COMPLIANCE alert. The counts in it are read as facts by the CS
 * team, so the thing worth guarding is not that the text looks nice — it is
 * that the numbers and the "…and N more" line tell the truth about what was
 * hidden. A list that silently drops its tail understates a backlog, which is
 * the failure mode this whole channel exists to prevent.
 *
 * Run:  npx tsx tests/csAlertFormat.test.ts
 */

import { csRuleLabel, topCounts } from "../src/utils/csAlertFormat";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("csAlertFormat");

console.log("\n=== CS alert formatting ===\n");

await suite.test("rule codes become readable labels", async () => {
  suite.expectEqual(csRuleLabel("renewal_overdue"), "Renewal overdue", "simple");
  suite.expectEqual(
    csRuleLabel("termination_missing_churn_date"),
    "Termination missing churn date",
    "multi-word",
  );
});

await suite.test("known abbreviations survive the title-casing", async () => {
  // "Missing cs owner" and "Missing arr value" read as typos in a message the
  // CS team is meant to act on.
  suite.expectEqual(csRuleLabel("missing_cs_owner"), "Missing CS owner", "cs");
  suite.expectEqual(csRuleLabel("missing_arr_value"), "Missing ARR value", "arr");
});

await suite.test("abbreviation expansion is whole-word only", async () => {
  // The naive replace turns "arrears" into "ARRears". \b prevents that.
  suite.expectEqual(csRuleLabel("arrears_flag"), "Arrears flag", "no false ARR");
  suite.expectEqual(csRuleLabel("cars_missing"), "Cars missing", "no false CS");
});

await suite.test("an unknown or empty code never renders as undefined", async () => {
  // A new rule added upstream must still print something a person can read.
  suite.expectEqual(csRuleLabel(""), "Unknown", "empty");
  suite.expectEqual(
    csRuleLabel("some_brand_new_rule"),
    "Some brand new rule",
    "unmapped code still reads",
  );
});

await suite.test("counts are listed highest first", async () => {
  const out = topCounts({ a: 2, b: 9, c: 5 }, 10);
  suite.expectEqual(out, "• b — 9\n• c — 5\n• a — 2", "descending");
});

await suite.test("zero counts are dropped, not listed", async () => {
  // The scan reports all 13 rule codes every run, most at zero. Listing them
  // buries the two that matter.
  const out = topCounts({ hit: 3, quiet: 0, alsoQuiet: 0 }, 10);
  suite.expectEqual(out, "• hit — 3", "only non-zero");
});

await suite.test("the overflow line counts what it actually hid", async () => {
  // The assertion that matters. 7 rules, cap of 3 → 4 hidden, not 3 and not 5.
  const counts: Record<string, number> = {};
  for (let i = 1; i <= 7; i++) counts[`r${i}`] = i;
  const out = topCounts(counts, 3);
  suite.expectEqual(
    out,
    "• r7 — 7\n• r6 — 6\n• r5 — 5\n• …and 4 more",
    "top 3 plus an honest remainder",
  );
});

await suite.test("no overflow line when everything fits", async () => {
  // Exactly at the cap must not print "…and 0 more".
  const out = topCounts({ a: 1, b: 2, c: 3 }, 3);
  suite.expectEqual(out, "• c — 3\n• b — 2\n• a — 1", "exact fit");
  suite.expectEqual(out.includes("more"), false, "no overflow line");
});

await suite.test("an empty or all-zero set returns empty, not a header", async () => {
  // The caller uses this to decide whether to add a section at all. Returning
  // a stray bullet would print an empty "Critical by rule:" heading.
  suite.expectEqual(topCounts({}, 5), "", "empty");
  suite.expectEqual(topCounts({ a: 0, b: 0 }, 5), "", "all zero");
});

await suite.test("the label function is applied to every row", async () => {
  const out = topCounts({ renewal_overdue: 4, missing_cs_owner: 1 }, 5, csRuleLabel);
  suite.expectEqual(
    out,
    "• Renewal overdue — 4\n• Missing CS owner — 1",
    "labelled",
  );
});

suite.finishOrExit();
