import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getSessionFromCookie } from "./authRoutes";
import {
  isAdminKeyConfigured,
  isAdminAuthorized,
  hasValidAdminApiKey,
} from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";

function renderSetupRequiredPage(title: string, panelDescription: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-50 min-h-screen flex items-center justify-center"><div class="bg-white p-8 rounded-xl shadow-lg max-w-md text-center"><h1 class="text-xl font-bold text-gray-900 mb-2">${title}</h1><p class="text-gray-600 mb-4">${panelDescription}</p><a href="/" class="text-blue-600 hover:underline">Return to Dashboard</a></div></body></html>`;
}

/**
 * Role-aware page-shell gate (Task #461, extended in Task #471). Used for the dashboard pages whose
 * backing `/api/*` routes enforce a specific role allowlist via
 * `ROUTE_PERMISSION_MAP` in `src/utils/rbacMiddleware.ts`.
 *
 * Access semantics (admit when ANY of):
 *   - the caller carries a valid `ADMIN_API_KEY` (header or `admin_key`
 *     cookie) — service / automation path; or
 *   - the caller carries a signed session cookie whose payload role is in
 *     `allowedRoles` — normal browser navigation.
 *
 * Otherwise the "Setup Required" placeholder page is returned (200) so the
 * page shell — which would otherwise leak admin chrome before the per-API
 * 403s land — is never rendered for an unauthorised caller.
 *
 * Why session.role is consulted directly (and not `getVerifiedRole`):
 * this gate intentionally mirrors the cookie-only check used by
 * `isAdminAuthorized` for `/admin`, `/users`, and `/qms`. The actual
 * authorisation boundary remains the per-API `enforceRoutePermission`
 * pass, which DOES re-verify the role against `platform_users` /
 * `users` and ignores any role smuggled in via a (still HMAC-signed)
 * cookie. This keeps the page gate cheap and DB-free while preserving
 * the API layer as the source of truth.
 */
function serveDashboardPageWithRoleGate(
  filename: string,
  allowedRoles: readonly UserRole[],
  pageTitle: string,
  panelDescription: string,
) {
  return async (c: any) => {
    try {
      if (!hasValidAdminApiKey(c)) {
        const session = getSessionFromCookie(c.req.header('Cookie'));
        if (!session || !allowedRoles.includes(session.role as UserRole)) {
          return c.html(renderSetupRequiredPage(pageTitle, panelDescription));
        }
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-route allowed-role sets (Task #461). Each entry mirrors the GET
// allowlist used by the route's backing `/api/*` rule in
// `src/utils/rbacMiddleware.ts`'s `ROUTE_PERMISSION_MAP`. When a backing
// API permits any authenticated session (e.g. /api/sandbox/, /api/feedback,
// /api/manual-audit-intake, /api/external-audits GET), we mirror that with
// `ANY_DASHBOARD_ROLES` — the same 11-role allowlist those rules enumerate.
// `'custom'` is intentionally excluded (no `ROUTE_PERMISSION_MAP` rule
// admits it, since custom roles derive permissions dynamically and cannot
// be statically validated by a page gate).
// ─────────────────────────────────────────────────────────────────────────────

const ANY_DASHBOARD_ROLES: readonly UserRole[] = [
  'admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager',
  'auditor', 'quality_specialist', 'team_lead', 'bu_owner', 'ai_specialist',
  'executive', 'department_viewer',
];

// Governance + senior leadership read set used for cross-module governance
// dashboards (audits, compliance, risks, management reviews, executive
// reports, GRC, infographic, CRM). Mirrors the 5-role read allowlist on
// `/api/audits GET`, `/api/compliance GET`, `/api/risks GET`,
// `/api/management-reviews GET`, `/api/crm/data GET`,
// `/api/executive/reports GET`, `/api/infographic GET`.
const GOVERNANCE_AND_EXECUTIVE: readonly UserRole[] = [
  'admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'executive',
];

// Governance write set (no executive, no read-only). Mirrors
// `/api/vendors GET` (GRC owns vendor data; PII / contract values).
const VENDORS_READ_ROLES: readonly UserRole[] = [
  'admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager',
];

// Policies read set. Mirrors `/api/policies GET` — broader than other
// QMS reads because policy text is widely consumed.
const POLICIES_READ_ROLES: readonly UserRole[] = [
  'admin', 'grc_manager', 'quality_manager', 'head_of_operations_quality',
  'bu_owner', 'executive', 'quality_specialist', 'auditor', 'team_lead',
  'ai_specialist',
];

// AI Approvals (HITL queue) read set. Mirrors `/api/ai/approvals GET`.
const AI_APPROVALS_ROLES: readonly UserRole[] = [
  'admin', 'quality_manager', 'grc_manager', 'head_of_operations_quality',
  'ai_specialist', 'bu_owner', 'executive', 'quality_specialist', 'auditor',
  'team_lead',
];

// TableF (department COPC scorecard) read set. Mirrors
// `/api/tablef/ GET` — adds bu_owner who reads their own department.
const TABLEF_READ_ROLES: readonly UserRole[] = [
  'admin', 'head_of_operations_quality', 'quality_manager', 'grc_manager',
  'executive', 'bu_owner',
];

// Consultant (AI alerts/feedback) read set. Mirrors
// `/api/consultant/alerts GET` and `/api/consultant/feedback POST`.
const CONSULTANT_ROLES: readonly UserRole[] = [
  'admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality',
];

// Admin-only set. Mirrors `/api/pdpl/ *` (admin-only by `requireAdminOrKey`)
// and `/api/logs GET` / `/api/event-logs GET` (admin-only audit trail).
const ADMIN_ONLY: readonly UserRole[] = ['admin'];

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
  // ──────────────────────────────────────────────────────────────────────
  // Task #461 — every dashboard route below uses `serveDashboardPageWithRoleGate`
  // with an explicit allowlist that mirrors the GET role rule on its
  // backing `/api/*` endpoint in `ROUTE_PERMISSION_MAP`. Previously these
  // routes admitted ANY signed session (and even no session, when
  // ADMIN_API_KEY was configured), allowing a non-admin browser to render
  // admin-style chrome before each backing API call 403'd. The new gate
  // refuses the page shell up-front so the role check is consistent
  // top-to-bottom.
  // ──────────────────────────────────────────────────────────────────────
  // /sandbox → /api/sandbox/ — any authenticated session.
  { path: "/sandbox", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("sandbox.html", ANY_DASHBOARD_ROLES, "Setup Required", `To access this dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /crm → /api/crm/data GET — governance + executive.
  { path: "/crm", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("crm.html", GOVERNANCE_AND_EXECUTIVE, "CRM Setup Required", `To access the CRM dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /audits → /api/audits GET — governance + executive.
  { path: "/audits", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("audits.html", GOVERNANCE_AND_EXECUTIVE, "Audits Setup Required", `To access the Audits dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /compliance → /api/compliance GET — governance + executive.
  { path: "/compliance", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("compliance.html", GOVERNANCE_AND_EXECUTIVE, "Compliance Setup Required", `To access the Compliance dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /policies → /api/policies GET — broad QMS read set.
  { path: "/policies", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("policies.html", POLICIES_READ_ROLES, "Policies Setup Required", `To access the Policies dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /reviews → /api/management-reviews GET — governance + executive.
  { path: "/reviews", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("reviews.html", GOVERNANCE_AND_EXECUTIVE, "Reviews Setup Required", `To access the Management Reviews dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /risks → /api/risks GET — governance + executive.
  { path: "/risks", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("risks.html", GOVERNANCE_AND_EXECUTIVE, "Risks Setup Required", `To access the Risk Register, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /grc → cross-module GRC dashboard (audits, compliance, risks, etc.).
  { path: "/grc", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("grc.html", GOVERNANCE_AND_EXECUTIVE, "GRC Setup Required", `To access the GRC dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /pdpl → /api/pdpl/* — admin only (privacy inventory, incident history).
  { path: "/pdpl", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("pdpl.html", ADMIN_ONLY, "PDPL Setup Required", `To access the PDPL dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /feedback → /api/feedback — any authenticated session.
  { path: "/feedback", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("feedback.html", ANY_DASHBOARD_ROLES, "Feedback Setup Required", `To access the Feedback dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /guide → platform user guide; readable by any authenticated dashboard
  // session (mirrors `ANY_DASHBOARD_ROLES`). Documents internal workflows
  // so unauthenticated visitors must not browse it, but every signed-in
  // role — including read-only ones — can consult the guide for the
  // features their own role can use.
  { path: "/guide", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("guide.html", ANY_DASHBOARD_ROLES, "Guide Setup Required", `To access the platform user guide, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /migration → /api/migration (GET + writes) — admin only. The page is
  // a functional data-import tool with file uploads and deduplication;
  // its backing API is admin-gated in `ROUTE_PERMISSION_MAP`, so the
  // page shell mirrors that allowlist.
  { path: "/migration", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("migration.html", ADMIN_ONLY, "Migration Setup Required", `To access the Data Migration Engine, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /logs → /api/logs GET, /api/event-logs GET — admin only.
  { path: "/logs", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("logs.html", ADMIN_ONLY, "Logs Setup Required", `To access the Audit Logs, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /ai-approvals → /api/ai/approvals GET — broad HITL participant set.
  { path: "/ai-approvals", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("ai-approvals.html", AI_APPROVALS_ROLES, "AI Approvals Setup Required", `To access the AI Approvals dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /intake → /api/manual-audit-intake GET — any authenticated session.
  { path: "/intake", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("intake.html", ANY_DASHBOARD_ROLES, "Intake Setup Required", `To access the Intake dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /external-audits → /api/external-audits GET — any authenticated session.
  { path: "/external-audits", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("external-audits.html", ANY_DASHBOARD_ROLES, "External Audits Setup Required", `To access the External Audits dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /vendors → /api/vendors GET — governance roles only (PII / contracts).
  { path: "/vendors", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("vendors.html", VENDORS_READ_ROLES, "Vendors Setup Required", `To access the Vendors dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /tablef → /api/tablef/ GET — governance + executive + bu_owner.
  { path: "/tablef", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("tablef.html", TABLEF_READ_ROLES, "Setup Required", `To access this dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /infographic → /api/infographic GET — governance + executive.
  { path: "/infographic", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("infographic.html", GOVERNANCE_AND_EXECUTIVE, "Infographic Setup Required", `To access the Infographic dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /executive.html → /api/executive/reports GET, /api/executive/mbr-data GET.
  { path: "/executive.html", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("executive.html", GOVERNANCE_AND_EXECUTIVE, "Setup Required", `To access this dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /grc.html → same dashboard shell as /grc.
  { path: "/grc.html", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("grc.html", GOVERNANCE_AND_EXECUTIVE, "GRC Setup Required", `To access the GRC dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
  // /consultant.html → /api/consultant/* — AI insiders only.
  { path: "/consultant.html", method: "GET", createHandler: async () => serveDashboardPageWithRoleGate("consultant.html", CONSULTANT_ROLES, "Setup Required", `To access this dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret or sign in.`) },
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

// Exported for tests so the role-gate test file can verify each route's
// allowlist matches the matrix below without having to re-derive it from
// `ROUTE_PERMISSION_MAP`. Not part of the public runtime surface.
export const ROLE_GATED_DASHBOARD_ROUTES: ReadonlyArray<{
  path: string;
  allowedRoles: readonly UserRole[];
}> = [
  { path: "/sandbox",         allowedRoles: ANY_DASHBOARD_ROLES },
  { path: "/crm",             allowedRoles: GOVERNANCE_AND_EXECUTIVE },
  { path: "/audits",          allowedRoles: GOVERNANCE_AND_EXECUTIVE },
  { path: "/compliance",      allowedRoles: GOVERNANCE_AND_EXECUTIVE },
  { path: "/policies",        allowedRoles: POLICIES_READ_ROLES },
  { path: "/reviews",         allowedRoles: GOVERNANCE_AND_EXECUTIVE },
  { path: "/risks",           allowedRoles: GOVERNANCE_AND_EXECUTIVE },
  { path: "/grc",             allowedRoles: GOVERNANCE_AND_EXECUTIVE },
  { path: "/pdpl",            allowedRoles: ADMIN_ONLY },
  { path: "/feedback",        allowedRoles: ANY_DASHBOARD_ROLES },
  { path: "/guide",           allowedRoles: ANY_DASHBOARD_ROLES },
  { path: "/migration",       allowedRoles: ADMIN_ONLY },
  { path: "/logs",            allowedRoles: ADMIN_ONLY },
  { path: "/ai-approvals",    allowedRoles: AI_APPROVALS_ROLES },
  { path: "/intake",          allowedRoles: ANY_DASHBOARD_ROLES },
  { path: "/external-audits", allowedRoles: ANY_DASHBOARD_ROLES },
  { path: "/vendors",         allowedRoles: VENDORS_READ_ROLES },
  { path: "/tablef",          allowedRoles: TABLEF_READ_ROLES },
  { path: "/infographic",     allowedRoles: GOVERNANCE_AND_EXECUTIVE },
  { path: "/executive.html",  allowedRoles: GOVERNANCE_AND_EXECUTIVE },
  { path: "/grc.html",        allowedRoles: GOVERNANCE_AND_EXECUTIVE },
  { path: "/consultant.html", allowedRoles: CONSULTANT_ROLES },
];
