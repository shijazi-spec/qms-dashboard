import { readFileSync, existsSync } from "fs";
import { join } from "path";

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
          const filePath = resolveDashboardFile("sop.html");
          if (filePath) return c.html(readFileSync(filePath, "utf-8"));
          return c.text("SOP page not found", 404);
        } catch (error) {
          console.error("Error serving SOP page:", error);
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
          const filePath = resolveSopFile();
          if (!filePath) return c.json({ error: "SOP document not found" }, 404);
          const content = readFileSync(filePath, "utf-8");
          const versionMatch = content.match(/\*\*Version:\*\*\s*(.+)/);
          const dateMatch = content.match(/\*\*Last Updated:\*\*\s*(.+)/);
          return c.json({
            content,
            version: versionMatch ? versionMatch[1].trim() : "Unknown",
            lastUpdated: dateMatch ? dateMatch[1].trim() : "Unknown",
          });
        } catch (error) {
          console.error("Error serving SOP API:", error);
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
          const filePath = resolveSopFile();
          if (!filePath) return c.text("SOP document not found", 404);
          const content = readFileSync(filePath, "utf-8");
          c.header("Content-Type", "text/markdown; charset=utf-8");
          c.header("Content-Disposition", `attachment; filename="WalaPlus_Platform_SOP.md"`);
          return c.body(content);
        } catch (error) {
          console.error("Error downloading SOP:", error);
          return c.text("Error downloading SOP", 500);
        }
      };
    },
  },
];
