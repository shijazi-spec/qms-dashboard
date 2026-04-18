/**
 * Health Pulse routes
 *   GET  /api/health/pulse           latest run + history (last 50)
 *   GET  /api/health/pulse/latest    latest run only
 *   POST /api/health/pulse/run       manual trigger (admin)
 */

import {
  runHealthPulse,
  maybeNotifyOnPulse,
  initHealthPulseTables,
  getLatestPulseRun,
  getRecentPulseRuns,
} from "../../utils/platformHealthPulse";

function isAuthorized(c: any): boolean {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return true; // dev / not configured
  const headerKey = c.req.header("X-Admin-Key");
  if (headerKey === adminKey) return true;
  const cookie = c.req.header("Cookie") || "";
  const m = cookie.match(/admin_key=([^;]+)/);
  return m?.[1] === adminKey;
}

export const healthPulseRoutes = [
  {
    path: "/api/health/pulse",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      if (!isAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);
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
      if (!isAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);
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
      if (!isAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);
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
