import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const analyzeNonconformitiesTool = createTool({
  id: "analyze-nonconformities",

  description:
    "Analyzes Nonconformance patterns to identify trends, overdue CAPAs, severity distributions, " +
    "and recurring issues. Helps quality managers spot systemic problems and prioritize actions.",

  inputSchema: z.object({
    analysisType: z.enum(['patterns', 'overdue_capas', 'severity_trends', 'recurring'])
      .describe("Type of NC analysis to perform"),
    dayRange: z.number().optional()
      .describe("Number of days to look back for analysis (default: 90)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    analysisType: z.string(),
    findings: z.array(z.object({
      title: z.string(),
      description: z.string(),
      severity: z.string(),
      count: z.number(),
    })),
    summary: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [analyzeNonconformitiesTool] Running NC analysis...", {
      analysisType: context.analysisType,
      dayRange: context.dayRange,
    });

    try {
      const dayRange = context.dayRange ?? 90;
      const findings: { title: string; description: string; severity: string; count: number }[] = [];
      let summary = '';

      if (context.analysisType === 'patterns') {
        const result = await pool.query(
          `SELECT nc_type, category, COUNT(*)::int AS count
           FROM nonconformance_records
           WHERE created_at >= NOW() - ($1 || ' days')::interval
           GROUP BY nc_type, category
           ORDER BY count DESC`,
          [dayRange.toString()]
        );

        for (const row of result.rows) {
          findings.push({
            title: `${row.nc_type} - ${row.category || 'Uncategorized'}`,
            description: `${row.count} occurrences of ${row.nc_type} in category ${row.category || 'N/A'} over the last ${dayRange} days`,
            severity: row.count >= 10 ? 'critical' : row.count >= 5 ? 'major' : 'minor',
            count: row.count,
          });
        }

        summary = findings.length > 0
          ? `Found ${findings.length} NC pattern groups. Top pattern: ${findings[0].title} with ${findings[0].count} occurrences.`
          : `No NC patterns found in the last ${dayRange} days.`;

      } else if (context.analysisType === 'overdue_capas') {
        const result = await pool.query(
          `SELECT c.id, c.capa_number, c.title, c.severity, c.due_date, c.status, c.assigned_to
           FROM capa_records c
           WHERE c.due_date < NOW()
             AND c.status != $1
           ORDER BY c.due_date ASC`,
          ['completed']
        );

        for (const row of result.rows) {
          const daysOverdue = Math.floor(
            (Date.now() - new Date(row.due_date).getTime()) / (1000 * 60 * 60 * 24)
          );
          findings.push({
            title: `${row.capa_number}: ${row.title}`,
            description: `Overdue by ${daysOverdue} days. Assigned to: ${row.assigned_to || 'Unassigned'}. Status: ${row.status}`,
            severity: daysOverdue > 30 ? 'critical' : daysOverdue > 14 ? 'major' : 'minor',
            count: daysOverdue,
          });
        }

        summary = findings.length > 0
          ? `Found ${findings.length} overdue CAPAs. Most overdue: ${findings[0].title} (${findings[0].count} days).`
          : 'No overdue CAPAs found.';

      } else if (context.analysisType === 'severity_trends') {
        const result = await pool.query(
          `SELECT severity, COUNT(*)::int AS count
           FROM nonconformance_records
           WHERE created_at >= NOW() - ($1 || ' days')::interval
           GROUP BY severity
           ORDER BY count DESC`,
          [dayRange.toString()]
        );

        const totalNCs = result.rows.reduce((sum: number, r: { count: number }) => sum + r.count, 0);

        for (const row of result.rows) {
          const pct = totalNCs > 0 ? Math.round((row.count / totalNCs) * 100) : 0;
          findings.push({
            title: `${row.severity} severity`,
            description: `${row.count} NCs (${pct}%) at ${row.severity} severity in the last ${dayRange} days`,
            severity: row.severity,
            count: row.count,
          });
        }

        const criticalCount = result.rows.find((r: { severity: string }) => r.severity === 'critical')?.count ?? 0;
        summary = `${totalNCs} total NCs in the last ${dayRange} days. ${criticalCount} critical. Severity breakdown: ${findings.map(f => `${f.title}: ${f.count}`).join(', ')}.`;

      } else if (context.analysisType === 'recurring') {
        const result = await pool.query(
          `SELECT title, nc_type, COUNT(*)::int AS count
           FROM nonconformance_records
           WHERE created_at >= NOW() - ($1 || ' days')::interval
           GROUP BY title, nc_type
           HAVING COUNT(*) >= 2
           ORDER BY count DESC`,
          [dayRange.toString()]
        );

        for (const row of result.rows) {
          findings.push({
            title: row.title,
            description: `Recurring ${row.nc_type} NC appearing ${row.count} times in the last ${dayRange} days`,
            severity: row.count >= 5 ? 'critical' : row.count >= 3 ? 'major' : 'minor',
            count: row.count,
          });
        }

        summary = findings.length > 0
          ? `Found ${findings.length} recurring NC patterns. Most frequent: "${findings[0].title}" with ${findings[0].count} occurrences.`
          : `No recurring NCs found in the last ${dayRange} days.`;
      }

      logger?.info("✅ [analyzeNonconformitiesTool] Analysis completed", {
        analysisType: context.analysisType,
        findingsCount: findings.length,
      });

      return {
        success: true,
        analysisType: context.analysisType,
        findings,
        summary,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [analyzeNonconformitiesTool] Analysis failed", { error: errorMessage });

      return {
        success: false,
        analysisType: context.analysisType,
        findings: [],
        summary: '',
        error: errorMessage,
      };
    }
  },
});
