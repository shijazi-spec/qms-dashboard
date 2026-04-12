import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const monitorKPIsTool = createTool({
  id: "monitor-kpis",

  description:
    "Monitors KPI performance by checking for missed targets, downward trends, and overall status. " +
    "Compares actual KPI values against defined targets and analyzes trends over recent periods.",

  inputSchema: z.object({
    checkType: z.enum(["missed_targets", "trending_down", "all_status"])
      .describe("Type of KPI check to perform"),
    periodCount: z.number().optional()
      .describe("Number of recent periods to analyze for trend detection (default: 3)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    checkType: z.string(),
    kpisChecked: z.number(),
    issues: z.array(z.object({
      kpiName: z.string(),
      target: z.number(),
      actual: z.number(),
      trend: z.string(),
      finding: z.string(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const periods = context.periodCount ?? 3;

    logger?.info("📊 [monitorKPIsTool] Running KPI check...", {
      checkType: context.checkType,
      periodCount: periods,
    });

    try {
      let issues: Array<{ kpiName: string; target: number; actual: number; trend: string; finding: string }> = [];

      switch (context.checkType) {
        case "missed_targets": {
          const result = await pool.query(
            `SELECT kd.id, kd.name, kd.target, ke.value, ke.period_date
             FROM kpi_definitions kd
             JOIN kpi_entries ke ON kd.id = ke.kpi_id
             WHERE ke.period_date = (
               SELECT MAX(ke2.period_date) FROM kpi_entries ke2 WHERE ke2.kpi_id = kd.id
             )
             AND ke.value < kd.target
             ORDER BY (kd.target - ke.value) DESC`
          );
          issues = result.rows.map(r => {
            const gap = r.target - r.value;
            const gapPct = ((gap / r.target) * 100).toFixed(1);
            return {
              kpiName: r.name,
              target: parseFloat(r.target),
              actual: parseFloat(r.value),
              trend: "below_target",
              finding: `Missed target by ${gap.toFixed(2)} (${gapPct}%). Latest value: ${r.value}, target: ${r.target}.`,
            };
          });
          break;
        }

        case "trending_down": {
          const kpiResult = await pool.query(`SELECT id, name, target FROM kpi_definitions`);

          for (const kpi of kpiResult.rows) {
            const entriesResult = await pool.query(
              `SELECT value, period_date FROM kpi_entries
               WHERE kpi_id = $1
               ORDER BY period_date DESC
               LIMIT $2`,
              [kpi.id, periods]
            );

            const entries = entriesResult.rows;
            if (entries.length < 2) continue;

            let declining = true;
            for (let i = 0; i < entries.length - 1; i++) {
              if (parseFloat(entries[i].value) >= parseFloat(entries[i + 1].value)) {
                declining = false;
                break;
              }
            }

            if (declining) {
              const latest = parseFloat(entries[0].value);
              const oldest = parseFloat(entries[entries.length - 1].value);
              const changePct = (((latest - oldest) / oldest) * 100).toFixed(1);

              issues.push({
                kpiName: kpi.name,
                target: parseFloat(kpi.target),
                actual: latest,
                trend: "declining",
                finding: `Declining over last ${entries.length} periods (${changePct}% change). Values: ${entries.map(e => e.value).join(" → ")}.`,
              });
            }
          }
          break;
        }

        case "all_status": {
          const result = await pool.query(
            `SELECT kd.id, kd.name, kd.target, ke.value, ke.period_date
             FROM kpi_definitions kd
             LEFT JOIN kpi_entries ke ON kd.id = ke.kpi_id
               AND ke.period_date = (
                 SELECT MAX(ke2.period_date) FROM kpi_entries ke2 WHERE ke2.kpi_id = kd.id
               )
             ORDER BY kd.name`
          );
          issues = result.rows.map(r => {
            const actual = r.value !== null ? parseFloat(r.value) : 0;
            const target = parseFloat(r.target);
            let trend: string;
            if (r.value === null) {
              trend = "no_data";
            } else if (actual >= target) {
              trend = "on_target";
            } else if (actual >= target * 0.9) {
              trend = "near_target";
            } else {
              trend = "below_target";
            }

            return {
              kpiName: r.name,
              target,
              actual,
              trend,
              finding: r.value === null
                ? "No data recorded for this KPI yet."
                : `Current value: ${actual}, target: ${target} (${((actual / target) * 100).toFixed(1)}% of target).`,
            };
          });
          break;
        }
      }

      logger?.info("✅ [monitorKPIsTool] KPI check complete", {
        checkType: context.checkType,
        kpisChecked: issues.length,
      });

      return {
        success: true,
        checkType: context.checkType,
        kpisChecked: issues.length,
        issues,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [monitorKPIsTool] KPI check failed", { error: errorMessage });

      return {
        success: false,
        checkType: context.checkType,
        kpisChecked: 0,
        issues: [],
        error: errorMessage,
      };
    }
  },
});
