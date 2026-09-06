/**
 * Unit tests for problemSignature in src/utils/platformHealthPulse.ts
 *
 * This decides whether a pulse run is announced. Getting it wrong is expensive
 * in both directions: too eager and the platform pages hourly until people mute
 * it, too lazy and a new failure is swallowed.
 *
 * The lazy direction is the one that actually bit. maybeNotifyOnPulse used to
 * compare only overall_status, so a platform stuck on "critical" — which is
 * exactly what a queue nobody drains produces — matched its predecessor every
 * run, alerted once, and then went silent forever, including for unrelated
 * failures appearing later. The signature exists so a steady state stays quiet
 * while anything NEWLY broken is still announced.
 *
 * Run:  npx tsx tests/healthPulseProblemSignature.test.ts
 */

import { problemSignature } from "../src/utils/platformHealthPulse";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("problemSignature");

console.log("\n=== health-pulse problem signature ===\n");

const ok = (id: string) => ({ id, status: "pass" });
const bad = (id: string) => ({ id, status: "fail" });
const meh = (id: string) => ({ id, status: "warn" });

await suite.test("an all-passing run has an empty signature", async () => {
  suite.expectEqual(problemSignature([ok("a"), ok("b")]), "", "no problems");
});

await suite.test("passing checks never enter the signature", async () => {
  // A check flipping pass→pass is not news and must not cause an alert.
  suite.expectEqual(
    problemSignature([ok("a"), bad("b")]),
    problemSignature([bad("b")]),
    "adding a passing check changes nothing",
  );
});

await suite.test("check ORDER cannot fake a change", async () => {
  // Checks are produced by array iteration; a reordering must not alert.
  suite.expectEqual(
    problemSignature([bad("b"), meh("a")]),
    problemSignature([meh("a"), bad("b")]),
    "sorted, so order is irrelevant",
  );
});

await suite.test("an unchanged failure stays silent", async () => {
  // The 280-pending-approvals case: same problem, run after run.
  const before = [bad("ai_approval_stale"), bad("ai_approval_queue_depth")];
  const after = [bad("ai_approval_stale"), bad("ai_approval_queue_depth")];
  suite.expectEqual(
    problemSignature(before) === problemSignature(after),
    true,
    "identical problems produce identical signatures",
  );
});

await suite.test("a NEW failure alongside an existing one is announced", async () => {
  // The regression this guards. Both runs are "critical", so the old
  // status-only comparison would have suppressed the second one entirely.
  const before = [bad("ai_approval_stale")];
  const after = [bad("ai_approval_stale"), bad("audit_write_health")];
  suite.expectEqual(
    problemSignature(before) === problemSignature(after),
    false,
    "a newly broken check changes the signature",
  );
});

await suite.test("a failure CLEARING is announced", async () => {
  const before = [bad("a"), bad("b")];
  const after = [bad("a")];
  suite.expectEqual(
    problemSignature(before) === problemSignature(after),
    false,
    "recovery is a change worth reporting",
  );
});

await suite.test("severity change on the same check is announced", async () => {
  // warn → fail on one check is a real escalation, not noise.
  suite.expectEqual(
    problemSignature([meh("a")]) === problemSignature([bad("a")]),
    false,
    "warn and fail are distinct",
  );
});

await suite.test("malformed input degrades to empty, never throws", async () => {
  // Persisted `checks` can be null or a legacy shape; this runs inside the
  // alerting path and must not take it down.
  suite.expectEqual(problemSignature(null), "", "null");
  suite.expectEqual(problemSignature(undefined), "", "undefined");
  suite.expectEqual(problemSignature([] as any), "", "empty array");
  suite.expectEqual(
    problemSignature([{ status: "fail" }] as any),
    "fail:?",
    "missing id does not throw",
  );
});

suite.finishOrExit();
