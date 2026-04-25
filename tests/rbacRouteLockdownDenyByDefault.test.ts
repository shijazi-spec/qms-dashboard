/**
 * RBAC deny-by-default fallback test for task #352.
 *
 * Asserts that any `/api/*` route NOT explicitly listed in
 * `ROUTE_PERMISSION_MAP` is rejected by `canAccessRoute` for every
 * non-admin role.  Admin is excluded because `canAccessRoute` short-circuits
 * to `true` for the admin super-user role at the top of the function.
 *
 * Uses the pure `canAccessRoute` helper (no DB calls, no live server).
 *
 * Run:  npx tsx tests/rbacRouteLockdownDenyByDefault.test.ts
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

const ALL_ROLES = [
  'admin',
  'head_of_operations_quality',
  'quality_manager',
  'quality_specialist',
  'grc_manager',
  'team_lead',
  'department_viewer',
  'auditor',
  'ai_specialist',
  'bu_owner',
  'executive',
  'custom',
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const UNKNOWN_PATHS = [
  '/api/unknown/route',
  '/api/totally/made-up/endpoint',
  '/api/new-feature-without-rbac-rule',
  '/api/lockdown-fallback-check',
];

console.log("\n=== Route Lockdown RBAC — deny-by-default fallback (task #352) ===\n");

console.log("Case: /api/unknown/route returns false for every role × method");
for (const path of UNKNOWN_PATHS) {
  for (const method of METHODS) {
    for (const role of ALL_ROLES) {
      assert(
        canAccessRoute(role, path, method) === false,
        `${method} ${path} role='${role}' is denied`,
      );
    }
  }
}

console.log("\nCase: admin keeps super-user bypass on routes that ARE in the map");
// Sanity check — make sure tightening the admin shortcut to only fire on a
// matching rule didn't regress legitimate admin access.
const KNOWN_ADMIN_PATHS: Array<[string, string]> = [
  ['/api/risks', 'GET'],
  ['/api/policies', 'GET'],
  ['/api/audits', 'GET'],
  ['/api/users/stats', 'GET'],
  ['/api/pdpl/inventory', 'GET'],
  ['/api/handoff/rules', 'GET'],
  ['/api/ai-ops/summary', 'GET'],
];
for (const [p, m] of KNOWN_ADMIN_PATHS) {
  assert(
    canAccessRoute('admin', p, m) === true,
    `${m} ${p} role='admin' is allowed (rule matches)`,
  );
}

console.log("\nCase: non-API paths keep the permissive default (page handlers)");
for (const role of ALL_ROLES) {
  assert(
    canAccessRoute(role, '/projects', 'GET') === true,
    `GET /projects role='${role}' falls through to permissive default`,
  );
  assert(
    canAccessRoute(role, '/onboarding', 'GET') === true,
    `GET /onboarding role='${role}' falls through to permissive default`,
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ Route lockdown deny-by-default RBAC tests FAILED");
  process.exit(1);
}

console.log("\n✅ All deny-by-default RBAC tests passed");
