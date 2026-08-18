import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

import { logger } from "../../utils/logger";
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
      if (!filePath)
        return c.text(`/* ${filename} not found */`, 404, {
          "Content-Type": contentType,
        });
      const content = readFileSync(filePath, "utf-8");
      // Content-hash ETag + revalidation. These externalised assets are large
      // (duplicates-app.js is ~700KB) and were previously served with no
      // validators, so browsers heuristically cached them and kept serving a
      // stale copy across deploys. With a strong ETag and `no-cache`, the
      // browser revalidates on every load: a tiny 304 when unchanged, and the
      // fresh file the instant the content changes.
      const etag = `"${createHash("sha1").update(content).digest("hex")}"`;
      if (c.req.header("if-none-match") === etag) {
        c.header("ETag", etag);
        c.header("Cache-Control", "no-cache");
        return c.body(null, 304);
      }
      return c.text(content, 200, {
        "Content-Type": contentType,
        ETag: etag,
        "Cache-Control": "no-cache",
      });
    } catch (error) {
      logger.error(`Error serving ${filename}:`, error);
      return c.text(`/* Error loading ${filename} */`, 500, {
        "Content-Type": contentType,
      });
    }
  };
}

export const staticAssetRoutes = [
  {
    path: "/css/navigation.css",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("css/navigation.css", "text/css; charset=utf-8"),
  },
  {
    // Compiled Tailwind stylesheet — built with the Tailwind CLI and shipped
    // as a static file. Served at the legacy /dashboard/tailwind.css path
    // that existing page <link> tags reference (changing it would require
    // updating every dashboard/*.html file). Cache-Control matches the
    // other CSS assets: 1 hour in production with revalidation.
    path: "/dashboard/tailwind.css",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("tailwind.css", "text/css; charset=utf-8"),
  },
  {
    // Semantic-token theme (shadcn-style HSL blocks + hand-written utilities).
    // See dashboard/css/theme.css for the token definitions and why the
    // utilities are hand-written (no build:css script → the shipped
    // tailwind.css can't be regenerated with the new config yet).
    path: "/css/theme.css",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("css/theme.css", "text/css; charset=utf-8"),
  },
  // Favicon — green-shield SVG matching the login-page badge in the
  // WalaPlus brand emerald. Serves both /favicon.svg (modern browsers,
  // referenced from each page head) and /favicon.ico (safety net for
  // browsers that probe the legacy path before reading the head tags).
  {
    path: "/favicon.svg",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("favicon.svg", "image/svg+xml"),
  },
  {
    path: "/favicon.ico",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("favicon.svg", "image/svg+xml"),
  },
  {
    path: "/js/navigation.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("js/navigation.js", "application/javascript"),
  },
  {
    path: "/js/safe-actions.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("js/safe-actions.js", "application/javascript"),
  },
  {
    // Duplicate Radar app script — extracted from duplicates.html so the
    // ~700KB of JS is downloaded once and served from browser cache on every
    // subsequent load / tab navigation (the page was 916KB; now ~197KB).
    path: "/js/duplicates-app.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText(
        "js/duplicates-app.js",
        "application/javascript; charset=utf-8",
      ),
  },
  {
    path: "/js/table-sort.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("js/table-sort.js", "application/javascript"),
  },
  {
    path: "/js/ai-consultant-widget.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("js/ai-consultant-widget.js", "application/javascript"),
  },
  {
    // Quality Reports hub script (dashboard/js/quality-reports.js). Dashboard
    // JS is served via EXPLICIT per-file routes here (there is no generic /js/*
    // static handler), so a new page's script must be registered or it 404s and
    // never loads — which left the Quality Reports hub stuck on "Loading…".
    path: "/js/quality-reports.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("js/quality-reports.js", "application/javascript"),
  },
  {
    path: "/css/utilities.css",
    method: "GET" as const,
    createHandler: async () => serveStaticText("css/utilities.css", "text/css"),
  },
  {
    path: "/css/a11y.css",
    method: "GET" as const,
    createHandler: async () => serveStaticText("css/a11y.css", "text/css"),
  },
  {
    path: "/js/csp-styles.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("js/csp-styles.js", "application/javascript"),
  },
  {
    path: "/js/streaming-download.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("js/streaming-download.js", "application/javascript"),
  },
  {
    path: "/js/i18n.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("js/i18n.js", "application/javascript; charset=utf-8"),
  },
  {
    path: "/js/a11y.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText("js/a11y.js", "application/javascript; charset=utf-8"),
  },
  {
    path: "/js/safe-render.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText(
        "js/safe-render.js",
        "application/javascript; charset=utf-8",
      ),
  },
  {
    // Chart.js color palette + helpers used by dashboard/index.html and
    // dashboard/consultant.html. Without an explicit route here, the
    // deployment's SPA fallback serves dashboard HTML for /js/chart-theme.js,
    // the browser rejects it as the wrong MIME type, downstream chart code
    // ReferenceErrors on `ChartTheme.*`, and the dashboard render aborts
    // before painting — surfaces as a misleading "No audit data yet" screen.
    path: "/js/chart-theme.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText(
        "js/chart-theme.js",
        "application/javascript; charset=utf-8",
      ),
  },
  {
    path: "/js/alert-resolution.js",
    method: "GET" as const,
    createHandler: async () =>
      serveStaticText(
        "js/alert-resolution.js",
        "application/javascript; charset=utf-8",
      ),
  },
  {
    path: "/dashboard/i18n/:lang",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const raw = c.req.param("lang") || "";
          if (!/^[a-zA-Z0-9_-]+\.json$/.test(raw)) {
            return c.text("Invalid locale", 400);
          }
          const candidates = [
            join(process.cwd(), "dashboard", "i18n", raw),
            join(process.cwd(), "..", "dashboard", "i18n", raw),
            `/home/runner/workspace/dashboard/i18n/${raw}`,
          ];
          const filePath = resolveFile(candidates);
          if (!filePath) return c.text("Locale not found", 404);
          return c.body(readFileSync(filePath, "utf-8"), 200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          });
        } catch (error) {
          logger.error("Error serving locale json:", error);
          return c.text("Error loading locale", 500);
        }
      };
    },
  },
  {
    // Served from origin root so its default scope ('/') covers the
    // `/_stream-download/<id>` trigger URLs the client navigates to.
    // Adds Service-Worker-Allowed defensively in case anyone moves the file
    // into a subdirectory later.
    path: "/streaming-download-sw.js",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const candidates = [
            join(process.cwd(), "dashboard", "streaming-download-sw.js"),
            join(process.cwd(), "..", "dashboard", "streaming-download-sw.js"),
            "/home/runner/workspace/dashboard/streaming-download-sw.js",
          ];
          const filePath = resolveFile(candidates);
          if (!filePath) {
            return c.text("/* streaming-download-sw.js not found */", 404, {
              "Content-Type": "application/javascript",
            });
          }
          const content = readFileSync(filePath, "utf-8");
          c.header("Content-Type", "application/javascript; charset=utf-8");
          c.header("Service-Worker-Allowed", "/");
          // Service workers should never be aggressively cached — browsers
          // already revalidate on every navigation, but this keeps proxies
          // honest too.
          c.header("Cache-Control", "no-cache, max-age=0, must-revalidate");
          return c.body(content);
        } catch (error) {
          logger.error("Error serving streaming-download-sw.js:", error);
          return c.text("/* Error loading streaming-download-sw.js */", 500, {
            "Content-Type": "application/javascript",
          });
        }
      };
    },
  },
];
