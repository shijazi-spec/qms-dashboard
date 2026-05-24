/**
 * Score every call_records row that has a transcript but no
 * sdr_call_evaluations row, using the currently-active scorecard.
 *
 * Diagnostic from 2026-05-24 revealed sdr_call_evaluations was empty:
 * the 199 calls in the platform had been uploaded + transcribed +
 * analyzed but never SDR-scored, so the v1 → v2 backfill found
 * nothing to backfill. This script closes that gap directly — runs
 * the SDR evaluator (which uses the active scorecard = COPC v2 now)
 * against every call that's missing an evaluation.
 *
 * Idempotent: only picks calls that don't already have an evaluation.
 * Safe to re-run after partial completion (e.g. cost cap hit). Uses
 * the existing aiCostGuard so a runaway scoring session pauses
 * gracefully when COST_CIRCUIT_BREAKER is on.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/scoreAllUnevaluatedCalls.ts          # preview
 *   DRY_RUN=1 npx tsx scripts/scoreAllUnevaluatedCalls.ts --max 5  # tiny preview
 *   npx tsx scripts/scoreAllUnevaluatedCalls.ts                    # score everything
 *   npx tsx scripts/scoreAllUnevaluatedCalls.ts --max 50           # cap to 50/run
 *
 * Cost: ~$0.0005 per call (gpt-4o-mini). 199 calls ≈ $0.10.
 * Time: ~3 seconds per call. 199 calls ≈ 10 minutes serial.
 */

import pg from "pg";

const DRY_RUN = process.env.DRY_RUN === "1";

function parseArgs(): { max: number } {
  const args = process.argv.slice(2);
  let max = 5000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max" && args[i + 1]) {
      max = Math.max(1, Math.min(50000, parseInt(args[i + 1], 10) || 5000));
      i++;
    }
  }
  return { max };
}

async function run(): Promise<void> {
  const { max } = parseArgs();
  console.log(`[scoreUnevaluated] starting (DRY_RUN=${DRY_RUN}, max=${max})`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    // Diagnostic — show the operator what the corpus looks like before
    // touching anything. Often the first 'huh' moment in a debug session.
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM call_records) AS calls,
        (SELECT COUNT(*) FROM call_transcripts) AS transcripts,
        (SELECT COUNT(*) FROM call_analysis) AS analyses,
        (SELECT COUNT(*) FROM sdr_call_evaluations) AS evaluations
    `);
    const d = counts.rows[0];
    console.log(`[scoreUnevaluated] corpus snapshot:`);
    console.log(`  call_records:          ${d.calls}`);
    console.log(`  call_transcripts:      ${d.transcripts}`);
    console.log(`  call_analysis:         ${d.analyses}`);
    console.log(`  sdr_call_evaluations:  ${d.evaluations}`);

    // Sanity: confirm the active scorecard is what we expect (COPC v2).
    const sc = await pool.query(
      `SELECT id, name, version FROM quality_scorecards WHERE is_active = true LIMIT 1`,
    );
    if (sc.rows.length === 0) {
      console.error("[scoreUnevaluated] no active scorecard! Run scripts/seedScorecardV2Copc.ts first.");
      process.exit(3);
    }
    console.log(`[scoreUnevaluated] active scorecard: ${sc.rows[0].name} (v${sc.rows[0].version})`);

    // Find candidates — call_records WITH a transcript but WITHOUT
    // an sdr_call_evaluations row. Oldest first so partial runs make
    // forward progress and survivors-on-retry stay deterministic.
    const candidatesRes = await pool.query(
      `SELECT cr.id, cr.call_id, cr.agent_email, cr.created_at
         FROM call_records cr
         JOIN call_transcripts t ON t.call_record_id = cr.id
         LEFT JOIN sdr_call_evaluations e ON e.call_record_id = cr.id
        WHERE e.id IS NULL
        ORDER BY cr.created_at ASC
        LIMIT $1`,
      [max],
    );
    const candidates = candidatesRes.rows;
    console.log(`[scoreUnevaluated] found ${candidates.length} call_record(s) without an evaluation`);

    if (candidates.length === 0) {
      console.log("[scoreUnevaluated] nothing to do. Exiting.");
      return;
    }

    if (DRY_RUN) {
      console.log("[scoreUnevaluated] DRY_RUN — would score:");
      for (const c of candidates.slice(0, 20)) {
        const created = c.created_at instanceof Date
          ? c.created_at.toISOString().slice(0, 10)
          : String(c.created_at).slice(0, 10);
        console.log(`  call #${c.id} (${c.call_id}, ${c.agent_email || "—"}, ${created})`);
      }
      if (candidates.length > 20) {
        console.log(`  …and ${candidates.length - 20} more`);
      }
      const estCost = (candidates.length * 0.0005).toFixed(2);
      const estTime = Math.ceil(candidates.length * 3 / 60);
      console.log(`[scoreUnevaluated] DRY_RUN — would cost ~$${estCost}, ~${estTime} minute(s) serial. No writes. Exiting.`);
      return;
    }

    // Actual scoring loop. triggerSDREvaluationForCall reads the
    // active scorecard (COPC v2 after the seed migration), runs the
    // AI judge prompt, and writes sdr_call_evaluations.
    const { triggerSDREvaluationForCall } = await import(
      "../src/utils/sdrAutoEvaluator"
    );
    const { isCostCapped, recordSpend, COST } = await import(
      "../src/utils/aiCostGuard"
    );

    let scored = 0;
    let skipped = 0;
    let failed = 0;
    const startedAt = Date.now();

    for (const c of candidates) {
      if (isCostCapped()) {
        console.warn(
          "[scoreUnevaluated] AI daily cost cap reached — pausing. " +
            "Re-run tomorrow to continue from where we left off.",
        );
        break;
      }
      try {
        const outcome = await triggerSDREvaluationForCall(c.id, "SDR");
        if (outcome.ran) {
          scored += 1;
          recordSpend(COST.GPT4O_MINI_SDR_EVAL, "fresh_score");
          console.log(
            `  ✓ call #${c.id}: overall ${outcome.overallScore} (scorecard #${outcome.scorecardId})`,
          );
        } else {
          skipped += 1;
          console.log(`  · call #${c.id}: skipped — ${outcome.skipReason}`);
        }
      } catch (err: any) {
        failed += 1;
        console.warn(`  ✗ call #${c.id}: ${err?.message || String(err)}`);
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[scoreUnevaluated] done — scored ${scored}, skipped ${skipped}, failed ${failed}, elapsed ${elapsed}s`,
    );
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("[scoreUnevaluated] FAILED:", err?.message || err);
  process.exit(1);
});
