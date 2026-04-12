import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const monitorRisksTool = createTool({
  id: "monitor-risks",

  description:
    "Monitors the risk register for high-scoring risks, escalated items, overdue treatment actions, " +
    "and threshold breaches. Provides early warning for risk management.",

  inputSchema: z.object({
    checkType: z.enum(["high_risks", "escalated", "overdue_treatments", "threshold_breach"])
      .describe("Type of risk check to perform"),
    riskThreshold: z.number().optional()
      .describe("Risk score threshold for high_risks check (default: 15, calculated as likelihood * impact)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    checkType: z.string(),
    risksFound: z.number(),
    details: z.array(z.object({
      riskId: z.number(),
      title: z.string(),
      score: z.number(),
      status: z.string(),
      finding: z.string(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const threshold = context.riskThreshold ?? 15;

    logger?.info("⚠️ [monitorRisksTool] Running risk check...", {
      checkType: context.checkType,
      riskThreshold: threshold,
    });

    try {
      let details: Array<{ riskId: number; title: string; score: number; status: string; finding: string }> = [];

      switch (context.checkType) {
        case "high_risks": {
          const result = await pool.query(
            `SELECT id, title, likelihood, impact, status, risk_level
             FROM risks
             WHERE (likelihood * impact) >= $1
             ORDER BY (likelihood * impact) DESC`,
            [threshold]
          );
          details = result.rows.map(r => ({
            riskId: r.id,
            title: r.title,
            score: r.likelihood * r.impact,
            status: r.status,
            finding: `Risk score ${r.likelihood * r.impact} (${r.likelihood}×${r.impact}) exceeds threshold of ${threshold}. Risk level: ${r.risk_level}.`,
          }));
          break;
        }

        case "escalated": {
          const result = await pool.query(
            `SELECT id, title, likelihood, impact, status, risk_level
             FROM risks
             WHERE status = 'escalated' OR risk_level IN ('critical', 'high')
             ORDER BY
               CASE risk_level WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               (likelihood * impact) DESC`
          );
          details = result.rows.map(r => ({
            riskId: r.id,
            title: r.title,
            score: r.likelihood * r.impact,
            status: r.status,
            finding: `Risk is ${r.status === 'escalated' ? 'escalated' : `at ${r.risk_level} level`}. Score: ${r.likelihood * r.impact}.`,
          }));
          break;
        }

        case "overdue_treatments": {
          const result = await pool.query(
            `SELECT rta.id, rta.description, rta.due_date, rta.status AS action_status,
                    r.id AS risk_id, r.title AS risk_title, r.likelihood, r.impact
             FROM risk_treatment_actions rta
             JOIN risks r ON r.id = rta.risk_id
             WHERE rta.due_date < NOW() AND rta.status != 'completed'
             ORDER BY rta.due_date ASC`
          );
          details = result.rows.map(r => {
            const daysOverdue = Math.floor((Date.now() - new Date(r.due_date).getTime()) / (1000 * 60 * 60 * 24));
            return {
              riskId: r.risk_id,
              title: r.risk_title,
              score: r.likelihood * r.impact,
              status: r.action_status,
              finding: `Treatment action "${r.description}" is ${daysOverdue} day(s) overdue (due: ${new Date(r.due_date).toISOString().split('T')[0]}).`,
            };
          });
          break;
        }

        case "threshold_breach": {
          const result = await pool.query(
            `SELECT id, title, likelihood, impact, status, risk_level,
                    risk_appetite, risk_tolerance
             FROM risks
             WHERE (risk_appetite IS NOT NULL AND (likelihood * impact) > risk_appetite)
                OR (risk_tolerance IS NOT NULL AND (likelihood * impact) > risk_tolerance)
             ORDER BY (likelihood * impact) DESC`
          );
          details = result.rows.map(r => {
            const score = r.likelihood * r.impact;
            const breaches: string[] = [];
            if (r.risk_appetite !== null && score > r.risk_appetite) {
              breaches.push(`appetite (${r.risk_appetite})`);
            }
            if (r.risk_tolerance !== null && score > r.risk_tolerance) {
              breaches.push(`tolerance (${r.risk_tolerance})`);
            }
            return {
              riskId: r.id,
              title: r.title,
              score,
              status: r.status,
              finding: `Score ${score} exceeds risk ${breaches.join(' and ')}. Immediate attention required.`,
            };
          });
          break;
        }
      }

      logger?.info("✅ [monitorRisksTool] Risk check complete", {
        checkType: context.checkType,
        risksFound: details.length,
      });

      return {
        success: true,
        checkType: context.checkType,
        risksFound: details.length,
        details,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [monitorRisksTool] Risk check failed", { error: errorMessage });

      return {
        success: false,
        checkType: context.checkType,
        risksFound: 0,
        details: [],
        error: errorMessage,
      };
    }
  },
});
