/**
 * Scorecard v2 Efficiency Report.
 *
 * Run AFTER scripts/backfillScorecardV2.ts to assess whether the new
 * COPC scorecard is actually scoring the corpus the way we want.
 * Pure SQL aggregation — no OpenAI calls, no writes. Safe to run
 * any time and produces a one-shot text report on stdout.
 *
 * Answers:
 *   • Coverage   — what fraction of evaluations are now COPC-scored?
 *   • Drift      — distribution of v1.5 → v2 score deltas (is the new
 *                  rubric systematically harsher / kinder, and by how much?)
 *   • Sections   — average score per COPC section + % deferred per
 *                  section (tells you which sections actually score
 *                  from transcripts vs which are waiting on Five9)
 *   • Per-agent  — top 10 by call count, avg v2 score vs avg v1.5
 *   • Outliers   — top 5 biggest positive deltas + top 5 biggest negative
 *                  (calls that swung hardest after re-scoring — worth
 *                  spot-checking to validate the new prompt)
 *
 * Usage:
 *   npx tsx scripts/scorecardEfficiencyReport.ts
 *   npx tsx scripts/scorecardEfficiencyReport.ts --json    # machine-readable
 */

import * as pg from "pg";

interface Args {
  jsonOutput: boolean;
}
function parseArgs(): Args {
  const args = process.argv.slice(2);
  return { jsonOutput: args.includes("--json") };
}

function pct(num: number, den: number): string {
  if (!den) return "0.0%";
  return ((num / den) * 100).toFixed(1) + "%";
}
function nz(v: any, places = 2): string {
  if (v == null || isNaN(Number(v))) return "—";
  return Number(v).toFixed(places);
}
function rule(): string {
  return "─".repeat(72);
}

async function run(): Promise<void> {
  const { jsonOutput } = parseArgs();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const report: any = { generated_at: new Date().toISOString() };

  try {
    // 1. Active scorecard
    const activeRes = await pool.query(
      `SELECT name, version FROM quality_scorecards WHERE is_active=true LIMIT 1`,
    );
    report.active_scorecard = activeRes.rows[0]
      ? `${activeRes.rows[0].name} (v${activeRes.rows[0].version})`
      : "(none active!)";

    // 2. Coverage
    const cov = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE backfilled_at IS NOT NULL)::int AS backfilled,
         COUNT(*) FILTER (WHERE backfilled_at IS NULL)::int AS still_v1
       FROM sdr_call_evaluations`,
    );
    report.coverage = cov.rows[0];

    // 3. Drift: avg v1.5 vs v2 + bucketed delta distribution
    const drift = await pool.query(
      `SELECT
         AVG(legacy_score_v1)::float AS avg_v1,
         AVG(overall_score)::float   AS avg_v2,
         AVG(overall_score - legacy_score_v1)::float AS avg_delta,
         MIN(overall_score - legacy_score_v1)::float AS min_delta,
         MAX(overall_score - legacy_score_v1)::float AS max_delta,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE overall_score - legacy_score_v1 >=  20)::int AS d_ge_20,
         COUNT(*) FILTER (WHERE overall_score - legacy_score_v1 >=  10 AND overall_score - legacy_score_v1 < 20)::int AS d_10_20,
         COUNT(*) FILTER (WHERE overall_score - legacy_score_v1 >=   5 AND overall_score - legacy_score_v1 < 10)::int AS d_5_10,
         COUNT(*) FILTER (WHERE overall_score - legacy_score_v1 >  -5 AND overall_score - legacy_score_v1 <  5)::int AS d_flat,
         COUNT(*) FILTER (WHERE overall_score - legacy_score_v1 <= -5 AND overall_score - legacy_score_v1 > -10)::int AS d_n5_10,
         COUNT(*) FILTER (WHERE overall_score - legacy_score_v1 <=-10 AND overall_score - legacy_score_v1 >-20)::int AS d_n10_20,
         COUNT(*) FILTER (WHERE overall_score - legacy_score_v1 <=-20)::int AS d_le_n20
       FROM sdr_call_evaluations
       WHERE backfilled_at IS NOT NULL AND legacy_score_v1 IS NOT NULL`,
    );
    report.drift = drift.rows[0];

    // 4. Section scores — unnest attribute_evaluations JSONB per row
    const sectionStats = await pool.query(
      `WITH attrs AS (
         SELECT
           (a->>'section_id')                          AS section_id,
           CASE WHEN a->>'score' = 'null' OR a->'score' IS NULL THEN NULL
                ELSE (a->>'score')::float END           AS score
         FROM sdr_call_evaluations e
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.attribute_evaluations, '[]'::jsonb)) AS a
         WHERE e.backfilled_at IS NOT NULL OR e.attribute_evaluations IS NOT NULL
       )
       SELECT
         section_id,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE score IS NOT NULL)::int AS scored,
         COUNT(*) FILTER (WHERE score IS NULL)::int AS deferred,
         ROUND( (AVG(score) FILTER (WHERE score IS NOT NULL) / 2.0 * 100)::numeric, 1 )::float AS avg_score_0_100
       FROM attrs
       WHERE section_id IS NOT NULL
       GROUP BY section_id
       ORDER BY section_id`,
    );
    report.section_scores = sectionStats.rows;

    // 5. Per-agent top 10
    const perAgent = await pool.query(
      `SELECT
         cr.agent_email,
         MAX(cr.agent_name) AS agent_name,
         COUNT(e.*)::int AS evals,
         ROUND(AVG(e.overall_score)::numeric, 1)::float AS avg_v2,
         ROUND(AVG(e.legacy_score_v1)::numeric, 1)::float AS avg_v1
       FROM sdr_call_evaluations e
       JOIN call_records cr ON cr.id = e.call_record_id
       WHERE cr.agent_email IS NOT NULL
       GROUP BY cr.agent_email
       ORDER BY evals DESC
       LIMIT 10`,
    );
    report.per_agent_top10 = perAgent.rows;

    // 6. Outliers — top 5 positive and top 5 negative deltas
    const topPos = await pool.query(
      `SELECT e.id AS eval_id, e.call_record_id, e.legacy_score_v1, e.overall_score,
              (e.overall_score - e.legacy_score_v1)::float AS delta,
              cr.agent_email
       FROM sdr_call_evaluations e
       JOIN call_records cr ON cr.id = e.call_record_id
       WHERE e.backfilled_at IS NOT NULL AND e.legacy_score_v1 IS NOT NULL
       ORDER BY (e.overall_score - e.legacy_score_v1) DESC
       LIMIT 5`,
    );
    const topNeg = await pool.query(
      `SELECT e.id AS eval_id, e.call_record_id, e.legacy_score_v1, e.overall_score,
              (e.overall_score - e.legacy_score_v1)::float AS delta,
              cr.agent_email
       FROM sdr_call_evaluations e
       JOIN call_records cr ON cr.id = e.call_record_id
       WHERE e.backfilled_at IS NOT NULL AND e.legacy_score_v1 IS NOT NULL
       ORDER BY (e.overall_score - e.legacy_score_v1) ASC
       LIMIT 5`,
    );
    report.outliers = { top_positive: topPos.rows, top_negative: topNeg.rows };

    // ============ OUTPUT ============
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // Pretty text
    console.log(rule());
    console.log("  Scorecard v2 Efficiency Report");
    console.log(`  Generated: ${report.generated_at}`);
    console.log(`  Active scorecard: ${report.active_scorecard}`);
    console.log(rule());
    console.log();

    console.log("CORPUS COVERAGE");
    const c = report.coverage;
    console.log(`  Total evaluations in sdr_call_evaluations: ${c.total}`);
    console.log(`  Backfilled to v2:                          ${c.backfilled} (${pct(c.backfilled, c.total)})`);
    console.log(`  Still on v1.5 (not backfilled):            ${c.still_v1} (${pct(c.still_v1, c.total)})`);
    console.log();

    console.log("SCORE DRIFT  v1.5 → v2  (backfilled rows only)");
    const d = report.drift;
    if (!d || !d.n) {
      console.log("  No backfilled rows yet — run scripts/backfillScorecardV2.ts first.");
    } else {
      console.log(`  Avg v1.5:    ${nz(d.avg_v1, 1)}`);
      console.log(`  Avg v2:      ${nz(d.avg_v2, 1)}`);
      console.log(`  Avg Δ:       ${d.avg_delta >= 0 ? "+" : ""}${nz(d.avg_delta, 1)}  (over ${d.n} backfilled row${d.n === 1 ? "" : "s"})`);
      console.log(`  Min Δ:       ${nz(d.min_delta, 1)}      Max Δ:  ${d.max_delta >= 0 ? "+" : ""}${nz(d.max_delta, 1)}`);
      console.log();
      console.log("  Delta distribution:");
      const bars = [
        [`≥ +20`, d.d_ge_20],
        [`+10 to +20`, d.d_10_20],
        [`+5 to +10`, d.d_5_10],
        [`−5 to +5`, d.d_flat],
        [`−5 to −10`, d.d_n5_10],
        [`−10 to −20`, d.d_n10_20],
        [`≤ −20`, d.d_le_n20],
      ];
      const max = Math.max(...bars.map(b => Number(b[1])));
      for (const [label, count] of bars) {
        const width = max > 0 ? Math.round((Number(count) / max) * 30) : 0;
        const bar = "█".repeat(width).padEnd(30);
        console.log(`    ${String(label).padStart(12)}  ${bar}  ${count}`);
      }
    }
    console.log();

    console.log("SECTION SCORES  (across all v2-scored evals)");
    if (!report.section_scores.length) {
      console.log("  No COPC section data yet.");
    } else {
      console.log(`  ${"Section".padEnd(30)}  ${"Avg".padStart(6)}  ${"Scored".padStart(6)}  ${"Deferred".padStart(8)}  ${"%Defer".padStart(7)}`);
      for (const s of report.section_scores) {
        const deferPct = pct(s.deferred, s.total);
        const sectionName = (s.section_id || "").replace(/_/g, " ");
        console.log(
          `  ${sectionName.padEnd(30)}  ${String(s.avg_score_0_100 ?? "—").padStart(6)}  ${String(s.scored).padStart(6)}  ${String(s.deferred).padStart(8)}  ${deferPct.padStart(7)}`,
        );
      }
    }
    console.log();

    console.log("PER-AGENT  (top 10 by call count)");
    if (!report.per_agent_top10.length) {
      console.log("  No agent data.");
    } else {
      console.log(`  ${"Agent".padEnd(36)}  ${"Evals".padStart(5)}  ${"Avg v2".padStart(7)}  ${"Avg v1".padStart(7)}  ${"Δ".padStart(6)}`);
      for (const a of report.per_agent_top10) {
        const delta = a.avg_v1 != null ? (a.avg_v2 - a.avg_v1).toFixed(1) : "—";
        const deltaStr = delta !== "—" && Number(delta) >= 0 ? `+${delta}` : delta;
        const agent = (a.agent_name || a.agent_email || "").substring(0, 36);
        console.log(
          `  ${agent.padEnd(36)}  ${String(a.evals).padStart(5)}  ${String(nz(a.avg_v2, 1)).padStart(7)}  ${String(nz(a.avg_v1, 1)).padStart(7)}  ${deltaStr.padStart(6)}`,
        );
      }
    }
    console.log();

    console.log("OUTLIERS — biggest positive Δ (calls that scored MUCH higher under v2)");
    if (!report.outliers.top_positive.length) {
      console.log("  (no backfilled data yet)");
    } else {
      for (const o of report.outliers.top_positive) {
        console.log(`  eval #${o.eval_id} (call #${o.call_record_id}, ${o.agent_email || "—"}): ${nz(o.legacy_score_v1, 0)} → ${nz(o.overall_score, 0)}  (Δ+${nz(o.delta, 1)})`);
      }
    }
    console.log();

    console.log("OUTLIERS — biggest negative Δ (calls that scored MUCH lower under v2)");
    if (!report.outliers.top_negative.length) {
      console.log("  (no backfilled data yet)");
    } else {
      for (const o of report.outliers.top_negative) {
        console.log(`  eval #${o.eval_id} (call #${o.call_record_id}, ${o.agent_email || "—"}): ${nz(o.legacy_score_v1, 0)} → ${nz(o.overall_score, 0)}  (Δ${nz(o.delta, 1)})`);
      }
    }
    console.log();

    console.log("HOW TO INTERPRET");
    console.log("  • Coverage = 100% means every eval is now COPC-scored — the consolidation succeeded.");
    console.log("  • Avg Δ near 0 means the new rubric is roughly calibrated to the old one;");
    console.log("    large positive avg Δ (>+10) suggests v2 is systematically more generous;");
    console.log("    large negative avg Δ (<−10) suggests v2 is harsher — review the prompt.");
    console.log("  • % Deferred per section ≥80% means that section is essentially un-scored from");
    console.log("    transcripts alone — expected for Activity & Process and KPI (Five9 dependency).");
    console.log("  • Outliers > 30 points either direction are worth opening manually to validate.");
    console.log();
    console.log(rule());
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("[efficiencyReport] FAILED:", err?.message || err);
  process.exit(1);
});
