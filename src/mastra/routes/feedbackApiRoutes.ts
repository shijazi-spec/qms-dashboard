import { logger } from "../../utils/logger";
export const feedbackApiRoutes = [
  {
    path: "/api/feedback",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { submitFeedback } = await import("../../utils/database");
          const body = await c.req.json();
          if (!body.submitter_name || !body.dashboard || !body.rating) {
            return c.json(
              { error: "Name, dashboard, and rating are required" },
              400,
            );
          }
          const feedback = await submitFeedback({
            submitter_name: body.submitter_name,
            submitter_role: body.submitter_role,
            dashboard: body.dashboard,
            rating: body.rating,
            ease_of_use: body.ease_of_use,
            comments: body.comments,
            suggestions: body.suggestions,
          });
          mastra
            ?.getLogger()
            ?.info("📝 [Feedback] New feedback submitted:", feedback);
          return c.json({ success: true, feedback });
        } catch (error) {
          logger.error("Error submitting feedback:", error);
          return c.json({ error: "Failed to submit feedback" }, 500);
        }
      };
    },
  },
  {
    path: "/api/feedback",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getAllFeedback } = await import("../../utils/database");
          const dashboard = c.req.query("dashboard");
          const startDate = c.req.query("startDate");
          const endDate = c.req.query("endDate");
          const feedback = await getAllFeedback({
            dashboard,
            startDate,
            endDate,
          });
          return c.json({ feedback });
        } catch (error) {
          logger.error("Error fetching feedback:", error);
          return c.json(
            { error: "Failed to fetch feedback", feedback: [] },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/feedback/stats",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getFeedbackStats } = await import("../../utils/database");
          const stats = await getFeedbackStats();
          return c.json(stats);
        } catch (error) {
          logger.error("Error fetching feedback stats:", error);
          return c.json({ error: "Failed to fetch feedback stats" }, 500);
        }
      };
    },
  },
];
