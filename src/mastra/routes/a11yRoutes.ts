import { join } from "path";
import { readFileSync, existsSync } from "fs";

export const a11yRoutes = [
  {
    path: "/a11y",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "a11y.html"),
            "/home/runner/workspace/dashboard/a11y.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              return c.html(readFileSync(p, "utf-8"));
            }
          }
          return c.text("Accessibility statement not found", 404);
        } catch (error) {
          console.error("Error serving accessibility statement:", error);
          return c.text("Error loading accessibility statement", 500);
        }
      };
    },
  },
];
