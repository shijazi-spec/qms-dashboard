import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sharedPool as pool } from "../../utils/sharedPool";

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
            `SELECT kd.id, kd.kpi_name, kd.target_value, kv.actual_value, kv.period_end
             FROM kpi_definitions kd
             JOIN kpi_values kv ON kd.id = kv.kpi_id
             WHERE kv.period_end = (
               SELECT MAX(kv2.period_end) FROM kpi_values kv2 WHERE kv2.kpi_id = kd.id
             )
             AND kv.actual_value < kd.target_value
             ORDER BY (kd.target_value - kv.actual_value) DESC`
          );
          issues = result.rows.map(r => {
            const gap = r.target_value - r.actual_value;
            const gapPct = ((gap / r.target_value) * 100).toFixed(1);
            return {
              kpiName: r.kpi_name,
              target: parseFloat(r.target_value),
              actual: parseFloat(r.actual_value),
              trend: "below_target",
              finding: `Missed target by ${gap.toFixed(2)} (${gapPct}%). Latest value: ${r.actual_value}, target: ${r.target_value}.`,
            };
          });
          break;
        }

        case "trending_down": {
          const kpiResult = await pool.query(`SELECT id, kpi_name, target_value FROM kpi_definitions`);

          for (const kpi of kpiResult.rows) {
            const entriesResult = await pool.query(
              `SELECT actual_value, period_end FROM kpi_values
               WHERE kpi_id = $1
               ORDER BY period_end DESC
               LIMIT $2`,
              [kpi.id, periods]
            );

            const entries = entriesResult.rows;
            if (entries.length < 2) continue;

            let declining = true;
            for (let i = 0; i < entries.length - 1; i++) {
              if (parseFloat(entries[i].actual_value) >= parseFloat(entries[i + 1].actual_value)) {
                declining = false;
                break;
              }
            }

            if (declining) {
              const latest = parseFloat(entries[0].actual_value);
              const oldest = parseFloat(entries[entries.length - 1].actual_value);
              const changePct = (((latest - oldest) / oldest) * 100).toFixed(1);

              issues.push({
                kpiName: kpi.kpi_name,
                target: parseFloat(kpi.target_value),
                actual: latest,
                trend: "declining",
                finding: `Declining over last ${entries.length} periods (${changePct}% change). Values: ${entries.map(e => e.actual_value).join(" → ")}.`,
              });
            }
          }
          break;
        }

        case "all_status": {
          const result = await pool.query(
            `SELECT kd.id, kd.kpi_name, kd.target_value, kv.actual_value, kv.period_end
             FROM kpi_definitions kd
             LEFT JOIN kpi_values kv ON kd.id = kv.kpi_id
               AND kv.period_end = (
                 SELECT MAX(kv2.period_end) FROM kpi_values kv2 WHERE kv2.kpi_id = kd.id
               )
             ORDER BY kd.kpi_name`
          );
          issues = result.rows.map(r => {
            const actual = r.actual_value !== null ? parseFloat(r.actual_value) : 0;
            const target = parseFloat(r.target_value);
            let trend: string;
            if (r.actual_value === null) {
              trend = "no_data";
            } else if (actual >= target) {
              trend = "on_target";
            } else if (actual >= target * 0.9) {
              trend = "near_target";
            } else {
              trend = "below_target";
            }

            return {
              kpiName: r.kpi_name,
              target,
              actual,
              trend,
              finding: r.actual_value === null
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
