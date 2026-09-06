/**
 * Unit tests for classifyAuditWriteRecency in src/utils/platformHealthPulse.ts
 *
 * This is the threshold logic behind the `audit_write_health` pulse check. It
 * is the only judgement in that check, and both ways of getting it wrong are
 * expensive: too tight and the platform cries wolf every quiet weekend until
 * people mute it, too loose and another audit-trail outage runs for weeks
 * unnoticed (2026-08 ran eighteen days).
 *
 * The `fail` boundary matters most: only a failing check makes a pulse run
 * "critical", and only a critical run is dispatched at `high` priority, which
 * is the sole path that reaches Slack/email. A `warn` notifies in-app only.
 *
 * Run:  npx tsx tests/auditWriteRecency.test.ts
 */

import {
  classifyAuditWriteRecency,
  AUDIT_WRITE_WARN_HOURS,
  AUDIT_WRITE_FAIL_HOURS,
} from "../src/utils/platformHealthPulse";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("classifyAuditWriteRecency");

console.log("\n=== audit-write recency thresholds ===\n");

await suite.test("a freshly written event passes", async () => {
  suite.expectEqual(classifyAuditWriteRecency(0).status, "pass", "0h");
  suite.expectEqual(classifyAuditWriteRecency(1.5).status, "pass", "90 min");
});

await suite.test("a normal working gap passes", async () => {
  // Overnight and a routine weekend must not alert.
  suite.expectEqual(classifyAuditWriteRecency(12).status, "pass", "12h");
  suite.expectEqual(classifyAuditWriteRecency(48).status, "pass", "48h");
});

await suite.test("the warn boundary is exclusive, not inclusive", async () => {
  // Exactly at the threshold is still healthy; only strictly past it warns.
  suite.expectEqual(
    classifyAuditWriteRecency(AUDIT_WRITE_WARN_HOURS).status,
    "pass",
    "exactly 72h still passes",
  );
  suite.expectEqual(
    classifyAuditWriteRecency(AUDIT_WRITE_WARN_HOURS + 0.1).status,
    "warn",
    "just past 72h warns",
  );
});

await suite.test("a long quiet stretch warns but does not alert", async () => {
  // A holiday week should not page anyone — warn keeps the run "degraded".
  const r = classifyAuditWriteRecency(120);
  suite.expectEqual(r.status, "warn", "5 days");
  suite.expectEqual(
    (r.message || "").includes("5.0 days"),
    true,
    "message states the age in days",
  );
});

await suite.test("the fail boundary is exclusive, not inclusive", async () => {
  suite.expectEqual(
    classifyAuditWriteRecency(AUDIT_WRITE_FAIL_HOURS).status,
    "warn",
    "exactly 168h is still only a warning",
  );
  suite.expectEqual(
    classifyAuditWriteRecency(AUDIT_WRITE_FAIL_HOURS + 0.1).status,
    "fail",
    "just past 168h fails",
  );
});

await suite.test("the 2026-08 outage would have been caught", async () => {
  // Eighteen days of missing audit history is the incident this check exists
  // for. It must reach `fail` — a warn would notify in-app only, into a feed
  // with no reachable reader, which is how it went unnoticed the first time.
  const r = classifyAuditWriteRecency(18 * 24);
  suite.expectEqual(r.status, "fail", "18 days fails");
  suite.expectEqual(
    (r.message || "").includes("18.0 days"),
    true,
    "message states the age in days",
  );
});

await suite.test("thresholds are ordered", async () => {
  suite.expectEqual(
    AUDIT_WRITE_WARN_HOURS < AUDIT_WRITE_FAIL_HOURS,
    true,
    "warn threshold is below fail threshold",
  );
});

suite.finishOrExit();
