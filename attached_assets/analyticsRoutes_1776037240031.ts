export const analyticsRoutes = [
  {
    path: "/api/analytics/cycle-times",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getCycleTimeMetrics } = await import("../../utils/analyticsEngine");
          const dateFrom = c.req.query("from") || undefined;
          const dateTo = c.req.query("to") || undefined;
          const metrics = await getCycleTimeMetrics(dateFrom, dateTo);
          return c.json(metrics);
        } catch (error) {
          return c.json({ error: "Failed to fetch cycle time metrics" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/agent-compliance",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getAgentComplianceReports } = await import("../../utils/analyticsEngine");
          const reports = await getAgentComplianceReports();
          return c.json({ reports });
        } catch (error) {
          return c.json({ error: "Failed to fetch agent compliance reports" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/capa-recurrence",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { detectCAPARecurrence } = await import("../../utils/analyticsEngine");
          const recurrences = await detectCAPARecurrence();
          return c.json({ recurrences, total: recurrences.length });
        } catch (error) {
          return c.json({ error: "Failed to detect CAPA recurrence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/trends",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getTrendData } = await import("../../utils/analyticsEngine");
          const periods = parseInt(c.req.query("periods") || "12");
          const interval = c.req.query("interval") === "week" ? "week" : "month" as const;
          const trends = await getTrendData(periods, interval);
          return c.json({ trends });
        } catch (error) {
          return c.json({ error: "Failed to fetch trend data" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { generateDigestData, buildDigestHTML } = await import("../../utils/executiveDigest");
          const format = c.req.query("format");
          const data = await generateDigestData();
          if (format === "html") {
            const html = buildDigestHTML(data);
            return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
          }
          return c.json(data);
        } catch (error) {
          return c.json({ error: "Failed to generate digest" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/send",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { sendDigestEmail } = await import("../../utils/executiveDigest");
          const result = await sendDigestEmail();
          return c.json(result);
        } catch (error) {
          return c.json({ error: "Failed to send digest" }, 500);
        }
      };
    },
  },
];
