import { logger as safeLogger } from "../../utils/logger"; /**
 * Sandbox API routes — return mock or live CRM/calendar/calls data for the
 * in-app sandbox dashboards. Every route requires an authenticated session
 * (or the X-Admin-Key header) so the data is never reachable from public
 * traffic. The handler-level gate also makes the auth boundary visible to
 * integration tests that bypass the global middleware.
 */

async function requireSandboxAuth(c: any): Promise<{ ok: boolean; res?: any }> {
  const { requireAuthOrKey, unauthorizedResponse } =
    await import("../../utils/rbacMiddleware");
  const user = requireAuthOrKey(c);
  if (!user) return { ok: false, res: unauthorizedResponse(c) };
  return { ok: true };
}

export const sandboxApiRoutes = [
  {
    path: "/api/sandbox/mode",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const { getDataMode } = await import("../../data");
          const mode = getDataMode();
          return c.json({
            mode,
            description:
              mode === "MOCK"
                ? "Using mock data for testing"
                : "Using live CRM data",
          });
        } catch (error) {
          safeLogger.error("Error getting data mode:", error);
          return c.json({ error: "Failed to get data mode" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/stats",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const {
            getLeads,
            getDeals,
            getActivities,
            getCalendarEvents,
            getFive9Calls,
            getDataMode,
          } = await import("../../data");
          const mode = getDataMode();
          const [leads, deals, activities, calendarEvents, calls] =
            await Promise.all([
              getLeads(),
              getDeals(),
              getActivities(),
              getCalendarEvents(),
              getFive9Calls(),
            ]);
          const stats = {
            mode,
            leads: leads.length,
            deals: deals.length,
            activities: activities.length,
            calendarEvents: calendarEvents.length,
            calls: calls.length,
            totalRecords:
              leads.length +
              deals.length +
              activities.length +
              calendarEvents.length +
              calls.length,
          };
          return c.json(stats);
        } catch (error) {
          safeLogger.error("Error getting mock data stats:", error);
          return c.json({ error: "Failed to get mock data stats" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/leads",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const { getLeads } = await import("../../data");
          const leads = await getLeads();
          return c.json({ leads, count: leads.length });
        } catch (error) {
          safeLogger.error("Error fetching leads:", error);
          return c.json({ error: "Failed to fetch leads" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/deals",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const { getDeals } = await import("../../data");
          const deals = await getDeals();
          return c.json({ deals, count: deals.length });
        } catch (error) {
          safeLogger.error("Error fetching deals:", error);
          return c.json({ error: "Failed to fetch deals" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/activities",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const { getActivities } = await import("../../data");
          const activities = await getActivities();
          return c.json({ activities, count: activities.length });
        } catch (error) {
          safeLogger.error("Error fetching activities:", error);
          return c.json({ error: "Failed to fetch activities" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/users",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const { getUsers } = await import("../../data");
          const users = await getUsers();
          return c.json({ users, count: users.length });
        } catch (error) {
          safeLogger.error("Error fetching users:", error);
          return c.json({ error: "Failed to fetch users" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/calendar",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const { getCalendarEvents } = await import("../../data");
          const events = await getCalendarEvents();
          return c.json({ events, count: events.length });
        } catch (error) {
          safeLogger.error("Error fetching calendar events:", error);
          return c.json({ error: "Failed to fetch calendar events" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/calls",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const { getFive9Calls } = await import("../../data");
          const calls = await getFive9Calls();
          return c.json({ calls, count: calls.length });
        } catch (error) {
          safeLogger.error("Error fetching calls:", error);
          return c.json({ error: "Failed to fetch calls" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/leads",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const body = await c.req.json();
          const { addLead } = await import("../../data");
          const lead = await addLead(body);
          return c.json({ success: true, lead });
        } catch (error) {
          safeLogger.error("Error adding lead:", error);
          return c.json({ error: "Failed to add lead" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/deals",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const body = await c.req.json();
          const { addDeal } = await import("../../data");
          const deal = await addDeal(body);
          return c.json({ success: true, deal });
        } catch (error) {
          safeLogger.error("Error adding deal:", error);
          return c.json({ error: "Failed to add deal" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sandbox/audit",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireSandboxAuth(c);
          if (!auth.ok) return auth.res;
          const logger = mastra?.getLogger();
          const {
            getLeads,
            getDeals,
            getActivities,
            getCalendarEvents,
            getFive9Calls,
            getDataMode,
          } = await import("../../data");
          const mode = getDataMode();
          const leads = await getLeads();
          const deals = await getDeals();
          const activities = await getActivities();
          const calendarEvents = await getCalendarEvents();
          const calls = await getFive9Calls();
          const leadIssues: any[] = [];
          leads.forEach((lead: any) => {
            if (!lead.Email)
              leadIssues.push({
                id: lead.id,
                issue: "Missing email",
                field: "Email",
                severity: "high",
              });
            else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.Email))
              leadIssues.push({
                id: lead.id,
                issue: "Invalid email format",
                field: "Email",
                severity: "medium",
              });
            if (!lead.Lead_Source)
              leadIssues.push({
                id: lead.id,
                issue: "Missing lead source",
                field: "Lead_Source",
                severity: "medium",
              });
            if (!lead.Lead_Status)
              leadIssues.push({
                id: lead.id,
                issue: "Missing lead status",
                field: "Lead_Status",
                severity: "high",
              });
            if (!lead.Owner)
              leadIssues.push({
                id: lead.id,
                issue: "Missing owner",
                field: "Owner",
                severity: "high",
              });
            if (lead.Phone && !/^[+]?[\d\s\-()]+$/.test(lead.Phone))
              leadIssues.push({
                id: lead.id,
                issue: "Invalid phone format",
                field: "Phone",
                severity: "low",
              });
          });
          const dealIssues: any[] = [];
          deals.forEach((deal: any) => {
            if (!deal.Deal_Name)
              dealIssues.push({
                id: deal.id,
                issue: "Missing deal name",
                field: "Deal_Name",
                severity: "critical",
              });
            if (!deal.Stage)
              dealIssues.push({
                id: deal.id,
                issue: "Missing stage",
                field: "Stage",
                severity: "critical",
              });
            if (!deal.Amount)
              dealIssues.push({
                id: deal.id,
                issue: "Missing amount",
                field: "Amount",
                severity: "high",
              });
            if (!deal.Closing_Date)
              dealIssues.push({
                id: deal.id,
                issue: "Missing closing date",
                field: "Closing_Date",
                severity: "high",
              });
            if (!deal.Owner)
              dealIssues.push({
                id: deal.id,
                issue: "Missing owner",
                field: "Owner",
                severity: "high",
              });
          });
          const activityIssues: any[] = [];
          activities.forEach((activity: any) => {
            if (!activity.Subject)
              activityIssues.push({
                id: activity.id,
                issue: "Missing subject",
                field: "Subject",
                severity: "high",
              });
            if (!activity.Due_Date)
              activityIssues.push({
                id: activity.id,
                issue: "Missing due date",
                field: "Due_Date",
                severity: "medium",
              });
            if (!activity.Owner)
              activityIssues.push({
                id: activity.id,
                issue: "Missing owner",
                field: "Owner",
                severity: "high",
              });
          });
          const calendarIssues: any[] = [];
          calendarEvents.forEach((event: any) => {
            if (
              !event.related_crm_record &&
              event.attendees.some((a: string) => !a.includes("@<REDACTED_HOST>"))
            )
              calendarIssues.push({
                id: event.id,
                issue: "External meeting not logged in CRM",
                field: "related_crm_record",
                severity: "medium",
              });
          });
          const callIssues: any[] = [];
          calls.forEach((call: any) => {
            if (!call.related_crm_record && call.duration_seconds > 60)
              callIssues.push({
                id: call.id,
                issue: "Call not linked to CRM record",
                field: "related_crm_record",
                severity: "medium",
              });
            if (!call.agent_id)
              callIssues.push({
                id: call.id,
                issue: "Missing agent information",
                field: "agent_id",
                severity: "high",
              });
          });
          const allIssues = [
            ...leadIssues,
            ...dealIssues,
            ...activityIssues,
            ...calendarIssues,
            ...callIssues,
          ];
          const totalIssues = allIssues.length;
          const totalRecords =
            leads.length +
            deals.length +
            activities.length +
            calendarEvents.length +
            calls.length;
          const criticalCount = allIssues.filter(
            (i: any) => i.severity === "critical",
          ).length;
          const highCount = allIssues.filter(
            (i: any) => i.severity === "high",
          ).length;
          const mediumCount = allIssues.filter(
            (i: any) => i.severity === "medium",
          ).length;
          const lowCount = allIssues.filter(
            (i: any) => i.severity === "low",
          ).length;
          const peopleScore = Math.max(
            0,
            100 - highCount * 3 - mediumCount * 1.5,
          );
          const processScore = Math.max(
            0,
            100 - criticalCount * 5 - highCount * 2,
          );
          const governanceScore = Math.max(0, 100 - totalIssues * 1.2);
          const overallScore = Math.round(
            peopleScore * 0.25 + processScore * 0.35 + governanceScore * 0.4,
          );
          return c.json({
            mode,
            timestamp: new Date().toISOString(),
            summary: {
              totalRecords,
              totalIssues,
              criticalCount,
              highCount,
              mediumCount,
              lowCount,
            },
            scores: {
              overall: overallScore,
              people: Math.round(peopleScore),
              process: Math.round(processScore),
              governance: Math.round(governanceScore),
            },
            moduleBreakdown: {
              leads: {
                records: leads.length,
                issues: leadIssues.length,
                details: leadIssues.slice(0, 10),
              },
              deals: {
                records: deals.length,
                issues: dealIssues.length,
                details: dealIssues.slice(0, 10),
              },
              activities: {
                records: activities.length,
                issues: activityIssues.length,
                details: activityIssues.slice(0, 10),
              },
              calendar: {
                records: calendarEvents.length,
                issues: calendarIssues.length,
                details: calendarIssues.slice(0, 10),
              },
              calls: {
                records: calls.length,
                issues: callIssues.length,
                details: callIssues.slice(0, 10),
              },
            },
            recommendations: [
              criticalCount > 0
                ? `Fix ${criticalCount} critical issues immediately (missing deal names/stages)`
                : null,
              highCount > 0
                ? `Address ${highCount} high-priority issues (missing owners, emails, amounts)`
                : null,
              leadIssues.length > 5
                ? `SDR Team: Improve lead data quality - ${leadIssues.length} issues found`
                : null,
              dealIssues.length > 5
                ? `Sales Team: Improve deal data quality - ${dealIssues.length} issues found`
                : null,
              calendarIssues.length > 0
                ? `Log all external meetings in CRM for better tracking`
                : null,
            ].filter(Boolean),
          });
        } catch (error) {
          safeLogger.error("Error running sandbox audit:", error);
          return c.json({ error: "Failed to run audit" }, 500);
        }
      };
    },
  },
];
