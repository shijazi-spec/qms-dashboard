import {
  getSessionUser,
  unauthorizedResponse,
} from "../../utils/rbacMiddleware";
import { logger } from "../../utils/logger";
import { redactSensitiveDeep } from "../../utils/sensitiveRedaction";
import {
  clearRecentDownloads,
  ensureRecentDownloadsTable,
  getRecentDownloads,
  upsertRecentDownloads,
} from "../../utils/recentDownloadsDatabase";

export const exportDownloadRoutes = [
  {
    path: "/api/exports/recent-downloads",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!user.userId) return c.json({ entries: [] });
        try {
          await ensureRecentDownloadsTable();
          const entries = await getRecentDownloads(user.userId);
          return c.json({ entries });
        } catch (error) {
          logger.error("[ExportDownloads] GET error", { err: error });
          return c.json({ entries: [] });
        }
      };
    },
  },
  {
    path: "/api/exports/recent-downloads",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!user.userId) return c.json({ success: true });
        try {
          const body = await c.req.json();
          const entries = Array.isArray(body.entries) ? body.entries : [];
          // Scrub deny-list keys / credential-shaped strings out of the JSONB
          // blob BEFORE persisting. The endpoint stores arbitrary client-side
          // download metadata (filename, URL, agent-supplied notes), and a
          // misbehaving caller could otherwise drop a `password_hash`,
          // `access_token`, JWT or `ghp_…` PAT into a nested field where it
          // would survive verbatim into Postgres.
          const safeEntries = redactSensitiveDeep(entries) as unknown[];
          await ensureRecentDownloadsTable();
          await upsertRecentDownloads(user.userId, safeEntries);
          return c.json({ success: true });
        } catch (error) {
          logger.error("[ExportDownloads] POST error", { err: error });
          return c.json({ error: "Failed to save recent downloads" }, 500);
        }
      };
    },
  },
  {
    path: "/api/exports/recent-downloads",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!user.userId) return c.json({ success: true });
        try {
          await ensureRecentDownloadsTable();
          await clearRecentDownloads(user.userId);
          return c.json({ success: true });
        } catch (error) {
          logger.error("[ExportDownloads] DELETE error", { err: error });
          return c.json({ error: "Failed to clear recent downloads" }, 500);
        }
      };
    },
  },
];
