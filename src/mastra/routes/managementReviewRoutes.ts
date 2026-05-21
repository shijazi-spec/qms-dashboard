export const managementReviewRoutes = [
  {
    path: "/api/management-reviews",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const { getReviews } =
            await import("../../utils/managementReviewDatabase");
          const status = c.req.query("status") || undefined;
          const year = c.req.query("year")
            ? parseInt(c.req.query("year"))
            : undefined;
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const result = await getReviews({ status, year, limit, offset });
          return c.json(result);
        } catch (error) {
          return c.json({ error: "Failed to fetch reviews" }, 500);
        }
      };
    },
  },
  {
    path: "/api/management-reviews/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { getReviewById } =
            await import("../../utils/managementReviewDatabase");
          const review = await getReviewById(id);
          if (!review) return c.json({ error: "Not found" }, 404);
          return c.json(review);
        } catch (error) {
          return c.json({ error: "Failed to fetch review" }, 500);
        }
      };
    },
  },
  {
    path: "/api/management-reviews",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const body = await c.req.json();
          const { createReview } =
            await import("../../utils/managementReviewDatabase");
          const review = await createReview(body);
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "CREATE",
              entityType: "DOCUMENT",
              entityId: String(review.id),
              entityName: review.review_number,
              description: `Management Review created: ${review.title}`,
              module: "management_review",
            });
          } catch {}
          return c.json(review, 201);
        } catch (error) {
          return c.json({ error: "Failed to create review" }, 500);
        }
      };
    },
  },
  {
    path: "/api/management-reviews/:id",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json();
          const { updateReview } =
            await import("../../utils/managementReviewDatabase");
          const review = await updateReview(id, body);
          if (!review) return c.json({ error: "Not found" }, 404);
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "UPDATE",
              entityType: "DOCUMENT",
              entityId: String(id),
              entityName: review.review_number,
              description: `Management Review updated: ${review.title}`,
              module: "management_review",
            });
          } catch {}
          return c.json(review);
        } catch (error) {
          return c.json({ error: "Failed to update review" }, 500);
        }
      };
    },
  },
  {
    path: "/api/management-reviews/:id",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { deleteReview } =
            await import("../../utils/managementReviewDatabase");
          const deleted = await deleteReview(id);
          if (!deleted) return c.json({ error: "Not found" }, 404);
          return c.json({ success: true });
        } catch (error) {
          return c.json({ error: "Failed to delete review" }, 500);
        }
      };
    },
  },
  {
    path: "/api/management-reviews/:id/actions",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const reviewId = parseInt(c.req.param("id"));
          if (isNaN(reviewId)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json();
          const { addReviewAction } =
            await import("../../utils/managementReviewDatabase");
          const action = await addReviewAction(reviewId, body);
          return c.json(action, 201);
        } catch (error) {
          return c.json({ error: "Failed to add action" }, 500);
        }
      };
    },
  },
  {
    path: "/api/management-reviews/actions/:actionId",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const actionId = parseInt(c.req.param("actionId"));
          if (isNaN(actionId)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json();
          const { updateReviewAction } =
            await import("../../utils/managementReviewDatabase");
          const action = await updateReviewAction(actionId, body);
          if (!action) return c.json({ error: "Not found" }, 404);
          return c.json(action);
        } catch (error) {
          return c.json({ error: "Failed to update action" }, 500);
        }
      };
    },
  },
  {
    path: "/api/management-reviews/actions/summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const { getReviewActionsSummary } =
            await import("../../utils/managementReviewDatabase");
          const summary = await getReviewActionsSummary();
          return c.json(summary);
        } catch (error) {
          return c.json({ error: "Failed to fetch summary" }, 500);
        }
      };
    },
  },
  {
    path: "/api/management-reviews/:id/gather-inputs",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { gatherReviewInputs, updateReview } =
            await import("../../utils/managementReviewDatabase");
          const inputs = await gatherReviewInputs();
          const review = await updateReview(id, { input_summary: inputs });
          return c.json({ success: true, inputs, review });
        } catch (error) {
          return c.json({ error: "Failed to gather inputs" }, 500);
        }
      };
    },
  },
];
