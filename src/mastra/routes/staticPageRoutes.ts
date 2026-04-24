import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getSessionFromCookie } from "./authRoutes";
import { isAdminKeyConfigured, isAdminAuthorized } from "../../utils/rbacMiddleware";

const STATIC_MIME: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
};

function resolveDashboardFile(relPath: string): string | null {
  const candidates = [
    join(process.cwd(), "dashboard", relPath),
    join(process.cwd(), "..", "dashboard", relPath),
    join(process.cwd(), "..", "..", "dashboard", relPath),
    `/home/runner/workspace/dashboard/${relPath}`,
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function serveDashboardPage(filename: string) {
  return async (c: any) => {
    try {
      const filePath = resolveDashboardFile(filename);
      if (filePath) return c.html(readFileSync(filePath, "utf-8"));
      return c.text(`${filename} not found`, 404);
    } catch (error) {
      console.error(`Error serving ${filename}:`, error);
      return c.text(`Error loading ${filename}`, 500);
    }
  };
}

export const staticPageRoutes = [
  {
    path: "/login",
    method: "GET",
    createHandler: async () => serveDashboardPage("login.html"),
  },
  {
    path: "/",
    method: "GET",
    createHandler: async () => serveDashboardPage("index.html"),
  },
  {
    path: "/dashboard",
    method: "GET",
    createHandler: async () => serveDashboardPage("index.html"),
  },
  {
    path: "/dashboard/:name",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const rawName = c.req.param('name') || '';
          if (!/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$/.test(rawName)) {
            return c.text("Invalid dashboard name", 400);
          }
          const dotIdx = rawName.lastIndexOf('.');
          const ext = dotIdx > 0 ? rawName.slice(dotIdx + 1).toLowerCase() : '';

          if (!ext || ext === 'html') {
            const baseName = rawName.replace(/\.html$/i, '');
            const htmlPath = resolveDashboardFile(`${baseName}.html`);
            if (htmlPath) return c.html(readFileSync(htmlPath, "utf-8"));
            return c.text(`Dashboard "${baseName}" not found`, 404);
          }

          const assetPath = resolveDashboardFile(rawName);
          if (!assetPath) return c.text(`Asset "${rawName}" not found`, 404);
          const mime = STATIC_MIME[ext] || 'application/octet-stream';
          const isText = mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript') || mime.includes('svg');
          const body = isText ? readFileSync(assetPath, 'utf-8') : readFileSync(assetPath);
          return c.body(body as any, 200, {
            'Content-Type': mime,
            'Cache-Control': 'public, max-age=3600',
          });
        } catch (error) {
          console.error("Error serving dashboard subpage:", error);
          return c.text("Error loading dashboard", 500);
        }
      };
    },
  },
  {
    // Access semantics: serve the admin dashboard shell when EITHER the
    // caller has a valid admin API key (cookie/header — for service and
    // automation use) OR the caller has a Replit-OIDC session whose role
    // is 'admin' (for normal browser navigation, which cannot send custom
    // headers). The backing `/api/admin/*` routes perform their own
    // per-route RBAC via `requireAdminOrKey` / `enforceRoutePermission`,
    // which is the actual authorization boundary for admin data.
    path: "/admin",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c)) {
            return c.html(`<!DOCTYPE html><html><head><title>Admin Setup Required</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-50 min-h-screen flex items-center justify-center"><div class="bg-white p-8 rounded-xl shadow-lg max-w-md text-center"><h1 class="text-xl font-bold text-gray-900 mb-2">Admin Setup Required</h1><p class="text-gray-600 mb-4">To access the admin panel, sign in with an admin account or set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret in your environment.</p><a href="/" class="text-blue-600 hover:underline">Return to Dashboard</a></div></body></html>`);
          }
          const filePath = resolveDashboardFile("admin.html");
          if (filePath) return c.html(readFileSync(filePath, "utf-8"));
          return c.text("Admin panel not found", 404);
        } catch (error) {
          console.error("Error serving admin panel:", error);
          return c.text("Error loading admin panel", 500);
        }
      };
    },
  },
  {
    // Access semantics: same OR-style gate as `/admin` for consistency —
    // the page shell is served when EITHER the caller has a valid admin
    // API key (cookie/header) OR a session with role='admin'. The
    // underlying `/api/users`, `/api/invitations`, and `/api/rbac` routes
    // perform their own per-role RBAC via `enforceRoutePermission`, which
    // is the actual authorization boundary for user-management data.
    path: "/users",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c)) {
            return c.html(`<!DOCTYPE html><html><head><title>Admin Setup Required</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-50 min-h-screen flex items-center justify-center"><div class="bg-white p-8 rounded-xl shadow-lg max-w-md text-center"><h1 class="text-xl font-bold text-gray-900 mb-2">Admin Setup Required</h1><p class="text-gray-600 mb-4">To access the Users &amp; Access panel, sign in with an admin account or set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret.</p><a href="/" class="text-blue-600 hover:underline">Return to Dashboard</a></div></body></html>`);
          }
          const filePath = resolveDashboardFile("users.html");
          if (filePath) return c.html(readFileSync(filePath, "utf-8"));
          return c.text("Users panel not found", 404);
        } catch (error) {
          console.error("Error serving users panel:", error);
          return c.text("Error loading users panel", 500);
        }
      };
    },
  },
  {
    path: "/accept-invite",
    method: "GET",
    createHandler: async () => serveDashboardPage("accept-invite.html"),
  },
  {
    // Access semantics: this is a *platform-configured* gate, not a true
    // admin-role gate. The page is shown when the deployment has an
    // ADMIN_API_KEY configured OR the caller has any valid session — the
    // QMS-backing API routes (audits, policies, compliance, risks, etc.)
    // perform their own per-role RBAC via `enforceRoutePermission`, which
    // is the actual authorization boundary for QMS data.
    path: "/qms",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const session = getSessionFromCookie(c.req.header('Cookie'));
          if (!isAdminKeyConfigured() && !session) {
            return c.html(`<!DOCTYPE html><html><head><title>QMS Setup Required</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-50 min-h-screen flex items-center justify-center"><div class="bg-white p-8 rounded-xl shadow-lg max-w-md text-center"><h1 class="text-xl font-bold text-gray-900 mb-2">QMS Setup Required</h1><p class="text-gray-600 mb-4">To access the QMS dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret.</p><a href="/" class="text-blue-600 hover:underline">Return to Dashboard</a></div></body></html>`);
          }
          const filePath = resolveDashboardFile("qms.html");
          if (filePath) return c.html(readFileSync(filePath, "utf-8"));
          return c.text("QMS Dashboard not found", 404);
        } catch (error) {
          console.error("Error serving QMS dashboard:", error);
          return c.text("Error loading QMS dashboard", 500);
        }
      };
    },
  },
  { path: "/sandbox", method: "GET", createHandler: async () => serveDashboardPage("sandbox.html") },
  { path: "/crm", method: "GET", createHandler: async () => serveDashboardPage("crm.html") },
  { path: "/audits", method: "GET", createHandler: async () => serveDashboardPage("audits.html") },
  { path: "/compliance", method: "GET", createHandler: async () => serveDashboardPage("compliance.html") },
  { path: "/policies", method: "GET", createHandler: async () => serveDashboardPage("policies.html") },
  { path: "/reviews", method: "GET", createHandler: async () => serveDashboardPage("reviews.html") },
  { path: "/risks", method: "GET", createHandler: async () => serveDashboardPage("risks.html") },
  { path: "/grc", method: "GET", createHandler: async () => serveDashboardPage("grc.html") },
  { path: "/pdpl", method: "GET", createHandler: async () => serveDashboardPage("pdpl.html") },
  { path: "/feedback", method: "GET", createHandler: async () => serveDashboardPage("feedback.html") },
  { path: "/guide", method: "GET", createHandler: async () => serveDashboardPage("guide.html") },
  { path: "/migration", method: "GET", createHandler: async () => serveDashboardPage("migration.html") },
  { path: "/logs", method: "GET", createHandler: async () => serveDashboardPage("logs.html") },
  { path: "/ai-approvals", method: "GET", createHandler: async () => serveDashboardPage("ai-approvals.html") },
  { path: "/intake", method: "GET", createHandler: async () => serveDashboardPage("intake.html") },
  { path: "/external-audits", method: "GET", createHandler: async () => serveDashboardPage("external-audits.html") },
  { path: "/vendors", method: "GET", createHandler: async () => serveDashboardPage("vendors.html") },
  { path: "/tablef", method: "GET", createHandler: async () => serveDashboardPage("tablef.html") },
  { path: "/infographic", method: "GET", createHandler: async () => serveDashboardPage("infographic.html") },
  { path: "/executive.html", method: "GET", createHandler: async () => serveDashboardPage("executive.html") },
  { path: "/grc.html", method: "GET", createHandler: async () => serveDashboardPage("grc.html") },
  { path: "/consultant.html", method: "GET", createHandler: async () => serveDashboardPage("consultant.html") },
  { path: "/login.html", method: "GET", createHandler: async () => serveDashboardPage("login.html") },
  {
    path: "/docs/SCOPE_OF_WORK.html",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "docs", "SCOPE_OF_WORK.html"),
            join(process.cwd(), "..", "docs", "SCOPE_OF_WORK.html"),
            "/home/runner/workspace/docs/SCOPE_OF_WORK.html",
          ];
          for (const docPath of possiblePaths) {
            if (existsSync(docPath)) return c.html(readFileSync(docPath, "utf-8"));
          }
          return c.text("Documentation not found", 404);
        } catch (error) {
          console.error("Error serving documentation:", error);
          return c.text("Error loading documentation", 500);
        }
      };
    },
  },
];
