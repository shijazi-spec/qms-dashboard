/**
 * RBAC guard tests for /api/reports/* endpoints.
 *
 * Uses the pure `canAccessRoute` helper (no DB calls, no live server) to assert
 * that ROUTE_PERMISSION_MAP is correctly configured for every GRC report route.
 *
 * Negative path  → department_viewer must receive 403 (canAccessRoute returns false)
 * Positive path  → executive (and other governance roles) must receive 200 (true)
 *
 * Run:  npx tsx tests/rbacReportRoutes.test.ts
 */

import { canAccessRoute } from "../src/utils/rbacMiddleware";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

const REPORT_ROUTES = [
  "/api/reports/capa-effectiveness",
  "/api/reports/compliance-posture",
];

const ALLOWED_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
];

const BLOCKED_ROLES = [
  "department_viewer",
  "quality_specialist",
  "team_lead",
  "auditor",
  "bu_owner",
  "ai_specialist",
];

console.log("\n=== Report Route RBAC — ROUTE_PERMISSION_MAP unit tests ===\n");

for (const route of REPORT_ROUTES) {
  console.log(`Route: GET ${route}`);

  console.log("  [Positive paths — should be ALLOWED]");
  for (const role of ALLOWED_ROLES) {
    assert(
      canAccessRoute(role, route, "GET") === true,
      `role '${role}' is allowed`
    );
  }

  console.log("  [Negative paths — should be BLOCKED]");
  for (const role of BLOCKED_ROLES) {
    assert(
      canAccessRoute(role, route, "GET") === false,
      `role '${role}' is blocked (returns 403)`
    );
  }

  console.log();
}

console.log("--- PDPL inventory (admin-only) ---");
assert(
  canAccessRoute("admin", "/api/reports/pdpl-inventory", "GET") === true,
  "admin can access PDPL inventory"
);
assert(
  canAccessRoute("executive", "/api/reports/pdpl-inventory", "GET") === false,
  "executive is blocked from PDPL inventory"
);
assert(
  canAccessRoute("department_viewer", "/api/reports/pdpl-inventory", "GET") === false,
  "department_viewer is blocked from PDPL inventory"
);

console.log();
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ RBAC report route tests FAILED");
  process.exit(1);
}

console.log("\n✅ All RBAC report route tests passed");
