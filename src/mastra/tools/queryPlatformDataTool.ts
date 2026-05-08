import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sharedPool as pool } from "../../utils/sharedPool";
import { getCurrentAgentContext } from "../../utils/withApprovalGate";

// NOTE: 'pdpl' and 'event_logs' are intentionally excluded from this map.
// Those tables are restricted to admin-only API routes and must never be
// reachable through the AI consultant tool, which is accessible to
// non-admin roles (ai_specialist, grc_manager, head_of_operations_quality).
const MODULE_TABLE_MAP: Record<string, { table: string; orderBy?: string; join?: string }> = {
  nonconformances: { table: 'nonconformance_records' },
  capas: { table: 'capa_records' },
  risks: { table: 'risks' },
  policies: { table: 'governance_documents' },
  audits: { table: 'quality_audit_results' },
  compliance: { table: 'obligations' },
  kpis: {
    table: 'kpi_definitions',
    join: 'LEFT JOIN kpi_entries ON kpi_definitions.id = kpi_entries.kpi_id',
  },
  vendors: { table: 'vendors' },
  training: { table: 'training_records' },
};

/**
 * Per-module role allowlist.  Mirrors the access rules enforced by the
 * corresponding REST API routes in src/utils/rbacMiddleware.ts so that the
 * consultant tool cannot be used to bypass normal RBAC.
 *
 * Rules (read endpoints only — the tool is read-only):
 *   nonconformances  /api/qms/nc         — admin only (rbacMiddleware line 2018)
 *   capas            /api/qms/capa       — admin only (rbacMiddleware line 2018)
 *   risks            /api/risks          — excludes ai_specialist (line 476-487)
 *   policies         /api/policies       — includes ai_specialist (line 1000-1013)
 *   audits           /api/audits         — excludes ai_specialist (line 594-605)
 *   compliance       /api/compliance     — excludes ai_specialist (line 714-725)
 *   kpis             /api/kpis           — excludes ai_specialist (line 1063-1074)
 *   vendors          /api/vendors        — excludes ai_specialist & executive (line 732-742)
 *   training         /api/qms/training   — admin only (line 2018)
 */
const MODULE_ROLE_ALLOWLIST: Record<string, string[]> = {
  nonconformances: ["admin"],
  capas:           ["admin"],
  risks:           ["admin", "head_of_operations_quality", "grc_manager", "quality_manager", "executive"],
  policies:        ["admin", "grc_manager", "quality_manager", "head_of_operations_quality", "bu_owner", "executive", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  audits:          ["admin", "head_of_operations_quality", "grc_manager", "quality_manager", "executive"],
  compliance:      ["admin", "head_of_operations_quality", "grc_manager", "quality_manager", "executive"],
  kpis:            ["admin", "quality_manager", "grc_manager", "head_of_operations_quality", "executive"],
  vendors:         ["admin", "head_of_operations_quality", "grc_manager", "quality_manager"],
  training:        ["admin"],
};

export const queryPlatformDataTool = createTool({
  id: "query-platform-data",

  description:
    "Queries platform data across QMS modules including nonconformances, CAPAs, risks, " +
    "policies, audits, compliance obligations, KPIs, vendors, and training records. " +
    "Supports optional filtering by status, severity, date range, and result limit.",

  inputSchema: z.object({
    module: z.enum([
      'nonconformances', 'capas', 'risks', 'policies', 'audits',
      'compliance', 'kpis', 'vendors', 'training',
    ]).describe("The QMS module to query data from"),
    status: z.string().optional().describe("Filter by status value"),
    severity: z.string().optional().describe("Filter by severity level"),
    limit: z.number().optional().describe("Maximum number of records to return (default: 50)"),
    dateFrom: z.string().optional().describe("Filter records created on or after this date (ISO format)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    module: z.string(),
    total: z.number(),
    records: z.array(z.record(z.any())),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();

    // Enforce per-module RBAC using the caller's verified role threaded into
    // the agent execution context by the consultant route via withAgentUserContext().
    // This prevents users from reading modules they cannot access through the
    // normal REST API, regardless of what the AI model was instructed to do.
    const agentCtx = getCurrentAgentContext();
    const callerRole = agentCtx?.user?.role ?? null;

    const allowedRoles = MODULE_ROLE_ALLOWLIST[context.module];
    if (!allowedRoles) {
      return {
        success: false,
        module: context.module,
        total: 0,
        records: [],
        error: `Unknown module: ${context.module}`,
      };
    }

    if (!callerRole || !allowedRoles.includes(callerRole)) {
      logger?.warn("🚫 [queryPlatformDataTool] Role not permitted for module", {
        module: context.module,
        callerRole,
        allowedRoles,
      });
      return {
        success: false,
        module: context.module,
        total: 0,
        records: [],
        error: `Access denied: your role (${callerRole ?? "unknown"}) is not permitted to query the '${context.module}' module.`,
      };
    }

    logger?.info("📊 [queryPlatformDataTool] Querying platform data...", {
      module: context.module,
      callerRole,
      status: context.status,
      severity: context.severity,
    });

    try {
      const moduleConfig = MODULE_TABLE_MAP[context.module];

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (context.status) {
        conditions.push(`${moduleConfig.table}.status = $${paramIndex++}`);
        params.push(context.status);
      }

      if (context.severity) {
        conditions.push(`${moduleConfig.table}.severity = $${paramIndex++}`);
        params.push(context.severity);
      }

      if (context.dateFrom) {
        conditions.push(`${moduleConfig.table}.created_at >= $${paramIndex++}`);
        params.push(context.dateFrom);
      }

      const limit = context.limit ?? 50;
      params.push(limit);

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause = moduleConfig.orderBy ? `ORDER BY ${moduleConfig.orderBy}` : 'ORDER BY created_at DESC';
      const joinClause = moduleConfig.join ?? '';

      const query = `
        SELECT ${moduleConfig.table}.*
        FROM ${moduleConfig.table}
        ${joinClause}
        ${whereClause}
        ${orderClause}
        LIMIT $${paramIndex}
      `;

      const result = await pool.query(query, params);

      logger?.info("✅ [queryPlatformDataTool] Query completed", {
        module: context.module,
        total: result.rows.length,
      });

      return {
        success: true,
        module: context.module,
        total: result.rows.length,
        records: result.rows,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [queryPlatformDataTool] Query failed", { error: errorMessage });

      return {
        success: false,
        module: context.module,
        total: 0,
        records: [],
        error: errorMessage,
      };
    }
  },
});
