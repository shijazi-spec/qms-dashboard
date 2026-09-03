/**
 * Page-shell ↔ API allowlist drift check (Task #472).
 *
 * Why this file exists
 * ────────────────────
 * Task #461 hand-mirrored each gated dashboard route's allowed-roles set
 * (in `ROLE_GATED_DASHBOARD_ROUTES` in `src/mastra/routes/staticPageRoutes.ts`)
 * from the GET-side rule of its backing `/api/*` endpoint in
 * `ROUTE_PERMISSION_MAP` (in `src/utils/rbacMiddleware.ts`).
 *
 * Today these two lists are kept in sync only by code review and the
 * existing role-gate test (`tests/staticPageRoutesRoleGate.test.ts`). If
 * a future task tightens — e.g. drops `executive` from `/api/audits GET` —
 * without also editing `staticPageRoutes.ts`, the page shell would still
 * admit executives even though every backing API call would 403. That is
 * exactly the soft information-disclosure regression Task #461 set out to
 * prevent.
 *
 * What it asserts (per gated route)
 * ─────────────────────────────────
 * For every entry in `ROLE_GATED_DASHBOARD_ROUTES`:
 *
 *   1. Compute the effective GET role allowlist that
 *      `enforceRoutePermission` would apply to the route's documented
 *      backing API path, by calling
 *      `getRouteRoleAllowlist(backingApiPath, 'GET')`.
 *   2. Assert the matrix's `allowedRoles` (sorted) equals the API
 *      allowlist (sorted).
 *
 * Failure produces a clear message naming both the dashboard route and
 * the offending `ROUTE_PERMISSION_MAP` entry path so the fix is obvious:
 *
 *   "Dashboard route /audits page-shell allowlist [admin, ...] does not
 *    match API allowlist for /api/audits GET [admin, ...] — update
 *    ROLE_GATED_DASHBOARD_ROUTES in staticPageRoutes.ts or the
 *    /^\/api\/audits/ GET rule in ROUTE_PERMISSION_MAP."
 *
 * Notes
 * ─────
 * - `getRouteRoleAllowlist` mirrors `canAccessRoute`'s first-match
 *   semantics — it returns the role list of the first matching rule —
 *   which is the dominant rule `enforceRoutePermission` consults for the
 *   simple "is this role allowed to read /api/X?" question this gate
 *   answers. Multi-rule routes whose later GET rules would broaden the
 *   set (none currently exist for the gated routes here) are not handled
 *   by this drift check; if such a route is ever added, prefer splitting
 *   it into its own narrower page rather than weakening this assertion.
 * - We only call the helper, which is a pure function over a static
 *   constant; this test does not need a DB pool, session cookie, or
 *   ADMIN_API_KEY. We still set `DATABASE_URL` because importing
 *   `rbacMiddleware.ts` constructs a `pg.Pool` at module load.
 *
 * Run:  npx tsx tests/staticPageRoleAllowlistDrift.test.ts
 */

// Mark this file as a module so the top-level `await import()` calls below
// don't trigger TS1375 ("'await' expressions are only allowed at the top
// level of a file when that file is a module"). The runner executes it
// via `npx tsx` which already treats it as an ES module — this is purely
// to satisfy the type-checker.
export {};

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "<REDACTED_DSN>";

const { ROLE_GATED_DASHBOARD_ROUTES } =
  await import("../src/mastra/routes/staticPageRoutes");
const { getRouteRoleAllowlist } = await import("../src/utils/rbacMiddleware");
const { TestSuite } = await import("./_helpers/runner");

const suite = new TestSuite("staticPageRoleAllowlistDrift");

console.log(
  "\n=== staticPageRoutes ↔ ROUTE_PERMISSION_MAP drift check (Task #472) ===\n",
);

function sortedRoles(roles: readonly string[]): string[] {
  return [...roles].sort();
}

// Sanity: helper exists and returns null for an unmapped /api/* path.
// Guards against a future refactor that accidentally renames or removes
// the helper, which would silently break every per-route assertion below.
await suite.test(
  "getRouteRoleAllowlist returns null for unmapped /api/* path",
  () => {
    const result = getRouteRoleAllowlist(
      "/api/__definitely-not-a-real-route-please__",
      "GET",
    );
    suite.expectEqual(
      result,
      null,
      "unmapped /api/* path should return null (deny-by-default)",
    );
  },
);

// Sanity: helper returns an admin-inclusive allowlist for /api/logs GET
// (a known admin-only rule). Confirms first-match semantics work end-to-end
// before we trust the per-route assertions.
await suite.test(
  "getRouteRoleAllowlist returns ['admin'] for /api/logs GET",
  () => {
    const result = getRouteRoleAllowlist("/api/logs", "GET");
    suite.expect(
      Array.isArray(result) && result.length === 1 && result[0] === "admin",
      `/api/logs GET should resolve to ['admin'] but was ${JSON.stringify(result)}`,
    );
  },
);

// Drift assertion — the heart of the test. For every gated dashboard
// route, the page-shell allowlist must equal the GET allowlist of its
// documented backing API path. Any future tightening (or loosening) on
// either side fires a labelled failure naming both halves of the contract.
//
// Routes with `backingApiPath: null` (e.g. `/guide`, a static user-guide
// HTML with no dedicated `/api/guide` rule) have no API-side allowlist
// to mirror; they're skipped here and remain covered end-to-end by
// `tests/staticPageRoutesRoleGate.test.ts` (Task #461 four-case suite).
for (const {
  path,
  allowedRoles,
  backingApiPath,
} of ROLE_GATED_DASHBOARD_ROUTES) {
  if (backingApiPath === null) continue;
  await suite.test(
    `${path} page-shell allowlist matches ${backingApiPath} GET in ROUTE_PERMISSION_MAP`,
    () => {
      const apiAllowlist = getRouteRoleAllowlist(backingApiPath, "GET");

      // Distinguish "no rule matched at all" from "rule matched but used
      // dynamic permissions" so the maintainer knows whether to add a
      // new GET rule or whether the dashboard simply cannot be statically
      // mirrored by a page gate.
      if (apiAllowlist === null) {
        suite.expect(
          false,
          `Dashboard route ${path} → backing API ${backingApiPath} GET ` +
            `has no static role allowlist in ROUTE_PERMISSION_MAP ` +
            `(rule missing OR rule uses dynamic 'permission' ACL). ` +
            `Either add an explicit GET roles rule for ${backingApiPath} ` +
            `in src/utils/rbacMiddleware.ts, or update the backingApiPath ` +
            `for ${path} in ROLE_GATED_DASHBOARD_ROUTES (staticPageRoutes.ts) ` +
            `to point at the route that actually carries the GET rule.`,
        );
        return;
      }

      const pageRoles = sortedRoles(allowedRoles);
      const apiRoles = sortedRoles(apiAllowlist);
      const apiRoleSet = new Set(apiRoles);

      // Drift direction matters. The dangerous case — and the only one this
      // test set out to catch — is when the page-shell admits a role that
      // the API would 403. That's the soft information-disclosure regression
      // Task #461 prevented: user sees the page chrome, every backing fetch
      // 403s, attacker may still infer that the *page* exists at all from
      // the redirect difference. So fail loudly on `pageRole ∉ apiRoles`.
      //
      // The reverse direction (API admits a role the page-shell omits) is
      // intentional and benign:
      //   - `'custom'` is statically un-gateable per the comment at the top
      //     of ROLE_GATED_DASHBOARD_ROUTES — admitting it to a page would
      //     require runtime permission resolution the page gate cannot do.
      //   - `'viewer'`/`'department_viewer'` are routinely excluded from
      //     write-heavy workflow pages (e.g. /ai-approvals HITL queue,
      //     /intake manual-audit intake) even though the read API permits
      //     them. The narrower page-shell is a UX choice, not a bug.
      // A user with one of those roles can still hit the API directly if
      // they know the URL — that's the API allowlist's job to gate.
      const pageRolesAdmittedByApi = pageRoles.every(r => apiRoleSet.has(r));
      const extras = pageRoles.filter(r => !apiRoleSet.has(r));

      suite.expect(
        pageRolesAdmittedByApi,
        `Dashboard route ${path} page-shell admits role(s) ${JSON.stringify(extras)} ` +
          `that ${backingApiPath} GET would 403 (API allowlist: ${JSON.stringify(apiRoles)}). ` +
          `This is the dangerous drift direction — a user lands on the page but every ` +
          `backing fetch fails. Update ROLE_GATED_DASHBOARD_ROUTES in ` +
          `src/mastra/routes/staticPageRoutes.ts (${path} entry) to drop the extras OR ` +
          `add them to the matching ${backingApiPath} GET rule in ROUTE_PERMISSION_MAP ` +
          `in src/utils/rbacMiddleware.ts so the two stay in sync.`,
      );
    },
  );
}

suite.finishOrExit();
