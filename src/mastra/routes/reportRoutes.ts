export const reportRoutes = [
  {
    path: "/api/reports/capa-effectiveness",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { generateCapaEffectivenessReport } = await import("../../utils/reportGenerator");
          const html = await generateCapaEffectivenessReport();
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } catch (error) {
          return c.json({ error: "Failed to generate report" }, 500);
        }
      };
    },
  },
  {
    path: "/api/reports/compliance-posture",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { generateCompliancePostureReport } = await import("../../utils/reportGenerator");
          const html = await generateCompliancePostureReport();
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } catch (error) {
          return c.json({ error: "Failed to generate report" }, 500);
        }
      };
    },
  },
  {
    path: "/api/reports/pdpl-inventory",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey } = await import("../../utils/rbacMiddleware");
          const user = await requireAdminOrKey(c);
          if (!user) return c.json({ error: "Admin access required" }, 403);
          const { generatePDPLInventoryReport } = await import("../../utils/reportGenerator");
          const html = await generatePDPLInventoryReport();
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } catch (error) {
          return c.json({ error: "Failed to generate report" }, 500);
        }
      };
    },
  },
];
