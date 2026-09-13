/**
 * Unit tests for classifyKeyAccess() in src/mastra/middleware/index.ts
 *
 * This is the single most security-relevant decision in the middleware: which
 * paths a bare X-Admin-Key can reach with no user session. It was three inline
 * booleans with no test, so the boundary could only be checked by reading it.
 *
 * The tests that matter here are the NEGATIVE ones. Anything that widens this
 * set hands more reach to a shared secret, and the failure would be silent —
 * a key-holder quietly able to read something they should not, with no error
 * anywhere to notice.
 *
 * Run:  npx tsx tests/adminKeyRouteScope.test.ts
 */

import {
  classifyKeyAccess,
  isSessionAdminAllowed,
} from "../src/mastra/middleware/index";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("adminKeyRouteScope");

console.log("\n=== Admin-key route scope ===\n");

const allowed = (p: string, m = "GET") =>
  classifyKeyAccess(p, m).isKeyAllowedRoute;

await suite.test("the key reaches /api/admin/*", async () => {
  suite.expectEqual(allowed("/api/admin"), true, "bare /api/admin");
  suite.expectEqual(allowed("/api/admin/slack-routing"), true, "sub-path");
  suite.expectEqual(
    allowed("/api/admin/notification-settings", "POST"),
    true,
    "writes too — this is the key's designed home",
  );
});

await suite.test("the key reaches the Inngest webhook", async () => {
  // checkInngestAccess() validates the signing key earlier in the chain;
  // rejecting key-only callers here means the serve handler never runs.
  suite.expectEqual(allowed("/api/inngest", "POST"), true, "exact");
  suite.expectEqual(allowed("/api/inngest/anything", "POST"), true, "sub-path");
});

await suite.test("the key reaches health-pulse READS", async () => {
  suite.expectEqual(allowed("/api/health/pulse"), true, "pulse");
  suite.expectEqual(allowed("/api/health/pulse/latest"), true, "latest");
});

await suite.test("the key CANNOT trigger a pulse run", async () => {
  // The whole point of restricting this to GET. Triggering a run is work, not
  // a read: a credential that can only observe has a materially smaller blast
  // radius than one that can make the platform act.
  suite.expectEqual(
    allowed("/api/health/pulse/run", "POST"),
    false,
    "POST /run is not key-reachable",
  );
  suite.expectEqual(
    allowed("/api/health/pulse", "POST"),
    false,
    "POST to the read path is not key-reachable either",
  );
  suite.expectEqual(
    allowed("/api/health/pulse", "DELETE"),
    false,
    "nor any other verb",
  );
});

await suite.test("the key does NOT become a universal credential", async () => {
  // The assertion this file exists for. Every one of these would be a real
  // escalation: a shared secret reading regulated business data.
  for (const p of [
    "/api/kpis",
    "/api/duplicates/clusters",
    "/api/policies",
    "/api/fraud/incidents",
    "/api/calls",
    "/api/notifications",
    "/api/health",
    "/api/users",
  ]) {
    suite.expectEqual(allowed(p), false, `${p} requires a session`);
  }
});

await suite.test("near-misses on the pulse paths are not allowed", async () => {
  // Exact-match, not prefix. A future /api/health/pulse-export or a route that
  // merely starts with the same characters must not inherit key access.
  suite.expectEqual(allowed("/api/health/pulse-export"), false, "suffix");
  suite.expectEqual(allowed("/api/health/pulses"), false, "plural");
  suite.expectEqual(allowed("/api/health/pulse/history"), false, "other subpath");
  suite.expectEqual(allowed("/api/health/pulse/latest/raw"), false, "deeper");
});

await suite.test("path prefixes cannot be spoofed into admin scope", async () => {
  // /api/admin is matched as a path segment, not a substring — a route like
  // /api/administrators must not fall inside it.
  suite.expectEqual(allowed("/api/administrators"), false, "not a prefix match");
  suite.expectEqual(allowed("/api/adminx/thing"), false, "nor this");
});

await suite.test("the individual flags agree with the verdict", async () => {
  // checkApiAuth branches on these separately, so a flag disagreeing with
  // isKeyAllowedRoute would let a caller past the 401 and then fall through to
  // RBAC with no session — a confusing 403 instead of a clean allow.
  const pulse = classifyKeyAccess("/api/health/pulse", "GET");
  suite.expectEqual(pulse.isHealthPulseRead, true, "flag set");
  suite.expectEqual(pulse.isAdminRoute, false, "not an admin route");
  suite.expectEqual(pulse.isInngestRoute, false, "not inngest");

  const admin = classifyKeyAccess("/api/admin/slack-routing", "GET");
  suite.expectEqual(admin.isAdminRoute, true, "admin flag");
  suite.expectEqual(admin.isHealthPulseRead, false, "not pulse");
});

await suite.test("a signed-in session reaches /api/admin/* only as an active admin", async () => {
  suite.expectEqual(
    isSessionAdminAllowed({ status: "active", role: "admin" }),
    true,
    "active admin",
  );
  suite.expectEqual(isSessionAdminAllowed(null), false, "no platform_users row");
  suite.expectEqual(
    isSessionAdminAllowed({ status: "disabled", role: "admin" }),
    false,
    "disabled admin",
  );
  suite.expectEqual(
    isSessionAdminAllowed({ status: "pending", role: "admin" }),
    false,
    "pending admin",
  );
  for (const role of ["quality_manager", "grc_manager", "viewer", "Admin", ""]) {
    suite.expectEqual(
      isSessionAdminAllowed({ status: "active", role }),
      false,
      `role "${role}" is not admin`,
    );
  }
});

suite.finishOrExit();
