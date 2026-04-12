import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MODULE_TABLE_MAP: Record<string, { table: string; orderBy?: string; join?: string }> = {
  nonconformances: { table: 'nonconformance_records' },
  capas: { table: 'capa_records' },
  risks: { table: 'risks' },
  policies: { table: 'governance_documents' },
  audits: { table: 'quality_audit_results' },
  compliance: { table: 'obligations' },
  kpis: {
    table: 'kpi_definitions',
    join: 'LEFT JOIN kpi_entries ON kpi_definitions.id = kpi_entries.kpi_definition_id',
  },
  vendors: { table: 'vendors' },
  pdpl: { table: 'pdpl_data_inventory' },
  event_logs: { table: 'event_logs', orderBy: 'created_at DESC' },
  training: { table: 'training_records' },
};

export const queryPlatformDataTool = createTool({
  id: "query-platform-data",

  description:
    "Queries platform data across QMS modules including nonconformances, CAPAs, risks, " +
    "policies, audits, compliance obligations, KPIs, vendors, PDPL, event logs, and training records. " +
    "Supports optional filtering by status, severity, date range, and result limit.",

  inputSchema: z.object({
    module: z.enum([
      'nonconformances', 'capas', 'risks', 'policies', 'audits',
      'compliance', 'kpis', 'vendors', 'pdpl', 'event_logs', 'training',
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
    logger?.info("📊 [queryPlatformDataTool] Querying platform data...", {
      module: context.module,
      status: context.status,
      severity: context.severity,
    });

    try {
      const moduleConfig = MODULE_TABLE_MAP[context.module];
      if (!moduleConfig) {
        return {
          success: false,
          module: context.module,
          total: 0,
          records: [],
          error: `Unknown module: ${context.module}`,
        };
      }

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
