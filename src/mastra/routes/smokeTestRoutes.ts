export const smokeTestRoutes = [
  {
    path: "/api/health",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        return c.json({
          status: "ok",
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          version: process.env.npm_package_version || "1.0.0",
        });
      };
    },
  },
  {
    path: "/api/smoke",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const checks: Record<string, { status: string; message?: string }> = {};

        try {
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          const result = await pool.query("SELECT 1 AS ok");
          checks.database = { status: result.rows[0]?.ok === 1 ? "pass" : "fail" };
          await pool.end();
        } catch (err: any) {
          console.error("Smoke test DB check failed:", err.message);
          checks.database = { status: "fail" };
        }

        checks.zoho = {
          status: !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN) ? "pass" : "not_configured",
        };

        checks.environment = {
          status: !!process.env.DATABASE_URL ? "pass" : "fail",
        };

        const allPass = Object.values(checks).every((c) => c.status === "pass");

        return c.json({
          status: allPass ? "healthy" : "degraded",
          checks,
          timestamp: new Date().toISOString(),
        });
      };
    },
  },
];
