/**
 * Global vitest setup: shim `src/utils/rbacMiddleware` so route-handler
 * unit tests that authenticate via the `X-Admin-Key` header continue to
 * pass without requiring a live OIDC session cookie or a real Postgres
 * `platform_users` row.
 *
 * Background
 * ----------
 * A recent security hardening removed acceptance of `X-Admin-Key` from the
 * shared role/auth helpers (`getSessionUser`, `requireAuthOrKey`,
 * `requireRoleOrKey`) and from `requireRole`'s platform-user lookup. The
 * production reasoning is sound — a server-to-server key must not silently
 * grant admin-level access to every role-gated browser route. But this also
 * broke ~78 vitest sub-tests under `tests/vitest/*.vitest.test.ts` that
 * exercise route business logic (200 / 400 / 500 branches) using the
 * `X-Admin-Key` header as a hermetic stand-in for an admin session.
 *
 * Strategy
 * --------
 * Re-export the real `rbacMiddleware` module unchanged, EXCEPT for the
 * three helpers that consult `getSessionUser` to resolve an admin caller.
 * In each shimmed helper we first check for a valid `X-Admin-Key`; if it
 * matches `process.env.ADMIN_API_KEY` we synthesise a deterministic
 * admin `SessionUser`. Otherwise we delegate to the real implementation,
 * so cookie-based auth, role checks against unrelated routes, and the
 * 401 / 403 negative-path tests in `staticPageRoutes.vitest.test.ts`
 * continue to behave exactly as production would.
 *
 * Crucially we ALSO short-circuit `requireRole` / `requireRoleOrKey` to
 * skip the live `platform_users` SELECT when the admin key is present,
 * because vitest workers run without a real database and the real
 * implementation would otherwise return null → 403 on every shimmed
 * call. The shim still enforces the per-route `allowedRoles` list
 * against the synthetic admin (which always satisfies admin-allowed
 * routes), so per-route RBAC remains observable in tests.
 *
 * Scope: per-file `vi.mock("../../src/utils/rbacMiddleware", ...)` calls
 * in individual test files OVERRIDE this shim (vitest mock precedence
 * gives the test file the final say), so suites that already maintain
 * their own bespoke rbac mock — `aiApprovalRoutes`, `kpiRoutes`,
 * `mobileRoutes`, `pmpRoutes`, `scorecardRoutes`, `CRMProviderAgingRoutes` —
 * are unaffected.
 */

import { vi } from "vitest";

vi.mock("../../../src/utils/rbacMiddleware", async (orig) => {
  const real = await orig<typeof import("../../../src/utils/rbacMiddleware")>();

  type SessionUser = import("../../../src/utils/rbacMiddleware").SessionUser;

  const TEST_ADMIN_EMAIL = "<REDACTED_EMAIL>";

  const adminFromKey = (c: any): SessionUser | null => {
    const expectedKey = process.env.ADMIN_API_KEY;
    if (!expectedKey) return null;
    const headerKey = c?.req?.header?.("X-Admin-Key");
    if (!headerKey || headerKey !== expectedKey) return null;
    return {
      userId: 0,
      email: TEST_ADMIN_EMAIL,
      name: "Vitest Admin",
      role: "admin",
    };
  };

  return {
    ...real,

    // Cookie-first (real impl), then X-Admin-Key fallback. Production deliberately
    // refuses the X-Admin-Key fallback here; tests need it so that
    // `gateApiRoute()` (which calls `requireAuthOrKey` → `getSessionUser`) admits
    // the same hermetic `X-Admin-Key` caller it used to admit before the security
    // hardening.
    getSessionUser: (c: any) => real.getSessionUser(c) ?? adminFromKey(c),

    requireAuth: (c: any) => real.getSessionUser(c) ?? adminFromKey(c),

    requireAuthOrKey: (c: any) => real.getSessionUser(c) ?? adminFromKey(c),

    // Short-circuit the platform_users DB lookup for the admin-key path so
    // the role check works without a live database. Cookie-authenticated
    // callers (used by a few real-session tests) still go through the real
    // implementation, preserving the platform_user enforcement.
    requireRole: async (c: any, allowedRoles: readonly string[]) => {
      const keyUser = adminFromKey(c);
      if (keyUser) {
        if (allowedRoles && !allowedRoles.includes(keyUser.role)) return null;
        return keyUser;
      }
      return real.requireRole(c, allowedRoles as any);
    },

    requireRoleOrKey: async (c: any, allowedRoles: readonly string[]) => {
      const keyUser = adminFromKey(c);
      if (keyUser) {
        if (allowedRoles && !allowedRoles.includes(keyUser.role)) return null;
        return keyUser;
      }
      return real.requireRoleOrKey(c, allowedRoles as any);
    },

    // Already accepts X-Admin-Key in production, but the cookie-fallback hits
    // `getPlatformUser` (DB) which fails in vitest. Replace with a deterministic
    // implementation that mirrors the production semantics for both paths.
    requireAdminOrKey: async (c: any) => {
      const keyUser = adminFromKey(c);
      if (keyUser) return keyUser;
      return real.requireAdminOrKey(c);
    },

    // No override needed — the real `isAdminAuthorized` already accepts both
    // `hasValidAdminApiKey` and an admin-role cookie session, neither of
    // which require a DB lookup. Left intentionally absent from the spread
    // override so `real.isAdminAuthorized` is re-exported as-is.

    // CRITICAL: re-implement `gateApiRoute` instead of re-exporting the real
    // one. The real `gateApiRoute` is a top-level function in
    // `rbacMiddleware.ts` whose body calls `requireAuthOrKey(c)` and
    // `unauthorizedResponse(c)` as same-module identifiers — not via the
    // exports table. ESM "live bindings" only forward across modules, so
    // overriding `requireAuthOrKey` above has NO effect on the real
    // `gateApiRoute`'s closure. Without this re-implementation, every
    // `dashboardApiRoutes.ts`-style route wrapped by `.map(gateApiRoute)`
    // would still hit the un-shimmed real `requireAuthOrKey`, return null
    // for X-Admin-Key callers, and 401. Re-implementing here lets the gate
    // call our shimmed `adminFromKey` directly.
    gateApiRoute: <
      T extends {
        path: string;
        roles?: string[];
        createHandler: (deps: any) => any | Promise<any>;
      },
    >(route: T): T => {
      if (!route.path.startsWith("/api/")) return route;
      const originalCreate = route.createHandler;
      const allowedRoles = route.roles;
      return {
        ...route,
        createHandler: async (deps: any) => {
          const inner = await originalCreate(deps);
          return async (c: any) => {
            const user = real.getSessionUser(c) ?? adminFromKey(c);
            if (!user) return c.json({ error: "Authentication required" }, 401);
            if (
              allowedRoles &&
              !allowedRoles.includes(user.role)
            ) {
              return c.json({ error: "Insufficient permissions" }, 403);
            }
            return inner(c);
          };
        },
      };
    },
  };
});
