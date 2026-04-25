import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getSessionFromCookie } from "./authRoutes";
import { hasValidAdminApiKey } from "../../utils/rbacMiddleware";

import { logger } from "../../utils/logger";
// Defense-in-depth gate for SOP routes. The middleware's PUBLIC_PATHS list
// (see src/mastra/middleware/index.ts) no longer allowlists `/sop` or
// `/api/sop*` because the SOP document is classified "Internal Use Only"
// (see docs/WalaPlus_Platform_SOP.md document control). We still enforce a
// session-or-admin-key check here so a future stale entry in PUBLIC_PATHS
// (the same class of bug audited in task #447) cannot silently re-expose the
// SOP to the public internet.
function isAuthorizedForSop(c: any): boolean {
  if (hasValidAdminApiKey(c)) return true;
  return !!getSessionFromCookie(c.req.header("Cookie"));
}

function resolveSopFile(): string | null {
  const candidates = [
    join(process.cwd(), "docs", "WalaPlus_Platform_SOP.md"),
    join(process.cwd(), "..", "docs", "WalaPlus_Platform_SOP.md"),
    "/home/runner/workspace/docs/WalaPlus_Platform_SOP.md",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function resolveDashboardFile(filename: string): string | null {
  const candidates = [
    join(process.cwd(), "dashboard", filename),
    join(process.cwd(), "..", "dashboard", filename),
    `/home/runner/workspace/dashboard/${filename}`,
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export const sopRoutes = [
  {
    path: "/sop",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAuthorizedForSop(c)) return c.redirect("/login");
          const filePath = resolveDashboardFile("sop.html");
          if (filePath) return c.html(readFileSync(filePath, "utf-8"));
          return c.text("SOP page not found", 404);
        } catch (error) {
          logger.error("Error serving SOP page:", error);
          return c.text("Error loading SOP", 500);
        }
      };
    },
  },
  {
    path: "/api/sop",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAuthorizedForSop(c))
            return c.json({ error: "Authentication required" }, 401);
          const filePath = resolveSopFile();
          if (!filePath)
            return c.json({ error: "SOP document not found" }, 404);
          const content = readFileSync(filePath, "utf-8");
          const versionMatch = content.match(/\*\*Version:\*\*\s*(.+)/);
          const dateMatch = content.match(/\*\*Last Updated:\*\*\s*(.+)/);
          return c.json({
            content,
            version: versionMatch ? versionMatch[1].trim() : "Unknown",
            lastUpdated: dateMatch ? dateMatch[1].trim() : "Unknown",
          });
        } catch (error) {
          logger.error("Error serving SOP API:", error);
          return c.json({ error: "Failed to load SOP" }, 500);
        }
      };
    },
  },
  {
    path: "/api/sop/download",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAuthorizedForSop(c))
            return c.json({ error: "Authentication required" }, 401);
          const filePath = resolveSopFile();
          if (!filePath) return c.text("SOP document not found", 404);
          const content = readFileSync(filePath, "utf-8");
          c.header("Content-Type", "text/markdown; charset=utf-8");
          c.header(
            "Content-Disposition",
            `attachment; filename="WalaPlus_Platform_SOP.md"`,
          );
          return c.body(content);
        } catch (error) {
          logger.error("Error downloading SOP:", error);
          return c.text("Error downloading SOP", 500);
        }
      };
    },
  },
];
