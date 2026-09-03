/**
 * Leadership KPI Feed route
 * =========================
 * GET /api/kpis/leadership-feed
 *
 * Read-only JSON feed PULLED by the ExampleOrg Leadership Platform (separate
 * Replit app) to auto-refresh the "Current" value of its GRQ KPIs. See
 * src/utils/leadershipKpiFeed.ts for the calculators and the omit-on-empty
 * safety contract.
 *
 * AUTH: this endpoint is in PUBLIC_PATHS (it must be reachable without a
 * platform session, since the caller is another server), so it does its OWN
 * auth via a shared secret in the `X-Feed-Key` header, compared in constant
 * time against process.env.LEADERSHIP_FEED_KEY. Set the same value in both
 * Replit apps' Secrets. If the key is unset/too short the feed returns 503
 * (fail closed — never serve KPI data unauthenticated).
 */

import { timingSafeEqual } from "crypto";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

import { logger as safeLogger } from "../../utils/logger";
import { buildLeadershipKpiFeed } from "../../utils/leadershipKpiFeed";

const PREVIEW_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
  "auditor",
  "team_lead",
  "ai_specialist",
  "viewer",
] as const;

const MIN_KEY_LENGTH = 16;

function keysMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const leadershipFeedRoutes = [
  {
    path: "/api/kpis/leadership-feed",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const expected = process.env.LEADERSHIP_FEED_KEY;
        if (!expected || expected.length < MIN_KEY_LENGTH) {
          safeLogger.warn(
            "[LeadershipFeed] LEADERSHIP_FEED_KEY unset or too short — feed disabled",
          );
          return c.json(
            { error: "Leadership feed not configured" },
            503,
          );
        }
        const provided = c.req.header("X-Feed-Key") || "";
        if (!keysMatch(provided, expected)) {
          return c.json({ error: "Invalid or missing X-Feed-Key" }, 401);
        }
        try {
          const feed = await buildLeadershipKpiFeed();
          // No-store: leadership must always pull the freshest computed values.
          c.header("Cache-Control", "no-store");
          return c.json(feed);
        } catch (error) {
          safeLogger.error("[LeadershipFeed] failed to build feed:", error);
          return c.json({ error: "Failed to build leadership feed" }, 500);
        }
      };
    },
  },
  {
    // In-platform preview: same computed feed, but viewable by a logged-in
    // QMS user (session-authed, no feed key) so the results can be seen
    // inside the QMS platform itself — powers /leadership-kpis.
    path: "/api/kpis/leadership-feed/preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...PREVIEW_ROLES]);
          if (!user)
            return forbiddenResponse(c, "Insufficient permissions for KPI data");
          const feed = await buildLeadershipKpiFeed();
          c.header("Cache-Control", "no-store");
          return c.json(feed);
        } catch (error) {
          safeLogger.error("[LeadershipFeed] preview failed:", error);
          return c.json({ error: "Failed to build leadership feed" }, 500);
        }
      };
    },
  },
  {
    // In-platform results page.
    path: "/leadership-kpis",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "leadership-kpis.html"),
            "/home/runner/workspace/dashboard/leadership-kpis.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) return c.html(readFileSync(p, "utf-8"));
          }
          return c.text("Leadership KPIs page not found", 404);
        } catch (error) {
          safeLogger.error("[LeadershipFeed] page serve failed:", error);
          return c.text("Error loading page", 500);
        }
      };
    },
  },
];
