import { readFileSync, existsSync } from "fs";
import { join } from "path";

function resolveFile(relPaths: string[]): string | null {
  for (const p of relPaths) if (existsSync(p)) return p;
  return null;
}

function serveStaticText(filename: string, contentType: string) {
  return async (c: any) => {
    try {
      const candidates = [
        join(process.cwd(), "dashboard", filename),
        join(process.cwd(), "..", "dashboard", filename),
        `/home/runner/workspace/dashboard/${filename}`,
      ];
      const filePath = resolveFile(candidates);
      if (!filePath) return c.text(`/* ${filename} not found */`, 404, { "Content-Type": contentType });
      const content = readFileSync(filePath, "utf-8");
      return c.text(content, 200, { "Content-Type": contentType });
    } catch (error) {
      console.error(`Error serving ${filename}:`, error);
      return c.text(`/* Error loading ${filename} */`, 500, { "Content-Type": contentType });
    }
  };
}

export const staticAssetRoutes = [
  {
    path: "/dashboard/tailwind.css",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const candidates = [
            join(process.cwd(), "dashboard", "tailwind.css"),
            join(process.cwd(), "..", "dashboard", "tailwind.css"),
            "/home/runner/workspace/dashboard/tailwind.css",
          ];
          const filePath = resolveFile(candidates);
          if (!filePath) return c.text("/* tailwind.css not found */", 404, { "Content-Type": "text/css" });
          const css = readFileSync(filePath, "utf-8");
          c.header("Content-Type", "text/css; charset=utf-8");
          c.header("Cache-Control", "public, max-age=3600");
          return c.body(css);
        } catch (error) {
          console.error("Error serving tailwind.css:", error);
          return c.text("/* Error loading tailwind.css */", 500, { "Content-Type": "text/css" });
        }
      };
    },
  },
  {
    path: "/css/navigation.css",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const candidates = [
            join(process.cwd(), "dashboard", "css", "navigation.css"),
            join(process.cwd(), "..", "dashboard", "css", "navigation.css"),
            "/home/runner/workspace/dashboard/css/navigation.css",
          ];
          const filePath = resolveFile(candidates);
          if (!filePath) return c.text("/* navigation.css not found */", 404, { "Content-Type": "text/css" });
          return c.text(readFileSync(filePath, "utf-8"), 200, { "Content-Type": "text/css" });
        } catch (error) {
          console.error("Error serving navigation.css:", error);
          return c.text("/* Error loading navigation.css */", 500, { "Content-Type": "text/css" });
        }
      };
    },
  },
  {
    path: "/js/navigation.js",
    method: "GET" as const,
    createHandler: async () => serveStaticText("js/navigation.js", "application/javascript"),
  },
  {
    path: "/js/safe-actions.js",
    method: "GET" as const,
    createHandler: async () => serveStaticText("js/safe-actions.js", "application/javascript"),
  },
  {
    path: "/js/ai-consultant-widget.js",
    method: "GET" as const,
    createHandler: async () => serveStaticText("js/ai-consultant-widget.js", "application/javascript"),
  },
  {
    path: "/css/utilities.css",
    method: "GET" as const,
    createHandler: async () => serveStaticText("css/utilities.css", "text/css"),
  },
  {
    path: "/js/csp-styles.js",
    method: "GET" as const,
    createHandler: async () => serveStaticText("js/csp-styles.js", "application/javascript"),
  },
  {
    path: "/js/streaming-download.js",
    method: "GET" as const,
    createHandler: async () => serveStaticText("js/streaming-download.js", "application/javascript"),
  },
  {
    path: "/js/i18n.js",
    method: "GET" as const,
    createHandler: async () => serveStaticText("js/i18n.js", "application/javascript; charset=utf-8"),
  },
  {
    path: "/js/a11y.js",
    method: "GET" as const,
    createHandler: async () => serveStaticText("js/a11y.js", "application/javascript; charset=utf-8"),
  },
  {
    path: "/js/safe-render.js",
    method: "GET" as const,
    createHandler: async () => serveStaticText("js/safe-render.js", "application/javascript; charset=utf-8"),
  },
  {
    path: "/dashboard/i18n/:lang",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const raw = c.req.param('lang') || '';
          if (!/^[a-zA-Z0-9_-]+\.json$/.test(raw)) {
            return c.text('Invalid locale', 400);
          }
          const candidates = [
            join(process.cwd(), "dashboard", "i18n", raw),
            join(process.cwd(), "..", "dashboard", "i18n", raw),
            `/home/runner/workspace/dashboard/i18n/${raw}`,
          ];
          const filePath = resolveFile(candidates);
          if (!filePath) return c.text('Locale not found', 404);
          return c.body(readFileSync(filePath, 'utf-8'), 200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          });
        } catch (error) {
          console.error('Error serving locale json:', error);
          return c.text('Error loading locale', 500);
        }
      };
    },
  },
];
