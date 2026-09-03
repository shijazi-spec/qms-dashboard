import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fetchCalendarEvents, getCalendarList, CalendarEvent } from "../../utils/googleCalendar";

export const fetchCalendarEventsTool = createTool({
  id: "fetch-calendar-events",

  description:
    "Fetches calendar events from Google Calendar for a specified date range. Use this to audit meeting activities and validate CRM logging.",

  inputSchema: z.object({
    startDate: z.string().describe("Start date in ISO format (YYYY-MM-DD)"),
    endDate: z.string().describe("End date in ISO format (YYYY-MM-DD)"),
    calendarId: z.string().optional().describe("Calendar ID to fetch from (defaults to primary)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    events: z.array(z.object({
      id: z.string(),
      summary: z.string(),
      description: z.string().optional(),
      start: z.string(),
      end: z.string(),
      attendees: z.array(z.string()),
      status: z.string(),
      organizer: z.string().optional(),
      location: z.string().optional(),
      meetingLink: z.string().optional(),
    })),
    totalEvents: z.number(),
    dateRange: z.object({
      start: z.string(),
      end: z.string(),
    }),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📅 [fetchCalendarEventsTool] Starting calendar events fetch...", {
      startDate: context.startDate,
      endDate: context.endDate,
      calendarId: context.calendarId || "primary",
    });

    try {
      const startDate = new Date(context.startDate);
      const endDate = new Date(context.endDate);
      endDate.setHours(23, 59, 59, 999);

      logger?.info("📅 [fetchCalendarEventsTool] Fetching events from Google Calendar API...");

      const events = await fetchCalendarEvents(startDate, endDate, context.calendarId);

      logger?.info(`✅ [fetchCalendarEventsTool] Successfully fetched ${events.length} events`);

      return {
        success: true,
        events,
        totalEvents: events.length,
        dateRange: {
          start: context.startDate,
          end: context.endDate,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [fetchCalendarEventsTool] Failed to fetch calendar events", { error: errorMessage });

      return {
        success: false,
        events: [],
        totalEvents: 0,
        dateRange: {
          start: context.startDate,
          end: context.endDate,
        },
        error: errorMessage,
      };
    }
  },
});

export const listCalendarsTool = createTool({
  id: "list-calendars",

  description:
    "Lists all available calendars from the connected Google Calendar account.",

  inputSchema: z.object({}),

  outputSchema: z.object({
    success: z.boolean(),
    calendars: z.array(z.object({
      id: z.string(),
      summary: z.string(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [listCalendarsTool] Fetching calendar list...");

    try {
      const calendars = await getCalendarList();
      logger?.info(`✅ [listCalendarsTool] Found ${calendars.length} calendars`);

      return {
        success: true,
        calendars,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [listCalendarsTool] Failed to fetch calendars", { error: errorMessage });

      return {
        success: false,
        calendars: [],
        error: errorMessage,
      };
    }
  },
});
