import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getSessionFromCookie } from "./authRoutes";
import { isAdminKeyConfigured, isAdminAuthorized } from "../../utils/rbacMiddleware";

function renderSetupRequiredPage(title: string, panelDescription: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-50 min-h-screen flex items-center justify-center"><div class="bg-white p-8 rounded-xl shadow-lg max-w-md text-center"><h1 class="text-xl font-bold text-gray-900 mb-2">${title}</h1><p class="text-gray-600 mb-4">${panelDescription}</p><a href="/" class="text-blue-600 hover:underline">Return to Dashboard</a></div></body></html>`;
}

function serveDashboardPageWithSetupCheck(filename: string, pageTitle: string, panelDescription: string) {
  return async (c: any) => {
    try {
      const session = getSessionFromCookie(c.req.header('Cookie'));
      if (!isAdminKeyConfigured() && !session) {
        return c.html(renderSetupRequiredPage(pageTitle, panelDescription));
      }
      const filePath = resolveDashboardFile(filename);
      if (filePath) return c.html(readFileSync(filePath, "utf-8"));
      return c.text(`${filename} not found`, 404);
    } catch (error) {
      console.error(`Error serving ${filename}:`, error);
      return c.text(`Error loading ${filename}`, 500);
    }
  };
}

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
            const session = getSessionFromCookie(c.req.header('Cookie'));
            if (!isAdminKeyConfigured() && !session) {
              return c.html(renderSetupRequiredPage("Setup Required", `To access this dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`));
            }
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
            return c.html(renderSetupRequiredPage("Admin Setup Required", `To access the admin panel, sign in with an admin account or set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret in your environment.`));
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
            return c.html(renderSetupRequiredPage("Admin Setup Required", `To access the Users &amp; Access panel, sign in with an admin account or set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret.`));
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
    // Access semantics: same OR-style gate as `/admin` and `/users` for
    // consistency — the page shell is served when EITHER the caller has a
    // valid admin API key (cookie/header) OR a session with role='admin'.
    // Non-admin sessions (e.g. role='user', 'department_viewer') are
    // explicitly blocked; this matches the `isAdminAuthorized` check that
    // every QMS-backing API route in `qmsApiRoutes.ts` performs, so the
    // page shell can never be rendered for a caller whose APIs would all
    // 403 anyway.  The QMS-backing API routes (audits, policies,
    // compliance, risks, etc.) perform their own per-role RBAC via
    // `enforceRoutePermission`, which is the actual authorization
    // boundary for QMS data.
    path: "/qms",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!isAdminAuthorized(c)) {
            return c.html(renderSetupRequiredPage(
              "QMS Setup Required",
              `To access the QMS dashboard, sign in with an admin account or set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret in your environment.`,
            ));
          }
          const filePath = resolveDashboardFile("qms.html");
          if (filePath) return c.html(readFileSync(filePath, "utf-8"));
          return c.text("QMS dashboard not found", 404);
        } catch (error) {
          console.error("Error serving QMS dashboard:", error);
          return c.text("Error loading QMS dashboard", 500);
        }
      };
    },
  },
  { path: "/sandbox", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("sandbox.html", "Setup Required", `To access this dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/crm", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("crm.html", "CRM Setup Required", `To access the CRM dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/audits", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("audits.html", "Audits Setup Required", `To access the Audits dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/compliance", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("compliance.html", "Compliance Setup Required", `To access the Compliance dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/policies", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("policies.html", "Policies Setup Required", `To access the Policies dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/reviews", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("reviews.html", "Reviews Setup Required", `To access the Management Reviews dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/risks", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("risks.html", "Risks Setup Required", `To access the Risk Register, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/grc", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("grc.html", "GRC Setup Required", `To access the GRC dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/pdpl", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("pdpl.html", "PDPL Setup Required", `To access the PDPL dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/feedback", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("feedback.html", "Feedback Setup Required", `To access the Feedback dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // Access semantics: both `/guide` and `/migration` are internal dashboard
  // pages that integrate with the WalaPlusNav chrome and describe / expose
  // admin-only workflows (the user guide documents internal admin features,
  // and the migration page is a functional data-import tool with file
  // uploads and deduplication). They are gated behind the same setup-check
  // as every other dashboard page so that an unauthenticated visitor cannot
  // browse them or learn about internal admin functionality.
  { path: "/guide", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("guide.html", "Guide Setup Required", `To access the platform user guide, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/migration", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("migration.html", "Migration Setup Required", `To access the Data Migration Engine, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/logs", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("logs.html", "Logs Setup Required", `To access the Audit Logs, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/ai-approvals", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("ai-approvals.html", "AI Approvals Setup Required", `To access the AI Approvals dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/intake", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("intake.html", "Intake Setup Required", `To access the Intake dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/external-audits", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("external-audits.html", "External Audits Setup Required", `To access the External Audits dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/vendors", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("vendors.html", "Vendors Setup Required", `To access the Vendors dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/tablef", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("tablef.html", "Setup Required", `To access this dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/infographic", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("infographic.html", "Infographic Setup Required", `To access the Infographic dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/executive.html", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("executive.html", "Setup Required", `To access this dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/grc.html", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("grc.html", "GRC Setup Required", `To access the GRC dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  { path: "/consultant.html", method: "GET", createHandler: async () => serveDashboardPageWithSetupCheck("consultant.html", "Setup Required", `To access this dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
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
