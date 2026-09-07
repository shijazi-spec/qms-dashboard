/**
 * Unit tests for the per-department audit split in directAuditRunner.
 *
 * Two properties matter and neither is visible at a glance in Slack:
 *
 *   1. A department must see ONLY its own findings. A marketplace count leaking
 *      into the Sales channel is not obviously wrong to anyone reading it — it
 *      just makes the numbers quietly untrue.
 *   2. A department with nothing must get SILENCE, not a "0 findings" post. A
 *      channel that receives a clean report every week teaches people to skim
 *      past it, and then the week it is not clean gets skimmed too.
 *
 * Run:  npx tsx tests/auditDepartmentSplit.test.ts
 */

import {
  auditSegmentForLayout,
  buildDepartmentAuditLines,
  type SegmentFindingCounts,
} from "../src/utils/directAuditRunner";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("auditDepartmentSplit");

console.log("\n=== per-department audit split ===\n");

const counts: SegmentFindingCounts = {
  "corporate|Deals|governance_violation": {
    count: 246, severity: "high", module: "Deals", segment: "corporate", issueType: "governance_violation",
  },
  "corporate|Leads|missing_required_field": {
    count: 350, severity: "medium", module: "Leads", segment: "corporate", issueType: "missing_required_field",
  },
  "corporate|Deals|invalid_value": {
    count: 68, severity: "critical", module: "Deals", segment: "corporate", issueType: "invalid_value",
  },
  "marketplace|Leads|invalid_format": {
    count: 43, severity: "medium", module: "Leads", segment: "marketplace", issueType: "invalid_format",
  },
};

await suite.test("layout decides the department", async () => {
  suite.expectEqual(auditSegmentForLayout("Marketplace"), "marketplace", "marketplace");
  suite.expectEqual(auditSegmentForLayout("Partner Accounts"), "marketplace", "partner accounts");
  suite.expectEqual(auditSegmentForLayout("partner  accounts"), "marketplace", "spacing ignored");
  suite.expectEqual(auditSegmentForLayout("WalaPlus"), "corporate", "walaplus");
  suite.expectEqual(auditSegmentForLayout("Standard"), "corporate", "standard");
  suite.expectEqual(auditSegmentForLayout(null), "corporate", "null defaults to corporate");
  suite.expectEqual(auditSegmentForLayout(""), "corporate", "empty defaults to corporate");
});

await suite.test("a department sees ONLY its own findings", async () => {
  const corp = buildDepartmentAuditLines(counts, "corporate");
  const mkt = buildDepartmentAuditLines(counts, "marketplace");
  suite.expectEqual(corp?.total, 246 + 350 + 68, "corporate total excludes marketplace");
  suite.expectEqual(mkt?.total, 43, "marketplace total excludes corporate");
  suite.expectEqual(
    (corp?.lines || []).some((l) => l.includes("invalid_format")),
    false,
    "the marketplace finding does not appear in the corporate lines",
  );
});

await suite.test("worst first — critical outranks a bigger medium", async () => {
  // 68 criticals must lead 350 mediums; sorting by count alone would bury the
  // thing that actually needs attention.
  const corp = buildDepartmentAuditLines(counts, "corporate");
  suite.expectEqual(
    (corp?.lines[0] || "").includes("invalid_value"),
    true,
    "critical first",
  );
});

await suite.test("a department with no findings gets silence, not a zero", async () => {
  const empty = buildDepartmentAuditLines(
    { "corporate|Deals|x": { count: 5, severity: "low", module: "Deals", segment: "corporate", issueType: "x" } },
    "marketplace",
  );
  suite.expectEqual(empty, null, "null means do not post");
});

await suite.test("an all-zero department is also silent", async () => {
  const zeroed: SegmentFindingCounts = {
    "marketplace|Deals|x": { count: 0, severity: "low", module: "Deals", segment: "marketplace", issueType: "x" },
  };
  suite.expectEqual(buildDepartmentAuditLines(zeroed, "marketplace"), null, "zero total is silence");
});

await suite.test("an empty tally is silent for every department", async () => {
  suite.expectEqual(buildDepartmentAuditLines({}, "corporate"), null, "corporate");
  suite.expectEqual(buildDepartmentAuditLines({}, "marketplace"), null, "marketplace");
});

await suite.test("long lists are truncated with an explicit remainder", async () => {
  // Slack blocks have a size limit, and a wall of 200 lines is unreadable
  // anyway — but the reader must be told the list was cut.
  const many: SegmentFindingCounts = {};
  for (let i = 0; i < 25; i++) {
    many[`corporate|Deals|type${i}`] = {
      count: 100 - i, severity: "medium", module: "Deals", segment: "corporate", issueType: `type${i}`,
    };
  }
  const built = buildDepartmentAuditLines(many, "corporate", 15);
  suite.expectEqual(built?.lines.length, 16, "15 findings plus one remainder line");
  suite.expectEqual(
    (built?.lines[15] || "").includes("10 more"),
    true,
    "remainder states how many were hidden",
  );
  suite.expectEqual(
    built?.total,
    Object.values(many).reduce((s, r) => s + r.count, 0),
    "the TOTAL still counts everything, not just the shown lines",
  );
});

suite.finishOrExit();
