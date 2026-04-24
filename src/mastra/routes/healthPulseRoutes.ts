/**
 * Health Pulse routes
 *   GET  /api/health/pulse           latest run + history (last 50)
 *   GET  /api/health/pulse/latest    latest run only
 *   POST /api/health/pulse/run       manual trigger (admin)
 *
 * RBAC: admin-only. Operational diagnostics expose secret presence,
 * dependency health, and check failure metadata that must not be readable
 * by non-admin platform users. The legacy admin-key check is preserved as
 * an additional access path for service-account callers.
 */

import {
  runHealthPulse,
  maybeNotifyOnPulse,
  initHealthPulseTables,
  getLatestPulseRun,
  getRecentPulseRuns,
} from "../../utils/platformHealthPulse";

function hasAdminKey(c: any): boolean {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  const headerKey = c.req.header("X-Admin-Key");
  if (headerKey === adminKey) return true;
  const cookie = c.req.header("Cookie") || "";
  const m = cookie.match(/admin_key=([^;]+)/);
  return m?.[1] === adminKey;
}

/**
 * Defense-in-depth authorization for the health-pulse routes.
 *
 * Allows either:
 *   1. A valid X-Admin-Key (header or admin_key cookie), OR
 *   2. A signed session that resolves to the `admin` platform role.
 *
 * Always enforces admin even when ADMIN_API_KEY is unset — the legacy
 * "open in dev when no key configured" branch was removed because it weakened
 * defense-in-depth: a non-admin session could otherwise access operational
 * diagnostics in any environment that simply forgot to set the key.
 */
async function authorize(c: any): Promise<boolean> {
  if (hasAdminKey(c)) return true;
  const { requireRole } = await import("../../utils/rbacMiddleware");
  const user = await requireRole(c, ['admin']);
  return !!user;
}

export const healthPulseRoutes = [
  {
    path: "/api/health/pulse",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      if (!(await authorize(c))) return c.json({ error: "Unauthorized" }, 403);
      try {
        await initHealthPulseTables();
        const latest = await getLatestPulseRun();
        const history = await getRecentPulseRuns(50);
        return c.json({
          latest,
          history: history.map((h) => ({
            id: h.id,
            run_at: h.run_at,
            overall_status: h.overall_status,
            pass_count: h.pass_count,
            warn_count: h.warn_count,
            fail_count: h.fail_count,
            skipped_count: h.skipped_count,
            duration_ms: h.duration_ms,
          })),
        });
      } catch (err: any) {
        return c.json({ error: err?.message || String(err) }, 500);
      }
    },
  },
  {
    path: "/api/health/pulse/latest",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      if (!(await authorize(c))) return c.json({ error: "Unauthorized" }, 403);
      try {
        await initHealthPulseTables();
        const latest = await getLatestPulseRun();
        if (!latest) {
          return c.json({ status: "never_run", message: "Health pulse has not run yet" }, 200);
        }
        return c.json(latest);
      } catch (err: any) {
        return c.json({ error: err?.message || String(err) }, 500);
      }
    },
  },
  {
    path: "/api/health/pulse/run",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      if (!(await authorize(c))) return c.json({ error: "Unauthorized" }, 403);
      try {
        await initHealthPulseTables();
        const run = await runHealthPulse();
        if (run.overall_status !== "healthy") {
          await maybeNotifyOnPulse(run);
        }
        return c.json(run);
      } catch (err: any) {
        return c.json({ error: err?.message || String(err) }, 500);
      }
    },
  },
];
