import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { UserRole } from "../../utils/rbacDatabase";
import { getSessionFromCookie } from "./authRoutes";
import { hasValidAdminApiKey } from "../../utils/rbacMiddleware";

import { logger as safeLogger } from "../../utils/logger";
const ONBOARDING_ADMIN_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
];

async function requireOnboardingAdmin(c: any) {
  const { requireRole, forbiddenResponse } =
    await import("../../utils/rbacMiddleware");
  const user = await requireRole(c, ONBOARDING_ADMIN_ROLES);
  if (!user) return { user: null, response: forbiddenResponse(c) };
  return { user, response: null };
}

export const onboardingRoutes = [
  {
    path: "/onboarding",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const session = getSessionFromCookie(c.req.header("Cookie"));
        if (!session && !hasValidAdminApiKey(c)) {
          return c.redirect("/login");
        }
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "onboarding.html"),
            join(process.cwd(), "..", "dashboard", "onboarding.html"),
            "/home/runner/workspace/dashboard/onboarding.html",
          ];

          for (const onboardingPath of possiblePaths) {
            if (existsSync(onboardingPath)) {
              const html = readFileSync(onboardingPath, "utf-8");
              return c.html(html);
            }
          }

          safeLogger.error(
            "Onboarding dashboard not found in any path:",
            possiblePaths,
          );
          return c.text("Onboarding dashboard not found", 404);
        } catch (error) {
          safeLogger.error("Error serving Onboarding dashboard:", error);
          return c.text("Error loading Onboarding dashboard", 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/status",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📋 [Onboarding API] Fetching user onboarding status");

          const { getSessionUser, getVerifiedRole } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) {
            return c.json({ error: "Authentication required" }, 401);
          }

          const verifiedRole = await getVerifiedRole(
            sessionUser.email,
            sessionUser.role,
          );

          const { initOnboardingTables, getUserOnboardingStatus } =
            await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          let userId: string;
          if (verifiedRole === "admin") {
            userId = c.req.query("userId") || sessionUser.email;
          } else {
            userId = sessionUser.email;
          }

          const status = await getUserOnboardingStatus(userId);

          if (status) {
            logger?.info("✅ [Onboarding API] Status found", { userId });
            return c.json({ status, isNewUser: false });
          } else {
            logger?.info("🆕 [Onboarding API] New user detected", { userId });
            return c.json({ status: null, isNewUser: true });
          }
        } catch (error) {
          safeLogger.error("Error fetching onboarding status:", error);
          return c.json({ error: "Failed to fetch onboarding status" }, 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/status",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();

          const { getSessionUser, getVerifiedRole } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = getSessionUser(c);
          if (!sessionUser) {
            return c.json({ error: "Authentication required" }, 401);
          }

          const verifiedRole = await getVerifiedRole(
            sessionUser.email,
            sessionUser.role,
          );
          if (verifiedRole !== "admin") {
            body.user_id = sessionUser.email;
          }

          logger?.info("📝 [Onboarding API] Updating onboarding status", {
            userId: body.user_id,
          });

          const { initOnboardingTables, createOrUpdateOnboardingStatus } =
            await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          const status = await createOrUpdateOnboardingStatus(body);
          logger?.info("✅ [Onboarding API] Status updated", {
            userId: body.user_id,
          });
          return c.json({ success: true, status });
        } catch (error) {
          safeLogger.error("Error updating onboarding status:", error);
          return c.json({ error: "Failed to update onboarding status" }, 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/stats",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { user: adminUser, response: authError } =
            await requireOnboardingAdmin(c);
          if (authError) return authError;

          logger?.info("📊 [Onboarding API] Fetching onboarding statistics", {
            requestedBy: adminUser?.email,
          });

          const {
            initOnboardingTables,
            getOnboardingStats,
            getAllOnboardingStatuses,
          } = await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          const stats = await getOnboardingStats();
          const allStatuses = await getAllOnboardingStatuses();

          logger?.info("✅ [Onboarding API] Stats fetched");
          return c.json({ stats, users: allStatuses });
        } catch (error) {
          safeLogger.error("Error fetching onboarding stats:", error);
          return c.json({ error: "Failed to fetch stats" }, 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/tour-steps",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireAuthOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!requireAuthOrKey(c)) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const role = c.req.query("role");
          logger?.info("🎯 [Onboarding API] Fetching tour steps", { role });

          const { initOnboardingTables, getTourSteps } =
            await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          const steps = await getTourSteps(role);
          logger?.info("✅ [Onboarding API] Tour steps fetched", {
            count: steps.length,
          });
          return c.json({ steps });
        } catch (error) {
          safeLogger.error("Error fetching tour steps:", error);
          return c.json({ error: "Failed to fetch tour steps" }, 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/tooltips",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireAuthOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!requireAuthOrKey(c)) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const module = c.req.query("module");
          logger?.info("💡 [Onboarding API] Fetching tooltips", { module });

          const { initOnboardingTables, getTooltips } =
            await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          const tooltips = await getTooltips(module);
          logger?.info("✅ [Onboarding API] Tooltips fetched", {
            count: tooltips.length,
          });
          return c.json({ tooltips });
        } catch (error) {
          safeLogger.error("Error fetching tooltips:", error);
          return c.json({ error: "Failed to fetch tooltips" }, 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/tooltip/:fieldId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireAuthOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!requireAuthOrKey(c)) return unauthorizedResponse(c);

          const fieldId = c.req.param("fieldId");
          const logger = mastra?.getLogger();
          logger?.info("💡 [Onboarding API] Fetching tooltip", { fieldId });

          const { initOnboardingTables, getTooltip } =
            await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          const tooltip = await getTooltip(fieldId);
          if (!tooltip) {
            return c.json({ error: "Tooltip not found" }, 404);
          }
          return c.json({ tooltip });
        } catch (error) {
          safeLogger.error("Error fetching tooltip:", error);
          return c.json({ error: "Failed to fetch tooltip" }, 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/demo-link",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { user: adminUser, response: authError } =
            await requireOnboardingAdmin(c);
          if (authError) return authError;

          const body = await c.req.json();
          logger?.info("🔗 [Onboarding API] Creating demo link", {
            requestedBy: adminUser?.email,
          });

          const { initOnboardingTables, createDemoLink } =
            await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          const link = await createDemoLink(body);
          const baseUrl =
            process.env.REPLIT_DOMAINS?.split(",")[0] || "localhost:5000";
          const fullUrl = `https://${baseUrl}/onboarding?demo=${link.link_code}`;

          logger?.info("✅ [Onboarding API] Demo link created", {
            linkCode: link.link_code,
          });
          return c.json({ success: true, link, fullUrl });
        } catch (error) {
          safeLogger.error("Error creating demo link:", error);
          return c.json({ error: "Failed to create demo link" }, 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/demo-link/:linkCode",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const linkCode = c.req.param("linkCode");
          const logger = mastra?.getLogger();
          const { user: adminUser, response: authError } =
            await requireOnboardingAdmin(c);
          if (authError) return authError;

          logger?.info("🔗 [Onboarding API] Validating demo link", {
            linkCode,
            requestedBy: adminUser?.email,
          });

          const { initOnboardingTables, validateDemoLink, getDemoLink } =
            await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          const validation = await validateDemoLink(linkCode);
          if (!validation.valid) {
            return c.json({ valid: false, reason: validation.reason }, 400);
          }

          const link = await getDemoLink(linkCode);
          logger?.info("✅ [Onboarding API] Demo link validated");
          return c.json({ valid: true, link });
        } catch (error) {
          safeLogger.error("Error validating demo link:", error);
          return c.json({ error: "Failed to validate demo link" }, 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/demo-links",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { user: adminUser, response: authError } =
            await requireOnboardingAdmin(c);
          if (authError) return authError;

          logger?.info("🔗 [Onboarding API] Listing demo links", {
            requestedBy: adminUser?.email,
          });

          const { initOnboardingTables, listDemoLinks } =
            await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          const links = await listDemoLinks();
          logger?.info("✅ [Onboarding API] Demo links listed", {
            count: links.length,
          });
          return c.json({ links });
        } catch (error) {
          safeLogger.error("Error listing demo links:", error);
          return c.json({ error: "Failed to list demo links" }, 500);
        }
      };
    },
  },
  {
    path: "/api/onboarding/demo-link/:linkCode/deactivate",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const linkCode = c.req.param("linkCode");
          const logger = mastra?.getLogger();
          const { user: adminUser, response: authError } =
            await requireOnboardingAdmin(c);
          if (authError) return authError;

          logger?.info("🔗 [Onboarding API] Deactivating demo link", {
            linkCode,
            requestedBy: adminUser?.email,
          });

          const { initOnboardingTables, deactivateDemoLink } =
            await import("../../utils/onboardingDatabase");
          await initOnboardingTables();

          await deactivateDemoLink(linkCode);
          logger?.info("✅ [Onboarding API] Demo link deactivated");
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error deactivating demo link:", error);
          return c.json({ error: "Failed to deactivate demo link" }, 500);
        }
      };
    },
  },
];
