/**
 * Pipeline Aging routes (Task #825)
 * =================================
 *
 * Surfaces the Lead Status / Deal Stage aging metrics computed by
 * `src/utils/CRMProviderAging.ts`:
 *
 *   GET /pipeline-aging                       dashboard page (role-gated)
 *   GET /api/CRMProvider/leads/:id/status-aging      single-record helper
 *   GET /api/CRMProvider/deals/:id/stage-aging       single-record helper
 *   GET /api/CRMProvider/leads/aging                 paginated list (sorted desc)
 *   GET /api/CRMProvider/deals/aging                 paginated list (sorted desc)
 *
 * The list endpoints page CRMProvider themselves — the caller never has to supply
 * record ids — and accept `limit` (default 50, max 200), `cursor` (CRMProvider
 * page number), `minDays`, and `include_terminal`. Items in each page are
 * returned sorted by `agingDays` descending so the most-stalled records
 * surface first.
 *
 * RBAC mirrors the Duplicate Radar read set; the page route also enforces
 * the same allowlist via cookie/admin-key check.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  hasValidAdminApiKey,
  requireRoleOrKey,
  unauthorizedResponse,
} from "../../utils/rbacMiddleware";
import { getSessionFromCookie } from "./authRoutes";
import { logger } from "../../utils/logger";

import {
  defaultAgingFetchers,
  getDealAgingThreshold,
  getDealStageAging,
  getLeadAgingThreshold,
  getLeadStatusAging,
  getTerminalDealStages,
  getTerminalLeadStatuses,
  listDealsAging,
  listLeadsAging,
  type AgingFetchers,
} from "../../utils/CRMProviderAging";

const PIPELINE_AGING_READ_ROLES = [
  "admin",
  "grc_manager",
  "ai_specialist",
  "head_of_operations_quality",
  "quality_manager",
  "bu_owner",
  "executive",
] as const;

async function requirePipelineAgingAccess(c: any) {
  return requireRoleOrKey(c, [...PIPELINE_AGING_READ_ROLES]);
}

function resolveDashboardFile(relPath: string): string | null {
  const candidates = [
    join(process.cwd(), "dashboard", relPath),
    join(process.cwd(), "..", "dashboard", relPath),
    `/home/runner/workspace/dashboard/${relPath}`,
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function renderSetupRequiredPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title><link rel="stylesheet" href="/dashboard/tailwind.css"></head><body class="bg-gray-50 min-h-screen flex items-center justify-center"><div class="bg-white p-8 rounded-xl shadow-lg max-w-md text-center"><h1 class="text-xl font-bold text-gray-900 mb-2">${title}</h1><p class="text-gray-600 mb-4">${body}</p><a href="/" class="text-blue-600 hover:underline">Return to Dashboard</a></div></body></html>`;
}

/**
 * Allow tests / future automation to swap the CRMProvider fetchers without going
 * through the live CRMProvider client. Defaults to the production fetchers in
 * `src/utils/CRMProviderAging.ts`.
 */
let injectedFetchers: AgingFetchers | null = null;
export function _setAgingFetchersForTests(fetchers: AgingFetchers | null): void {
  injectedFetchers = fetchers;
}
function fetchers(): AgingFetchers {
  return injectedFetchers ?? defaultAgingFetchers;
}

function parseListOpts(url: URL) {
  return {
    limit: parseInt(url.searchParams.get("limit") || "50", 10),
    cursor: url.searchParams.get("cursor") || undefined,
    minDays: parseInt(url.searchParams.get("minDays") || "0", 10),
    includeTerminal: url.searchParams.get("include_terminal") === "true",
  };
}

export const CRMProviderAgingRoutes = [
  // ── Page (cookie/admin-key gated) ──────────────────────────────────────────
  {
    path: "/pipeline-aging",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          if (!hasValidAdminApiKey(c)) {
            const session = getSessionFromCookie(c.req.header("Cookie"));
            if (
              !session ||
              !PIPELINE_AGING_READ_ROLES.includes(session.role as any)
            ) {
              return c.html(
                renderSetupRequiredPage(
                  "Pipeline Aging — Access Required",
                  `Sign in with a sales-ops role (admin / GRC / quality / executive / BU owner) or set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret.`,
                ),
              );
            }
          }
          const filePath = resolveDashboardFile("pipeline-aging.html");
          if (filePath) return c.html(readFileSync(filePath, "utf-8"));
          return c.text("Pipeline Aging dashboard not found", 404);
        } catch (err) {
          logger.error("Error serving Pipeline Aging dashboard:", err);
          return c.text("Error loading Pipeline Aging dashboard", 500);
        }
      };
    },
  },

  // ── Single-record helpers ──────────────────────────────────────────────────
  {
    path: "/api/CRMProvider/deals/:id/stage-aging",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const ok = await requirePipelineAgingAccess(c);
          if (!ok) return unauthorizedResponse(c);
          const id = c.req.param("id");
          if (!id) return c.json({ error: "id is required" }, 400);
          return c.json(await getDealStageAging(id, fetchers()));
        } catch (err: any) {
          logger.error("Error fetching deal stage aging:", err);
          return c.json({ error: err?.message || "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/CRMProvider/leads/:id/status-aging",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const ok = await requirePipelineAgingAccess(c);
          if (!ok) return unauthorizedResponse(c);
          const id = c.req.param("id");
          if (!id) return c.json({ error: "id is required" }, 400);
          return c.json(await getLeadStatusAging(id, fetchers()));
        } catch (err: any) {
          logger.error("Error fetching lead status aging:", err);
          return c.json({ error: err?.message || "An internal error occurred" }, 500);
        }
      };
    },
  },

  // ── Paginated list endpoints ───────────────────────────────────────────────
  {
    path: "/api/CRMProvider/deals/aging",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const ok = await requirePipelineAgingAccess(c);
          if (!ok) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const result = await listDealsAging(parseListOpts(url), fetchers());
          return c.json({
            ...result,
            terminalStages: getTerminalDealStages(),
          });
        } catch (err: any) {
          logger.error("Error listing deals aging:", err);
          return c.json({ error: err?.message || "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/CRMProvider/leads/aging",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const ok = await requirePipelineAgingAccess(c);
          if (!ok) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const result = await listLeadsAging(parseListOpts(url), fetchers());
          return c.json({
            ...result,
            terminalStatuses: getTerminalLeadStatuses(),
          });
        } catch (err: any) {
          logger.error("Error listing leads aging:", err);
          return c.json({ error: err?.message || "An internal error occurred" }, 500);
        }
      };
    },
  },

  // Threshold endpoint — small but lets the dashboard render the chip legend
  // without an extra page-level config call.
  {
    path: "/api/CRMProvider/aging/config",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const ok = await requirePipelineAgingAccess(c);
          if (!ok) return unauthorizedResponse(c);
          return c.json({
            leadThresholdDays: getLeadAgingThreshold(),
            dealThresholdDays: getDealAgingThreshold(),
            terminalLeadStatuses: getTerminalLeadStatuses(),
            terminalDealStages: getTerminalDealStages(),
          });
        } catch (err: any) {
          logger.error("Error fetching aging config:", err);
          return c.json({ error: err?.message || "An internal error occurred" }, 500);
        }
      };
    },
  },
];
