/**
 * Unit tests for classifyPulseTransition in src/utils/platformHealthPulse.ts
 *
 * This decides whether a health-pulse run pages anyone. Both failure modes are
 * expensive and neither is visible from the outside:
 *
 *   too eager  the channel gets an alert every ~90 minutes about a platform
 *              that has barely moved, people mute it, and the real alert is
 *              muted along with it.
 *   too quiet  something new breaks and nobody is told.
 *
 * The eager direction is the one that actually happened, on 2026-09-07: two
 * alerts 83 minutes apart in which the approval queue had RESOLVED and the
 * stale check had improved from fail to warn. Two of the three changes were
 * things getting better, and they still paged.
 *
 * Run:  npx tsx tests/healthPulseDampening.test.ts
 */

import { classifyPulseTransition } from "../src/utils/platformHealthPulse";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("classifyPulseTransition");

console.log("\n=== health-pulse alert dampening ===\n");

const ok = (id: string) => ({ id, status: "pass" });
const warn = (id: string) => ({ id, status: "warn" });
const fail = (id: string) => ({ id, status: "fail" });

await suite.test("a brand-new failure is announced", async () => {
  const r = classifyPulseTransition([ok("a")], [fail("a")]);
  suite.expectEqual(r.announce, true, "announce");
  suite.expectEqual(r.reason, "worsened", "reason");
  suite.expectEqual(r.worsened.join(","), "a", "names the check");
});

await suite.test("warn escalating to fail is announced", async () => {
  const r = classifyPulseTransition([warn("a")], [fail("a")]);
  suite.expectEqual(r.announce, true, "escalation is news");
});

await suite.test("an unchanged problem stays silent", async () => {
  const r = classifyPulseTransition([fail("a"), warn("b")], [fail("a"), warn("b")]);
  suite.expectEqual(r.announce, false, "steady state is not news");
});

await suite.test("fail improving to warn stays silent", async () => {
  // Half of the 2026-09-07 noise. Getting better must not page anyone.
  const r = classifyPulseTransition([fail("a")], [warn("a")]);
  suite.expectEqual(r.announce, false, "improvement is not news");
});

await suite.test("a problem clearing stays silent while others remain", async () => {
  // The other half: the approval queue resolved while KPI freshness stayed
  // broken. Nothing new, so nothing to say.
  const r = classifyPulseTransition([fail("queue"), fail("kpi")], [ok("queue"), fail("kpi")]);
  suite.expectEqual(r.announce, false, "partial recovery is not news");
});

await suite.test("the real 2026-09-07 pair: the second run would have been quieter", async () => {
  // 12:02 → 1:25 exactly as they appeared in Slack.
  const at1202 = [fail("ai_approval_queue_depth"), fail("ai_approval_stale"), fail("kpi_freshness"), fail("endpoint_audit_latest"), warn("rate_limit_429_pruner_freshness")];
  const at0125 = [ok("ai_approval_queue_depth"), warn("ai_approval_stale"), fail("kpi_freshness"), fail("endpoint_audit_latest"), fail("rate_limit_429_pruner_freshness")];
  const r = classifyPulseTransition(at1202, at0125);
  // The pruner genuinely escalated warn→fail, so this run still alerts — but
  // ONLY for that, not for the queue resolving or the stale check improving.
  suite.expectEqual(r.announce, true, "the pruner escalation is real");
  suite.expectEqual(
    r.worsened.join(","),
    "rate_limit_429_pruner_freshness",
    "and it is the ONLY thing reported as new/worse",
  );
});

await suite.test("full recovery sends exactly one message", async () => {
  const r = classifyPulseTransition([fail("a"), warn("b")], [ok("a"), ok("b")]);
  suite.expectEqual(r.announce, true, "recovery is worth knowing");
  suite.expectEqual(r.reason, "recovered", "reason");
});

await suite.test("staying healthy says nothing", async () => {
  const r = classifyPulseTransition([ok("a")], [ok("a")]);
  suite.expectEqual(r.announce, false, "healthy to healthy is silence");
});

await suite.test("a newly ADDED check that fails counts as new", async () => {
  // A check absent last run is treated as previously fine, so adding a check
  // that immediately fails is announced rather than swallowed.
  const r = classifyPulseTransition([ok("a")], [ok("a"), fail("brand_new")]);
  suite.expectEqual(r.announce, true, "announce");
  suite.expectEqual(r.worsened.join(","), "brand_new", "names it");
});

await suite.test("no history announces an unhealthy run", async () => {
  // First run ever, or history unavailable: better to speak up than to assume.
  const r = classifyPulseTransition(null, [fail("a")]);
  suite.expectEqual(r.announce, true, "announce");
  const r2 = classifyPulseTransition(undefined, [ok("a")]);
  suite.expectEqual(r2.announce, false, "but a healthy first run is silent");
});

await suite.test("malformed input never throws", async () => {
  suite.expectEqual(classifyPulseTransition(null, null).announce, false, "both null");
  suite.expectEqual(classifyPulseTransition([{} as any], [{} as any]).announce, false, "no ids");
});

suite.finishOrExit();
